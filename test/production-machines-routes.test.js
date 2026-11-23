'use strict';

const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { hashPin } = require('../auth-core');
const { names: [mep, machineSeven, machineSix] } = require('../db/approvedMachineCatalog.json');
const { ROLE_PERMISSIONS } = require('../permissions');

test('נתיבי מכונות ייצור', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-production-machines-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.BACKUP_DIR = path.join(directory, 'backups');
  process.env.MACHINE_WRITES_ENABLED = 'false';

  const { server, db, closeServer } = require('../server');
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const modbus = require('../modbus').getInstance();
  const writeParams = t.mock.method(modbus, 'writeParams', async () => {});
  const reconfigMachine = t.mock.method(modbus, 'reconfigMachine', async () => {});
  t.mock.method(modbus, 'getAllState', () => []);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  const users = new Map();

  function request(method, url, role, body) {
    const headers = {};
    if (role) headers.Authorization = 'Bearer ' + users.get(role).token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(base + url, { method, headers, body: JSON.stringify(body) });
  }

  async function expectResponse(method, url, role, status, body) {
    const response = await request(method, url, role, body);
    assert.equal(response.status, status, [method, url, role ?? 'ללא התחברות'].join(' '));
    const data = await response.json();
    if (Array.isArray(data)) return data;
    const { _requestId, _ts, ...payload } = data;
    return payload;
  }

  const insertUser = db.prepare(
    'INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at) VALUES (?, ?, ?, ?, 1, ?)'
  );
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    const username = 'machines-test-' + role;
    const displayName = role === 'maintenance' ? 'אחראי תחזוקה' : username;
    const pin = String(randomInt(1000, 10000));
    const { lastInsertRowid: id } = insertUser.run(username, displayName, role, hashPin(pin, 4), new Date().toISOString());
    const auth = await expectResponse('POST', '/auth/login', null, 200, { username, pin });
    assert.ok(auth.access_token);
    users.set(role, { id, displayName, token: auth.access_token });
  }

  const insertMachine = db.prepare("INSERT INTO machines (name, label, conn_mode) VALUES (?, ?, 'disabled')");
  const machineId = insertMachine.run(mep, mep).lastInsertRowid;
  const otherMachineId = insertMachine.run(machineSeven, machineSeven).lastInsertRowid;
  const machineUrl = '/machines/' + machineId;
  const machine = () => db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId);

  await t.test('הרשאות לכל נתיב', async () => {
    const stateRoles = ['production', 'maintenance', 'manager', 'admin'];
    const stationRoles = ['production', 'kiosk', 'manager', 'admin'];
    const configRoles = ['manager', 'admin'];
    const routes = [
      ['GET', '/machines', [...stateRoles, 'kiosk', 'office'], 200],
      ['POST', '/machines', ['manager'], 400, {}],
      ['DELETE', '/machines/0', ['manager'], 404],
      ['POST', machineUrl + '/send-params', stationRoles, 200, {}],
      ['POST', machineUrl + '/assign', ['production', ...configRoles], 404, { itemId: 0 }],
      ['PATCH', machineUrl + '/config', configRoles, 400, { conn_mode: 'http' }],
      ['POST', machineUrl + '/complete', stationRoles, 400, { producedQty: 10 }],
      ['PATCH', machineUrl + '/state', stateRoles, 400, {}],
      ['GET', machineUrl + '/state-log', stateRoles, 200],
    ];

    const before = machine();
    for (const [method, url, roles, allowedStatus, body] of routes) {
      await expectResponse(method, url, null, 401, body);
      for (const role of users.keys()) {
        await expectResponse(method, url, role, roles.includes(role) ? allowedStatus : 403, body);
      }
    }
    assert.equal(writeParams.mock.callCount(), stationRoles.length);
    assert.equal(reconfigMachine.mock.callCount(), 0);
    assert.deepEqual(machine(), before);
  });

  await t.test('רק מנהל יכול להוסיף ולמחוק מכונה', async () => {
    const { error } = await expectResponse('POST', '/machines', 'manager', 400, { name: '  ' });
    assert.equal(error, 'שם מכונה נדרש');

    const body = { name: ' ' + machineSix + ' ', conn_mode: 'disabled' };
    const inserted = await expectResponse('POST', '/machines', 'manager', 200, body);
    assert.equal(inserted.success, true);
    const find = db.prepare('SELECT name, label, conn_mode FROM machines WHERE id = ?');
    assert.deepEqual(find.get(inserted.id), { name: machineSix, label: machineSix, conn_mode: 'disabled' });

    const url = '/machines/' + inserted.id;
    await expectResponse('DELETE', url, 'admin', 403);
    assert.ok(find.get(inserted.id));
    assert.deepEqual(await expectResponse('DELETE', url, 'manager', 200), { success: true });
    assert.equal(find.get(inserted.id), undefined);
  });

  await t.test('שליחת פרמטרים מחזירה את תוצאת Modbus', async () => {
    writeParams.mock.resetCalls();
    const url = machineUrl + '/send-params';
    const parameters = { diameter: 12, totalLengthMm: 1000, productionQty: 10 };
    assert.deepEqual(await expectResponse('POST', url, 'production', 200, parameters), { success: true });
    assert.deepEqual(writeParams.mock.calls[0].arguments, [machineId, { ...parameters, angles: [] }]);

    const bent = { ...parameters, angles: [90, 135] };
    const message = 'המכונה אינה מחוברת';
    writeParams.mock.mockImplementationOnce(async () => { throw new Error(message); });
    assert.equal((await expectResponse('POST', url, 'kiosk', 500, bent)).error, message);
    assert.deepEqual(writeParams.mock.calls[1].arguments, [machineId, bent]);
    assert.equal(writeParams.mock.callCount(), 2);
  });

  await t.test('הגדרות חיבור לא תקינות נדחות לפני שמירה וחיבור מחדש', async () => {
    const url = machineUrl + '/config';
    const before = machine();
    for (const body of [
      { conn_mode: 'http' },
      { conn_mode: 'tcp', tcp_port: -1 },
      { conn_mode: 'tcp', tcp_port: 65536 },
      { conn_mode: 'tcp', tcp_port: 502.5 },
      { conn_mode: 'tcp', tcp_port: true },
    ]) {
      const result = await expectResponse('PATCH', url, 'manager', 400, body);
      assert.ok(result.error);
      assert.deepEqual(machine(), before);
    }
    assert.equal(reconfigMachine.mock.callCount(), 0);

    await expectResponse('PATCH', url, 'manager', 200, { conn_mode: 'tcp', can_3d: true });
    assert.equal(machine().tcp_port, 502);
    assert.equal(machine().can_3d, 1);
    await expectResponse('PATCH', url, 'manager', 200, { conn_mode: 'rtu', rtu_port: 'COM3', can_3d: false });
    assert.equal(machine().conn_mode, 'rtu');
    assert.equal(machine().tcp_port, null);
    assert.equal(machine().rtu_port, 'COM3');
    assert.equal(machine().can_3d, 0);
    await expectResponse('PATCH', url, 'manager', 200, { conn_mode: 'disabled' });
    assert.equal(machine().conn_mode, 'disabled');
    assert.equal(machine().rtu_port, null);
    assert.deepEqual(reconfigMachine.mock.calls.map(call => call.arguments), [[String(machineId)], [String(machineId)], [String(machineId)]]);
  });

  await t.test('שיוך פריט מותנה בשחרור ההזמנה לייצור ומאפשר דיווח השלמה', async () => {
    const { lastInsertRowid: orderId } = db.prepare(
      'INSERT INTO orders (order_num, status) VALUES (?, ?)'
    ).run('MACHINES-TEST', 'ממתינה לאישור');
    const { lastInsertRowid: palletId } = db.prepare(
      'INSERT INTO pallets (order_id, pallet_num) VALUES (?, 1)'
    ).run(orderId);
    const { lastInsertRowid: itemId } = db.prepare(`
      INSERT INTO items (pallet_id, order_id, shape_name, diameter, quantity, production_qty, total_length_mm, total_weight, segments, status)
      VALUES (?, ?, 'straight', 12, 10, 12, 1000, 8.88, '[]', 'ממתין')
    `).run(palletId, orderId);
    const getItem = () => db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    const assignUrl = machineUrl + '/assign';
    const completeUrl = machineUrl + '/complete';

    const noItem = await expectResponse('POST', completeUrl, 'kiosk', 400, { producedQty: 12 });
    assert.equal(noItem.error, 'אין פריט פעיל');
    const pending = await expectResponse('POST', assignUrl, 'production', 409, { itemId });
    assert.equal(pending.error, 'item_not_released_to_production');
    assert.equal(machine().current_item_id, null);
    assert.equal(getItem().started_at, null);

    db.prepare("UPDATE orders SET status = 'בתור ייצור' WHERE id = ?").run(orderId);
    assert.deepEqual(await expectResponse('POST', assignUrl, 'production', 200, { itemId }), { success: true });
    assert.equal(machine().current_item_id, itemId);
    assert.equal(machine().current_order_num, 'MACHINES-TEST');
    assert.equal(getItem().machine_id, machineId);
    assert.equal(getItem().status, 'בייצור');
    assert.ok(getItem().started_at);

    db.prepare('UPDATE machines SET counter = 12 WHERE id = ?').run(machineId);
    const completed = await expectResponse('POST', completeUrl, 'kiosk', 200, { producedQty: 12 });
    assert.equal(completed.success, true);
    assert.equal(completed.actualWaste, 2);
    assert.equal(completed.consumedReservations.consumed, 0);
    const item = getItem();
    assert.equal(item.status, 'הושלם');
    assert.ok(item.completed_at);
    assert.equal(item.produced_qty, 12);
    assert.equal(item.actual_waste, 2);
    assert.equal(machine().current_item_id, null);
    assert.equal(machine().current_order_num, null);
    assert.equal(machine().counter, 0);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'הושלם – ממתין לאיסוף');
    await expectResponse('POST', completeUrl, 'kiosk', 400, { producedQty: 12 });
    assert.deepEqual(getItem(), item);
  });

  await t.test('מעברי מצב חוקיים נרשמים ביומן ומעברים אסורים לא משנים מצב', async () => {
    const url = machineUrl + '/state';
    const logUrl = machineUrl + '/state-log';
    const operator = users.get('maintenance');
    const change = (state, status, reason) =>
      expectResponse('PATCH', url, 'maintenance', status, { state, reason, operator_id: operator.id });

    const invalid = await change('בייצור', 400);
    assert.match(invalid.error, /^מצב לא תקין/);
    const skipped = await change('ריצה', 409);
    assert.equal(skipped.current, 'לא מחובר');
    assert.deepEqual(skipped.allowed, ['סרק']);
    assert.equal(machine().status, 'לא מחובר');
    assert.deepEqual(await expectResponse('GET', logUrl, 'production', 200), []);

    assert.deepEqual(await change('סרק', 200), { ok: true, from: 'לא מחובר', to: 'סרק' });
    const { lastInsertRowid: lockId } = db.prepare(
      'INSERT INTO loto (machine_id, locked_by) VALUES (?, ?)'
    ).run(machineId, operator.displayName);
    const locked = await change('ריצה', 409);
    assert.equal(locked.loto_id, lockId);
    assert.equal(machine().status, 'סרק');
    db.prepare("UPDATE loto SET status = 'שוחרר' WHERE id = ?").run(lockId);

    await change('ריצה', 200);
    const reason = 'תקלה בחיישן';
    await change('תקלה', 200, reason);
    assert.equal(machine().status, 'תקלה');
    assert.deepEqual(db.prepare('SELECT event_type FROM production_events WHERE machine_id = ? ORDER BY id').all(machineId), [
      { event_type: 'MachineStarted' },
      { event_type: 'MachineStopped' },
    ]);
    const alert = db.prepare('SELECT type, level, message FROM alerts WHERE machine_id = ?').get(machineId);
    assert.deepEqual(alert, { type: 'machine_fault', level: 'critical', message: 'מכונה ' + mep + ' עברה לתקלה: ' + reason });

    await expectResponse('PATCH', '/machines/' + otherMachineId + '/state', 'maintenance', 200, { state: 'סרק' });
    // חותמות הזמן ב-SQLite נרשמות ברמת שנייה. קובעים תיקו כדי לבדוק את סדר היומן.
    db.prepare("UPDATE machine_state_log SET created_at = '2026-11-15 06:00:00' WHERE machine_id = ?").run(machineId);
    const log = await expectResponse('GET', logUrl, 'production', 200);
    assert.ok(log.every(row => row.machine_id === machineId && row.operator_id === operator.id && row.operator_name === operator.displayName));
    assert.deepEqual(log.map(row => [row.from_state, row.to_state, row.reason]), [
      ['ריצה', 'תקלה', reason],
      ['סרק', 'ריצה', null],
      ['לא מחובר', 'סרק', null],
    ]);
  });
});
