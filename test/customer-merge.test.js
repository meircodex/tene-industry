'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { ensureCoreSchema, runCoreMigrations } = require('../db/startup');
const { createCustomerMergeService } = require('../services/customerMerge');
const { ensureCustomerIdentityConstraints, mergedCustomerId } = require('../services/customerIdentity');

function removeTestDir(dir) {
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('tene-customer-merge-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-customer-merge-'));
  const db = new Database(':memory:');
  ensureCoreSchema(db);
  runCoreMigrations(db);
  db.pragma('foreign_keys=ON');
  t.after(() => { db.close(); removeTestDir(dir); });
  const targetId = db.prepare('INSERT INTO customers (name,tax_id,phone,notes,portal_token) VALUES (?,?,?,?,?)').run('ראשי', '512345678', '0500000000', 'הערה ראשית', 'target-secret-token').lastInsertRowid;
  const sourceId = db.prepare('INSERT INTO customers (name,phone,email,notes,portal_token) VALUES (?,?,?,?,?)').run('כפול', '0500000001', 'source@example.invalid', 'הערה ישנה', 'source-secret-token').lastInsertRowid;
  const service = createCustomerMergeService(db, { secret: 'merge-test-key', backupDir: dir });
  const preview = () => service.preview({ sourceId, targetId, taxId: '512345678' }, 1);
  const confirm = plan => service.merge({ token: plan.token, acknowledge: true, confirmTaxId: plan.taxId }, 1);
  return { db, dir, sourceId, targetId, service, preview, confirm };
}

