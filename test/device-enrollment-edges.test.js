'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { hashPin } = require('../auth-core');
const { requireRole } = require('../permissions');
const createDeviceEnrollmentRouter = require('../routes/deviceEnrollment');
const { createDeviceEnrollmentService } = require('../services/deviceEnrollment');
const { createWorkerInvitationService } = require('../services/workerInvitations');

const requestsPath = '/api/device-enrollment/requests';
const validRequest = { requester_name: 'עובד ייצור', device_name: 'טלפון אולם ייצור' };
const adminName = 'מנהל מערכת';

function jsonRequest(method, body, headers = {}) {
  return {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return (pathname, options) => fetch(baseUrl + pathname, options);
}

test('device enrollment edges with a temporary database', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-device-enrollment-edges-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.BCRYPT_ROUNDS = '4';
  process.env.DB_PATH = path.join(tmpDir, 'enrollment.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  delete process.env.ALLOW_UNINVITED_DEVICE_ENROLLMENT;

  let runtime;
  t.after(async () => {
    if (runtime) {
      await new Promise(resolve => runtime.closeServer(resolve));
      runtime.db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  runtime = require('../server');
  const { db, server } = runtime;
  const request = await listen(server);
  const getDb = () => db;
  const devices = createDeviceEnrollmentService({ getDb });
  const countDevices = () => db.prepare('SELECT COUNT(*) AS count FROM device_enrollment_requests').get().count;

  await t.test('the default POST requires an invitation and creates no request', async () => {
    const response = await request(requestsPath, jsonRequest('POST', validRequest));
    assert.equal(response.status, 403);
    const { error, code } = await response.json();
    assert.deepEqual({ error, code }, {
      error: 'worker_invitation_required',
      code: 'worker_invitation_required',
    });
    assert.equal(countDevices(), 0);
  });

  await t.test('legacy POST rejects short names and returns the same pending request on repeat', async (legacyTest) => {
    const legacyApp = express();
    legacyApp.use(express.json());
    legacyApp.use('/api', createDeviceEnrollmentRouter({
      getDb,
      requireRole,
      deviceEnrollment: devices,
      enrollmentLimiter: rateLimit({ windowMs: 60_000, limit: 20 }),
      auditLog: () => assert.fail('POST must not write a device review audit'),
      allowUninvitedEnrollment: true,
    }));
    const legacyServer = http.createServer(legacyApp);
    legacyTest.after(() => new Promise(resolve => legacyServer.close(resolve)));
    const legacyRequest = await listen(legacyServer);

    for (const field of ['requester_name', 'device_name']) {
      const response = await legacyRequest(requestsPath, jsonRequest('POST', {
        ...validRequest,
        [field]: ' א ',
      }));
      assert.equal(response.status, 400, field);
      assert.equal((await response.json()).error, 'requester_name_and_device_name_required');
    }
    assert.equal(countDevices(), 0);

    const first = await legacyRequest(requestsPath, jsonRequest('POST', validRequest));
    assert.equal(first.status, 201);
    const { credential, ...created } = await first.json();
    assert.equal(typeof credential, 'string');
    assert.equal(created.status, 'pending');

    const repeat = await legacyRequest(requestsPath, jsonRequest('POST', validRequest, {
      'X-IronBend-Device': credential,
    }));
    assert.equal(repeat.status, 202);
    assert.deepEqual(await repeat.json(), created);
    assert.equal(countDevices(), 1);
  });

  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active)
    VALUES (?, ?, ?, ?, ?)
  `);
  const adminId = insertUser.run('enrollment-admin', adminName, 'admin', hashPin('8801'), 1).lastInsertRowid;
  insertUser.run('enrollment-manager', 'מנהל ייצור', 'manager', hashPin('8802'), 1);
  const workerName = 'עובד מוזמן';
  const invitedId = insertUser.run('invited-worker', workerName, 'production', null, 0).lastInsertRowid;
  const otherId = insertUser.run('other-worker', workerName, 'production', null, 0).lastInsertRowid;
  const invitations = createWorkerInvitationService({ getDb });
  const { row: invitation } = invitations.create({
    workerName,
    role: 'production',
    createdBy: adminId,
    createdByName: adminName,
  });
  // Older invitation claims could leave a pending device tied to an inactive user.
  const { row: pending } = devices.createPendingEnrollment({
    requesterName: workerName,
    deviceName: 'טלפון עובד',
    requesterUserId: invitedId,
    invitationId: invitation.id,
  });
  db.prepare(`
    UPDATE worker_invitations SET status='claimed', claimed_at=CURRENT_TIMESTAMP,
      claimed_user_id=?, claimed_device_id=? WHERE id=?
  `).run(invitedId, pending.id, invitation.id);

  async function login(username, pin) {
    const response = await request('/api/auth/login', jsonRequest('POST', { username, pin }));
    assert.equal(response.status, 200);
    return { Authorization: `Bearer ${(await response.json()).access_token}` };
  }

  const adminHeaders = await login('enrollment-admin', '8801');
  const managerHeaders = await login('enrollment-manager', '8802');
  const reviewPath = `${requestsPath}/${pending.id}`;

  await t.test('only admins can list or review requests, and list filters keep pending first', async () => {
    const { row: approved } = devices.createApprovedEnrollment({
      requesterName: 'עובד מחסן',
      deviceName: 'טלפון מחסן',
    });
    const setRequestedAt = db.prepare('UPDATE device_enrollment_requests SET requested_at=? WHERE id=?');
    setRequestedAt.run('2020-01-01 00:00:00', pending.id);
    setRequestedAt.run('2020-01-02 00:00:00', approved.id);

    assert.equal((await request(requestsPath)).status, 401);
    assert.equal((await request(requestsPath, { headers: managerHeaders })).status, 403);
    assert.equal((await request(reviewPath, jsonRequest('PATCH', { status: 'approved' }, managerHeaders))).status, 403);

    const list = await request(requestsPath, { headers: adminHeaders });
    assert.equal(list.status, 200);
    const rows = await list.json();
    assert.equal(rows.at(-1).id, approved.id);
    const pendingRows = rows.slice(0, -1);
    assert.ok(pendingRows.some(row => row.id === pending.id));
    assert.ok(pendingRows.every(row => row.status === 'pending'));

    for (const [status, expected] of [['pending', pendingRows], ['approved', [rows.at(-1)]], ['revoked', []]]) {
      const response = await request(`${requestsPath}?status=${status}`, { headers: adminHeaders });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
  });

  await t.test('PATCH validates input and audits approval and revocation of the invited device', async () => {
    const review = (id, status) => request(`${requestsPath}/${id}`,
      jsonRequest('PATCH', { status }, adminHeaders));
    for (const [id, status] of [['invalid', 'approved'], [0, 'approved'], [1.5, 'approved'], [pending.id, 'pending'], [pending.id, undefined]]) {
      const response = await review(id, status);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invalid_device_review');
    }
    const unknown = await review(999_999, 'approved');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'device_request_not_found');

    const active = db.prepare('SELECT active FROM users WHERE id=?').pluck();
    const auditRows = db.prepare(`
      SELECT entity_id, entity_ref, action, field_name, old_value, new_value, user_id, user_name
      FROM audit_log WHERE entity_type='device_enrollment' ORDER BY id
    `);
    assert.deepEqual([active.get(invitedId), active.get(otherId)], [0, 0]);
    assert.deepEqual(auditRows.all(), []);

    const approved = await review(pending.id, 'approved');
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.id, pending.id);
    assert.equal(approvedBody.status, 'approved');
    assert.equal(approvedBody.approved, true);
    assert.deepEqual([active.get(invitedId), active.get(otherId)], [1, 0]);

    const revoked = await review(pending.id, 'revoked');
    assert.equal(revoked.status, 200);
    const revokedBody = await revoked.json();
    assert.equal(revokedBody.id, pending.id);
    assert.equal(revokedBody.status, 'revoked');
    assert.equal(revokedBody.approved, false);
    assert.equal(db.prepare('SELECT status FROM device_enrollment_requests WHERE id=?').pluck().get(pending.id), 'revoked');

    assert.deepEqual(auditRows.all(), [
      {
        entity_id: pending.id, entity_ref: pending.request_uid, action: 'device_review',
        field_name: 'status', old_value: 'pending', new_value: 'approved',
        user_id: adminId, user_name: adminName,
      },
      {
        entity_id: pending.id, entity_ref: pending.request_uid, action: 'device_review',
        field_name: 'status', old_value: 'approved', new_value: 'revoked',
        user_id: adminId, user_name: adminName,
      },
    ]);
  });
});
