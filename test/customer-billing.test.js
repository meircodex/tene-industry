'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openFinanceDb } = require('./helpers/finance-db');
const {
  getCustomerAccountSummary,
  createInvoiceDraftFromBillableOrders,
  linkInvoiceToOrders,
} = require('../services/customerBilling');

function setup(t) {
  const db = openFinanceDb(t);
  db.exec(`
    INSERT INTO customers (id, name, tax_id, payment_terms) VALUES
      (1, 'קבלן שלד', '515000000', 'שוטף 45'),
      (2, 'קבלן תשתיות', NULL, 'שוטף 30'),
      (3, 'קבלן פיתוח', NULL, 'שוטף 60');
    INSERT INTO customer_sites (id, customer_id, name) VALUES (1, 1, 'אתר דרום');
    INSERT INTO orders (id, order_num, customer_id, site_id, status, delivery_date,
      delivery_address, total_weight, billing_weight, sale_price, portal_price) VALUES
      (11, 'ORD-011', 1, 1, 'נמסרה', '2026-04-09', 'המסגר 12', 100.125, 103.129, 550, 560),
      (12, 'ORD-012', 1, 1, 'סופקה', '2026-04-08', NULL, 50, 51.5, NULL, 315.238),
      (13, 'ORD-013', 1, 1, 'בייצור', '2026-04-10', NULL, 150, 154.5, 800.55, NULL),
      (14, 'ORD-014', 1, 1, 'נשלחה', '2026-04-07', NULL, 200, 206, 1000, NULL),
      (15, 'ORD-015', 1, 1, 'נמסרה', '2026-04-07', NULL, 300, 309, 1500, NULL),
      (16, 'ORD-016', 2, NULL, 'נמסרה', '2026-04-07', NULL, 500, 515, 2500, NULL);
    INSERT INTO order_costs (order_id, revenue, total_cost) VALUES
      (11, 600.127, 480), (13, 875.55, 680.24);
    INSERT INTO order_billing (order_id, billed_amount) VALUES (14, 970);
    INSERT INTO invoices (id, invoice_num, customer_id, order_id, due_date, total, paid_amount, status) VALUES
      (21, 'INV-021', 1, 15, '2026-05-01', 1770.30, 500.10, 'חלקית'),
      (22, 'INV-022', 1, 12, '2026-04-15', 300, 0, 'ביטול'),
      (23, 'INV-023', 1, 14, '2026-04-20', 1144.60, 1144.60, 'שולמה'),
      (24, 'INV-024', 2, 16, '2026-04-19', 2950, 0, 'פתוחה'),
      (25, 'INV-025', 1, NULL, '2026-04-29', 265.75, 0, 'פתוחה');
    INSERT INTO customer_credit (customer_id, credit_limit, payment_terms, open_debt, wip_value)
      VALUES (1, 2200, 45, 100, 100);
    INSERT INTO credit_accounts (customer_id, credit_limit, payment_terms, blocked, block_reason)
      VALUES (1, 9999, 90, 1, 'חריגה ממסגרת'), (2, 5000, 30, 0, NULL);
  `);
  return db;
}

