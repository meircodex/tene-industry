'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const ai = require('../ai');
const { ITEM_STATUS } = require('../status-contracts');

const tmpDir = mkdtempSync(path.join(tmpdir(), 'tene-inventory-vision-'));
const signingKey = randomBytes(32).toString('hex');
const stubKey = 'unused-axios-stub';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = signingKey;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_API_KEY_LOCAL = '';

const { app, closeServer, db, server } = require('../server');
const image = readFileSync(path.join(__dirname, '../public/brand/tene-pdf-logo.jpg'));
const pdf = readFileSync(path.join(__dirname, 'fixtures/fault-two-pages.pdf'));

const bending = 'analyze-bending-shape';
const label = 'scan-label';
const receipt = 'receipt-reviews/analyze';
const uploadImage = [image, 'image/jpeg', 'tene-pdf-logo.jpg'];
const uploadPdf = [pdf, 'application/pdf', 'fault-two-pages.pdf'];
const uploadText = [Buffer.from('קובץ טקסט'), 'text/plain', 'note.txt'];

const tokens = {};
let warehouseId;
let nextClient = 0;

test.before(async () => {
  // Each group gets its own client address behind a loopback-only proxy.
  app.set('trust proxy', 'loopback');
  const insert = db.prepare('INSERT INTO users (username, display_name, role, active) VALUES (?, ?, ?, 1)');
  for (const role of ['warehouse', 'office', 'manager', 'admin', 'production']) {
    const user = insert.run('vision-' + role, role, role);
    tokens[role] = jwt.sign({ sub: String(user.lastInsertRowid), role }, signingKey);
    if (role === 'warehouse') warehouseId = user.lastInsertRowid;
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

test.after(async () => {
  await new Promise((resolve, reject) => closeServer(error => error ? reject(error) : resolve()));
  ai.init(null);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function client() {
  const address = `192.0.2.${++nextClient}`;
  return async (route, expectedStatus, { role = 'warehouse', file } = {}) => {
    const headers = { 'X-Forwarded-For': address };
    if (role) headers.Authorization = `Bearer ${tokens[role]}`;
    const body = new FormData();
    if (file) {
      const [bytes, type, name] = file;
      body.set('image', new Blob([bytes], { type }), name);
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/inventory/${route}`, {
      method: 'POST', headers, body,
    });
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, `${route}: ${JSON.stringify(payload)}`);
    return payload;
  };
}

function configureVision(enabled, key = '') {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  set.run('INTAKE_AI_ENABLED', String(enabled));
  set.run('OPENAI_API_KEY', key);
  set.run('OPENAI_MODEL', 'vision-test-model');
}

function modelResponse(value) {
  return { data: { output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } };
}

function stubModel(t, respond = () => assert.fail('Unexpected call to the model')) {
  return t.mock.method(axios, 'post', async (url, body, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${stubKey}`);
    assert.equal(body.model, 'vision-test-model');
    assert.equal(body.text.format.strict, true);
    return respond(body);
  });
}

test('document routes reject disabled recognition, missing keys and invalid uploads', async t => {
  const post = client();
  const model = stubModel(t);
  for (const route of [bending, receipt]) {
    configureVision(false);
    assert.equal((await post(route, 501, { file: uploadPdf })).feature, 'intake-ai');
    configureVision(true);
    assert.match((await post(route, 500, { file: uploadPdf })).error, /OPENAI_API_KEY/);
    configureVision(true, stubKey);
    assert.match((await post(route, 400)).error, /required/);
    assert.match((await post(route, 400, { file: uploadText })).error, /images and PDFs/);
  }
  assert.equal(model.mock.callCount(), 0);
});

test('inventory vision requires authentication and permits the warehouse, office, manager and admin roles', async t => {
  const model = stubModel(t);
  configureVision(false);
  for (const route of [bending, label, receipt]) {
    const post = client();
    assert.ok((await post(route, 401, { role: null, file: uploadImage })).error);
    assert.ok((await post(route, 403, { role: 'production', file: uploadImage })).error);
    for (const role of ['warehouse', 'office', 'manager', 'admin']) {
      const body = await post(route, route === label ? 200 : 501, { role, file: uploadImage });
      if (route === label) assert.equal(body.aiUsed, false);
    }
  }
  assert.equal(model.mock.callCount(), 0);
});

test('scan-label requires an image and returns manual entry when recognition is unavailable', async t => {
  const post = client();
  const model = stubModel(t);
  configureVision(true, stubKey);
  assert.equal((await post(label, 400)).error, 'נדרשת תמונה');
  assert.equal((await post(label, 400, { file: uploadText })).error, 'נתמכות תמונות בלבד');

  for (const [enabled, key] of [[false, stubKey], [true, '']]) {
    configureVision(enabled, key);
    const manual = await post(label, 200, { file: uploadImage });
    assert.equal(manual.success, true);
    assert.equal(manual.aiUsed, false);
    assert.deepEqual(manual.data, {
      diameter: null, lot_number: null, weight_kg: null, grade: 'B500B',
      material_type: 'coil', certificate_num: null, notes: null,
    });
  }
  assert.equal(model.mock.callCount(), 0);
});

test('scan-label resolves the supplier and leaves unread fields empty', async t => {
  configureVision(true, stubKey);
  const supplierName = 'פלדה למלאי';
  const supplierId = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(supplierName).lastInsertRowid;
  const model = stubModel(t, body => {
    assert.equal(body.text.format.name, 'label_scan');
    assert.deepEqual(body.input[0].content[1], {
      type: 'input_image', image_url: `data:image/jpeg;base64,${image.toString('base64')}`, detail: 'high',
    });
    return modelResponse({
      diameter: 12, lot_number: 'HEAT-12', weight_kg: null, grade: null, material_type: null,
      certificate_num: null, supplier_name: supplierName, notes: null, confidence: 0.85,
    });
  });
  const result = await client()(label, 200, { file: uploadImage });
  assert.equal(model.mock.callCount(), 1);
  assert.equal(result.aiUsed, true);
  assert.equal(result.confidence, 0.85);
  assert.deepEqual(result.data, {
    diameter: 12, lot_number: 'HEAT-12', weight_kg: null, grade: 'B500B', material_type: 'coil',
    certificate_num: null, supplier_name: supplierName, supplier_id: supplierId, notes: null,
  });
});

test('bending-shape recognition forwards the PDF and recalculates length from segments', async t => {
  configureVision(true, stubKey);
  const segments = [{ length_mm: 400, angle_deg: 90 }, { length_mm: 600, angle_deg: 180 }];
  const model = stubModel(t, body => {
    assert.equal(body.text.format.name, 'ironbend_bending_shape');
    assert.deepEqual(body.input[0].content[1], {
      type: 'input_file', filename: uploadPdf[2], file_data: `data:application/pdf;base64,${pdf.toString('base64')}`,
    });
    return modelResponse({
      shape_name: ' זווית ', diameter: 12, material_grade: 'B500B', segments,
      total_length_mm: 900, confidence: 1, notes: null,
    });
  });
  const result = await client()(bending, 200, { file: uploadPdf });
  assert.equal(model.mock.callCount(), 1);
  assert.equal(result.success, true);
  assert.equal(result.shape_name, 'זווית');
  assert.equal(result.diameter, 12);
  assert.deepEqual(result.segments, segments);
  assert.equal(result.total_length_mm, 1000);
});

test('bending-shape recognition returns 422 when no usable segments are found', async t => {
  configureVision(true, stubKey);
  const model = stubModel(t, body => {
    assert.equal(body.input[0].content[1].type, 'input_image');
    return modelResponse({ segments: [] });
  });
  assert.equal((await client()(bending, 422, { file: uploadImage })).error, 'No bending shape was recognized');
  assert.equal(model.mock.callCount(), 1);
});

test('receipt OCR creates one draft with normalized lines and leaves stock untouched', async t => {
  configureVision(true, stubKey);
  const supplierName = 'ספק תעודות מלאי';
  const insert = db.prepare('INSERT INTO suppliers (name, active) VALUES (?, ?)');
  insert.run(supplierName, 0);
  const supplierId = insert.run(supplierName, 1).lastInsertRowid;
  const model = stubModel(t, body => {
    assert.equal(body.text.format.name, 'ironbend_supplier_receipt');
    assert.equal(body.input[0].content[1].type, 'input_file');
    return modelResponse({
      supplier_name: supplierName, delivery_note_num: 'DN-100', received_date: '2026-06-02', notes: null,
      items: [{
        material_type: 'coil', diameter: 12, lot_number: 'HEAT-100', certificate_num: 'CERT-100',
        grade: 'B500B', weight_kg: 1200, purchase_price: null, warehouse_loc: null, shape_name: null,
        segments: [], confidence: 0.95, notes: null,
      }],
    });
  });
  const post = client();
  const stock = db.prepare('SELECT COUNT(*) FROM raw_material').pluck();
  const beforeStock = stock.get();
  const result = await post(receipt, 200, { file: uploadPdf });
  assert.equal(result.id, result.receipt_id);
  assert.deepEqual(db.prepare(`
    SELECT status, source_type, supplier_id, delivery_note_num, created_by
    FROM pending_raw_material_receipts_v2 WHERE id = ?
  `).get(result.id), {
    status: 'draft', source_type: 'ocr', supplier_id: supplierId, delivery_note_num: 'DN-100', created_by: warehouseId,
  });
  assert.deepEqual(db.prepare(`
    SELECT source_line_ref, diameter, lot_number, certificate_num, weight_received
    FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id = ?
  `).all(result.id), [{
    source_line_ref: 'ocr-1', diameter: 12, lot_number: 'HEAT-100', certificate_num: 'CERT-100', weight_received: 1200,
  }]);
  assert.equal(result.parsed.items[0].received_date, '2026-06-02');
  assert.equal((await post(receipt, 200, { file: uploadPdf })).receipt_id, result.id);
  assert.equal(model.mock.callCount(), 2);
  assert.equal(stock.get(), beforeStock);
});

test('malformed model JSON returns endpoint-specific errors without creating receipts', async t => {
  configureVision(true, stubKey);
  const model = stubModel(t, () => ({
    data: { output: [{ content: [{ type: 'output_text', text: '{' }] }] },
  }));
  const post = client();
  const receipts = db.prepare('SELECT COUNT(*) FROM pending_raw_material_receipts_v2').pluck();
  const before = receipts.get();
  assert.match((await post(bending, 500, { file: uploadImage })).error, /^Bending shape recognition failed/);
  const manual = await post(label, 200, { file: uploadImage });
  assert.equal(manual.aiUsed, false);
  assert.ok(manual.aiError);
  assert.equal(manual.data.weight_kg, null);
  assert.equal((await post(receipt, 502, { file: uploadImage })).error, 'Supplier delivery note recognition failed');
  assert.equal(receipts.get(), before);
  assert.equal(model.mock.callCount(), 3);
});

const registerItem = (overrides = {}) => {
  const item = {
    machine: 'מכונה א', diameter: 12, quantity: 100, total_weight: 200, actual_waste: 0,
    status: ITEM_STATUS.DONE, started_at: '2026-06-01T09:00:00.000Z',
    completed_at: '2026-06-01T09:10:00.000Z', ...overrides,
  };
  db.prepare(`
    INSERT INTO items (machine, diameter, quantity, total_weight, actual_waste, status, started_at, completed_at)
    VALUES (@machine, @diameter, @quantity, @total_weight, @actual_waste, @status, @started_at, @completed_at)
  `).run(item);
};

function resetItems(t) {
  t.after(() => db.prepare('DELETE FROM items').run());
}

test('production prediction scales historical cycles and falls back to diameter and bend count', t => {
  resetItems(t);
  for (const quantity of [80, 100, 120]) registerItem({ quantity });
  registerItem({ quantity: 900, machine: 'מכונה ב' });
  registerItem({ quantity: 900, started_at: null });
  registerItem({ quantity: 900, status: ITEM_STATUS.WAITING });
  registerItem({ diameter: 16, machine: 'מכונה ב' });
  registerItem({ diameter: 16, machine: 'מכונה ב' });

  const result = ai.predictProductionTime([
    { id: 1, shape_name: 'ישר', diameter: 12, machine: 'מכונה א', quantity: 300, production_qty: 200 },
    { id: 2, shape_name: 'זווית', diameter: 16, machine: 'מכונה ב', quantity: 50,
      segments: JSON.stringify([{ length_mm: 400, angle_deg: 90 }, { length_mm: 600, angle_deg: 180 }]) },
    { id: 3, shape_name: 'ישר', diameter: 25, machine: 'מכונה ב', quantity: 50, segments: 'null' },
  ]);
  assert.deepEqual(result, {
    estimatedMinutes: 40, confidence: 25, breakdown: [
      { itemId: 1, shapeName: 'ישר', diameter: 12, machine: 'מכונה א', quantity: 300, estimatedMinutes: 20, confidence: 15 },
      { itemId: 2, shapeName: 'זווית', diameter: 16, machine: 'מכונה ב', quantity: 50, estimatedMinutes: 8.5, confidence: 30 },
      { itemId: 3, shapeName: 'ישר', diameter: 25, machine: 'מכונה ב', quantity: 50, estimatedMinutes: 11, confidence: 30 },
    ],
  });
});

test('delivery feasibility applies the buffer and distinguishes tight and missed deadlines', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 5, 1, 17, 0) });
  const items = quantity => [{ diameter: 10, machine: 'מכונה ג', quantity, segments: '[' }];
  const delivery = { delivery_date: '2026-06-01' };
  assert.deepEqual(ai.checkDeliveryFeasibility({}, items(350)), { feasible: true, warning: null });
  assert.deepEqual(ai.checkDeliveryFeasibility(delivery, items(350)), {
    feasible: true, estimatedMinutes: 30, hoursUntilDeadline: 1, confidence: 30, warning: null,
  });
  const tight = ai.checkDeliveryFeasibility(delivery, items(500));
  assert.equal(tight.feasible, true);
  assert.match(tight.warning, /הזמנה בגבול/);
  const missed = ai.checkDeliveryFeasibility(delivery, items(625));
  assert.equal(missed.feasible, false);
  assert.match(missed.warning, /צפי ייצור: 52.*60 דק'/);
});

test('waste analysis groups completed samples by machine and diameter and skips singletons', t => {
  resetItems(t);
  registerItem({ quantity: 100, actual_waste: 10, diameter: 12.5 });
  registerItem({ quantity: 50, actual_waste: 10 });
  registerItem({ diameter: 16, actual_waste: 20 });
  registerItem({ machine: 'מכונה ב', actual_waste: 1 });
  registerItem({ machine: 'מכונה ב', actual_waste: 3 });
  registerItem({ actual_waste: -1 });
  registerItem({ actual_waste: 90, status: ITEM_STATUS.WAITING });

  assert.deepEqual(ai.analyzeWastePatterns(), [
    { machine: 'מכונה א', diameter: 12, item_count: 2, total_ordered: 150, total_waste: 20, waste_pct: 13.3, avg_waste_pct_per_item: 15 },
    { machine: 'מכונה ב', diameter: 12, item_count: 2, total_ordered: 200, total_waste: 4, waste_pct: 2, avg_waste_pct_per_item: 2 },
  ]);
});

test('machine efficiency aggregates completed work in the selected date window', t => {
  resetItems(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-08T09:00:00.000Z') });
  registerItem({ actual_waste: 5 });
  registerItem({ quantity: 50, total_weight: 100, actual_waste: 10, started_at: null, completed_at: '2026-06-08T08:00:00.000Z' });
  registerItem({ machine: 'מכונה ב', started_at: '2026-06-01 09:00:00', completed_at: '2026-06-01 09:10:00' });
  registerItem({ completed_at: '2026-06-01T08:59:59.999Z' });
  registerItem({ status: ITEM_STATUS.WAITING });

  const machineA = { machine: 'מכונה א', completed_items: 2, total_units: 150, total_weight_kg: 300, avg_cycle_min: 10, waste_pct: 10 };
  assert.deepEqual(ai.getMachineEfficiency(), [
    machineA,
    { machine: 'מכונה ב', completed_items: 1, total_units: 100, total_weight_kg: 200, avg_cycle_min: 10, waste_pct: 0 },
  ]);
  assert.deepEqual(ai.getMachineEfficiency(1), [
    { ...machineA, completed_items: 1, total_units: 50, total_weight_kg: 100, avg_cycle_min: null, waste_pct: 20 },
  ]);
});

test('AI helpers return empty defaults before database initialization', t => {
  ai.init(null);
  t.after(() => ai.init(db));
  assert.deepEqual(ai.predictProductionTime([]), { estimatedMinutes: 0, confidence: 0, breakdown: [] });
  assert.deepEqual(ai.checkDeliveryFeasibility({ delivery_date: '2026-06-01' }, []), { feasible: true, warning: null });
  assert.deepEqual(ai.analyzeWastePatterns(), []);
  assert.deepEqual(ai.getMachineEfficiency(), []);
});