test('customer merge moves related data, keeps document values and archives the old account with a backup', async t => {
  const f = fixture(t), { db, sourceId, targetId } = f;
  const orderId = db.prepare("INSERT INTO orders (order_num,customer_id,total_weight,portal_price) VALUES ('MERGE-ORDER',?,25,123.45)").run(sourceId).lastInsertRowid;
  const invoiceId = db.prepare("INSERT INTO invoices (invoice_num,customer_id,customer_name,customer_vat_id,order_id,total,paid_amount) VALUES ('MERGE-INV',?,'שם במסמך','512345678',?,123.45,20)").run(sourceId, orderId).lastInsertRowid;
  const projectId = db.prepare("INSERT INTO projects (name,customer_id) VALUES ('פרויקט',?)").run(sourceId).lastInsertRowid;
  db.prepare("INSERT INTO sites (name,project_id,customer_id) VALUES ('אתר רגיל',?,?)").run(projectId, sourceId);
  const siteId = db.prepare("INSERT INTO customer_sites (name,customer_id,budget_amount) VALUES ('אתר פורטל',?,5000)").run(sourceId).lastInsertRowid;
  const userId = db.prepare("INSERT INTO portal_users (customer_id,phone,name,role,token,default_site_id) VALUES (?,'0500000001','משתמש','customer_admin','old-user-token',?)").run(sourceId, siteId).lastInsertRowid;
  db.prepare('INSERT INTO customer_site_users (customer_id,site_id,portal_user_id) VALUES (?,?,?)').run(sourceId, siteId, userId);
  db.prepare("INSERT INTO customer_portal_otps (customer_id,phone,code_hash,expires_at) VALUES (?,'0500000001','test','2099-01-01')").run(sourceId);
  db.prepare("INSERT INTO customer_guarantee_documents (customer_id,original_name,file_name,data_url) VALUES (?,'test.pdf','test.pdf','data:application/pdf;base64,AA==')").run(sourceId);
  db.prepare("INSERT INTO customer_profile_change_requests (customer_id,requested_json) VALUES (?,?)").run(sourceId, JSON.stringify({ name: 'לא לדרוס' }));
  db.prepare("INSERT INTO credit_transactions (customer_id,order_id,type,amount) VALUES (?,?,'payment',20)").run(sourceId, orderId);
  db.prepare("INSERT INTO delivery_notes (note_num,customer_id,order_id,total_weight) VALUES ('MERGE-DN',?,?,25)").run(sourceId, orderId);
  const deliveryId = db.prepare("SELECT id FROM delivery_notes WHERE note_num='MERGE-DN'").get().id;
  db.prepare("INSERT INTO delivery_note_orders (delivery_note_id,order_id,order_num,customer_id,total_weight) VALUES (?,?,'MERGE-ORDER',?,25)").run(deliveryId, orderId, sourceId);
  db.prepare("INSERT INTO pricing_price_books (code,name,customer_id,status) VALUES ('MERGE-BOOK','מחירון',?,'draft')").run(sourceId);
  const payload = { customer: { id: sourceId, name: 'כפול' }, order: {}, pallets: [{ items: [{ diameter: 12, length: 1000, qty: 2 }] }] };
  db.prepare("INSERT INTO order_quotes (quote_num,customer_id,customer_name,payload_json,total_price) VALUES ('MERGE-Q',?,'כפול',?,88)").run(sourceId, JSON.stringify(payload));
  const beforeOrders = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const beforeInvoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  const plan = f.preview();
  assert.equal(plan.canMerge, true, JSON.stringify(plan.blockers));
  assert.equal(plan.activePortalUsersToSuspend, 1);
  assert.equal(plan.counts.find(row => row.table === 'orders').source, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2, 'preview is read-only');
  assert.equal(fs.readdirSync(f.dir).length, 0, 'preview does not create a backup or change data');
  const result = await f.confirm(plan);
  assert.equal(result.targetId, targetId);
  assert.equal(result.backupCreated, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), { ...beforeOrders, customer_id: targetId });
  assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId), { ...beforeInvoice, customer_id: targetId });
  for (const table of ['projects', 'sites', 'customer_sites', 'customer_site_users', 'credit_transactions', 'delivery_notes', 'delivery_note_orders', 'pricing_price_books', 'customer_guarantee_documents']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE customer_id=?`).get(sourceId).n, 0, table);
    assert.ok(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE customer_id=?`).get(targetId).n > 0, table);
  }
  const user = db.prepare('SELECT * FROM portal_users WHERE id=?').get(userId);
  assert.equal(user.customer_id, targetId);
  assert.equal(user.default_site_id, siteId);
  assert.equal(user.active, 0);
  assert.equal(user.token, null);
  assert.ok(db.prepare('SELECT consumed_at FROM customer_portal_otps').get().consumed_at);
  assert.equal(db.prepare('SELECT status FROM customer_profile_change_requests').get().status, 'rejected');
  const quote = db.prepare("SELECT * FROM order_quotes WHERE quote_num='MERGE-Q'").get();
  assert.equal(JSON.parse(quote.payload_json).customer.id, targetId);
  assert.equal(quote.total_price, 88);
  const target = db.prepare('SELECT * FROM customers WHERE id=?').get(targetId);
  assert.equal(target.name, 'ראשי');
  assert.equal(target.phone, '0500000000');
  assert.equal(target.email, 'source@example.invalid');
  assert.equal(target.portal_token, 'target-secret-token');
  assert.match(target.notes, /הערה ראשית/);
  assert.match(target.notes, /הערה ישנה/);
  const archived = db.prepare('SELECT * FROM customer_merge_archive').get();
  assert.equal(archived.old_customer_id, sourceId);
  assert.equal(archived.target_customer_id, targetId);
  assert.equal(JSON.parse(archived.links_json).orders[0].id, orderId);
  assert.doesNotMatch(archived.profile_json, /source-secret-token/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='customer_merge'").get().n, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const backup = new Database(path.join(f.dir, fs.readdirSync(f.dir)[0]), { readonly: true });
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
    assert.equal(backup.prepare('SELECT customer_id FROM orders WHERE id=?').get(orderId).customer_id, sourceId);
  } finally { backup.close(); }
  const repeated = await f.confirm(plan);
  assert.equal(repeated.alreadyMerged, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_merge_log').get().n, 1);
});

