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
  assert.match(ordersHtml, /מינימום פחת הוא היעד הראשון/);
  assert.match(ordersHtml, /אוטומטי — מינימום פחת, כולל שילוב 6 ו־12/);
  assert.match(ordersHtml, /אורך אחד בלבד לקוטר/);
  assert.match(ordersHtml, /else policies\[diameter\] = \{ stockLengthsMm: \[6000, 12000\], allowMixedStockLengths: true \}/);
  assert.match(ordersHtml, /groupPolicies/);
});

test('cutting bars use item-only labels, colored mixed-item segments, dimensions, diameter and shape previews', () => {
  assert.match(ordersHtml, /label: `פריט \$\{itemNumber\}`/);
  assert.doesNotMatch(ordersHtml, /label: sourceNumber \? `מקור/);
  assert.match(ordersHtml, /מוט משולב:/);
  assert.match(ordersHtml, /class="cut-piece"[\s\S]*straightStockLengthText\(piece\.lengthMm\)/);
  assert.match(ordersHtml, /קוטר ⌀\$\{escHtml\(group\.diameter\)\}/);
  assert.match(ordersHtml, /data-cut-shape-item/);
  assert.match(ordersHtml, /renderStraightStockShapePreviews/);
  assert.match(ordersHtml, /straightStockBarPatterns/);
  assert.match(ordersHtml, /× \$\{barPattern\.count\} מוטות/);
  assert.match(ordersHtml, /פחת למוט/);
});
