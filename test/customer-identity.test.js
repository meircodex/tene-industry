'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { normalizeCustomerTaxId, validateCustomerTaxId, findCustomersByTaxId, ensureCustomerIdentityConstraints } = require('../services/customerIdentity');
const { resolveIntakeCustomer, buildIntakeOrderPayload, buildOrderImportPreview } = require('../services/intakeWorkflow');

test('tax ID normalization preserves leading zeroes and rejects invalid formats', () => {
  assert.equal(normalizeCustomerTaxId('\u200e 012-345 678\u00a0\r\n'), '012345678');
  assert.equal(validateCustomerTaxId('012-345-678'), '012345678');
  assert.equal(validateCustomerTaxId(null), null);
  for (const value of ['', null, '000000000', '12345678', '1234567890', '1234x6789', '12.3456789', '123/456789', {}]) {
    assert.throws(() => validateCustomerTaxId(value, { required: true }), error => error.statusCode === 400);
  }
});

test('database guards reject duplicate inserts and updates, while preserving legacy duplicate rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, tax_id TEXT)');
    const insert = db.prepare('INSERT INTO customers (name,tax_id) VALUES (?,?)');
    insert.run('ישן א', '012-345-678');
    insert.run('ישן ב', '012345678');
    insert.run('חסר מזהה', null);
    const before = db.prepare('SELECT * FROM customers').all();
    ensureCustomerIdentityConstraints(db);
    ensureCustomerIdentityConstraints(db);
    assert.deepEqual(db.prepare('SELECT * FROM customers').all(), before, 'migration must not delete or rewrite legacy data');
    assert.equal(findCustomersByTaxId(db, '012 345 678').length, 2);
    assert.throws(() => insert.run('כפול', '\u200e012 345-678'), /duplicate_customer_tax_id/);
    assert.throws(() => db.prepare('UPDATE customers SET tax_id=? WHERE id=3').run('012345678'), /duplicate_customer_tax_id/);
    db.prepare('UPDATE customers SET name=?, tax_id=? WHERE id=1').run('שם מעודכן', '012345678');
    db.prepare('UPDATE customers SET tax_id=? WHERE id=2').run('987654321');
    insert.run('עוד חסר מזהה', null);
    assert.equal(findCustomersByTaxId(db, '012345678').length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE tax_id IS NULL').get().n, 2);
  } finally { db.close(); }
});

test('intake uses tax ID before name or phone and never falls back to a different identity', () => {
  const existing = { id: 7, name: 'חברה', phone: '0500000000', tax_id: '512345678' };
  const match = resolveIntakeCustomer({ customer_name: 'שם אחר', customer_tax_id: '512-345678' }, '', {
    byTaxId: value => { assert.equal(value, existing.tax_id); return existing; },
    byName: () => assert.fail('must not select a customer by name when a tax ID was supplied'),
  });
  assert.equal(match.customer.id, 7);
  assert.equal(match.customer.match_type, 'tax_id');
  assert.equal(match.needs_customer_review, false);
  const missing = resolveIntakeCustomer({ customer_tax_id: '598765432', customer_phone: existing.phone }, '', {
    byTaxId: () => null, byPhone: () => assert.fail('tax-ID mismatch must not fall back to phone'),
  });
  assert.equal(missing.customer, null);
  assert.equal(missing.needs_customer_review, true);
  const payload = buildIntakeOrderPayload({ customer_name: 'שם אחר', customer_tax_id: existing.tax_id, items: [] }, { resolveCustomer: () => match.customer });
  assert.equal(payload.customer.id, 7);
  assert.equal(payload.customer.taxId, existing.tax_id);
});

