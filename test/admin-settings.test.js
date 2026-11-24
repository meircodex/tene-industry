'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-admin-settings-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomUUID();
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.OPENAI_API_KEY_LOCAL = 'openai-env-fixture';
process.env.GOOGLE_VISION_API_KEY = '';

const { closeServer, db, server } = require('../server');
const { hashPin } = require('../auth-core');

const mask = '••••••••';
const secretKeys = [
  'WHATSAPP_TOKEN', 'WHATSAPP_VERIFY_TOKEN', 'EMAIL_IMAP_PASS', 'PRIORITY_PASS',
  'MAVEN_API_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_VISION_API_KEY',
];

test('admin integration settings over HTTP', async (t) => {
  const seedUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  seedUser.run('settings-admin', 'מנהל מערכת', 'admin', hashPin('4201', 4), new Date().toISOString());
  seedUser.run('settings-manager', 'מנהל', 'manager', hashPin('4202', 4), new Date().toISOString());

  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function login(username, pin) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).access_token;
  }

  function settings(token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${baseUrl}/api/settings`, {
      headers,
      method: body === undefined ? 'GET' : 'POST',
      body: JSON.stringify(body),
    });
  }

  const admin = await login('settings-admin', '4201');
  const manager = await login('settings-manager', '4202');
  const seed = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  const read = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?');
  const updatedAt = '2020-01-01 00:00:00';
  for (const key of secretKeys) {
    if (key !== 'OPENAI_API_KEY') {
      seed.run(key, key === 'GOOGLE_VISION_API_KEY' ? '' : `fixture-${key}`, updatedAt);
    }
  }
  seed.run('MODULE_OCR', 'false', updatedAt);

  await t.test('GET and POST require an admin', async () => {
    assert.equal((await settings(null)).status, 401);
    assert.equal((await settings(manager)).status, 403);
    assert.equal((await settings(admin)).status, 200);
    assert.equal((await settings(null, { MODULE_OCR: 'true' })).status, 401);
    assert.equal((await settings(manager, { MODULE_OCR: 'true' })).status, 403);
    assert.equal(read.get('MODULE_OCR').value, 'false');
  });

  await t.test('GET masks configured database and environment secrets and leaves empty secrets blank', async () => {
    const response = await settings(admin);
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const key of secretKeys) {
      assert.equal(body[key], key === 'GOOGLE_VISION_API_KEY' ? '' : mask, key);
    }
    assert.equal(body.MODULE_OCR, 'false');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('fixture-GOOGLE_VISION_API_KEY', 'GOOGLE_VISION_API_KEY');
    const configured = await settings(admin);
    assert.equal((await configured.json()).GOOGLE_VISION_API_KEY, mask);
  });

  await t.test('posting returned masks preserves stored and environment-backed secrets', async () => {
    const current = await (await settings(admin)).json();
    const payload = Object.fromEntries(secretKeys.map(key => [key, current[key]]));
    const response = await settings(admin, { ...payload, MODULE_OCR: 'true' });
    assert.equal(response.status, 200);
    const { success, saved } = await response.json();
    assert.equal(success, true);
    assert.equal(saved, 1);
    for (const key of secretKeys) {
      assert.deepEqual(read.get(key), key === 'OPENAI_API_KEY' ? undefined : {
        value: `fixture-${key}`, updated_at: updatedAt,
      }, key);
    }
    assert.equal(read.get('MODULE_OCR').value, 'true');
  });

  await t.test('vendor-only changes and unknown keys reject the whole request', async () => {
    const blocked = await settings(admin, { WHATSAPP_TOKEN: 'replacement-fixture', MODULE_OCR: 'false' });
    assert.equal(blocked.status, 403);
    assert.deepEqual((await blocked.json()).blocked, ['WHATSAPP_TOKEN']);
    assert.equal(read.get('WHATSAPP_TOKEN').value, 'fixture-WHATSAPP_TOKEN');

    const unknown = await settings(admin, { UNKNOWN_SETTING: mask, MODULE_OCR: 'false' });
    assert.equal(unknown.status, 400);
    assert.equal(read.get('UNKNOWN_SETTING'), undefined);
    assert.equal(read.get('MODULE_OCR').value, 'true');
  });
});
