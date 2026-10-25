const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../public/order-item-filters');
const items = [
  { id: 1, diameter: 12, status: 'ממתין', quantity: 500, produced_qty: 500 },
  { id: 2, diameter: '12.0', status: 'בייצור', quantity: 20, produced_qty: 10 },
  { id: 3, diameter: 12, status: 'הושלם', quantity: 100 },
  { id: 4, diameter: 12, status: 'הועמס', quantity: 2 },
  { id: 5, diameter: 12, status: 'נשלח', quantity: 40 },
  { id: 6, diameter: 12, status: 'סופק', quantity: 8 },
  { id: 7, diameter: 12, status: 'בוטל', quantity: 70 },
  { id: 8, diameter: 12, status: 'הושלם', cancelled_at: '2026-10-25', quantity: 90 },
  { id: 9, diameter: 8, status: 'הושלם', quantity: 1000 },
  { id: 10, diameter: 12, status: 'בהמתנה', quantity: 1 },
  { id: 11, diameter: null, status: 'ממתין', quantity: 1 },
];
test('diameter production groups count rows and preserve rollback, partial and cancelled semantics', () => {
  const before = JSON.stringify(items);
  const result = project(items, { diameter: '12', status: '__remaining' });
  assert.deepEqual(result.visible.map(x => x.id), [1, 2, 10]);
  assert.deepEqual([result.total, result.done, result.remaining, result.cancelled], [7, 4, 3, 2]);
  assert.deepEqual(project(items, { diameter: '12', status: '__done' }).visible.map(x => x.id), [3, 4, 5, 6]);
  assert.equal(JSON.stringify(items), before);
});
test('exact status intersects with diameter, including cancelled and missing diameter', () => {
  assert.deepEqual(project(items, { diameter: '12', status: 'בוטל' }).visible.map(x => x.id), [7]);
  assert.deepEqual(project(items, { diameter: '8', status: '__remaining' }).visible, []);
  assert.deepEqual(project(items, { diameter: 'unknown' }).visible.map(x => x.id), [11]);
  assert.equal(project(items).visible.length, items.length);
  assert.equal(project([]).total, 0);
});
