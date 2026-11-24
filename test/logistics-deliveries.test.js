'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-logistics-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(folder, 'test.db');
process.env.BACKUP_DIR = path.join(folder, 'backups');
process.env.BCRYPT_ROUNDS = '4';

const { db, server, closeServer } = require('../server');
const { hashPin } = require('../auth-core');
const { ROLE_PERMISSIONS } = require('../permissions');

const creationRoles = ['office', 'warehouse', 'manager', 'admin'];
const scheduledDate = '2026-11-24';
const tokens = {};
let baseUrl;
let customerId;
let driverId;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  customerId = db.prepare('INSERT INTO customers (name) VALUES (?)').run('לקוח בדיקה').lastInsertRowid;
  driverId = seedDriver('נהג בדיקה');

  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  const pin = '2749';
  const pinHash = hashPin(pin, 4);
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    const username = `logistics-${role}`;
    insertUser.run(username, username, role, pinHash, new Date().toISOString());
    const login = await request('/auth/login', { method: 'POST', body: { username, pin } });
    assert.equal(login.status, 200, `login as ${role}`);
    assert.ok(login.body.access_token, `access token for ${role}`);
    tokens[role] = login.body.access_token;
  }
});

after(async () => {
  await new Promise(resolve => closeServer(resolve));
  db.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

function seedDriver(name) {
  return db.prepare('INSERT INTO drivers (name) VALUES (?)').run(name).lastInsertRowid;
}

function seedOrder(label, status = 'ממתינה לאישור') {
  return db.prepare('INSERT INTO orders (order_num, customer_id, status) VALUES (?, ?, ?)')
    .run(`DEL-${label}`, customerId, status).lastInsertRowid;
}

function seedDelivery(label, status, { assignedDriver = driverId, date = scheduledDate } = {}) {
  const orderId = seedOrder(label, 'בתור ייצור');
  const id = db.prepare('INSERT INTO deliveries (order_id, driver_id, scheduled_date, status) VALUES (?, ?, ?, ?)')
    .run(orderId, assignedDriver, date, status).lastInsertRowid;
  return { id, orderId };
}

function delivery(id) {
  return db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
}

function orderStatus(id) {
  return db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status;
}

function alerts(orderId) {
  return db.prepare('SELECT type, level, message, order_id FROM alerts WHERE order_id = ?').all(orderId);
}

async function request(endpoint, { method = 'GET', role, body } = {}) {
  const headers = {};
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, { method, headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function action(id, name, body) {
  return request(`/deliveries/${id}/${name}`, { method: 'POST', role: 'driver', body });
}

test('POST /deliveries permits only office, warehouse, manager and admin', async () => {
  const blockedOrder = seedOrder('BLOCKED');
  const blocked = { orderId: blockedOrder, driverId, scheduledDate };
  assert.equal((await request('/deliveries', { method: 'POST', body: blocked })).status, 401);
  for (const role of Object.keys(ROLE_PERMISSIONS).filter(role => !creationRoles.includes(role))) {
    const result = await request('/deliveries', { method: 'POST', role, body: blocked });
    assert.equal(result.status, 403, role);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM deliveries WHERE order_id = ?').get(blockedOrder).count, 0);
  assert.equal(orderStatus(blockedOrder), 'ממתינה לאישור');

  for (const role of creationRoles) {
    const orderId = seedOrder(role);
    const result = await request('/deliveries', { method: 'POST', role, body: { orderId, driverId, scheduledDate } });
    assert.equal(result.status, 200, role);
    const row = delivery(result.body.id);
    assert.deepEqual([row.order_id, row.driver_id, row.scheduled_date, row.status], [orderId, driverId, scheduledDate, 'ממתין']);
    assert.equal(orderStatus(orderId), 'בתור ייצור');
  }
});

test('GET /deliveries filters by driver, date and status independently and together', async () => {
  const filterDriver = seedDriver('נהג לסינון');
  const date = '2026-12-01';
  const matching = seedDelivery('MATCH', 'מתוכנן', { assignedDriver: filterDriver, date });
  const wrongDriver = seedDelivery('OTHER-DRIVER', 'מתוכנן', { date });
  const wrongDate = seedDelivery('OTHER-DATE', 'מתוכנן', { assignedDriver: filterDriver, date: '2026-12-02' });
  const wrongStatus = seedDelivery('OTHER-STATUS', 'סופק', { assignedDriver: filterDriver, date });

  const cases = [
    [{ driverId: filterDriver }, [matching.id, wrongStatus.id, wrongDate.id]],
    [{ date }, [matching.id, wrongDriver.id, wrongStatus.id]],
    [{ status: 'מתוכנן' }, [matching.id, wrongDriver.id, wrongDate.id]],
    [{ driverId: filterDriver, date, status: 'מתוכנן' }, [matching.id]],
  ];
  for (const [filters, expected] of cases) {
    const query = new URLSearchParams(filters);
    const result = await request(`/deliveries?${query}`, { role: 'driver' });
    assert.equal(result.status, 200, query.toString());
    assert.deepEqual(result.body.map(row => row.id), expected, query.toString());
  }
});

test('depart accepts both pending statuses and rejects missing or ineligible deliveries', async () => {
  assert.equal((await action(0, 'depart')).status, 404);

  for (const status of ['יצא', 'סופק', 'בעיה', 'ביטול']) {
    const { id, orderId } = seedDelivery(`DEPART-BLOCKED-${status}`, status);
    const previous = delivery(id);
    assert.equal((await action(id, 'depart')).status, 409, status);
    assert.deepEqual(delivery(id), previous);
    assert.equal(orderStatus(orderId), 'בתור ייצור');
  }

  for (const status of ['ממתין', 'מתוכנן']) {
    const { id, orderId } = seedDelivery(`DEPART-${status}`, status);
    const result = await action(id, 'depart');
    assert.equal(result.status, 200, status);
    assert.equal(result.body.success, true);
    const departed = delivery(id);
    assert.equal(departed.status, 'יצא');
    assert.ok(Number.isFinite(Date.parse(departed.departed_at)));
    assert.equal(orderStatus(orderId), 'בדרך ללקוח');
    assert.equal((await action(id, 'depart')).status, 409);
    assert.deepEqual(delivery(id), departed);
  }
});

test('confirm requires departure and persists the delivery details once', async () => {
  const details = { notes: 'נמסר במחסן', lat: 31.78, lng: 35.22 };
  assert.equal((await action(0, 'confirm', details)).status, 404);

  for (const status of ['מתוכנן', 'בעיה', 'ביטול']) {
    const { id, orderId } = seedDelivery(`CONFIRM-BLOCKED-${status}`, status);
    const previous = delivery(id);
    assert.equal((await action(id, 'confirm', details)).status, 409, status);
    assert.deepEqual(delivery(id), previous);
    assert.equal(orderStatus(orderId), 'בתור ייצור');
  }

  const { id, orderId } = seedDelivery('CONFIRM', 'ממתין');
  const pending = delivery(id);
  assert.equal((await action(id, 'confirm', details)).status, 409);
  assert.deepEqual(delivery(id), pending);
  assert.equal(orderStatus(orderId), 'בתור ייצור');

  assert.equal((await action(id, 'depart')).status, 200);
  const result = await action(id, 'confirm', details);
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const delivered = delivery(id);
  assert.equal(delivered.status, 'סופק');
  assert.ok(Number.isFinite(Date.parse(delivered.delivered_at)));
  assert.equal(delivered.notes, details.notes);
  assert.equal(delivered.delivery_lat, details.lat);
  assert.equal(delivered.delivery_lng, details.lng);
  assert.equal(delivered.photo_url, null);
  assert.equal(orderStatus(orderId), 'סופק – אושר');

  assert.equal((await action(id, 'confirm', { notes: 'ניסיון חוזר' })).status, 409);
  assert.deepEqual(delivery(id), delivered);
});

test('confirm can record a departed delivery without optional details', async () => {
  const { id, orderId } = seedDelivery('CONFIRM-NO-DETAILS', 'ממתין');
  assert.equal((await action(id, 'confirm')).status, 409);
  assert.equal((await action(id, 'depart')).status, 200);
  const result = await action(id, 'confirm');
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(delivery(id).status, 'סופק');
  assert.equal(orderStatus(orderId), 'סופק – אושר');
});

test('problem records the issue and creates an alert unless the delivery was supplied', async () => {
  const details = { problemType: 'כתובת שגויה', problemNotes: 'הכתובת בהזמנה שונה מכתובת הפריקה' };
  assert.equal((await action(0, 'problem', details)).status, 404);

  const delivered = seedDelivery('PROBLEM-BLOCKED', 'סופק');
  const previous = delivery(delivered.id);
  assert.equal((await action(delivered.id, 'problem', details)).status, 409);
  assert.deepEqual(delivery(delivered.id), previous);
  assert.deepEqual(alerts(delivered.orderId), []);

  for (const status of ['ממתין', 'יצא']) {
    const label = `PROBLEM-${status}`;
    const { id, orderId } = seedDelivery(label, status);
    assert.deepEqual(alerts(orderId), []);
    const result = await action(id, 'problem', details);
    assert.equal(result.status, 200, status);
    assert.equal(result.body.success, true);
    const row = delivery(id);
    assert.equal(row.status, 'בעיה');
    assert.equal(row.problem_type, details.problemType);
    assert.equal(row.problem_notes, details.problemNotes);
    assert.deepEqual(alerts(orderId), [{
      type: 'delivery_problem',
      level: 'danger',
      message: `בעיה באספקה DEL-${label}: ${details.problemType}`,
      order_id: orderId,
    }]);
  }
});
