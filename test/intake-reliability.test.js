const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const axios = require('axios');
const workflow = require('../services/intakeWorkflow');
const confidence = require('../public/intake-confidence');
function createIntakeRouter(deps) {
  // The legacy module owns a singleton Express router; isolate each test app.
  delete require.cache[require.resolve('../routes/intake')];
  return require('../routes/intake')(deps);
}
const createReviewRouter = require('../routes/intakeReview');
const parser = require('../services/steelDocumentParser');
const allow = () => (req, res, next) => next();

function database(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE intake_log (id INTEGER PRIMARY KEY, source, source_system, external_id, raw_content, parsed_data, original_filename, original_mime, original_data_url, status, order_id);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_num);
    CREATE TABLE intake_training_examples (title, document_type, problem_text, correction_text);`);
  t.after(() => db.close());
  return db;
}
async function serve(t, router) {
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(body + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
const bentItem = { shape_name: 'L angle', diameter: 12, quantity: 20, total_length_mm: 2400, segments: [{ length_mm: 400, angle_deg: 90 }, { length_mm: 2000, angle_deg: 0 }] };
function recognitionDeps(db, key = 'test-key') {
  return { db, requireAnyRole: allow, analyzeImageAuthorization: allow(), imageAnalysisLimiter: allow(), upload: multer({ storage: multer.memoryStorage() }), getSetting: () => 'true', getOpenAiApiKey: () => key, getIntakeTrainingGuidance: () => '', normalizeFactorySegments: (shape, segments) => segments, normalizeFactoryShapeName: name => name, INTAKE_AI_ENABLED: true, intake: {}, intakeWorkflow: workflow, wsBroadcast: () => {} };
}

test('recognition confidence is real, item-scoped and unknown when absent', () => {
  assert.equal(confidence.itemScore({ items: [bentItem] }, 0), null);
  const parsed = { items: [{ field_confidence: { diameter: .94, quantity: 94, total_length_cm: .91, shape: .6 } }] };
  assert.equal(confidence.forPath(parsed, 'items.0.quantity'), .94);
  assert.equal(confidence.itemScore(parsed, 0), 60);
  assert.equal(confidence.forPath(parsed, 'items.1.quantity'), null);
  assert.equal(confidence.forPath({ field_confidence: { quantity: .99 }, items: [{}] }, 'items.0.quantity'), null);
  assert.equal(confidence.forPath({ items: [{ fields: { shape: { confidence: .72 } } }] }, 'items.0.shape_name'), .72);
});

test('review notes survive enrichment and missing quantity is never one', () => {
  const parsed = workflow.withStructuredReviewNotes({ review_notes: [{ scope: 'order', item_index: null, field: 'header' }], items: [{ ...bentItem, quantity: null, review_notes: [{ field: 'shape', code: 'geometry_conflict', message: 'Check drawing', item_index: 7 }], uncertain_fields: ['diameter'] }] });
  assert.equal(parsed.review_notes[0].item_index, null);
  assert.ok(parsed.items[0].review_notes.some(note => note.code === 'geometry_conflict' && note.item_index === 0));
  assert.ok(parsed.items[0].review_notes.some(note => note.field === 'diameter' && note.code === 'uncertain_field'));
  assert.equal(workflow.normalizeIntakeItem(parsed.items[0]).qty, 0);
  assert.ok(workflow.intakeApprovalErrors(parsed).some(error => error.field === 'quantity'));
  assert.ok(workflow.intakeApprovalErrors({ items: [{ ...bentItem, segments: [] }] }).some(error => error.field === 'shape_name'));
  assert.equal(workflow.intakeApprovalErrors({ items: [bentItem] }).length, 0);
  const normalized = workflow.normalizeIntakeItem({ ...bentItem, item_number: '17', total_length_mm: undefined, total_length_cm: 240, segments: [{ length_cm: 40, angle_deg: 90 }, { length_cm: 200, angle_deg: 0 }] });
  assert.deepEqual(normalized.sides, [400, 2000]);
  assert.equal(normalized.length, 2400);
  assert.equal(normalized.shapeName, 'L angle');
  assert.equal(normalized.source_item_number, '17');
  const shapeOnly = workflow.withStructuredReviewNotes({ items: [{ ...bentItem, note: 'Review required: shape dimensions are unclear' }] });
  assert.ok(!shapeOnly.items[0].review_notes.some(note => ['diameter', 'quantity'].includes(note.field)));
});

test('reviewed quantity, cut length and geometry override stale parser aliases', () => {
  const normalized = workflow.normalizeIntakeItem({ ...bentItem, quantity: 7, qty: 20, total_length_mm: 2500, length: 2400, sides: [400, 2000], angles: [135], segments: [{ length_mm: 500, angle_deg: 90 }, { length_mm: 2000, angle_deg: 0 }] });
  assert.equal(normalized.qty, 7);
  assert.equal(normalized.length, 2500);
  assert.deepEqual(normalized.sides, [500, 2000]);
  assert.deepEqual(normalized.angles, [90]);
  const source = fs.readFileSync(path.join(__dirname, '../public/intake.html'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(functionText(source, 'syncOcrItemAliases'), context);
  const synced = context.syncOcrItemAliases({ ...bentItem, quantity: 7, qty: 20, total_length_mm: 2500, length: 2400 });
  assert.equal(synced.qty, 7);
  assert.equal(synced.length, 2500);
});

test('approve rejects incomplete rows without creating anything, then creates geometry once', async t => {
  const db = database(t); let creations = 0; let savedPayload;
  const id = db.prepare('INSERT INTO intake_log (source,status,parsed_data) VALUES (?,?,?)').run('ocr', 'pending_review', JSON.stringify({ customer_name: 'Test', items: [{ ...bentItem, quantity: null }] })).lastInsertRowid;
  const base = await serve(t, createReviewRouter({ db, requireAnyRole: allow, wsBroadcast: () => {}, enrichIntakeRow: row => row, intakeWorkflow: workflow, intake: {},
    intakeToOrderPayload: parsed => workflow.buildIntakeOrderPayload(parsed),
    createOrderFromPayload: payload => { creations++; savedPayload = payload; db.prepare('INSERT INTO orders (id,order_num) VALUES (1,?)').run('TEST-1'); return { success: true, orderId: 1, orderNum: 'TEST-1' }; },
  }));
  const approve = body => fetch(`${base}/api/intake/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  assert.equal((await approve()).status, 422);
  assert.equal(creations, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM intake_training_examples').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM intake_log').get().status, 'pending_review');
  const missingCustomer = await approve({ parsed_data: { items: [bentItem] } });
  assert.equal(missingCustomer.status, 422);
  assert.equal((await approve({ parsed_data: { customer_name: 'Test', items: [bentItem] } })).status, 200);
  assert.deepEqual(savedPayload.pallets[0].items[0].sides, [400, 2000]);
  assert.deepEqual(savedPayload.pallets[0].items[0].angles, [90]);
  assert.equal((await (await approve()).json()).alreadyApproved, true);
  assert.equal(creations, 1);
});

