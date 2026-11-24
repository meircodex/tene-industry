'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { hashPin } = require('../auth-core');
const { ROLE_PERMISSIONS } = require('../permissions');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-production-shifts-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(folder, 'test.db');
process.env.BACKUP_DIR = path.join(folder, 'backups');
process.env.TZ = 'Asia/Jerusalem';

const { server, db, closeServer } = require('../server');
const shiftReadRoles = ['production', 'kiosk', 'office', 'manager', 'admin'];
const shiftWriteRoles = ['production', 'kiosk', 'manager', 'admin'];
const users = {};
let baseUrl;

function request(endpoint, role, method = 'GET', body) {
  const headers = {};
  if (role) headers.Authorization = `Bearer ${users[role].token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${endpoint}`, { method, headers, body: JSON.stringify(body) });
}

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const pin = '2468';
  const pinHash = hashPin(pin, 4);
  const insertUser = db.prepare(`INSERT INTO users (username, display_name, role, pin_hash, active)
    VALUES (?, ?, ?, ?, 1)`);
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    const username = `shift-test-${role}`;
    const displayName = `משתמש בדיקה ${role}`;
    const { lastInsertRowid: id } = insertUser.run(username, displayName, role, pinHash);
    const response = await request('/auth/login', null, 'POST', { username, pin });
    assert.equal(response.status, 200, `login for ${role}`);
    const { access_token: token } = await response.json();
    assert.ok(token, `access token for ${role}`);
    users[role] = { id, displayName, token };
  }
});

after(async () => {
  try {
    await new Promise((resolve, reject) => closeServer(error => error ? reject(error) : resolve()));
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('GET /shifts is restricted to the shift read roles', async () => {
  assert.equal((await request('/shifts')).status, 401);
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    const response = await request('/shifts', role);
    assert.equal(response.status, shiftReadRoles.includes(role) ? 200 : 403, role);
    await response.json();
  }
});

test('POST /shifts and PATCH /shifts/:id/end require a shift write role', async () => {
  const machine = db.prepare('SELECT id, name FROM machines ORDER BY id LIMIT 1').get();
  const operator = users.production;
  const shift = { date: '2026-11-19', machine_id: machine.id, operator_id: operator.id, notes: 'משמרת בוקר' };
  const end = { total_pieces: 0, total_weight: 124.5 };

  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    if (shiftWriteRoles.includes(role)) continue;
    assert.equal((await request('/shifts', role, 'POST', shift)).status, 403, role);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shifts WHERE machine_id=? AND date=?')
    .get(machine.id, shift.date).count, 0);

  const createdIds = [];
  for (const role of shiftWriteRoles) {
    const created = await request('/shifts', role, 'POST', shift);
    assert.equal(created.status, 200, role);
    const { id: shiftId } = await created.json();
    createdIds.push(shiftId);
    const ended = await request(`/shifts/${shiftId}/end`, role, 'PATCH', end);
    assert.equal(ended.status, 200, role);
    assert.equal((await ended.json()).ok, true);
  }

  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    if (shiftWriteRoles.includes(role)) continue;
    const response = await request(`/shifts/${createdIds[0]}/end`, role, 'PATCH', { total_pieces: 99 });
    assert.equal(response.status, 403, role);
  }

  const result = await request(`/shifts?date=${shift.date}&machine_id=${machine.id}`, 'office');
  assert.equal(result.status, 200);
  const shifts = await result.json();
  assert.deepEqual(shifts.map(row => row.id).sort((a, b) => a - b), createdIds);
  for (const row of shifts) {
    assert.ok(row.ended_at);
    assert.equal(row.shift_type, 'morning');
    assert.equal(row.total_pieces, end.total_pieces);
    assert.equal(row.total_weight, end.total_weight);
    assert.equal(row.notes, shift.notes);
    assert.equal(row.machine_name, machine.name);
    assert.equal(row.operator_name, operator.displayName);
  }
});

test('PATCH /shifts/:id/end returns 404 for a missing shift', async () => {
  const { id } = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM shifts').get();
  for (const body of [{}, undefined]) {
    const response = await request(`/shifts/${id}/end`, 'production', 'PATCH', body);
    assert.equal(response.status, 404);
    assert.ok((await response.json()).error);
  }
});