test('CSV import carries tax IDs and does not combine different legal identities', () => {
  const header = 'customer_name,tax_id,diameter,length,qty\n';
  const same = buildOrderImportPreview(Buffer.from(header + 'שם א,512345678,12,1000,1\nשם ב,512345678,12,1000,2'));
  assert.equal(same.orders.length, 1);
  assert.equal(same.orders[0].payload.customer.taxId, '512345678');
  assert.equal(same.orders[0].payload.pallets[0].items.length, 2);
  const different = buildOrderImportPreview(Buffer.from(header + 'שם א,512345678,12,1000,1\nשם א,598765432,12,1000,2'));
  assert.equal(different.orders.length, 2);
  const conflict = buildOrderImportPreview(Buffer.from('order_num,' + header + '1,שם א,512345678,12,1000,1\n1,שם א,598765432,12,1000,2'));
  assert.equal(conflict.errors.length, 1);
});

function loadCustomerSaveClient(response = { ok: true, data: { id: 7 } }) {
  const html = fs.readFileSync(path.join(__dirname, '../public/customers.html'), 'utf8');
  const nodes = new Map();
  const calls = [];
  const element = () => ({ value: '', style: {}, children: [], textContent: '', hidden: false, disabled: false, focus() { this.focused = true; }, appendChild(child) { this.children.push(child); } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const context = vm.createContext({
    document: { getElementById: get, createElement: element }, window: { showToast() {} },
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: response.ok, json: async () => response.data }; },
    closeModal() {}, loadList: async () => {}, selectCustomer() {},
  });
  vm.runInContext(html.slice(html.indexOf('async function saveCustomer()'), html.indexOf('// close modal on backdrop click')), context);
  get('fName').value = 'לקוח בדיקה';
  return { get, calls, save: () => vm.runInContext('saveCustomer()', context) };
}

test('customer form requires and normalizes new tax IDs and prevents double submission', async () => {
  const client = loadCustomerSaveClient();
  await client.save();
  assert.equal(client.calls.length, 0);
  assert.equal(client.get('customerSaveError').hidden, false);
  assert.equal(client.get('fTaxId').focused, true);
  client.get('fTaxId').value = '012-345 678';
  const first = client.save();
  await client.save();
  await first;
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].body.taxId, '012345678');
  assert.equal(client.get('saveBtn').disabled, false);
});

test('customer form shows a working link to the existing account on duplicate ID', async () => {
  const client = loadCustomerSaveClient({ ok: false, data: { code: 'duplicate_customer_tax_id', error: 'קיים לקוח', existingCustomer: { id: 42 } } });
  client.get('fTaxId').value = '512345678';
  await client.save();
  assert.equal(client.get('customerSaveError').hidden, false);
  assert.equal(client.get('customerSaveError').children[0].href, '/customers.html?customer_id=42');
  assert.equal(client.get('saveBtn').disabled, false);
});

test('new-order form keeps tax ID through customer selection, draft restore and submission', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, { value: '', style: {} }); return nodes.get(id); };
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [] }, window: {},
    selectedCustomerSites: [], selectedCustomerAccountSummary: null,
    pallets: [{ items: [{ diameter: 12, qty: 2, length: 1000 }] }],
    setInputValue: (id, value) => { get(id).value = value; },
    setInputValueIfEmpty: (id, value) => { if (!get(id).value) get(id).value = value; },
    updateCustomerSummary() {}, updateDeliverySummary() {}, updateNotesSummary() {},
    renderPallets() {}, setCustomerState() {},
    calcPalletWeight: () => 1.776, calcItemWeight: () => 1.776, isSpiralOrderItem: () => false,
    draftAgeMs: () => 0, ORDER_DRAFT_MAX_AGE_MS: 1000,
    readOrderDraft: () => context.savedDraft,
    hydrateSelectedCustomer: (id, seed) => { context.hydratedSeed = seed; },
    alert: message => assert.fail(message), openCustomerDetails() {}, openDeliveryDetails() {},
  });
  for (const [startName, endName] of [
    ['clearSelectedCustomerBinding', 'onCustomerSearchInput'],
    ['applyCustomerDetails', 'applyCustomerSite'],
    ['captureOrderDraft', 'saveOrderDraftForCustomerHandoff'],
    ['restoreOrderDraft', 'clearOrderDraft'],
    ['buildOrderPayload', 'setActionButtonsBusy'],
  ]) {
    const start = html.indexOf('function ' + startName + '(');
    const end = html.indexOf('function ' + endName + '(', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(html.slice(start, end), context);
  }
  vm.runInContext("applyCustomerDetails({id:7,name:'חברה',tax_id:'012345678'})", context);
  assert.equal(get('customerTaxId').value, '012345678');
  get('deliveryAddress').value = 'כתובת';
  get('deliveryDate').value = '2026-10-01';
  vm.runInContext('savedDraft = captureOrderDraft(); clearSelectedCustomerBinding()', context);
  assert.equal(get('customerTaxId').value, '');
  assert.equal(vm.runInContext('restoreOrderDraft()', context), true);
  assert.equal(get('customerTaxId').value, '012345678');
  assert.equal(context.hydratedSeed.tax_id, '012345678');
  const payload = vm.runInContext('buildOrderPayload()', context);
  assert.equal(payload.customer.taxId, '012345678');
  assert.equal(payload.customer.id, 7);
});

