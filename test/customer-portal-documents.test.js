'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const createPortalDocumentsRouter = require('../routes/portalDocuments');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE customers (id INTEGER PRIMARY KEY,name TEXT,phone TEXT,portal_can_manage_users INTEGER DEFAULT 0,portal_can_create_sites INTEGER DEFAULT 0,portal_can_set_budgets INTEGER DEFAULT 0,portal_can_expose_prices INTEGER DEFAULT 1,portal_price_list_visibility TEXT DEFAULT 'none',payment_terms TEXT,portal_token TEXT,portal_token_expires_at TEXT,portal_token_revoked_at TEXT,tax_id TEXT,address TEXT,email TEXT,contact_name TEXT,contact_phone TEXT,price_tier TEXT,discount_pct REAL,price_approved_at TEXT,portal_profile_locked_at TEXT);
    CREATE TABLE customer_sites (id INTEGER PRIMARY KEY,customer_id INTEGER,name TEXT,address TEXT,city TEXT,status TEXT,manager_name TEXT,manager_phone TEXT,budget_amount REAL,budget_kg REAL,alert_pct REAL,block_over_budget INTEGER);
    CREATE TABLE portal_users (id INTEGER PRIMARY KEY,customer_id INTEGER,phone TEXT,name TEXT,role TEXT,active INTEGER,token TEXT,token_expires_at TEXT,can_view_invoices INTEGER DEFAULT 0,can_view_delivery_notes INTEGER DEFAULT 1,default_site_id INTEGER);
    CREATE TABLE customer_site_users (customer_id INTEGER,site_id INTEGER,portal_user_id INTEGER,is_default INTEGER);
    CREATE TABLE orders (id INTEGER PRIMARY KEY,customer_id INTEGER,site_id INTEGER,order_num TEXT,status TEXT,delivery_date TEXT,delivery_address TEXT,delivery_time TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY,invoice_num TEXT,order_id INTEGER,customer_id INTEGER,issue_date TEXT,total REAL,paid_amount REAL,status TEXT,items_json TEXT,subtotal REAL);
    CREATE TABLE delivery_notes (id INTEGER PRIMARY KEY,note_num TEXT,order_id INTEGER,customer_id INTEGER,items_json TEXT,total_weight REAL,issued_at TEXT,delivered_at TEXT,signed_by TEXT,signature_data TEXT);
    CREATE TABLE delivery_note_orders (delivery_note_id INTEGER,order_id INTEGER,order_num TEXT,customer_id INTEGER,items_json TEXT,total_weight REAL);
  `);
  const customerId = db.prepare("INSERT INTO customers(id,name,phone,portal_can_expose_prices) VALUES (1,'One','0501',1)").run().lastInsertRowid;
  db.prepare("INSERT INTO customers(id,name,phone,portal_can_expose_prices) VALUES (2,'Two','0502',1)").run();
  db.prepare("INSERT INTO customer_sites(id,customer_id,name,status) VALUES (10,1,'A','active'),(11,1,'B','active')").run();
  db.prepare("INSERT INTO portal_users(id,customer_id,phone,name,role,active,token,token_expires_at,can_view_invoices,can_view_delivery_notes,default_site_id) VALUES (1,1,'0510','Viewer','both',1,'doc-token','2099-01-01',1,1,10),(2,1,'0511','No docs','orderer',1,'nodoc-token','2099-01-01',0,0,10)").run();
  db.prepare('INSERT INTO customer_site_users VALUES (1,10,1,1),(1,10,2,1)').run();
  const orderA = db.prepare("INSERT INTO orders(id,customer_id,site_id,order_num,status) VALUES (100,1,10,'A-100','done')").run().lastInsertRowid;
  const orderB = db.prepare("INSERT INTO orders(id,customer_id,site_id,order_num,status) VALUES (101,1,11,'B-101','done')").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO orders(id,customer_id,site_id,order_num,status) VALUES (102,2,NULL,'X-102','done')").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices(id,invoice_num,order_id,customer_id,issue_date,total,paid_amount,status,items_json,subtotal) VALUES (1,'INV-1',100,1,'2026-09-01',125,25,'open',?,100)").run('[{"secret_cost":999}]');
  db.prepare("INSERT INTO delivery_notes(id,note_num,order_id,customer_id,total_weight,issued_at,signed_by,signature_data) VALUES (1,'DN-1',100,1,12,'2026-09-02','PERSON','RAW-SIGNATURE')").run();
  db.prepare("INSERT INTO delivery_note_orders VALUES (1,100,'A-100',1,'[]',12),(1,101,'B-101',1,'[]',5)").run();
  const app = express();
  app.use(express.json());
  app.use('/api', createPortalDocumentsRouter({ db, crypto, settingsService: { get: (_k, f) => f }, PORT: 3000, customerPortalActionLimiter: (_req,_res,next)=>next() }));
  return { db, app, orderA, orderB, other };
}

test('portal document library returns only authorized real docs and safe summary', async t => {
  const { db, app, orderA, orderB, other } = setup();
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });
  const get = async path => { const r = await fetch(base + path); return { r, b: await r.json().catch(() => ({})) }; };
  const list = await get(`/api/c/orders/${orderA}/documents?token=doc-token`);
  assert.equal(list.r.status, 200);
  assert.deepEqual(list.b.documents.map(x => x.type), ['invoice'], 'consolidated note containing inaccessible site order is hidden');
  const inv = db.prepare('DELETE FROM delivery_note_orders WHERE delivery_note_id=1 AND order_id=101').run();
  const safe = await get(`/api/c/orders/${orderA}/documents?token=doc-token`);
  assert.deepEqual(safe.b.documents.map(x => x.type).sort(), ['delivery_note','invoice']);
  assert.doesNotMatch(JSON.stringify(safe.b), /secret_cost|RAW-SIGNATURE|items_json|subtotal/);
  const printable = await fetch(`${base}/api/c/orders/${orderA}/documents/invoice/1?token=doc-token`);
  assert.equal(printable.status, 200);
  const html = await printable.text();
  assert.match(html, /INV-1/);
  assert.doesNotMatch(html, /secret_cost|RAW-SIGNATURE|PERSON|items_json/);
  assert.equal((await get(`/api/c/orders/${orderB}/documents?token=doc-token`)).r.status, 404);
  assert.equal((await get(`/api/c/orders/${other}/documents?token=doc-token`)).r.status, 404);
  assert.equal((await get(`/api/c/orders/${orderA}/documents?token=nodoc-token`)).b.documents.length, 0);
  assert.equal(inv.changes, 1);
  db.prepare('UPDATE invoices SET items_json=? WHERE id=1').run(JSON.stringify([{ order_id: orderB }]));
  assert.equal((await fetch(`${base}/api/c/orders/${orderA}/documents/invoice/1?token=doc-token`)).status, 404, 'consolidated invoice must not leak inaccessible site totals');
  db.prepare('UPDATE delivery_notes SET order_id=? WHERE id=1').run(other);
  assert.equal((await get(`/api/c/orders/${orderA}/documents?token=doc-token`)).b.documents.length, 0, 'legacy primary order is also checked for a consolidated note');
});