test('customer summary separates billable orders, open balances and work in progress', t => {
  const db = setup(t);
  const { customer, billableOrders, openInvoices, wip, credit } =
    getCustomerAccountSummary(db, { customer_id: '1' });

  assert.equal(customer.name, 'קבלן שלד');
  assert.deepEqual(billableOrders.rows.map(row => [row.id, row.site_name]), [[12, 'אתר דרום'], [11, 'אתר דרום']]);
  assert.equal(billableOrders.count, 2);
  assert.equal(billableOrders.totalWeightKg, 150.13);
  assert.equal(billableOrders.billingWeightKg, 154.63);
  assert.equal(billableOrders.expectedAmount, 915.37);
  assert.deepEqual(openInvoices.rows.map(row => [row.id, row.balance_due]), [[25, 265.75], [21, 1270.20]]);
  assert.equal(openInvoices.total, 2036.05);
  assert.equal(openInvoices.paidAmount, 500.10);
  assert.equal(openInvoices.openDebt, 1535.95);
  assert.deepEqual(wip.rows.map(row => row.id), [13]);
  assert.equal(wip.expectedAmount, 875.55);
  assert.equal(wip.estimatedCost, 680.24);
  assert.deepEqual(
    [credit.source, credit.creditLimit, credit.paymentTerms, credit.totalExposure, credit.creditAvailable,
      credit.creditOverLimit, credit.creditOverLimitAmount, credit.blocked, credit.blockReason],
    ['customer_credit', 2200, 45, 2411.50, -211.50, true, 211.50, true, 'חריגה ממסגרת'],
  );

  const second = getCustomerAccountSummary(db, { customer_id: 2 });
  assert.deepEqual([second.credit.source, second.credit.creditAvailable, second.credit.creditOverLimit], ['credit_accounts', 2050, false]);
  const third = getCustomerAccountSummary(db, { customer_id: 3 });
  assert.deepEqual([third.credit.source, third.credit.paymentTerms, third.credit.totalExposure], ['none', 'שוטף 60', 0]);
  assert.throws(() => getCustomerAccountSummary(db, { customer_id: 0 }), { message: 'invalid_customer_id', statusCode: 400 });
  assert.throws(() => getCustomerAccountSummary(db, { customer_id: 90 }), { message: 'customer_not_found', statusCode: 404 });
});

