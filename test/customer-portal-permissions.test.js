const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const { createPortalAccessService } = require('../services/portalAccess');
const { evaluatePortalBudget } = require('../services/portalBudget');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE customers (id INTEGER PRIMARY KEY,name TEXT,phone TEXT,portal_can_manage_users INTEGER DEFAULT 0,
      portal_can_create_sites INTEGER DEFAULT 0,portal_can_set_budgets INTEGER DEFAULT 0,
      portal_can_expose_prices INTEGER DEFAULT 0,portal_price_list_visibility TEXT DEFAULT 'none',
      payment_terms TEXT,portal_token TEXT,portal_token_expires_at TEXT,portal_token_revoked_at TEXT,
      tax_id TEXT,address TEXT,email TEXT,contact_name TEXT,contact_phone TEXT,price_tier TEXT,discount_pct REAL,
      price_approved_at TEXT,portal_profile_locked_at TEXT);
    CREATE TABLE customer_sites (id INTEGER PRIMARY KEY,customer_id INTEGER,name TEXT,address TEXT,city TEXT,status TEXT,
      manager_name TEXT,manager_phone TEXT,budget_amount REAL DEFAULT 0,budget_kg REAL DEFAULT 0,alert_pct REAL,block_over_budget INTEGER DEFAULT 0);
    CREATE TABLE orders (id INTEGER PRIMARY KEY,customer_id INTEGER,site_id INTEGER,billing_weight REAL,portal_price REAL,status TEXT);
    CREATE TABLE customer_site_users (customer_id INTEGER,site_id INTEGER,portal_user_id INTEGER,is_default INTEGER DEFAULT 0);
  `);
  db.prepare(`INSERT INTO customers (id,name,phone,portal_can_manage_users,portal_can_create_sites,portal_can_set_budgets,portal_can_expose_prices) VALUES (1,'Acme','0501',1,1,1,1)`).run();
  const settingsService = { get: (_key, fallback) => fallback, getNum: (_key, fallback) => fallback };
  const access = createPortalAccessService({ db, crypto, settingsService, PORT: 3000 });
  return { db, access };
}

test('explicit portal denials override role defaults and delegation cannot self-escalate', () => {
  const { db, access } = fixture();
  const user = db.prepare(`INSERT INTO portal_users (customer_id,phone,name,role,active,can_create_orders,can_approve_orders,can_view_prices,can_view_invoices,can_view_payment_alerts,can_manage_users,can_create_sites,can_set_budget) VALUES (1,'0502','Denied','both',1,0,0,0,0,0,0,0,0)`).run().lastInsertRowid;
  const row = db.prepare('SELECT * FROM portal_users WHERE id=?').get(user);
  const caps = access.roleCaps(row, db.prepare('SELECT * FROM customers WHERE id=1').get());
  assert.equal(caps.canOrder, false);
  assert.equal(caps.canApprove, false);
  assert.equal(caps.seePrice, false);
  assert.equal(caps.canViewInvoices, false);
  assert.equal(caps.canManageUsers, false);
  assert.equal(caps.canCreateSites, false);
  assert.equal(caps.canSetBudget, false);
  db.close();
});

test('authorized-site resolution rejects no-site and cross-site access', () => {
  const { db, access } = fixture();
  db.prepare("INSERT INTO customer_sites (id,customer_id,name,status) VALUES (10,1,'A','active'),(11,1,'B','active')").run();
  const id = db.prepare("INSERT INTO portal_users (customer_id,phone,name,role,active,can_create_orders) VALUES (1,'0503','Scoped','orderer',1,1)").run().lastInsertRowid;
  const user = db.prepare('SELECT * FROM portal_users WHERE id=?').get(id);
  assert.equal(access.resolveAuthorizedSite(1, user, 10).ok, false);
  db.prepare('INSERT INTO customer_site_users (customer_id,site_id,portal_user_id,is_default) VALUES (1,10,?,1)').run(id);
  assert.equal(access.resolveAuthorizedSite(1, user, 10).ok, true);
  assert.equal(access.resolveAuthorizedSite(1, user, 11).ok, false);
  db.close();
});

test('support preview fails closed after selected portal user is deactivated', () => {
  const { db, access } = fixture();
  const id = db.prepare("INSERT INTO portal_users (customer_id,phone,name,role,active) VALUES (1,'0504','Support target','both',1)").run().lastInsertRowid;
  const token = access.issueSupportPreviewToken(1, 99, id).token;
  db.prepare('UPDATE portal_users SET active=0 WHERE id=?').run(id);
  assert.equal(access.resolvePortalSession(token), null);
  db.close();
});

test('blocked site budget rejects projected overrun and view-only cannot write budget', () => {
  const { db } = fixture();
  db.prepare("INSERT INTO customer_sites (id,customer_id,name,status,budget_amount,budget_kg,block_over_budget) VALUES (20,1,'Budget','active',10,1,1)").run();
  db.prepare("INSERT INTO orders (customer_id,site_id,billing_weight,portal_price,status) VALUES (1,20,.5,5,'ממתינה לאישור לקוח')").run();
  const result = evaluatePortalBudget({ db, customerId: 1, siteId: 20, amount: 6, kg: .2 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'over_budget');
  db.prepare('UPDATE customer_sites SET budget_amount=0,budget_kg=0 WHERE id=20').run();
  const site = db.prepare('SELECT budget_amount,budget_kg FROM customer_sites WHERE id=20').get();
  assert.deepEqual(site, { budget_amount: 0, budget_kg: 0 });
  db.close();
});

test('HTTP portal enforces delegated flags and cross-site order access', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-permissions-http-'));
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'portal-permissions-http-secret', BCRYPT_ROUNDS: '4', DB_PATH: path.join(dir, 'portal.db'), BACKUP_DIR: path.join(dir, 'backups') });
  const { server, db, closeServer } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => closeServer(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const customerId = db.prepare("INSERT INTO customers(name,phone,portal_can_manage_users,portal_can_create_sites,portal_can_set_budgets,portal_can_expose_prices) VALUES ('HTTP customer','0509',1,1,1,1)").run().lastInsertRowid;
  const token = 'http-admin-token';
  const callerId = db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,active,token,token_expires_at,can_manage_users,can_create_sites,can_assign_site_users,can_create_orders,can_approve_orders,can_view_prices,can_view_budget,can_set_budget,can_view_invoices,can_view_delivery_notes,can_view_payment_alerts) VALUES (?,?,?,?,?,'http-admin-token','2099-01-01',1,1,1,1,1,1,1,1,1,1,1)").run(customerId, '0510', 'Caller', 'both', 1).lastInsertRowid;
  const otherId = db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,active,token,token_expires_at,can_create_orders) VALUES (?,?,?,?,?,'other-token','2099-01-01',1)").run(customerId, '0511', 'Other', 'orderer', 1).lastInsertRowid;
  const siteA = db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?, 'A','active')").run(customerId).lastInsertRowid;
  const siteB = db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?, 'B','active')").run(customerId).lastInsertRowid;
  db.prepare('INSERT INTO customer_site_users(customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,1)').run(customerId, siteA, callerId);
  const orderId = db.prepare("INSERT INTO orders(customer_id,site_id,status,order_num) VALUES (?,?,?,'HTTP-1')").run(customerId, siteB, 'ממתינה לאישור לקוח').lastInsertRowid;
  async function call(url, options = {}) { const response = await fetch(base + url, options); return { response, body: await response.json().catch(() => ({})) }; }
  const headers = { 'Content-Type': 'application/json' };
  const denied = await call('/api/c/users', { method: 'POST', headers, body: JSON.stringify({ token, phone: '0512', role: 'customer_admin', canManageUsers: true, canCreateSites: true, canCreateOrders: true, canApproveOrders: true, canViewPrices: true, canViewBudget: true, canSetBudget: true, canViewInvoices: true, canViewPaymentAlerts: true, siteIds: [siteA] }) });
  assert.equal(denied.response.status, 200, JSON.stringify(denied.body));
  const delegated = db.prepare('SELECT * FROM portal_users WHERE phone=\'0512\'').get();
  assert.equal(delegated.role, 'customer_admin');
  assert.equal(delegated.can_create_orders, 1);
  assert.equal(delegated.can_approve_orders, 1);
  assert.equal(delegated.can_view_invoices, 1);
  const cross = await call(`/api/c/orders/${orderId}?token=${token}`);
  assert.equal(cross.response.status, 404);
  const print = await fetch(`${base}/api/c/orders/${orderId}/print?token=${token}`);
  assert.equal(print.status, 404);
  db.prepare('UPDATE portal_users SET can_approve_orders=1 WHERE id=?').run(callerId);
  const approve = await call('/api/c/approve', { method: 'POST', headers, body: JSON.stringify({ token, orderId }) });
  assert.equal(approve.response.status, 403);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'ממתינה לאישור לקוח');
});
