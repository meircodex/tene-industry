'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createRoles = [
  'office', 'production', 'kiosk', 'maintenance', 'quality', 'manager', 'admin',
];
const readOnlyRoles = [
  'viewer', 'finance', 'production_planner', 'warehouse', 'driver', 'sales',
];
const message = 'נדרשת בדיקת מכונה';

test('alerts routes use the configured role permissions and persist changes in SQLite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-alerts-'));
  process.env.NODE_ENV = 'test';
  process.env.BCRYPT_ROUNDS = '4';
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

  const { server, db, closeServer } = require('../server');
  const { hashPin } = require('../auth-core');

  t.after(async () => {
    await new Promise((resolve, reject) => {
      closeServer((error) => error ? reject(error) : resolve());
    });
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = new Map();

  function request(method, pathname, role, body) {
    const headers = {};
    if (role) headers.Authorization = `Bearer ${tokens.get(role)}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${pathname}`, { method, headers, body: JSON.stringify(body) });
  }

  const seedUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  const roles = [...readOnlyRoles, ...createRoles];
  const pin = '1234';
  for (const role of roles) {
    const username = `alerts-${role}`;
    seedUser.run(username, username, role, hashPin(pin, 4), new Date().toISOString());
    const response = await request('POST', '/auth/login', null, { username, pin });
    assert.equal(response.status, 200, `login as ${role}`);
    tokens.set(role, (await response.json()).access_token);
  }

  const seedAlert = db.prepare(`
    INSERT INTO alerts (type, message, resolved, created_at) VALUES ('system', ?, ?, ?)
  `);
  const findAlert = db.prepare('SELECT type, level, message, resolved FROM alerts WHERE id = ?');
  const countAlerts = db.prepare('SELECT COUNT(*) AS count FROM alerts');

  await t.test('GET /alerts lists unresolved alerts for viewer and above', async () => {
    const older = seedAlert.run(message, 0, '2026-01-01 09:00:00').lastInsertRowid;
    const newer = seedAlert.run(message, 0, '2026-01-01 10:00:00').lastInsertRowid;
    seedAlert.run(message, 1, '2026-01-01 11:00:00');

    assert.equal((await request('GET', '/alerts')).status, 401);
    for (const role of roles) {
      const response = await request('GET', '/alerts', role);
      assert.equal(response.status, 200, role);
      const alerts = await response.json();
      assert.deepEqual(alerts.map(({ id }) => id), [newer, older], role);
    }
  });

  await t.test('POST /alerts stores alerts only for the allowed roles', async () => {
    const countBefore = countAlerts.get().count;
    assert.equal((await request('POST', '/alerts', null, { message })).status, 401);
    for (const role of readOnlyRoles) {
      assert.equal((await request('POST', '/alerts', role, { message })).status, 403, role);
    }
    assert.equal(countAlerts.get().count, countBefore);

    for (const role of createRoles) {
      const response = await request('POST', '/alerts', role, { message });
      assert.equal(response.status, 200, role);
      const { id } = await response.json();
      assert.deepEqual(findAlert.get(id), { type: 'system', level: 'warning', message, resolved: 0 }, role);
    }
    assert.equal(countAlerts.get().count, countBefore + createRoles.length);
  });

  await t.test('POST /alerts requires a message', async () => {
    const countBefore = countAlerts.get().count;
    for (const body of [{}, { message: '' }, undefined]) {
      const response = await request('POST', '/alerts', 'office', body);
      assert.equal(response.status, 400);
    }
    assert.equal(countAlerts.get().count, countBefore);
  });

  await t.test('PATCH /alerts/:id/resolve excludes kiosk and read-only roles', async () => {
    const id = seedAlert.run(message, 0, '2026-01-02 09:00:00').lastInsertRowid;
    const pathname = `/alerts/${id}/resolve`;
    assert.equal((await request('PATCH', pathname)).status, 401);
    for (const role of [...readOnlyRoles, 'kiosk']) {
      assert.equal((await request('PATCH', pathname, role)).status, 403, role);
    }
    assert.equal(findAlert.get(id).resolved, 0);

    for (const role of createRoles.filter((role) => role !== 'kiosk')) {
      const id = seedAlert.run(message, 0, '2026-01-02 10:00:00').lastInsertRowid;
      const response = await request('PATCH', `/alerts/${id}/resolve`, role);
      assert.equal(response.status, 200, role);
      assert.equal((await response.json()).success, true, role);
      assert.equal(findAlert.get(id).resolved, 1, role);
    }
  });

  await t.test('PATCH /alerts/:id/resolve returns 404 when the alert does not exist', async () => {
    const { id } = db.prepare('SELECT MAX(id) + 1 AS id FROM alerts').get();
    const response = await request('PATCH', `/alerts/${id}/resolve`, 'office');
    assert.equal(response.status, 404);
  });
});
