'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const axios = require('axios');
const Database = require('better-sqlite3');
const express = require('express');
const { ensureCoreSchema } = require('../db/coreSchema');
const { requireAnyRole } = require('../permissions');
const createPriorityExportRouter = require('../routes/priorityExport');
const {
  buildInvoiceExportPayload,
  buildDeliveryNoteExportPayload,
  exportAsFormat,
  linkExportToOrderBilling,
  recordExportLog,
} = require('../services/exportEngine');

// Quantities and diameters from the checked-in Tassa order 105 bending schedule.
const customerName = 'תקרה, שלב "ג"';
const invoiceDescription = 'ברזל לתקרה, קומה "ג"\nלפי תכנית';
const cardTitle = 'ברזל Ø8, תקרה "ג"';
const invoiceRef = 'INV-2026-00001';
const noteRef = 'DN-20261120-L1';
const date = '2026-11-20';

function exportFixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureCoreSchema(db);
  const customerId = db.prepare('INSERT INTO customers(name, priority_id) VALUES (?, ?)')
    .run(customerName, 'C105').lastInsertRowid;
  const insertOrder = db.prepare(`
    INSERT INTO orders(order_num, customer_id, priority_order_id, delivery_date, total_weight)
    VALUES (?, ?, ?, ?, ?)
  `);
  const orderId = insertOrder.run('105', customerId, 'P105', date, 139).lastInsertRowid;
  const secondOrderId = insertOrder.run('105-10', customerId, 'P105-10', date, 215.55).lastInsertRowid;
  const invoiceId = db.prepare(`
    INSERT INTO invoices(invoice_num, order_id, order_num, customer_id, issue_date, due_date,
                         items_json, subtotal, vat_amount, total)
    VALUES (?, ?, '105', ?, ?, '2026-12-20', ?, 417, 75.06, 492.06)
  `).run(invoiceRef, orderId, customerId, date, JSON.stringify([
    {
      type: 'order', order_id: orderId, order_num: '105', description: invoiceDescription,
      billing_weight_kg: 139, total_weight_kg: 135, amount: 417, delivery_date: date,
    },
    { description: 'פריקה באתר', quantity: 1, amount: 0 },
  ])).lastInsertRowid;
  const item = {
    card_key: '105:1', parent_item_id: 1, title: cardTitle, quantity: 51,
    weight: 139, diameter_mm: 8, total_length_mm: 6900, loading_card: true,
    order_id: orderId, order_num: '105',
  };
  const noteId = db.prepare(`
    INSERT INTO delivery_notes(note_num, order_id, order_num, customer_id, issued_at, delivered_at,
                               total_weight, packages_json, items_json, signed_by)
    VALUES (?, ?, '105', ?, ?, ?, 354.55, '[]', ?, 'מחסן')
  `).run(noteRef, orderId, customerId, date, date, JSON.stringify([
    item,
    { ...item, card_key: '105-10:10', parent_item_id: 10, weight: 215.55, total_length_mm: 10700,
      order_id: secondOrderId, order_num: '105-10' },
  ])).lastInsertRowid;
  const linkOrder = db.prepare(`
    INSERT INTO delivery_note_orders(delivery_note_id, order_id, order_num, total_weight) VALUES (?, ?, ?, ?)
  `);
  linkOrder.run(noteId, orderId, '105', 139);
  linkOrder.run(noteId, secondOrderId, '105-10', 215.55);
  return { db, customerId, orderId, secondOrderId, invoiceId, noteId };
}

