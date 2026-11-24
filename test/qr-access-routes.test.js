'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-qr-access-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'qr-access.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.ALLOW_UNINVITED_DEVICE_ENROLLMENT = 'true';

const { closeServer, db, server } = require('../server');
const { hashPin } = require('../auth-core');

const modePath = '/api/qr-access/mode';
const scanPath = '/api/qr-access/scan';
const activityPath = '/api/qr-access/activity';
const openMode = { mode: 'open', open: true, secure: false };
const secureMode = { mode: 'secure', open: false, secure: true };

let baseUrl;
let adminId;
let adminToken;
let managerToken;

function seedUser(username, displayName, role, pin) {
  return db.prepare(`
    INSERT INTO users (username, display_name, role, pin, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(username, displayName, role, pin, hashPin(pin, 4), new Date().toISOString()).lastInsertRowid;
}

function request(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
  if (body !== undefined) headers = { ...headers, 'Content-Type': 'application/json' };
  return fetch(`${baseUrl}${pathname}`, { method, headers, body: JSON.stringify(body) });
}

async function login(username, pin) {
  const response = await request('/api/auth/login', { method: 'POST', body: { username, pin } });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

async function routeBody(response) {
  const { _requestId, _ts, ...body } = await response.json();
  return body;
}

test.before(async () => {
  adminId = seedUser('qr-admin', 'מנהל מערכת', 'admin', '8901');
  seedUser('qr-manager', 'מנהל תפעול', 'manager', '8902');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login('qr-admin', '8901');
  managerToken = await login('qr-manager', '8902');
});

test.after(async () => {
  await new Promise(resolve => closeServer(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = 'QR_ACCESS_MODE'").run();
  db.prepare("DELETE FROM audit_log WHERE entity_type = 'qr_access'").run();
  db.prepare('DELETE FROM qr_scan_activity').run();
});

test('public mode reads use no-store and reflect the current mode', async () => {
  const initial = await request(modePath);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await routeBody(initial), openMode);

  const patch = await request(modePath, { method: 'PATCH', token: adminToken, body: { mode: 'secure' } });
  assert.equal(patch.status, 200);

  const current = await request(modePath);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await routeBody(current), secureMode);
});

test('only an admin can change the mode and only valid changes are audited', async () => {
  const body = { mode: 'secure' };
  assert.equal((await request(modePath, { method: 'PATCH', body })).status, 401);
  assert.equal((await request(modePath, { method: 'PATCH', token: managerToken, body })).status, 403);
  assert.deepEqual(await routeBody(await request(modePath)), openMode);

  const change = await request(modePath, { method: 'PATCH', token: adminToken, body });
  assert.equal(change.status, 200);
  assert.deepEqual(await routeBody(change), secureMode);

  for (const mode of [undefined, 'disabled', ['open']]) {
    const invalid = await request(modePath, { method: 'PATCH', token: adminToken, body: { mode } });
    assert.equal(invalid.status, 400, JSON.stringify({ mode }));
    assert.equal((await invalid.json()).error, 'invalid_qr_access_mode');
  }

  assert.deepEqual(await routeBody(await request(modePath)), secureMode);
  const audit = db.prepare(`
    SELECT entity_ref, action, field_name, old_value, new_value, user_id, user_name
    FROM audit_log WHERE entity_type = 'qr_access' ORDER BY id
  `).all();
  assert.deepEqual(audit, [{
    entity_ref: 'QR_ACCESS_MODE',
    action: 'update',
    field_name: 'mode',
    old_value: 'open',
    new_value: 'secure',
    user_id: adminId,
    user_name: 'מנהל מערכת',
  }]);
});

test('scan rejects invalid kinds, values, and order IDs without creating activity', async () => {
  const invalidScans = [
    { kind: 'package', value: 'TENE-ORDER-1' },
    { kind: ['card'], value: 'ORDER-000001' },
    { kind: 'card', value: '   ' },
    { kind: 'card', value: 'א'.repeat(513) },
    { kind: 'card', value: { code: 'ORDER-000001' } },
    { kind: 'card', value: '\uD800' },
    ...[undefined, null, 0, -1, 1.5, 'abc', true, [1], '0x1', Number.MAX_SAFE_INTEGER + 1]
      .map(order_id => ({ kind: 'order', value: 'TENE-ORDER-1', order_id })),
  ];
  for (const [index, body] of invalidScans.entries()) {
    const response = await request(scanPath, { method: 'POST', body });
    assert.equal(response.status, 400, `Invalid scan case ${index + 1}`);
    assert.equal((await response.json()).error, 'invalid_qr_scan');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM qr_scan_activity').get().count, 0);
});

test('secure mode denies and logs scans from unregistered and pending devices', async () => {
  const patch = await request(modePath, { method: 'PATCH', token: adminToken, body: { mode: 'secure' } });
  assert.equal(patch.status, 200);

  const registration = await request('/api/device-enrollment/requests', {
    method: 'POST',
    body: { requester_name: 'עובד ייצור', device_name: 'טלפון מחלקת ייצור', platform: 'Android' },
  });
  assert.equal(registration.status, 201);
  const device = await registration.json();
  assert.equal(device.status, 'pending');

  const value = 'ORDER-000001';
  for (const [deviceStatus, headers] of [
    ['unregistered', {}],
    ['pending', { 'X-IronBend-Device': device.credential }],
  ]) {
    const response = await request(scanPath, {
      method: 'POST',
      headers,
      body: { kind: 'card', value, scanner_id: deviceStatus },
    });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.error, 'device_activation_required');
    assert.equal(result.mode, 'secure');
    assert.equal(result.device_status, deviceStatus);
    assert.equal(result.target, undefined);
  }

  const activity = db.prepare(`
    SELECT access_mode, permission, qr_kind, qr_value, action, outcome, device_enrollment_id, scanner_id
    FROM qr_scan_activity ORDER BY id
  `).all();
  const deniedScan = {
    access_mode: 'secure',
    permission: 'production',
    qr_kind: 'card',
    qr_value: value,
    action: 'open',
    outcome: 'device_activation_required',
  };
  assert.deepEqual(activity, [
    { ...deniedScan, device_enrollment_id: null, scanner_id: 'unregistered' },
    { ...deniedScan, device_enrollment_id: device.id, scanner_id: 'pending' },
  ]);
});

test('open mode returns encoded warehouse order and production card targets', async () => {
  const customerId = db.prepare('INSERT INTO customers (name) VALUES (?)').run('לקוח בדיקה').lastInsertRowid;
  const orderId = db.prepare('INSERT INTO orders (order_num, customer_id, channel, status) VALUES (?, ?, ?, ?)')
    .run('QR-000001', customerId, 'משרד', 'הושלם – ממתין לאיסוף').lastInsertRowid;

  for (const order_id of [orderId, `00${orderId}`]) {
    const order = await request(scanPath, {
      method: 'POST',
      body: { kind: 'order', value: `TENE-ORDER-${orderId}`, order_id },
    });
    assert.equal(order.status, 200);
    assert.deepEqual(await routeBody(order), {
      allowed: true,
      mode: 'open',
      target: `/warehouse.html?load_order=${orderId}&autostart=1&source=in_app_scan`,
    });
  }

  const card = await request(scanPath, {
    method: 'POST',
    body: { kind: 'card', value: 'א &+#/%-000001' },
  });
  assert.equal(card.status, 200);
  assert.deepEqual(await routeBody(card), {
    allowed: true,
    mode: 'open',
    target: '/worker-visual.html?scan=1&card=%D7%90%20%26%2B%23%2F%25-000001&source=in_app_scan',
  });
});

test('only an admin can read recorded scan activity', async () => {
  const response = await request(scanPath, {
    method: 'POST',
    body: { kind: 'card', value: 'ORDER-000001', scanner_id: 'qr-activity-test' },
  });
  assert.equal(response.status, 200);

  assert.equal((await request(activityPath)).status, 401);
  assert.equal((await request(activityPath, { token: managerToken })).status, 403);

  const activity = await request(activityPath, { token: adminToken });
  assert.equal(activity.status, 200);
  const rows = await activity.json();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.access_mode, 'open');
  assert.equal(row.permission, 'production');
  assert.equal(row.qr_kind, 'card');
  assert.equal(row.qr_value, 'ORDER-000001');
  assert.equal(row.action, 'open_worker_card');
  assert.equal(row.outcome, 'allowed');
  assert.equal(row.scanner_id, 'qr-activity-test');
});