test('edited customer and order pages have valid inline JavaScript', () => {
  for (const file of ['customers.html', 'index.html', 'intake.html', 'orders.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
    for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (script[1].trim()) assert.doesNotThrow(() => new vm.Script(script[1], { filename: file }));
    }
  }
});

test('customer identity HTTP flow preserves one account and its existing orders', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-customer-identity-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'customer-identity-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  process.env.DB_PATH = path.join(tmpDir, 'identity.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  const { server, db, closeServer } = require('../server');
  const { hashPin } = require('../auth-core');
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    const resolved = path.resolve(tmpDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tene-customer-identity-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  db.prepare(`INSERT INTO users (username,display_name,role,pin,pin_hash,active,password_changed_at) VALUES ('identity-office','Identity Office','office','1234',?,1,?)`)
    .run(hashPin('1234', 4), new Date().toISOString());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'identity-office', pin: '1234' }) });
  assert.equal(login.status, 200);
  const token = (await login.json()).access_token;
  const request = async (url, method = 'GET', body, authenticated = true) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  let firstId, secondId;
  await t.test('creating an account requires tax ID and keeps different IDs distinct despite equal names', async () => {
    assert.equal((await request('/api/customers', 'POST', { name: 'זהה' })).status, 400);
    const first = await request('/api/customers', 'POST', { name: 'זהה', taxId: '012-345 678', phone: '0500000000', portalCanCreateSites: true });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    firstId = first.data.id;
    const second = await request('/api/customers', 'POST', { name: 'זהה', taxId: '512345678' });
    assert.equal(second.status, 200);
    secondId = second.data.id;
    assert.notEqual(firstId, secondId);
    assert.equal(db.prepare('SELECT tax_id FROM customers WHERE id=?').get(firstId).tax_id, '012345678');
  });
  await t.test('duplicate creation and changing an ID to an existing one are rejected', async () => {
    const duplicate = await request('/api/customers', 'POST', { name: 'שם אחר לגמרי', taxId: '\u200e012 345-678' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_customer_tax_id');
    assert.equal(duplicate.data.existingCustomer.id, firstId);
    assert.equal((await request('/api/customers/' + secondId, 'PATCH', { taxId: '012345678' })).status, 409);
    assert.equal((await request('/api/customers/' + firstId, 'PATCH', { taxId: null })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  });
  await t.test('partial edits preserve identity, contacts, permissions and legacy order ownership', async () => {
    assert.equal((await request('/api/customers/' + firstId, 'PATCH', { name: 'חברה ראשית' })).status, 200);
    const row = db.prepare('SELECT * FROM customers WHERE id=?').get(firstId);
    assert.equal(row.tax_id, '012345678');
    assert.equal(row.phone, '0500000000');
    assert.equal(row.portal_can_create_sites, 1);
    const legacyId = db.prepare("INSERT INTO customers (name) VALUES ('לקוח ישן')").run().lastInsertRowid;
    const orderId = db.prepare("INSERT INTO orders (order_num,customer_id) VALUES ('IDENTITY-LEGACY',?)").run(legacyId).lastInsertRowid;
    assert.equal((await request('/api/customers/' + legacyId, 'PATCH', { taxId: '598765432' })).status, 200);
    assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(orderId).customer_id, legacyId);
    assert.equal((await request('/api/customers/999999', 'PATCH', { taxId: '511111111' })).status, 404);
  });
  await t.test('ID search resolves formatted identifiers and does not expose customer data without login', async () => {
    const found = await request('/api/customers?q=' + encodeURIComponent('012-345 678'));
    assert.equal(found.status, 200);
    assert.equal(found.data.length, 1);
    assert.equal(found.data[0].id, firstId);
    assert.equal(found.data[0].tax_id_duplicate, 0);
    assert.equal((await request('/api/customers?q=012345678', 'GET', undefined, false)).status, 401);
  });
  const payload = customer => ({ customer, order: { channel: 'משרד', deliveryDate: '2026-10-01', deliveryAddress: 'כתובת בדיקה', totalWeight: 1.776 }, pallets: [{ maxWeight: 500, items: [{ shapeId: 'straight', shapeName: 'ישר', diameter: 12, sides: [1000], length: 1000, qty: 2 }] }] });
  await t.test('orders with the same tax ID reuse the existing customer without renaming or duplicating it', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM customers').get().n;
    for (const name of ['שם שהוקלד אחרת', 'וריאציה נוספת']) {
      const response = await request('/api/orders', 'POST', payload({ name, phone: '0599999999', taxId: '012-345678' }));
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(response.data.orderId).customer_id, firstId);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, before);
    const customer = db.prepare('SELECT name,phone FROM customers WHERE id=?').get(firstId);
    assert.equal(customer.name, 'חברה ראשית');
    assert.equal(customer.phone, '0500000000');
  });
  await t.test('a conflicting customer selection is rejected atomically', async () => {
    const count = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    const response = await request('/api/orders', 'POST', payload({ id: firstId, name: 'חברה ראשית', taxId: '512345678' }));
    assert.equal(response.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, count);
  });
  await t.test('a quotation is linked to the existing customer by tax ID before approval', async () => {
    const quotePayload = payload({ name: 'שם אחר בהצעה', taxId: '012-345678', phone: '0599999999' });
    const response = await request('/api/order-quotes', 'POST', { payload: quotePayload });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(response.data.quote.customer_id, firstId);
    assert.equal(response.data.quote.payload.customer.id, firstId);
    assert.equal(response.data.quote.payload.customer.taxId, '012345678');
    const approved = await request('/api/order-quotes/' + response.data.quote.id + '/approve', 'POST', {});
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(approved.data.orderId).customer_id, firstId);
    const profile = db.prepare('SELECT name,phone FROM customers WHERE id=?').get(firstId);
    assert.equal(profile.name, 'חברה ראשית');
    assert.equal(profile.phone, '0500000000');
    assert.equal((await request('/api/order-quotes', 'POST', { payload: payload({ id: firstId, name: 'חברה ראשית', taxId: '512345678' }) })).status, 409);
  });
  await t.test('new identified orders persist their tax ID and subsequent orders reuse it', async () => {
    const first = await request('/api/orders', 'POST', payload({ name: 'לקוח חדש להזמנה', taxId: '523456789' }));
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const customerId = db.prepare('SELECT customer_id FROM orders WHERE id=?').get(first.data.orderId).customer_id;
    const second = await request('/api/orders', 'POST', payload({ name: 'שוב אותו לקוח', taxId: '523456789' }));
    assert.equal(second.status, 200);
    assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(second.data.orderId).customer_id, customerId);
    assert.equal(findCustomersByTaxId(db, '523456789').length, 1);
  });
});
