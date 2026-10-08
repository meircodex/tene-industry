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

test('cutting dialog supports item quantities and a per-diameter 600cm or 1200cm decision', () => {
  assert.match(ordersHtml, /data-cut-quantity/);
  assert.match(ordersHtml, /מאיזה מוט לחתוך/);
  assert.match(ordersHtml, /רק מוט 600 CM/);
  assert.match(ordersHtml, /רק מוט 1200 CM/);
  assert.match(ordersHtml, /אפשר לשלב 600 ו־1200 CM/);
  assert.match(ordersHtml, /מינימום פחת הוא היעד הראשון/);
  assert.match(ordersHtml, /אוטומטי — מינימום פחת, כולל שילוב 600 ו־1200 CM/);
  assert.match(ordersHtml, /אורך אחד בלבד לקוטר/);
  assert.match(ordersHtml, /else policies\[diameter\] = \{ stockLengthsMm: \[6000, 12000\], allowMixedStockLengths: true \}/);
  assert.match(ordersHtml, /groupPolicies/);
});

test('cutting bars use item-only labels, colored mixed-item segments, dimensions, diameter and shape previews', () => {
  assert.match(ordersHtml, /label: `פריט \$\{itemNumber\}`/);
  assert.doesNotMatch(ordersHtml, /label: sourceNumber \? `מקור/);
  assert.match(ordersHtml, /מוט משולב:/);
  assert.match(ordersHtml, /class="cut-piece\$\{isShort \? ' is-short' : ''\}"[\s\S]*straightStockLengthText\(piece\.lengthMm\)/);
  assert.match(ordersHtml, /קוטר ⌀\$\{escHtml\(group\.diameter\)\}/);
  assert.match(ordersHtml, /data-cut-shape-item/);
  assert.match(ordersHtml, /renderStraightStockShapePreviews/);
  assert.match(ordersHtml, /straightStockBarPatterns/);
  assert.match(ordersHtml, /× \$\{barPattern\.count\} PCS/);
  assert.match(ordersHtml, /פחת למוט/);
});

test('cutting plan renders every length in CM, every quantity in PCS, and highlights very short pieces', () => {
  assert.match(ordersHtml, /return `\$\{Number\.isInteger\(centimeters\)[\s\S]*\} CM`/);
  assert.match(ordersHtml, /\$\{plan\.bars\.length\} PCS/);
  assert.match(ordersHtml, /\$\{plan\.pieceCount\} PCS/);
  assert.match(ordersHtml, /piece\.lengthMm <= 600 \? ' is-short'/);
  assert.match(ordersHtml, /const visibleLabel = isShort \? String\(piece\.itemNumber/);
});