test('PDF header recognition preserves deterministic shapes; duplicate upload reuses source identity', async t => {
  const db = database(t); let calls = 0; let request;
  t.mock.method(parser, 'parseSteelDocument', () => ({ items: [bentItem], metrics: { rows_detected: 1, usable_rows: 1 }, parsing_profile: { id: 'tassa_easybar_bending_schedule' } }));
  t.mock.method(axios, 'post', async (url, body) => { calls++; request = body; return { data: { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ customer_name: 'Test customer', delivery_address: 'Test site', delivery_date: '2026-10-25' }) }] }] } }; });
  const base = await serve(t, createIntakeRouter(recognitionDeps(db)));
  const upload = () => { const form = new FormData(); form.set('image', new Blob([pdf()], { type: 'application/pdf' }), 'order.pdf'); return fetch(base + '/api/analyze-image?save_to_intake=true', { method: 'POST', body: form }); };
  const first = await upload(); assert.equal(first.status, 200);
  const parsed = await first.json();
  assert.equal(parsed.customer_name, 'Test customer');
  assert.deepEqual(parsed.items[0].segments, bentItem.segments);
  assert.equal(request.text.format.schema.properties.items, undefined);
  const second = await upload(); assert.equal(second.status, 409);
  assert.equal((await second.json()).conflict.existingId, parsed.intakeId);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM intake_log').get().n, 1);
  db.prepare('UPDATE intake_log SET status=?,order_id=? WHERE id=?').run('approved', 7, parsed.intakeId);
  const approvedDuplicate = await upload();
  assert.equal((await approvedDuplicate.json()).conflict.orderId, 7);
  assert.equal(calls, 1);
});

