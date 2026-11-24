'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { hashPin } = require('../auth-core');

test('finance ledger and invoice routes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-finance-routes-'));
  let close;
  t.after(async () => {
    try {
      await close?.();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(tmpDir, 'finance.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  const { db, server, closeServer } = require('../server');
  close = async () => {
    await new Promise((resolve, reject) => closeServer(err => err ? reject(err) : resolve()));
    db.close();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api';
  async function request(method, route, token, payload) {
    const response = await fetch(baseUrl + route, {
      method,
      headers: {
        ...(token && { Authorization: 'Bearer ' + token }),
        ...(payload !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }

  const pinHash = hashPin('1234', 4);
  const sessions = {};
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
  `);
  for (const role of ['finance', 'manager', 'admin', 'office']) {
    const username = 'finance-routes-' + role;
    const { lastInsertRowid: userId } = insertUser.run(username, username, role, pinHash);
    const login = await request('POST', '/auth/login', null, { username, pin: '1234' });
    assert.equal(login.status, 200);
    assert.ok(login.body.access_token);
    sessions[role] = { token: login.body.access_token, userId };
  }

  const finance = sessions.finance.token;
  const insertCustomer = db.prepare('INSERT INTO customers (name, tax_id) VALUES (?, ?)');
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_num, customer_id, status, sale_price) VALUES (?, ?, ?, ?)
  `);
  const insertInvoice = db.prepare(`
    INSERT INTO invoices (customer_id, invoice_num, total, status) VALUES (?, ?, ?, ?)
  `);
  const readInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?');
  const ledgerCustomer = insertCustomer.run('לקוח כרטסת', null).lastInsertRowid;

  await t.test('finance, manager and admin have access; unsigned and office requests are denied', async () => {
    const ledger = '/customers/' + ledgerCustomer + '/ledger';
    const credit = '/customers/' + ledgerCustomer + '/credit';
    for (const [method, route, payload] of [
      ['GET', ledger],
      ['PATCH', credit, { credit_limit: 1000 }],
      ['GET', '/invoices'],
      ['POST', '/invoices', { customer_id: ledgerCustomer, subtotal: 100 }],
      ['PATCH', '/invoices/1/pay', { paid_amount: 10 }],
      ['PATCH', '/invoices/1/cancel'],
      ['POST', '/invoices/1/link-orders', { order_ids: [1] }],
    ]) {
      assert.equal((await request(method, route, null, payload)).status, 401, method + ' ' + route);
      assert.equal((await request(method, route, sessions.office.token, payload)).status, 403, method + ' ' + route);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credit').get().n, 0);

    for (const role of ['finance', 'manager', 'admin']) {
      assert.equal((await request('GET', ledger, sessions[role].token)).status, 200, role);
      assert.equal((await request('GET', '/invoices', sessions[role].token)).status, 200, role);
    }
  });

  await t.test('ledger totals, credit limits and 70% and 90% alert thresholds', async () => {
    const otherCustomer = insertCustomer.run('לקוח נוסף', null).lastInsertRowid;
    const wip = insertOrder.run('TEST-WIP', ledgerCustomer, 'בייצור', 400).lastInsertRowid;
    const delivered = insertOrder.run('TEST-DELIVERED', ledgerCustomer, 'סופקה', 600).lastInsertRowid;
    const uncosted = insertOrder.run('TEST-UNCOSTED', ledgerCustomer, 'ממתין', 0).lastInsertRowid;
    const otherOrder = insertOrder.run('TEST-OTHER', otherCustomer, 'בייצור', 900).lastInsertRowid;

    const insertCost = db.prepare(`
      INSERT INTO order_costs (order_id, total_cost, revenue, tons_delivered) VALUES (?, ?, ?, ?)
    `);
    insertCost.run(wip, 200, 400, 0);
    insertCost.run(delivered, 300, 600, 2.5);
    insertCost.run(otherOrder, 900, 900, 9);
    const openInvoice = insertInvoice.run(ledgerCustomer, 'TEST-OPEN', 490, 'פתוחה').lastInsertRowid;
    insertInvoice.run(ledgerCustomer, 'TEST-PAID', 1000, 'שולמה');
    insertInvoice.run(ledgerCustomer, 'TEST-CANCELLED', 2000, 'ביטול');
    insertInvoice.run(otherCustomer, 'TEST-OTHER-CUSTOMER', 3000, 'פתוחה');

    const ledger = '/customers/' + ledgerCustomer + '/ledger';
    const credit = '/customers/' + ledgerCustomer + '/credit';
    const initial = await request('GET', ledger, finance);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.customer.id, ledgerCustomer);
    assert.equal(initial.body.credit.credit_limit, 100000);
    assert.deepEqual(initial.body.orders.map(order => order.id).sort((a, b) => a - b), [wip, delivered, uncosted]);
    assert.deepEqual(initial.body.summary, {
      total_orders: 3,
      totalRevenue: 1000,
      totalCost: 500,
      totalMargin: 500,
      avgMarginPct: 50,
      totalTons: 2.5,
    });

    const settings = { credit_limit: 1000, payment_terms: 45, notes: 'מסגרת מאושרת' };
    assert.equal((await request('PATCH', credit, finance, settings)).status, 200);
    const readCredit = db.prepare('SELECT * FROM customer_credit WHERE customer_id = ?');
    const savedCredit = readCredit.get(ledgerCustomer);
    for (const [key, value] of Object.entries(settings)) assert.equal(savedCredit[key], value);
    for (const payload of [{}, { credit_limit: -1 }, { credit_limit: null }, { credit_limit: 'abc' }, { credit_limit: true }]) {
      assert.equal((await request('PATCH', credit, finance, payload)).status, 400);
    }
    assert.deepEqual(readCredit.get(ledgerCustomer), savedCredit);
    assert.equal((await request('PATCH', '/customers/99999/credit', finance, settings)).status, 404);
    assert.equal(readCredit.get(99999), undefined);
    assert.equal((await request('GET', '/customers/99999/ledger', finance)).status, 404);

    const setInvoiceTotal = db.prepare('UPDATE invoices SET total = ? WHERE id = ?');
    for (const [debt, percent, alert] of [[490, 69, 'ok'], [500, 70, 'warning'], [690, 89, 'warning'], [700, 90, 'critical'], [900, 110, 'critical']]) {
      setInvoiceTotal.run(debt, openInvoice);
      const response = await request('GET', ledger, finance);
      assert.equal(response.status, 200);
      const {
        open_debt, wip_value, total_exposure, credit_available, credit_pct, credit_alert,
      } = response.body.credit;
      assert.deepEqual(
        { open_debt, wip_value, total_exposure, credit_available, credit_alert },
        {
          open_debt: debt,
          wip_value: 200,
          total_exposure: debt + 200,
          credit_available: Math.max(0, 800 - debt),
          credit_alert: alert,
        },
      );
      assert.ok(Math.abs(credit_pct - percent) < 1e-9);
      assert.equal(readCredit.get(ledgerCustomer).total_exposure, debt + 200);
    }
    assert.equal((await request('PATCH', credit, finance, { credit_limit: 0 })).status, 200);
    assert.equal(readCredit.get(ledgerCustomer).credit_limit, 0);
  });

  await t.test('invoice numbering, VAT, session attribution, payment and cancellation', async () => {
    const customer = insertCustomer.run('לקוח חשבוניות', '500000001').lastInsertRowid;
    const order = insertOrder.run('TEST-INVOICE', customer, 'סופקה', 100).lastInsertRowid;
    const year = new Date().getFullYear();
    insertInvoice.run(customer, 'INV-' + (year - 1) + '-00001', 1, 'פתוחה');

    const first = await request('POST', '/invoices', finance, {
      order_id: order, subtotal: 100, created_by: sessions.admin.userId,
    });
    assert.equal(first.status, 200);
    const { id, invoice_num } = first.body;
    assert.equal(invoice_num, 'INV-' + year + '-00001');
    assert.equal(first.body.total, 118);
    const invoice = readInvoice.get(id);
    assert.equal(invoice.order_num, 'TEST-INVOICE');
    assert.equal(invoice.customer_id, customer);
    assert.equal(invoice.customer_name, 'לקוח חשבוניות');
    assert.equal(invoice.customer_vat_id, '500000001');
    assert.equal(invoice.created_by, sessions.finance.userId);
    assert.equal(invoice.subtotal, 100);
    assert.equal(invoice.vat_rate, 0.18);
    assert.equal(invoice.vat_amount, 18);

    const second = await request('POST', '/invoices', sessions.manager.token, {
      customer_id: customer, subtotal: 100, vat_rate: 0,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.invoice_num, 'INV-' + year + '-00002');
    assert.equal(second.body.total, 100);
    assert.equal(readInvoice.get(second.body.id).vat_amount, 0);
    assert.equal(readInvoice.get(second.body.id).created_by, sessions.manager.userId);

    const pay = '/invoices/' + id + '/pay';
    const cancel = '/invoices/' + id + '/cancel';
    for (const payload of [{}, { paid_amount: 0 }, { paid_amount: -1 }, { paid_amount: null }, { paid_amount: 'abc' }, { paid_amount: true }]) {
      assert.equal((await request('PATCH', pay, finance, payload)).status, 400);
    }
    assert.deepEqual(readInvoice.get(id), invoice);

    const partial = await request('PATCH', pay, finance, {
      paid_amount: 40, payment_method: 'העברה', payment_ref: 'TEST-PAYMENT',
    });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.ok, true);
    assert.equal(partial.body.status, 'חלקית');
    assert.equal(partial.body.paid_amount, 40);

    const full = await request('PATCH', pay, finance, { paid_amount: 78 });
    assert.equal(full.status, 200);
    assert.equal(full.body.ok, true);
    assert.equal(full.body.status, 'שולמה');
    assert.equal(full.body.paid_amount, 118);
    const paidInvoice = readInvoice.get(id);
    assert.equal(paidInvoice.status, 'שולמה');
    assert.equal(paidInvoice.paid_amount, 118);
    assert.equal(paidInvoice.payment_method, 'העברה');
    assert.equal(paidInvoice.payment_ref, 'TEST-PAYMENT');
    assert.equal((await request('PATCH', cancel, finance)).status, 409);
    assert.deepEqual(readInvoice.get(id), paidInvoice);

    assert.equal((await request('PATCH', '/invoices/99999/cancel', finance)).status, 404);
    const secondRoute = '/invoices/' + second.body.id;
    assert.equal((await request('PATCH', secondRoute + '/cancel', finance)).status, 200);
    assert.equal((await request('PATCH', secondRoute + '/pay', finance, { paid_amount: 10 })).status, 409);
    assert.equal(readInvoice.get(second.body.id).status, 'ביטול');
    assert.equal(readInvoice.get(second.body.id).paid_amount, 0);

    const listed = await request('GET', '/invoices?customer_id=' + customer + '&order_id=' + order, finance);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map(row => row.id), [id]);
  });

  await t.test('link-orders persists billable orders and rejects mixed-customer requests atomically', async () => {
    const customer = insertCustomer.run('לקוח שיוך הזמנות', null).lastInsertRowid;
    const otherCustomer = insertCustomer.run('לקוח של הזמנה זרה', null).lastInsertRowid;
    const firstOrder = insertOrder.run('TEST-LINK-1', customer, 'סופקה', 100).lastInsertRowid;
    const secondOrder = insertOrder.run('TEST-LINK-2', customer, 'נמסרה', 200).lastInsertRowid;
    const otherOrder = insertOrder.run('TEST-LINK-OTHER', otherCustomer, 'סופקה', 300).lastInsertRowid;
    const invoice = insertInvoice.run(customer, 'TEST-LINK', 354, 'פתוחה').lastInsertRowid;
    const route = '/invoices/' + invoice + '/link-orders';

    assert.equal((await request('POST', route, finance, { order_ids: [] })).status, 400);
    assert.equal((await request('POST', '/invoices/99999/link-orders', finance, { order_ids: [firstOrder] })).status, 404);
    const rejected = await request('POST', route, finance, { order_ids: [firstOrder, otherOrder] });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body.rejectedOrderIds, [otherOrder]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_billing').get().n, 0);

    const linked = await request('POST', route, finance, { order_ids: [firstOrder, secondOrder] });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.invoice_id, invoice);
    assert.equal(linked.body.linked_count, 2);
    assert.equal(linked.body.linked_amount, 300);
    assert.deepEqual(db.prepare(`
      SELECT order_id, billed_amount, priority_invoice_ref FROM order_billing ORDER BY order_id
    `).all(), [
      { order_id: firstOrder, billed_amount: 100, priority_invoice_ref: 'TEST-LINK' },
      { order_id: secondOrder, billed_amount: 200, priority_invoice_ref: 'TEST-LINK' },
    ]);
  });
});