test('invoice payload preserves references, amounts and Hebrew through JSON and CSV', t => {
  const { db, customerId, orderId, invoiceId } = exportFixture(t);
  const payload = buildInvoiceExportPayload(db, { invoice_id: String(invoiceId), destination: ' Priority ' });

  assert.equal(payload.documentType, 'invoice');
  assert.equal(payload.sourceId, invoiceId);
  assert.equal(payload.sourceRef, invoiceRef);
  assert.deepEqual(payload.destinationRefs, {
    customerRef: 'C105', orderRef: 'P105', existingDocumentRef: null,
  });
  assert.equal(payload.customer.id, customerId);
  assert.equal(payload.customer.name, customerName);
  assert.equal(payload.order.id, orderId);
  assert.equal(payload.dates.issueDate, date);
  assert.equal(payload.dates.dueDate, '2026-12-20');
  assert.deepEqual(payload.totals, { subtotal: 417, vatRate: 0.18, vatAmount: 75.06, total: 492.06, paidAmount: 0 });
  assert.deepEqual(payload.lines[0], {
    lineNo: 1, sourceType: 'order', sourceId: orderId, sourceRef: '105',
    description: invoiceDescription, quantity: 0.139, unit: 'ton', unitPrice: 3000,
    amount: 417, weightKg: 139, deliveryDate: date, siteName: null,
  });
  const json = exportAsFormat(payload);
  assert.ok(json.includes('ברזל לתקרה'));
  assert.deepEqual(JSON.parse(json), payload);
  assert.equal(exportAsFormat(payload, ' CSV '), [
    'destination,document_type,document_ref,customer_ref,customer_name,line_no,source_ref,description,quantity,unit,unit_price,amount,weight_kg',
    'priority,invoice,INV-2026-00001,C105,"תקרה, שלב ""ג""",1,105,"ברזל לתקרה, קומה ""ג""\nלפי תכנית",0.139,ton,3000,417,139',
    'priority,invoice,INV-2026-00001,C105,"תקרה, שלב ""ג""",2,,פריקה באתר,1,unit,0,0,0',
  ].join('\n'));
  assert.throws(() => exportAsFormat(payload, 'api'), { message: 'unsupported_export_format', statusCode: 400 });
});

test('delivery note exports loading cards and every linked order', t => {
  const { db, orderId, secondOrderId, noteId } = exportFixture(t);
  const payload = buildDeliveryNoteExportPayload(db, { delivery_note_id: noteId });
  assert.equal(payload.documentType, 'delivery_note');
  assert.equal(payload.sourceRef, noteRef);
  assert.deepEqual(payload.logistics, { deliveryId: null, driverId: null, signedBy: 'מחסן' });
  assert.deepEqual(payload.dates, { issuedAt: date, deliveredAt: date });
  assert.deepEqual(payload.totals, { totalWeightKg: 354.55 });
  assert.deepEqual(payload.linkedOrders, [
    { orderId, orderNum: '105', totalWeightKg: 139 },
    { orderId: secondOrderId, orderNum: '105-10', totalWeightKg: 215.55 },
  ]);
  assert.deepEqual(payload.lines[0], {
    lineNo: 1, sourceType: 'item', sourceId: 1, sourceRef: '105:1',
    description: cardTitle, quantity: 51, unit: 'unit', weightKg: 139, diameter: 8,
    zone: null, orderId, orderNum: '105',
  });
  assert.equal(payload.lines[1].orderId, secondOrderId);
  assert.deepEqual(JSON.parse(exportAsFormat(payload)), payload);
  assert.match(exportAsFormat(payload, 'csv'), /,1,105:1,"ברזל Ø8, תקרה ""ג""",51,unit,,,139\n/);
});

test('package snapshots take precedence over their underlying items', t => {
  const { db, noteId } = exportFixture(t);
  db.prepare('UPDATE delivery_notes SET packages_json = ? WHERE id = ?').run(
    JSON.stringify([{ id: 1, package_code: 'PKG-105-1', item_ids: [1, 10], quantity: 102, weight: 354.55 }]),
    noteId,
  );
  const payload = buildDeliveryNoteExportPayload(db, { delivery_note_id: noteId, destination: 'hashovshevet' });
  assert.equal(payload.destination, 'hashovshevet');
  assert.deepEqual(payload.destinationRefs, { customerRef: null, orderRef: null, existingDocumentRef: null });
  assert.deepEqual(payload.lines, [{
    lineNo: 1, sourceType: 'package', sourceId: 1, sourceRef: 'PKG-105-1',
    description: 'PKG-105-1', quantity: 102, unit: 'unit', weightKg: 354.55,
    diameter: null, zone: null, orderId: null, orderNum: null,
  }]);
});