test('partial PDF tables use full recognition and preserve unreadable rows for review', async t => {
  const db = database(t); let request;
  t.mock.method(parser, 'parseSteelDocument', () => ({ items: [bentItem, { ...bentItem, quantity: 0 }], metrics: { rows_detected: 2, usable_rows: 1 } }));
  t.mock.method(axios, 'post', async (url, body) => {
    request = body;
    return { data: { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ customer_name: 'Test', items: [20, 0].map(quantity => ({ ...bentItem, quantity, total_length_cm: 240, segments: [{ length_cm: 40, angle_deg: 90 }, { length_cm: 200, angle_deg: 0 }] })) }) }] }] } };
  });
  const base = await serve(t, createIntakeRouter(recognitionDeps(db)));
  const form = new FormData(); form.set('image', new Blob([pdf()], { type: 'application/pdf' }), 'partial.pdf');
  const response = await fetch(base + '/api/analyze-image?save_to_intake=true', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  const parsed = await response.json();
  assert.ok(request.text.format.schema.properties.items);
  assert.equal(parsed.items.length, 2);
  assert.ok(parsed.items[1].review_notes.some(note => note.field === 'quantity'));
  assert.ok(workflow.intakeApprovalErrors(parsed).some(error => error.item_index === 1));
});

function functionText(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:  )?(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
test('quick PDF upload opens complete intake instead of flattening or dropping rows', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/new-order-editor.js'), 'utf8');
  const context = { document: { getElementById: () => null }, FormData, fetch: async () => ({ ok: true, json: async () => ({ intakeId: 55, items: [bentItem, { quantity: null }] }) }), window: { location: {}, intakeReviewUrl: id => '/intake.html?open=' + id }, showQuickImportMessage: () => {}, saveActiveDraftNow: () => {}, addIntakeRowsToOrder: () => { throw Error('must not flatten OCR geometry'); } };
  vm.createContext(context); vm.runInContext(functionText(source, 'importQuickOcrFile'), context);
  const input = { value: 'file.pdf' };
  await context.importQuickOcrFile(new Blob(['file']), input);
  assert.equal(context.window.location.href, '/intake.html?open=55');
  assert.equal(input.disabled, false);
});

test('the review UI cannot show missing rows as approved, and opens the created order', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/intake.html'), 'utf8');
  const context = { IronBendIntakeConfidence: confidence, ocrOperatorApproved: item => item.operator_approved === true };
  vm.createContext(context);
  vm.runInContext(functionText(source, 'ocrItemMissingFields') + '\n' + functionText(source, 'ocrActionState'), context);
  assert.equal(context.ocrActionState({}, { ...bentItem, quantity: null, operator_approved: true }, 0).key, 'missing');
  assert.equal(context.ocrActionState({}, bentItem, 0).pct, null);
  let opened;
  Object.assign(context, { intakeRows: [{ id: 1, customer_match: { customer: { id: 2 } } }], selectedCustomers: {}, activeCompareId: 1, readCorrectedParsed: () => ({ items: [bentItem] }), fetch: async () => ({ ok: true, json: async () => ({ success: true, orderId: 7 }) }), toast: () => {}, closeIntakeCompare: () => {}, renderIntakeQueue: () => {}, openLinkedOrder: id => { opened = id; } });
  vm.runInContext(functionText(source, 'intakeApprove'), context);
  await context.intakeApprove(1);
  assert.equal(opened, 7);
});
