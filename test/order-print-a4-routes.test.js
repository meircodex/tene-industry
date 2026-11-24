'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('GET /orders/:id/print-a4', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-order-print-a4-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.BCRYPT_ROUNDS = '4';
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

  const { closeServer, db, server } = require('../server');
  const { hashPin } = require('../auth-core');

  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const orderNum = 'A4-1042';
  const { lastInsertRowid: orderId } = db.prepare(`
    INSERT INTO orders (order_num, channel, status) VALUES (?, 'משרד', 'ממתין')
  `).run(orderNum);

  const allowedRoles = ['office', 'production', 'manager', 'admin'];
  const pin = '1234';
  const pinHash = hashPin(pin, 4);
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `);
  for (const role of [...allowedRoles, 'sales']) {
    const username = `print-a4-${role}`;
    insertUser.run(username, username, role, pinHash);
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  async function login(role) {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `print-a4-${role}`, pin }),
    });
    assert.equal(response.status, 200, `login as ${role}`);
    const { access_token: token } = await response.json();
    assert.ok(token, `access token for ${role}`);
    return { Authorization: `Bearer ${token}` };
  }

  for (const role of allowedRoles) {
    await t.test(`returns Hebrew RTL HTML with the order number for ${role}`, async () => {
      const headers = await login(role);
      const response = await fetch(`${baseUrl}/orders/${orderId}/print-a4`, { headers });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/html(?:;|$)/i);
      const html = await response.text();
      assert.match(html, /<html lang="he" dir="rtl">/);
      assert.ok(html.includes(`>${orderNum}<`), 'order number is visible in the HTML');
    });
  }

  await t.test('returns 403 for sales', async () => {
    const headers = await login('sales');
    const response = await fetch(`${baseUrl}/orders/${orderId}/print-a4`, { headers });

    assert.equal(response.status, 403);
  });

  await t.test('returns the Hebrew 404 message for a missing order', async () => {
    const headers = await login('office');
    const response = await fetch(`${baseUrl}/orders/${orderId + 1}/print-a4`, { headers });

    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'הזמנה לא נמצאה');
  });
});