test('export log stores payload, status, reference and actor', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const payload = { documentType: 'invoice', sourceId: 1, sourceRef: invoiceRef, customer: { name: customerName } };
  const result = recordExportLog(db, {
    payload, exportFormat: 'CSV', status: 'exported', externalRef: invoiceRef, exportedBy: 7, exportedAt: date,
  });
  assert.deepEqual(result, {
    id: 1, destination: 'priority', entity_type: 'invoice', entity_id: 1, export_format: 'csv', status: 'exported',
  });
  const row = db.prepare('SELECT * FROM export_log WHERE id = ?').get(result.id);
  assert.deepEqual(JSON.parse(row.payload_json), payload);
  assert.equal(row.external_ref, invoiceRef);
  assert.equal(row.exported_by, 7);
  assert.equal(row.exported_at, date);
  assert.throws(() => recordExportLog(db, { payload: { documentType: 'invoice' } }), {
    message: 'invalid_export_log_entity', statusCode: 400,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM export_log').get().count, 1);
});

test('invoice and delivery-note billing links update the same order rows', t => {
  const { db, orderId, secondOrderId, invoiceId, noteId } = exportFixture(t);
  const readBilling = () => db.prepare(`
    SELECT id, order_id, order_num, billed_amount, billed_date, priority_invoice_ref, billed_by, billing_notes
    FROM order_billing ORDER BY order_id
  `).all();
  const invoice = linkExportToOrderBilling(db, {
    entity_type: 'invoice', entity_id: invoiceId, priority_ref: '  P-INV-105  ', billed_date: date, exported_by: 'finance',
  });
  assert.deepEqual(invoice.linked_orders, [
    { order_id: orderId, order_num: '105', billed_amount: 417, priority_ref: 'P-INV-105' },
  ]);
  const [original] = readBilling();
  assert.equal(original.billed_date, date);
  assert.equal(original.billed_by, 'finance');
  assert.equal(original.billing_notes, `Linked from invoice export ${invoiceId}`);

  const note = linkExportToOrderBilling(db, {
    entity_type: 'delivery_note', entity_id: noteId, priority_ref: 'P-DN-105', billed_amount: 1063.65, billed_date: date,
  });
  assert.equal(note.linked_count, 2);
  assert.equal(note.linked_amount, 1063.65);
  assert.deepEqual(note.linked_orders, [
    { order_id: orderId, order_num: '105', billed_amount: 417, priority_ref: 'P-DN-105' },
    { order_id: secondOrderId, order_num: '105-10', billed_amount: 646.65, priority_ref: 'P-DN-105' },
  ]);
  const rows = readBilling();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, original.id);
  assert.deepEqual(rows.map(row => [row.order_id, row.billed_amount, row.priority_invoice_ref]), [
    [orderId, 417, 'P-DN-105'], [secondOrderId, 646.65, 'P-DN-105'],
  ]);
  assert.equal(rows[1].billed_by, 'exportEngine');
  assert.throws(() => linkExportToOrderBilling(db, {
    entity_type: 'order_billing', entity_id: original.id, priority_ref: ' ',
  }), { message: 'priority_ref_required', statusCode: 400 });
  assert.deepEqual(readBilling(), rows);
});

