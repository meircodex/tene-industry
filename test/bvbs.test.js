const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const multer = require('multer');
const { ensureCoreSchema } = require('../db/coreSchema');
const industry = require('../modules/steel-rebar');
const createBvbsRouter = require('../routes/bvbs');
const { createOrderNumberAllocator } = require('../services/orderNumbers');

// BVBS Guideline 3.1, BF2D examples 2 and 3 (pp. 20–21).
// https://www.bvbs.de/wp-content/uploads/2024/01/BVBS-Guideline-Data-Exchange-Reinforcement-Data-3.1-Engl_20210614.pdf
const lines = [
  'BF2D@HjTestPDF@r417@ia@p1@l800@n10@e0.710@d12@gB500A@s48@v@Gl100@w180@l600@w180@l100@w0@C71@',
  'BF2D@HjTestPDF@r417@ia@p1@l1224@n10@e1.087@d12@gB500A@s48@v@Gl100@w90@l300@w45@l424@w-45@l300@w-90@l100@w0@C82@',
];
const content = lines.join('\r\n');

async function fixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureCoreSchema(db);
  const customerId = db.prepare('INSERT INTO customers (name) VALUES (?)').run('לקוח בדיקה').lastInsertRowid;
  const events = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createBvbsRouter({
    db,
    requireAnyRole: () => (_req, _res, next) => next(),
    upload: multer(),
    industry,
    generateOrderNum: createOrderNumberAllocator(db),
    wsBroadcast: (name, payload) => events.push({ name, payload, inTransaction: db.inTransaction }),
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  function post(action, body) {
    const options = body instanceof FormData
      ? { body }
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(`http://127.0.0.1:${server.address().port}/api/bvbs/${action}`, {
      method: 'POST',
      ...options,
    });
  }

  return { db, customerId, events, post };
}

function assertNoOrder(db, events) {
  for (const table of ['orders', 'pallets', 'items', 'order_sequences']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.deepEqual(events, []);
}

test('BVBS parses published records and saves weights calculated from validated dimensions', async t => {
  const { db, customerId, events, post } = await fixture(t);
  const upload = new FormData();
  upload.set('file', new Blob([content]), 'example.abs');
  const preview = await post('parse', upload);
  assert.equal(preview.status, 200);
  const parsed = await preview.json();
  assert.deepEqual(parsed.header, { project: 'TestPDF' });
  assert.deepEqual(parsed.items.map(({ diameter, total_length, quantity, mark, grade }) =>
    [diameter, total_length, quantity, mark, grade]), [
    [12, 800, 10, '1', 'B500A'],
    [12, 1224, 10, '1', 'B500A'],
  ]);

  const response = await post('create-order', {
    customer_id: String(customerId),
    bvbs_result: {
      ...parsed,
      total_weight: 1,
      items: parsed.items.map(item => ({ ...item, weight_per_unit: -1, total_weight: 1 })),
    },
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.items_created, 2);

  const rows = db.prepare(`SELECT diameter,total_length_mm,quantity,weight_per_unit,total_weight
    FROM items ORDER BY id`).all();
  const expected = [800, 1224].map(length => {
    const unitWeight = (length / 1000) * 0.888;
    return {
      diameter: 12, total_length_mm: length, quantity: 10,
      weight_per_unit: unitWeight, total_weight: unitWeight * 10,
    };
  });
  assert.deepEqual(rows, expected);
  const total = expected.reduce((sum, item) => sum + item.total_weight, 0);
  assert.deepEqual(db.prepare('SELECT customer_id,channel,total_weight FROM orders').get(),
    { customer_id: customerId, channel: 'BVBS', total_weight: total });
  assert.deepEqual(db.prepare('SELECT order_id,total_weight FROM pallets').get(),
    { order_id: created.order_id, total_weight: total });
  assert.deepEqual(events, [{
    name: 'new_order',
    payload: { orderId: created.order_id, orderNum: created.order_num },
    inTransaction: false,
  }]);
});

test('BVBS rejects invalid records, order input and unknown customers before writing', async t => {
  const { db, customerId, events, post } = await fixture(t);
  assert.equal((await post('parse', { content: 1 })).status, 400);
  assert.equal((await post('parse', { content: lines[0].replace('@n10@', '@n0@') })).status, 422);
  const item = industry.parseBVBS(content).items[0];
  const invalidItems = [
    { length: 1 }, [], [null], [item, { ...item, diameter: 13 }],
    [{ ...item, diameter: '12mm' }],
    [{ ...item, total_length: 0 }], [{ ...item, total_length: 'Infinity' }],
    [{ ...item, quantity: 1.5 }], [{ ...item, quantity: true }],
  ];
  for (const items of invalidItems) {
    assert.equal((await post('create-order', { customer_id: customerId, bvbs_result: { items } })).status,
      400, JSON.stringify(items));
  }
  assert.equal((await post('create-order', {
    customer_id: [customerId], bvbs_result: { items: [item] },
  })).status, 400);
  assert.equal((await post('create-order', {
    customer_id: customerId + 1, bvbs_result: { items: [item] },
  })).status, 404);
  assertNoOrder(db, events);
});

test('BVBS rolls back the order, pallet, first item and sequence if the second item fails', async t => {
  const { db, customerId, events, post } = await fixture(t);
  db.exec(`CREATE TRIGGER fail_second_item BEFORE INSERT ON items
    WHEN EXISTS (SELECT 1 FROM items WHERE pallet_id = NEW.pallet_id)
    BEGIN SELECT RAISE(ABORT, 'second item failed'); END`);

  const body = { customer_id: customerId, bvbs_result: industry.parseBVBS(content) };
  const response = await post('create-order', body);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'שמירת הזמנת BVBS נכשלה' });
  assertNoOrder(db, events);

  db.exec('DROP TRIGGER fail_second_item');
  const retry = await post('create-order', body);
  assert.equal(retry.status, 200);
  assert.match((await retry.json()).order_num, /-001$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items').get().count, 2);
  assert.equal(events.length, 1);
});
