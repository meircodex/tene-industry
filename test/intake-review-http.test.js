const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');

const { ensureCoreSchema } = require('../db/coreSchema');
const { runCoreMigrations } = require('../db/startup');
const intake = require('../intake');
const industry = require('../modules/steel-rebar');
const { requireAnyRole } = require('../permissions');
const createIntakeReviewRouter = require('../routes/intakeReview');
const intakeWorkflow = require('../services/intakeWorkflow');
const { createOrderFactory } = require('../services/orders');
const { parseSteelDocument } = require('../services/steelDocumentParser');
const { pages } = require('./fixtures/order105-tassa-pdf-words.json');

const { items: documentItems } = parseSteelDocument({ pages, fileName: 'order105.pdf' });
const firstItem = documentItems.find(item => item.item_number === '1');
const tenthItem = documentItems.find(item => item.item_number === '10');
const parsedOrder = { customer_name: 'עשוש', items: [firstItem, tenthItem] };

async function setup(t) {
  const db = new Database(':memory:');
  // The schema emits a line for every migration on a fresh database.
  const migrationLog = t.mock.method(console, 'log', () => {});
  try {
    ensureCoreSchema(db);
    runCoreMigrations(db);
  } finally {
    migrationLog.mock.restore();
  }

  const events = [];
  const { createOrderFromPayload, calcWeightPerUnit } = createOrderFactory(db, {
    industry,
    generateOrderNum: () => '105',
  });
  const app = express();
  app.use(express.json());
  let role = 'office';
  app.use((req, res, next) => {
    if (role) req.auth = { role, username: role, sub: role };
    next();
  });
  app.use('/api', createIntakeReviewRouter({
    db,
    requireAnyRole,
    createOrderFromPayload,
    intake,
    intakeWorkflow,
    wsBroadcast: (...event) => events.push(event),
    enrichIntakeRow: row => ({ ...row, parsed: JSON.parse(row.parsed_data || '{}') }),
    intakeToOrderPayload: (parsed, source, customerOverride, rawContent) =>
      intakeWorkflow.buildIntakeOrderPayload(parsed, { source, customerOverride, rawContent, calcWeightPerUnit }),
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  function request(path, method = 'GET', data) {
    const options = data === undefined ? { method } : {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
    return fetch(`http://127.0.0.1:${server.address().port}/api/intake${path}`, options);
  }

  function addIntake(parsed = parsedOrder, { status = 'pending_review', sourceId = '105', createdAt = '2026-10-19T09:00:00Z' } = {}) {
    return db.prepare(`INSERT INTO intake_log (source, source_system, external_id, parsed_data, status, created_at)
      VALUES ('ocr', 'tassa', ?, ?, ?, ?)`).run(sourceId, JSON.stringify(parsed), status, createdAt).lastInsertRowid;
  }

  return { db, events, request, addIntake, setRole: nextRole => { role = nextRole; } };
}

async function expectJson(response, status) {
  assert.equal(response.status, status, response.ok ? response.url : await response.clone().text());
  return response.json();
}

test('יומן הקליטה ממיין רשומות, מסנן לפי סטטוס ומחייב הרשאה', async t => {
  const { request, addIntake, setRole } = await setup(t);
  const first = addIntake();
  const second = addIntake(parsedOrder, {
    status: 'rejected', sourceId: null, createdAt: '2026-10-19T10:00:00Z',
  });
  const log = await expectJson(await request('/log'), 200);
  assert.deepEqual(log.map(row => row.id), [second, first]);
  assert.equal(log[0].parsed.items[0].quantity, 51);
  const pending = await expectJson(await request('/log?status=pending_review'), 200);
  assert.deepEqual(pending.map(row => row.id), [first]);

  const actions = [
    ['/log', 'GET'], ['/order-review-tasks', 'GET'], ['/parse-text', 'POST'],
    ['/shape-mappings', 'GET'], ['/shape-mappings', 'POST'], ['/shape-mappings/1', 'DELETE'],
    ...['approve', 'draft', 'reject', 'order-review'].map(action => [`/${first}/${action}`, 'POST']),
  ];
  for (const [role, expectedStatus] of [[null, 401], ['production', 403]]) {
    setRole(role);
    for (const [path, method] of actions) {
      assert.equal((await request(path, method)).status, expectedStatus, `${method} ${path}`);
    }
  }
});

test('שמירת טיוטה, אישור חוזר ודחייה שומרים על קישור ההזמנה', async t => {
  const { db, events, request, addIntake } = await setup(t);
  const incomplete = { ...firstItem, quantity: null, qty: null };
  const id = addIntake({ ...parsedOrder, items: [incomplete] });
  const rejectId = addIntake(parsedOrder, { sourceId: null });
  for (const action of ['approve', 'draft', 'reject', 'order-review']) {
    await expectJson(await request(`/999/${action}`, 'POST'), 404);
  }
  const validation = await expectJson(await request(`/${id}/approve`, 'POST'), 422);
  assert.ok(validation.errors.some(error => error.field === 'quantity'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);

  const draft = await expectJson(await request(`/${id}/draft`, 'POST', { parsed_data: parsedOrder }), 200);
  const readIntake = db.prepare('SELECT status, order_id, parsed_data FROM intake_log WHERE id=?');
  assert.equal(readIntake.get(id).status, 'pending_review');
  assert.equal(readIntake.get(id).order_id, null);
  assert.deepEqual(JSON.parse(readIntake.get(id).parsed_data), draft.parsed);
  assert.ok(db.prepare('SELECT id FROM intake_training_examples WHERE title=?').get(`Intake correction #${id}`));
  await expectJson(await request(`/${id}/order-review`, 'POST'), 409);

  const [approved, replay] = await Promise.all([
    request(`/${id}/approve`, 'POST'),
    request(`/${id}/approve`, 'POST'),
  ]).then(responses => Promise.all(responses.map(response => expectJson(response, 200))));
  assert.equal(approved.orderNum, '105');
  assert.equal(replay.orderId, approved.orderId);
  assert.equal([approved, replay].filter(result => result.alreadyApproved).length, 1);
  assert.deepEqual(events, [['new_order', { orderNum: '105', orderId: approved.orderId }]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  assert.deepEqual(db.prepare('SELECT quantity, total_length_mm FROM items ORDER BY id').all(), [
    { quantity: 51, total_length_mm: 6900 }, { quantity: 51, total_length_mm: 10700 },
  ]);

  const approvedRow = readIntake.get(id);
  assert.equal(approvedRow.status, 'approved');
  await expectJson(await request(`/${id}/draft`, 'POST', { parsed_data: { items: [] } }), 409);
  await expectJson(await request(`/${id}/reject`, 'POST'), 409);
  assert.deepEqual(readIntake.get(id), approvedRow);
  await expectJson(await request(`/${rejectId}/reject`, 'POST'), 200);
  assert.equal(readIntake.get(rejectId).status, 'rejected');
});

test('משימות בקרת הזמנה משחזרות שורות ומעדכנות אותן לפי מזהה פריט', async t => {
  const { db, request, addIntake, setRole } = await setup(t);
  const id = addIntake();
  setRole('manager');
  const { orderId } = await expectJson(await request(`/${id}/approve`, 'POST'), 200);
  const [first, tenth] = db.prepare('SELECT id FROM items WHERE order_id=? ORDER BY id').all(orderId);
  db.prepare("UPDATE items SET review_status='pending' WHERE order_id=?").run(orderId);
  db.prepare("UPDATE intake_log SET parsed_data='null' WHERE id=?").run(id);

  const tasks = await expectJson(await request('/order-review-tasks'), 200);
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.equal(task.order_num, '105');
  assert.equal(task.post_order_review, true);
  assert.equal(task.review_count, 2);
  assert.deepEqual(task.review_items.map(item => item.id), [first.id, tenth.id]);
  assert.deepEqual(task.parsed.items.map(item => [item.item_id, item.item_number, item.total_length_mm]), [
    [first.id, 1, 6900], [tenth.id, 2, 10700],
  ]);
  assert.deepEqual(task.parsed.items[0].segments.map(segment => segment.length_mm), [200, 6700]);

  const [firstParsed, tenthParsed] = task.parsed.items;
  const reviewed = await expectJson(await request(`/${id}/order-review`, 'POST', {
    parsed_data: { items: [
      { ...tenthParsed, operator_review_status: 'missing' },
      { ...firstParsed, operator_review_status: 'accepted' },
      { ...firstParsed, item_id: 999, operator_review_status: 'accepted' },
    ] },
  }), 200);
  assert.deepEqual(reviewed.parsed.items.slice(0, 2).map(item => [item.item_id, item.operator_review_status]), [
    [tenth.id, 'missing'], [first.id, 'accepted'],
  ]);
  assert.deepEqual(db.prepare('SELECT review_status FROM items ORDER BY id').pluck().all(), ['approved', 'missing']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM intake_training_examples WHERE title LIKE 'Intake row approval%'").get().count, 1);

  const remaining = await expectJson(await request('/order-review-tasks'), 200);
  assert.deepEqual(remaining[0].review_items.map(item => item.id), [tenth.id]);
  await expectJson(await request(`/${id}/order-review`, 'POST', {
    parsed_data: { items: [{ ...tenthParsed, operator_review_status: 'accepted' }] },
  }), 200);
  assert.deepEqual(await expectJson(await request('/order-review-tasks'), 200), []);
});

test('קליטה מטקסט שומרת שורות בעברית ומזהה מקור כפול', async t => {
  const { db, request } = await setup(t);
  const item = documentItems.find(row => row.item_number === '3');
  const itemLine = `${item.diameter} ${item.total_length_mm} ${item.quantity}`;
  const text = `לקוח: עשוש\nאתר: תקרה\n${itemLine}`;
  const input = { text, source: 'whatsapp', source_system: ' TASSA ', external_id: '105' };

  await expectJson(await request('/parse-text', 'POST'), 400);
  await expectJson(await request('/parse-text', 'POST', { text: '' }), 400);
  const result = await expectJson(await request('/parse-text', 'POST', input), 200);
  assert.equal(result.item_count, 1);
  assert.equal(result.parsed.customerName, 'עשוש');
  assert.equal(result.parsed.deliveryAddress, 'תקרה');
  assert.equal(result.parsed.source, 'whatsapp');
  assert.equal(result.parsed.items[0].length, 8200);
  assert.deepEqual(db.prepare('SELECT source_system, external_id, raw_content, status FROM intake_log WHERE id=?').get(result.id), {
    source_system: 'tassa', external_id: '105', raw_content: text, status: 'pending_review',
  });
  const duplicate = await expectJson(await request('/parse-text', 'POST', input), 409);
  assert.equal(duplicate.conflict.existingId, result.id);

  // Re-enter the same printed values with indentation and a separate incomplete line.
  const manual = await expectJson(await request('/parse-text', 'POST', {
    text: `  ${itemLine}\n14\n9600 51\nØ14 × 9600 × 51`,
  }), 200);
  assert.equal(manual.parsed.source, 'manual');
  assert.deepEqual(manual.parsed.items.map(({ diameter, length, qty }) => ({ diameter, length, qty })), [
    { diameter: 14, length: 9600, qty: 51 },
    { diameter: 14, length: 8200, qty: 76 },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM intake_log').get().count, 2);
});

test('מיפוי צורות מנרמל קודים, מעדכן מיפוי קיים ומגביל מחיקה', async t => {
  const { db, request, setRole } = await setup(t);
  const path = '/shape-mappings';
  const catalog = await expectJson(await request(path), 200);
  assert.deepEqual(catalog.learned, []);
  const builtin = catalog.builtin.find(mapping => mapping.sourceSystem === 'TASSA' && mapping.externalCode === '103');
  assert.equal(builtin.internalShapeCode, 'closed_stirrup_rect_hook');

  await expectJson(await request(path, 'POST', {}), 400);
  const input = { sourceSystem: ' tassa ', externalCode: ' 103 ', label: '  חישוק סגור  ' };
  await expectJson(await request(path, 'POST', { ...input, internalShapeCode: '105' }), 422);
  const created = await expectJson(await request(path, 'POST', { ...input, internalShapeCode: builtin.internalShapeCode }), 200);
  assert.deepEqual(created.mapping, {
    source_system: 'TASSA', external_code: '103', shape_type: 'closed_stirrup', internal_shape_code: builtin.internalShapeCode,
  });
  const { learned: [mapping] } = await expectJson(await request(path), 200);
  assert.equal(mapping.label, 'חישוק סגור');

  const rename = { ...input, label: 'חישוק מלבני', internalShapeCode: builtin.internalShapeCode };
  await expectJson(await request(path, 'POST', rename), 200);
  const { learned } = await expectJson(await request(path), 200);
  assert.deepEqual(learned.map(entry => [entry.id, entry.label]), [[mapping.id, 'חישוק מלבני']]);

  const mappingPath = `${path}/${mapping.id}`;
  await expectJson(await request(mappingPath, 'DELETE'), 403);
  setRole('admin');
  await expectJson(await request(mappingPath, 'DELETE'), 200);
  await expectJson(await request(mappingPath, 'DELETE'), 404);
  assert.equal(db.prepare('SELECT active FROM external_shape_mappings WHERE id=?').get(mapping.id).active, 0);
  const after = await expectJson(await request(path), 200);
  assert.deepEqual(after.learned, []);
  assert.deepEqual(after.builtin, catalog.builtin);
});
