const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureCoreSchema } = require('../db/coreSchema');
const { runCoreMigrations } = require('../db/startup');
const industry = require('../modules/steel-rebar');
const { createOrderFactory } = require('../services/orders');

test('order items preserve element, source identity and explicit display order', () => {
  const db = new Database(':memory:');
  try {
    ensureCoreSchema(db);
    runCoreMigrations(db);
    const service = createOrderFactory(db, { generateOrderNum: () => 'SOURCE-META-1', industry });
    service.createOrderFromPayload({
      customer: { name: 'Source metadata test' },
      order: {},
      pallets: [{ items: [
        {
          shapeName: 'straight', diameter: 12, length: 1000, qty: 1,
          structElement: 'אלמנט שני', sourceItemNumber: '87', sourceRowNumber: 412, sortOrder: 2,
        },
        {
          shapeName: 'straight', diameter: 12, length: 1000, qty: 1,
          structElement: 'אלמנט ראשון', sourceItemNumber: '86', sourceRowNumber: 407, sortOrder: 1,
        },
      ] }],
    });

    const rows = db.prepare(`
      SELECT struct_element, source_item_number, source_row_number, sort_order
      FROM items
      ORDER BY COALESCE(sort_order, id), id
    `).all();
    assert.deepEqual(rows, [
      { struct_element: 'אלמנט ראשון', source_item_number: '86', source_row_number: 407, sort_order: 1 },
      { struct_element: 'אלמנט שני', source_item_number: '87', source_row_number: 412, sort_order: 2 },
    ]);
  } finally {
    db.close();
  }
});

test('order detail visibly renders the element and original source number', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'orders.html'), 'utf8');
  assert.match(html, /class="item-element"/);
  assert.match(html, /מס׳ מקור/);
  assert.match(html, /item\.struct_element/);
  assert.match(html, /source_item_number/);
});
