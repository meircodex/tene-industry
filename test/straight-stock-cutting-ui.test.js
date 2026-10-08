const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ordersHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'orders.html'), 'utf8');

test('order detail exposes the straight-stock cutting plan next to print actions', () => {
  assert.match(ordersHtml, /straight-stock-cutting\.js\?v=1/);
  assert.match(ordersHtml, /תוכנית חיתוך ממוטות/);
  assert.match(ordersHtml, /openStraightStockCutting\(event,\$\{o\.id\}\)/);
  assert.match(ordersHtml, /id="straightStockOverlay"/);
});

test('cutting dialog supports item quantities and a per-diameter 6m or 12m decision', () => {
  assert.match(ordersHtml, /data-cut-quantity/);
  assert.match(ordersHtml, /מאיזה מוט לחתוך/);
  assert.match(ordersHtml, /רק מוט 6 מטר/);
  assert.match(ordersHtml, /רק מוט 12 מטר/);
  assert.match(ordersHtml, /אפשר לשלב 6 ו־12 מטר/);
  assert.match(ordersHtml, /groupPolicies/);
});