test('draft saves Hebrew order lines, tax, terms and the requested order selection', t => {
  const db = setup(t);
  const draft = createInvoiceDraftFromBillableOrders(db, { customer_id: 1, order_ids: ['11', 12, 11] });
  assert.match(draft.invoice_num, /^DRAFT-\d{4}-00001$/);
  assert.equal(draft.status, 'טיוטה');
  assert.deepEqual(draft.order_ids, [11, 12]);
  assert.deepEqual(draft.items.map(item => [item.order_id, item.description, item.amount]), [
    [12, 'הזמנה ORD-012', 315.24],
    [11, 'הזמנה ORD-011', 600.13],
  ]);
  assert.equal(draft.items[1].delivery_address, 'המסגר 12');
  assert.equal(draft.items[1].billing_weight_kg, 103.13);
  assert.deepEqual([draft.subtotal, draft.vat_rate, draft.vat_amount, draft.total], [915.37, 0.18, 164.77, 1080.14]);

  const stored = db.prepare('SELECT * FROM invoices WHERE id = ?').get(draft.id);
  assert.equal(stored.invoice_type, 'draft');
  assert.equal(stored.status, 'טיוטה');
  assert.equal(stored.customer_vat_id, '515000000');
  assert.equal(stored.order_id, null);
  assert.equal(stored.order_num, null);
  assert.deepEqual(JSON.parse(stored.items_json), draft.items);
  assert.equal(stored.due_date, draft.due_date);
  const due = new Date(`${stored.issue_date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 45);
  assert.equal(stored.due_date, due.toISOString().slice(0, 10));

  assert.equal(getCustomerAccountSummary(db, { customer_id: 1 }).billableOrders.count, 0);
  assert.throws(() => createInvoiceDraftFromBillableOrders(db, { customer_id: 1, order_ids: [11] }), {
    message: 'no_billable_orders', statusCode: 409, rejectedOrderIds: [11],
  });
  const linked = linkInvoiceToOrders(db, { invoice_id: draft.id, order_ids: [11, 12] });
  assert.equal(linked.linked_amount, 915.37);
});

test('draft rejects unavailable orders without inserting a partial invoice', t => {
  const db = setup(t);
  const invoiceCount = () => db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const before = invoiceCount();
  const create = order_ids => createInvoiceDraftFromBillableOrders(db, { customer_id: 1, order_ids });

  assert.throws(() => create([]), { message: 'order_ids_required', statusCode: 400 });
  assert.throws(() => create([13, 14, 15, 16]), {
    message: 'no_billable_orders', statusCode: 409, rejectedOrderIds: [13, 14, 15, 16],
  });
  assert.throws(() => create([11, 13, 16]), {
    message: 'some_orders_are_not_billable', statusCode: 409, rejectedOrderIds: [13, 16],
  });
  assert.equal(invoiceCount(), before);
  const draft = create([11]);
  assert.deepEqual(db.prepare('SELECT order_id, order_num FROM invoices WHERE id = ?').get(draft.id), {
    order_id: 11, order_num: 'ORD-011',
  });
});

test('linking rounds each order total once and blocks relinking even at a zero billed amount', t => {
  const db = setup(t);
  db.prepare('UPDATE invoices SET issue_date = ?, items_json = ? WHERE id = 25').run('2026-04-10', JSON.stringify([
    { order_id: 11, amount: 100.004 },
    { order_id: 11, amount: 25.004 },
    { order_id: 12, amount: 0 },
  ]));
  const link = (invoice_id, order_ids) => linkInvoiceToOrders(db, { invoice_id, order_ids });
  const result = link(25, ['12', 11, 12]);
  assert.equal(result.linked_count, 2);
  assert.equal(result.linked_amount, 125.01);
  assert.deepEqual(result.linked_orders.map(row => [row.order_id, row.billed_amount, row.billing_ref]), [
    [11, 125.01, 'INV-025'], [12, 0, 'INV-025'],
  ]);
  assert.deepEqual(db.prepare(`
    SELECT order_id, billed_amount, billed_date, priority_invoice_ref, billed_by
    FROM order_billing WHERE order_id IN (11, 12) ORDER BY order_id
  `).all(), [
    { order_id: 11, billed_amount: 125.01, billed_date: '2026-04-10', priority_invoice_ref: 'INV-025', billed_by: 'customerBilling' },
    { order_id: 12, billed_amount: 0, billed_date: '2026-04-10', priority_invoice_ref: 'INV-025', billed_by: 'customerBilling' },
  ]);
  for (const orderId of [11, 12]) {
    assert.throws(() => link(25, [orderId]), {
      message: 'no_billable_orders_to_link', statusCode: 409, rejectedOrderIds: [orderId],
    });
  }
  db.exec("INSERT INTO invoices (id, invoice_num, customer_id) VALUES (26, 'INV-026', 1)");
  assert.throws(() => link(26, [12]), {
    message: 'no_billable_orders_to_link', statusCode: 409, rejectedOrderIds: [12],
  });
  assert.equal(getCustomerAccountSummary(db, { customer_id: 1 }).billableOrders.count, 0);
});

test('linking rejects a mixed-customer selection atomically and falls back to order revenue', t => {
  const db = setup(t);
  const link = (invoice_id, order_ids) => linkInvoiceToOrders(db, { invoice_id, order_ids });
  assert.throws(() => link(25, [11, 16]), {
    message: 'some_orders_are_not_billable', statusCode: 409, rejectedOrderIds: [16],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_billing WHERE order_id IN (11, 16)').get().n, 0);
  assert.equal(db.prepare('SELECT order_id FROM invoices WHERE id = 25').get().order_id, null);
  assert.throws(() => link(25, [15]), { message: 'no_billable_orders_to_link', statusCode: 409, rejectedOrderIds: [15] });
  assert.throws(() => link(22, [11]), { message: 'invoice_is_closed', statusCode: 409 });
  assert.throws(() => link(23, [11]), { message: 'invoice_is_closed', statusCode: 409 });
  assert.throws(() => link(99, [11]), { message: 'invoice_not_found', statusCode: 404 });
  assert.throws(() => link(25, []), { message: 'order_ids_required', statusCode: 400 });
  assert.equal(link(25, [11]).linked_amount, 600.13);
  assert.deepEqual(db.prepare('SELECT order_id, order_num FROM invoices WHERE id = 25').get(), {
    order_id: 11, order_num: 'ORD-011',
  });
});
