'use strict';

const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-access-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.BACKUP_DIR = path.join(tempDir, 'backups');

const { closeServer, db, server } = require('../server');
const { hashPin } = require('../auth-core');

const tokens = new Map();
const override = { screenId: 'orders', role: 'office', level: 'read' };
let baseUrl;

async function request(pathname, { as, method = 'GET', body } = {}) {
  const headers = {};
  if (as) {
    assert.ok(tokens.has(as), `Missing login for ${as}`);
    headers.Authorization = `Bearer ${tokens.get(as)}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function screensFor(as, expectedRole = as) {
  const response = await request('/access/me', { as });
  assert.equal(response.status, 200);
  assert.equal(response.body.role, expectedRole);
  return response.body.screens;
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `);
  for (const role of ['viewer', 'kiosk', 'operator', 'production', 'office', 'manager', 'admin']) {
    const username = `access-${role}`;
    const pin = String(randomInt(1000, 10000));
    insertUser.run(username, username, role, hashPin(pin, 4));
    const login = await request('/auth/login', { method: 'POST', body: { username, pin } });
    assert.equal(login.status, 200, role);
    assert.ok(login.body.access_token, role);
    tokens.set(role, login.body.access_token);
  }
});

after(async () => {
  try {
    await new Promise((resolve, reject) => {
      closeServer(error => error ? reject(error) : resolve());
    });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GET /access/me returns the screens and access levels for the authenticated role', async () => {
  assert.equal((await request('/access/me')).status, 401);

  const viewer = await screensFor('viewer');
  assert.deepEqual(viewer.find(screen => screen.id === 'scanner'), {
    id: 'scanner', path: '/scan.html', label: 'סריקת QR', icon: '📷', group: 'תפעול', access: 'read',
  });
  assert.ok(!viewer.some(screen => screen.id === 'orders'));

  for (const [role, level] of [['production', 'read'], ['office', 'edit'], ['admin', 'edit']]) {
    const screens = await screensFor(role);
    assert.equal(screens.find(screen => screen.id === 'orders')?.access, level, role);
  }
});

test('GET /access/me returns kiosk screens for a legacy operator account', async () => {
  const kiosk = await screensFor('kiosk');
  assert.equal(kiosk.find(screen => screen.id === 'kiosk')?.access, 'edit');
  assert.deepEqual(await screensFor('operator', 'kiosk'), kiosk);
});

test('GET and PUT /access/matrix are admin only', async () => {
  assert.equal((await request('/access/matrix')).status, 401);
  assert.equal((await request('/access/matrix', { method: 'PUT', body: override })).status, 401);

  for (const as of ['viewer', 'office', 'manager']) {
    assert.equal((await request('/access/matrix', { as })).status, 403, as);
    assert.equal((await request('/access/matrix', { as, method: 'PUT', body: override })).status, 403, as);
  }

  const matrix = await request('/access/matrix', { as: 'admin' });
  assert.equal(matrix.status, 200);
  assert.ok(matrix.body.screens.some(screen => screen.id === override.screenId));
  assert.ok(matrix.body.roles.includes(override.role));
  assert.equal(matrix.body.access.orders.office, 'edit');
});

test('PUT /access/matrix requires screenId, role and level', async () => {
  for (const field of Object.keys(override)) {
    const body = { ...override };
    delete body[field];
    const response = await request('/access/matrix', { as: 'admin', method: 'PUT', body });
    assert.equal(response.status, 400, `Missing ${field}`);
  }
});

test('PUT /access/matrix saves an override reflected in GET /access/me for that role', async () => {
  const response = await request('/access/matrix', { as: 'admin', method: 'PUT', body: override });
  assert.equal(response.status, 200);
  const { success, screenId, role, level } = response.body;
  assert.deepEqual({ success, screenId, role, level }, { success: true, ...override });

  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get('ROLE_SCREEN_ACCESS');
  assert.equal(JSON.parse(saved.value).orders.office, 'read');

  const office = await screensFor('office');
  assert.equal(office.find(screen => screen.id === 'orders')?.access, 'read');
  const admin = await screensFor('admin');
  assert.equal(admin.find(screen => screen.id === 'orders')?.access, 'edit');
});