test('billing link rolls back when an invoice line points at a missing order', t => {
  const { db, invoiceId } = exportFixture(t);
  const { items_json } = db.prepare('SELECT items_json FROM invoices WHERE id = ?').get(invoiceId);
  const lines = JSON.parse(items_json);
  lines.push({ type: 'order', order_id: 999, order_num: '999', amount: 75 });
  db.prepare('UPDATE invoices SET items_json = ? WHERE id = ?').run(JSON.stringify(lines), invoiceId);

  assert.throws(() => linkExportToOrderBilling(db, {
    entity_type: 'invoice', entity_id: invoiceId, priority_ref: 'P-INV-105', billed_date: date,
  }), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_billing').get().count, 0);
});

async function serveExports(t, db, enabled) {
  const app = express();
  app.use((req, res, next) => {
    const role = req.get('x-test-role');
    if (role) req.auth = { role, sub: '7' };
    next();
  });
  app.use('/api', createPriorityExportRouter({ db, requireAnyRole, PRIORITY_ENABLED: enabled }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/api/priority/export`;
  return (path, { role = 'finance', method = 'GET' } = {}) =>
    fetch(origin + path, { method, headers: role ? { 'x-test-role': role } : {}, signal: AbortSignal.timeout(5000) });
}

test('download routes return JSON and CSV and log authorized exports only', async t => {
  const { db, invoiceId, noteId } = exportFixture(t);
  const request = await serveExports(t, db, false);
  const noAuth = await request(`/invoices/${invoiceId}.json`, { role: null });
  assert.equal(noAuth.status, 401);
  await noAuth.text();
  const forbidden = await request(`/delivery-notes/${noteId}.csv`, { role: 'office' });
  assert.equal(forbidden.status, 403);
  await forbidden.text();

  for (const [path, sourceRef, description, type] of [
    [`/invoices/${invoiceId}`, invoiceRef, invoiceDescription, 'invoice'],
    [`/delivery-notes/${noteId}`, noteRef, cardTitle, 'delivery_note'],
  ]) {
    const json = await request(path + '.json?destination=hashovshevet');
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /^application\/json/);
    const { exportLog, ...payload } = await json.json();
    assert.equal(payload.documentType, type);
    assert.equal(payload.sourceRef, sourceRef);
    assert.equal(payload.lines[0].description, description);
    assert.equal(payload.destination, 'hashovshevet');
    assert.equal(exportLog.status, 'exported');
    const stored = db.prepare('SELECT * FROM export_log WHERE id = ?').get(exportLog.id);
    assert.equal(stored.exported_by, 7);
    assert.ok(Number.isFinite(Date.parse(stored.exported_at)));
    assert.deepEqual(JSON.parse(stored.payload_json), payload);

    const csv = await request(path + '.csv');
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(csv.headers.get('content-disposition'), `attachment; filename="${sourceRef}.csv"`);
    assert.ok((await csv.text()).includes(`priority,${type},${sourceRef},C105,"תקרה, שלב ""ג"""`));
  }

  db.prepare(`INSERT INTO delivery_note_cancellations(note_id, reason, restored_items_json)
              VALUES (?, 'תיקון תעודה', '[]')`).run(noteId);
  for (const [path, status, error] of [
    ['/invoices/0.json', 400, 'invalid_invoice_id'],
    ['/invoices/999.csv', 404, 'invoice_not_found'],
    ['/delivery-notes/999.json', 404, 'delivery_note_not_found'],
    [`/delivery-notes/${noteId}.csv`, 409, 'delivery_note_cancelled'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  assert.deepEqual(db.prepare('SELECT entity_type, export_format FROM export_log ORDER BY id').all(), [
    { entity_type: 'invoice', export_format: 'json' },
    { entity_type: 'invoice', export_format: 'csv' },
    { entity_type: 'delivery_note', export_format: 'json' },
    { entity_type: 'delivery_note', export_format: 'csv' },
  ]);
});

test('send routes record drafts or failed attempts without calling Priority', async t => {
  const { db, invoiceId, noteId } = exportFixture(t);
  const create = t.mock.method(axios, 'create', () => assert.fail('Unexpected Priority HTTP client'));
  const disabled = await serveExports(t, db, false);
  const enabled = await serveExports(t, db, true);

  for (const [path, type, id] of [
    [`/invoices/${invoiceId}/send`, 'invoice', invoiceId],
    [`/delivery-notes/${noteId}/send`, 'delivery_note', noteId],
  ]) {
    for (const [request, status, code, logStatus] of [
      [disabled, 200, 'priority_disabled', 'draft'],
      [enabled, 501, 'priority_send_not_implemented', 'failed'],
    ]) {
      const response = await request(path, { method: 'POST' });
      assert.equal(response.status, status);
      const result = await response.json();
      assert.equal(result.success, false);
      assert.equal(result.sent, false);
      assert.equal(result.code, code);
      assert.deepEqual(result.exportLog, {
        id: result.exportLog.id, destination: 'priority', entity_type: type, entity_id: id,
        export_format: 'api', status: logStatus,
      });
      const row = db.prepare('SELECT * FROM export_log WHERE id = ?').get(result.exportLog.id);
      assert.equal(row.exported_by, 7);
      assert.equal(row.external_ref, null);
      const payload = JSON.parse(row.payload_json);
      assert.equal(payload.sourceId, id);
      assert.equal(payload.documentType, type);
      if (logStatus === 'draft') {
        assert.equal(row.exported_at, null);
        assert.equal(row.error_message, null);
      } else {
        assert.ok(Number.isFinite(Date.parse(row.exported_at)));
        assert.equal(row.error_message, result.message);
        assert.deepEqual(payload, result.payload);
      }
    }
  }
  assert.equal(create.mock.callCount(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM export_log').get().count, 4);
});
