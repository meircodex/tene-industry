'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { hashPin } = require('../auth-core');
const { ROLE_PERMISSIONS } = require('../permissions');

const readRoles = ['maintenance', 'production', 'office', 'manager', 'admin'];
const createRoles = ['maintenance', 'production', 'manager', 'admin'];
const updateRoles = ['maintenance', 'manager', 'admin'];
const roles = Object.keys(ROLE_PERMISSIONS);

test('maintenance routes enforce permissions and persist changes in SQLite', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-maintenance-http-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(folder, 'test.db');
  process.env.BACKUP_DIR = path.join(folder, 'backups');
  process.env.BCRYPT_ROUNDS = '4';

  let runtime;
  t.after(async () => {
    try {
      if (runtime) {
        await new Promise((resolve, reject) => runtime.closeServer(error => error ? reject(error) : resolve()));
      }
    } finally {
      runtime?.db.close();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
  runtime = require('../server');
  const { server, db } = runtime;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = new Map();
  const pin = '1234';
  const pinHash = hashPin(pin, 4);
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `);

  async function request(url, { role, method = 'GET', body, status = 200 } = {}) {
    const headers = {};
    if (role) headers.Authorization = `Bearer ${tokens.get(role)}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(baseUrl + url, { method, headers, body: JSON.stringify(body) });
    assert.equal(response.status, status, `${method} ${url} (${role || 'anonymous'})`);
    return response.json();
  }

  for (const role of roles) {
    const username = `maintenance-test-${role}`;
    insertUser.run(username, username, role, pinHash);
    const session = await request('/auth/login', { method: 'POST', body: { username, pin } });
    assert.ok(session.access_token, `Login token for ${role}`);
    tokens.set(role, session.access_token);
  }

  const machine = db.prepare('SELECT id, name FROM machines WHERE retired_at IS NULL ORDER BY id LIMIT 1').get();
  assert.ok(machine, 'A machine from the application catalog is required');
  const { id: machine_id } = machine;
  const description = 'בדיקת מערכת הידראולית';
  const log = db.prepare('SELECT * FROM maintenance_logs WHERE id = ?');
  const logCount = db.prepare('SELECT COUNT(*) AS count FROM maintenance_logs');
  const existingId = db.prepare(`
    INSERT INTO maintenance_logs (machine_id, description, downtime_min)
    VALUES (?, ?, 30)
  `).run(machine_id, description).lastInsertRowid;

  await t.test('GET /maintenance and /maintenance/stats allow only the five read roles', async () => {
    const results = [
      [`/maintenance?machine_id=${machine_id}`, data => {
        assert.equal(data.length, 1);
        assert.equal(data[0].id, existingId);
        assert.equal(data[0].description, description);
        assert.equal(data[0].machine_name, machine.name);
      }],
      ['/maintenance/stats', data => {
        assert.equal(data.open, 1);
        assert.equal(data.breakdowns, 1);
        assert.equal(data.avgDowntime, 30);
        assert.equal(data.byMachine.find(row => row.id === machine_id).total_down, 30);
      }],
    ];
    for (const [url, verify] of results) {
      await request(url, { status: 401 });
      for (const role of roles) {
        if (readRoles.includes(role)) verify(await request(url, { role }));
        else await request(url, { role, status: 403 });
      }
    }
  });

  await t.test('POST /maintenance permits creation roles and rejects incomplete requests', async () => {
    const method = 'POST';
    const body = { machine_id, description, log_type: 'inspection' };
    await request('/maintenance', { method, body, status: 401 });
    for (const role of roles) {
      if (createRoles.includes(role)) {
        const { id } = await request('/maintenance', { role, method, body });
        const saved = log.get(id);
        assert.equal(saved.machine_id, machine_id);
        assert.equal(saved.description, description);
      } else {
        await request('/maintenance', { role, method, body, status: 403 });
      }
    }
    const countBeforeInvalidRequests = logCount.get().count;
    for (const invalidBody of [{ description }, { machine_id }, {}, undefined]) {
      await request('/maintenance', { role: 'maintenance', method, body: invalidBody, status: 400 });
    }
    assert.equal(logCount.get().count, countBeforeInvalidRequests);
    assert.equal(countBeforeInvalidRequests, 1 + createRoles.length);
  });

  await t.test('PATCH /maintenance/:id permits update roles and rejects missing logs', async () => {
    const url = `/maintenance/${existingId}`;
    const method = 'PATCH';
    await request(url, { method, body: { downtime_min: 60 }, status: 401 });
    for (const role of roles) {
      const previousDowntime = log.get(existingId).downtime_min;
      const body = { downtime_min: previousDowntime + 1 };
      if (updateRoles.includes(role)) {
        const result = await request(url, { role, method, body });
        assert.equal(result.success, true);
        assert.equal(log.get(existingId).downtime_min, body.downtime_min);
        await request('/maintenance/-1', { role, method, body, status: 404 });
      } else {
        await request(url, { role, method, body, status: 403 });
        assert.equal(log.get(existingId).downtime_min, previousDowntime);
      }
    }
  });

  await t.test('LOTO rejects a second active lock and returns 404 for a missing release', async () => {
    const role = 'maintenance';
    const body = { machine_id, locked_by: 'אחראי תחזוקה', reason: 'תחזוקה' };
    const { id } = await request('/loto', { role, method: 'POST', body });
    await request('/loto', { role, method: 'POST', body, status: 409 });
    await request('/loto/-1/release', {
      role, method: 'PATCH', body: { released_by: body.locked_by }, status: 404,
    });
    await request('/loto/-1/release', { role, method: 'PATCH', status: 404 });
    await request(`/loto/${id}/release`, { role, method: 'PATCH', status: 400 });
    assert.deepEqual(db.prepare('SELECT id, status FROM loto WHERE machine_id = ?').all(machine_id), [
      { id, status: 'פעיל' },
    ]);
    assert.equal(db.prepare('SELECT status FROM machines WHERE id = ?').get(machine_id).status, 'נעול LOTO');
  });
});