test('different tax IDs, self-merge and missing confirmation cannot mutate customers', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE customers SET tax_id=? WHERE id=?').run('598765432', f.sourceId);
  assert.equal(f.preview().canMerge, false);
  assert.throws(() => f.service.preview({ sourceId: f.sourceId, targetId: f.sourceId }, 1), error => error.statusCode === 400);
  f.db.prepare('UPDATE customers SET tax_id=NULL WHERE id=?').run(f.sourceId);
  const plan = f.preview();
  await assert.rejects(f.service.merge({ token: plan.token, confirmTaxId: plan.taxId }, 1), error => error.code === 'merge_confirmation_required');
  await assert.rejects(f.service.merge({ token: plan.token, acknowledge: true, confirmTaxId: '111111111' }, 1), error => error.code === 'merge_confirmation_required');
  await assert.rejects(f.service.merge({ token: plan.token, acknowledge: true, confirmTaxId: plan.taxId }, 2), error => error.code === 'invalid_merge_preview');
  await assert.rejects(f.service.merge({ token: plan.token + 'x', acknowledge: true, confirmTaxId: plan.taxId }, 1), error => error.code === 'invalid_merge_preview');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('changed data invalidates the signed preview', async t => {
  const f = fixture(t), plan = f.preview();
  f.db.prepare('UPDATE customers SET phone=? WHERE id=?').run('0500000099', f.sourceId);
  await assert.rejects(f.confirm(plan), error => error.code === 'stale_merge_preview');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('backup failure leaves every customer intact', async t => {
  const f = fixture(t);
  const service = createCustomerMergeService(f.db, { secret: 'test', backupDir: path.join(f.dir, '\0invalid') });
  const plan = service.preview({ sourceId: f.sourceId, targetId: f.targetId }, 1);
  await assert.rejects(service.merge({ token: plan.token, acknowledge: true, confirmTaxId: plan.taxId }, 1), error => error.code === 'merge_backup_failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_merge_log').get().n, 0);
});

test('unexpected write failure rolls back archival, transferred orders and suspended users together', async t => {
  const f = fixture(t), { db } = f;
  db.prepare("INSERT INTO orders (order_num,customer_id) VALUES ('ROLLBACK-MERGE',?)").run(f.sourceId);
  db.prepare("INSERT INTO portal_users (customer_id,phone,token) VALUES (?,'0500000001','keep-token')").run(f.sourceId);
  db.exec("CREATE TRIGGER test_reject_customer_delete BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  await assert.rejects(f.confirm(f.preview()), /injected write failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  assert.equal(db.prepare('SELECT customer_id FROM orders').get().customer_id, f.sourceId);
  assert.equal(db.prepare('SELECT active FROM portal_users').get().active, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_merge_archive').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_merge_log').get().n, 0);
});

test('credit balances and pricing conflicts stop the merge instead of guessing', t => {
  const f = fixture(t);
  for (const id of [f.sourceId, f.targetId]) {
    f.db.prepare('INSERT INTO customer_credit (customer_id,open_debt) VALUES (?,100)').run(id);
    f.db.prepare("INSERT INTO pricing_price_books (code,name,customer_id,status) VALUES (?, 'מחירון',?,'active')").run('P' + id, id);
  }
  const plan = f.preview();
  assert.equal(plan.canMerge, false);
  assert.equal(plan.token, null);
  assert.ok(plan.blockers.some(text => text.includes('יתרות')));
  assert.ok(plan.blockers.some(text => text.includes('מחירון')));
});

test('an empty credit row and a single populated account combine without losing or adding balances', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO customer_credit (customer_id,open_debt,wip_value,total_exposure) VALUES (?,100,25,125)').run(f.sourceId);
  f.db.prepare('INSERT INTO customer_credit (customer_id) VALUES (?)').run(f.targetId);
  f.db.prepare('INSERT INTO credit_accounts (customer_id,current_debt) VALUES (?,70)').run(f.sourceId);
  f.db.prepare('INSERT INTO credit_accounts (customer_id) VALUES (?)').run(f.targetId);
  await f.confirm(f.preview());
  const credit = f.db.prepare('SELECT * FROM customer_credit').get();
  assert.equal(credit.customer_id, f.targetId);
  assert.equal(credit.open_debt, 100);
  assert.equal(credit.wip_value, 25);
  assert.equal(credit.total_exposure, 125);
  assert.equal(credit.credit_limit, 0);
  assert.equal(f.db.prepare('SELECT current_debt FROM credit_accounts').get().current_debt, 70);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM credit_accounts').get().n, 1);
});

test('legacy same-tax-ID duplicates can be merged and archived aliases survive a later merge', async t => {
  const f = fixture(t);
  f.db.exec('DROP TRIGGER customers_tax_id_update_guard');
  f.db.prepare('UPDATE customers SET tax_id=? WHERE id=?').run('512-345678', f.sourceId);
  ensureCustomerIdentityConstraints(f.db);
  assert.equal(f.preview().canMerge, true);
  await f.confirm(f.preview());
  const nextTarget = f.db.prepare("INSERT INTO customers (name) VALUES ('ראשי חדש')").run().lastInsertRowid;
  const plan = f.service.preview({ sourceId: f.targetId, targetId: nextTarget, taxId: '512345678' }, 1);
  assert.equal(plan.canMerge, true, JSON.stringify(plan.blockers));
  await f.confirm(plan);
  assert.equal(mergedCustomerId(f.db, f.sourceId), nextTarget);
  assert.equal(mergedCustomerId(f.db, f.targetId), nextTarget);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('unsupported customer relationships and conflicting invoice tax IDs are reported before changes', t => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE future_customer_data (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES customers(id))');
  f.db.prepare('INSERT INTO future_customer_data (owner) VALUES (?)').run(f.sourceId);
  f.db.prepare("INSERT INTO invoices (invoice_num,customer_id,customer_vat_id) VALUES ('DIFFERENT-ENTITY',?,'598765432')").run(f.sourceId);
  const plan = f.preview();
  assert.equal(plan.canMerge, false);
  assert.ok(plan.blockers.some(text => text.includes('future_customer_data')));
  assert.ok(plan.blockers.some(text => text.includes('חשבוניות')));
});

test('HTTP merge requires admin and confirmation; archived customer URLs resolve to the primary card', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-customer-merge-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'merge-http-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  process.env.DB_PATH = path.join(dir, 'http.db');
  process.env.BACKUP_DIR = path.join(dir, 'backups');
  const { server, db, closeServer } = require('../server');
  const { hashPin } = require('../auth-core');
  t.after(async () => { await new Promise(resolve => closeServer(resolve)); db.close(); removeTestDir(dir); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, token, body) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const login = async role => {
    const username = 'merge-' + role;
    db.prepare('INSERT INTO users (username,display_name,role,pin,pin_hash,active,password_changed_at) VALUES (?,?,?,?,?,1,?)').run(username, username, role, '1234', hashPin('1234', 4), new Date().toISOString());
    const response = await request('/api/auth/login', null, { username, pin: '1234' });
    assert.equal(response.status, 200);
    return response.data.access_token;
  };
  const admin = await login('admin'), office = await login('office');
  const targetId = db.prepare("INSERT INTO customers (name,tax_id) VALUES ('ראשי','512345678')").run().lastInsertRowid;
  const sourceId = db.prepare("INSERT INTO customers (name,phone,portal_token) VALUES ('ישן','0500000042','legacy-source-token')").run().lastInsertRowid;
  db.prepare("INSERT INTO portal_users (customer_id,phone,name,token) VALUES (?,'0500000042','משתמש','legacy-user-token')").run(sourceId);
  const input = { sourceId, targetId, taxId: '512345678' };
  assert.equal((await request('/api/customers/merge/preview', null, input)).status, 401);
  assert.equal((await request('/api/customers/merge/preview', office, input)).status, 403);
  const preview = await request('/api/customers/merge/preview', admin, input);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.canMerge, true, JSON.stringify(preview.data.blockers));
  const confirmation = { token: preview.data.token, acknowledge: true, confirmTaxId: '512345678' };
  assert.equal((await request('/api/customers/merge/confirm', office, confirmation)).status, 403);
  assert.equal((await request('/api/customers/merge/confirm', admin, { token: confirmation.token })).status, 400);
  const result = await request('/api/customers/merge/confirm', admin, confirmation);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const oldUrl = await request('/api/customers/' + sourceId, admin);
  assert.equal(oldUrl.status, 200);
  assert.equal(oldUrl.data.id, targetId);
  assert.equal(oldUrl.data.merged_from_customer_id, sourceId);
  assert.equal(oldUrl.data.merged_cards[0].old_customer_id, sourceId);
  assert.equal((await request('/api/customers', admin)).data.length, 1);
  assert.equal((await request('/api/c/me?token=legacy-user-token')).status, 401);
  const body = { customer: { id: sourceId, name: 'שם ישן' }, order: { channel: 'משרד', totalWeight: 1.776 }, pallets: [{ items: [{ shapeId: 'straight', shapeName: 'ישר', diameter: 12, length: 1000, qty: 2 }] }] };
  const newOrder = await request('/api/orders', admin, body);
  assert.equal(newOrder.status, 200, JSON.stringify(newOrder.data));
  assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(newOrder.data.orderId).customer_id, targetId);
  assert.equal(db.prepare('SELECT name FROM customers WHERE id=?').get(targetId).name, 'ראשי');
  assert.equal((await request('/api/customers/merge/confirm', admin, confirmation)).data.alreadyMerged, true);
});
