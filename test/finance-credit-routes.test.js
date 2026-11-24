'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-finance-credit-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'finance-credit.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

const { hashPin } = require('../auth-core');
const { ROLE_PERMISSIONS } = require('../permissions');
const { server, db, closeServer } = require('../server');

const allowedRoles = ['finance', 'manager', 'admin'];
const tokens = new Map();
let baseUrl;

function request(url, { role, method = 'GET', body } = {}) {
  const headers = {};
  if (role) {
    assert.ok(tokens.has(role), `Missing token for ${role}`);
    headers.Authorization = `Bearer ${tokens.get(role)}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${url}`, { method, headers, body: JSON.stringify(body) });
}

function createCustomer(name, phone = null) {
  return db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(name, phone).lastInsertRowid;
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const pin = '1234';
  const pinHash = hashPin(pin, 4);
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    const username = `credit-${role}`;
    db.prepare('INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(username, username, role, pinHash, new Date().toISOString());
    const response = await request('/auth/login', { method: 'POST', body: { username, pin } });
    assert.equal(response.status, 200, `Login for ${role}`);
    const { access_token } = await response.json();
    assert.ok(access_token, `Access token for ${role}`);
    tokens.set(role, access_token);
  }
});

after(async () => {
  if (server.listening) await new Promise(resolve => closeServer(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('credit list, detail and status allow only finance, manager and admin', async () => {
  const name = 'לקוח אשראי';
  const phone = '0500000000';
  const customerId = createCustomer(name, phone);
  const creditUrl = `/credit/${customerId}`;
  for (const url of ['/credit', creditUrl, `${creditUrl}/status`]) {
    assert.equal((await request(url)).status, 401, url);
    for (const role of tokens.keys()) {
      if (allowedRoles.includes(role)) continue;
      assert.equal((await request(url, { role })).status, 403, `${role} GET ${url}`);
    }
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM credit_accounts WHERE customer_id = ?').get(customerId).count, 0);

  for (const role of allowedRoles) {
    const detail = await request(creditUrl, { role });
    assert.equal(detail.status, 200, role);
    const account = await detail.json();
    assert.equal(account.customer_id, customerId);
    assert.equal(account.customer_name, name);
    assert.deepEqual(account.transactions, []);

    const list = await request('/credit', { role });
    assert.equal(list.status, 200, role);
    const listed = (await list.json()).find(row => row.customer_id === customerId);
    assert.equal(listed?.customer_name, name);
    assert.equal(listed?.customer_phone, phone);

    const status = await request(`${creditUrl}/status`, { role });
    assert.equal(status.status, 200, role);
    const { blocked, credit_limit, current_debt } = await status.json();
    assert.deepEqual({ blocked, credit_limit, current_debt }, { blocked: 0, credit_limit: 0, current_debt: 0 });
  }
});

test('PATCH persists the limit, payment terms and block flag on partial updates', async () => {
  const customerId = createCustomer('לקוח תנאי תשלום');
  const url = `/credit/${customerId}`;
  const updates = [
    { credit_limit: 500, payment_terms: 60, blocked: 1 },
    { payment_terms: 0, blocked: false },
  ];
  const expected = [
    { credit_limit: 500, payment_terms: 60, blocked: 1 },
    { credit_limit: 500, payment_terms: 0, blocked: 0 },
  ];
  const readAccount = db.prepare('SELECT credit_limit, payment_terms, blocked FROM credit_accounts WHERE customer_id = ?');

  for (const [index, body] of updates.entries()) {
    const response = await request(url, { role: 'finance', method: 'PATCH', body });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).success, true);
    assert.deepEqual(readAccount.get(customerId), expected[index]);
  }
});

test('POST requires a type and a valid amount before writing any credit data', async () => {
  const customerId = createCustomer('לקוח תנועה חסרה');
  const url = `/credit/${customerId}/transaction`;
  for (const body of [undefined, {}, { amount: 100 }, { type: 'charge' }, { type: 'charge', amount: 'abc' }]) {
    const response = await request(url, { role: 'finance', method: 'POST', body });
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${await response.text()}`);
  }
  assert.equal(db.prepare('SELECT id FROM credit_accounts WHERE customer_id = ?').get(customerId), undefined);
  assert.equal(db.prepare('SELECT id FROM credit_transactions WHERE customer_id = ?').get(customerId), undefined);
});

test('transactions adjust debt and block the account when it exceeds its limit', async () => {
  const customerId = createCustomer('לקוח מסגרת אשראי');
  const url = `/credit/${customerId}`;
  const role = 'finance';
  const patch = await request(url, { role, method: 'PATCH', body: { credit_limit: 100 } });
  assert.equal(patch.status, 200);
  const readTransaction = db.prepare('SELECT customer_id, type, amount FROM credit_transactions WHERE id = ?');
  const transactionIds = [];

  for (const [type, amount, expectedDebt, expectedBlocked] of [
    ['charge', 100, 100, 0],
    ['payment', 20, 80, 0],
    ['credit_note', 15, 65, 0],
    ['adjustment', 35.01, 100.01, 1],
  ]) {
    const response = await request(`${url}/transaction`, { role, method: 'POST', body: { type, amount } });
    assert.equal(response.status, 200, type);
    const { id } = await response.json();
    assert.deepEqual(readTransaction.get(id), { customer_id: customerId, type, amount });
    transactionIds.push(id);

    const status = await request(`${url}/status`, { role });
    assert.equal(status.status, 200, type);
    const { blocked, block_reason, credit_limit, current_debt } = await status.json();
    assert.equal(credit_limit, 100, type);
    assert.equal(current_debt, expectedDebt, type);
    assert.equal(blocked, expectedBlocked, type);
    assert.equal(block_reason, expectedBlocked ? 'חריגה ממסגרת אשראי' : null, type);
  }

  const detail = await request(url, { role });
  assert.equal(detail.status, 200);
  const { transactions } = await detail.json();
  assert.deepEqual(transactions.map(row => row.id).sort((a, b) => a - b), transactionIds);
  assert.equal(db.prepare('SELECT blocked FROM credit_accounts WHERE customer_id = ?').get(customerId).blocked, 1);
});