test('GET /machine-stops filters by machine, shift and active status', async () => {
  const [machine, otherMachine] = db.prepare('SELECT id FROM machines ORDER BY id LIMIT 2').all();
  const insertShift = db.prepare('INSERT INTO shifts (date, machine_id) VALUES (?, ?)');
  const { lastInsertRowid: shiftId } = insertShift.run('2026-11-20', machine.id);
  const { lastInsertRowid: otherShiftId } = insertShift.run('2026-11-21', machine.id);
  const insertStop = db.prepare(`INSERT INTO machine_stops (machine_id, shift_id, reason_code, started_at, ended_at)
    VALUES (?, ?, 'SETUP', ?, ?)`);
  const active = insertStop.run(machine.id, shiftId, '2026-11-20 08:00:00', null).lastInsertRowid;
  const ended = insertStop.run(machine.id, shiftId, '2026-11-20 07:00:00', '2026-11-20 07:15:00').lastInsertRowid;
  const otherShift = insertStop.run(machine.id, otherShiftId, '2026-11-21 06:00:00', null).lastInsertRowid;
  const otherMachineStop = insertStop.run(otherMachine.id, null, '2026-11-20 09:00:00', null).lastInsertRowid;

  for (const [query, expected] of [
    [`machine_id=${machine.id}`, [otherShift, active, ended]],
    [`shift_id=${shiftId}`, [active, ended]],
    ['active=1', [otherShift, otherMachineStop, active]],
    [`machine_id=${machine.id}&shift_id=${shiftId}&active=1`, [active]],
    [`machine_id=${otherMachine.id}&shift_id=${shiftId}&active=1`, []],
  ]) {
    const response = await request(`/machine-stops?${query}`, 'maintenance');
    assert.equal(response.status, 200, query);
    assert.deepEqual((await response.json()).map(row => row.id), expected, query);
  }
});

test('POST /machine-stops records a stop and PATCH /machine-stops/:id/end records its duration', async () => {
  const { id: machineId } = db.prepare('SELECT id FROM machines ORDER BY id LIMIT 1').get();
  const { lastInsertRowid: shiftId } = db.prepare('INSERT INTO shifts (date, machine_id) VALUES (?, ?)')
    .run('2026-11-22', machineId);
  const reporter = users.production;
  const reason = db.prepare("SELECT code, label, color FROM downtime_reasons WHERE code='BREAKDOWN'").get();
  const body = { machine_id: machineId, shift_id: shiftId, reason_code: reason.code, notes: 'בדיקת תקלה', reported_by: reporter.id };
  const created = await request('/machine-stops', 'production', 'POST', body);
  assert.equal(created.status, 200);
  const { id } = await created.json();

  const list = await request(`/machine-stops?shift_id=${shiftId}&active=1`, 'production');
  assert.equal(list.status, 200);
  const [stop] = await list.json();
  assert.equal(stop.id, id);
  for (const [field, value] of Object.entries(body)) assert.equal(stop[field], value, field);
  assert.equal(stop.reason_label, reason.label);
  assert.equal(stop.reason_color, reason.color);
  assert.equal(stop.reported_by_name, reporter.displayName);
  const event = db.prepare("SELECT * FROM production_events WHERE event_type='MachineStopped' AND machine_id=?").get(machineId);
  assert.equal(event.operator_id, reporter.id);
  assert.deepEqual(JSON.parse(event.payload), { reason_code: body.reason_code, notes: body.notes });

  db.prepare("UPDATE machine_stops SET started_at=datetime('now', '-17 minutes', '-45 seconds') WHERE id=?").run(id);
  const ended = await request(`/machine-stops/${id}/end`, 'maintenance', 'PATCH');
  assert.equal(ended.status, 200);
  const endedStop = db.prepare('SELECT started_at, ended_at, duration_min FROM machine_stops WHERE id=?').get(id);
  assert.ok(endedStop.ended_at);
  const asUtc = timestamp => Date.parse(`${timestamp.replace(' ', 'T')}Z`);
  const expectedDuration = Math.round((asUtc(endedStop.ended_at) - asUtc(endedStop.started_at)) / 60000);
  const { ok, duration_min } = await ended.json();
  assert.equal(ok, true);
  assert.equal(duration_min, expectedDuration);
  assert.equal(endedStop.duration_min, expectedDuration);
  const active = await request(`/machine-stops?shift_id=${shiftId}&active=1`, 'production');
  assert.deepEqual(await active.json(), []);
});

test('PATCH /machine-stops/:id/end returns 404 for a missing stop', async () => {
  const { id } = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM machine_stops').get();
  const response = await request(`/machine-stops/${id}/end`, 'maintenance', 'PATCH');
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});
