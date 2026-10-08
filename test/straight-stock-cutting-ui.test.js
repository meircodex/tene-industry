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

test('cutting bars show only lengths inside colored segments and place shapes side by side below', () => {
  assert.match(ordersHtml, /label: `פריט \$\{itemNumber\}`/);
  assert.doesNotMatch(ordersHtml, /label: sourceNumber \? `מקור/);
  assert.match(ordersHtml, /מוט משולב:/);
  assert.match(ordersHtml, /class="cut-piece\$\{isShort \? ' is-short' : ''\}"[\s\S]*<b>\$\{escHtml\(visibleLength\)\}<\/b>/);
  assert.doesNotMatch(ordersHtml, /class="cut-piece[^\n]*data-cut-shape-item/);
  assert.match(ordersHtml, /class="cut-shape-strip">\$\{shapeStrip\}/);
  assert.match(ordersHtml, /class="cut-shape-thumb-preview" data-cut-shape-item/);
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
  assert.match(ordersHtml, /const isShort = width < 7/);
  assert.match(ordersHtml, /const visibleLength = isShort \? fullLength\.replace\(\/\\s\*CM\$\/, ''\) : fullLength/);
  assert.match(ordersHtml, /\.cut-shape-thumb-preview svg text\{font-size:14px!important;font-weight:900!important/);
  assert.match(ordersHtml, /data-cut-shape-size="thumb"/);
  assert.match(ordersHtml, /width: 108,[\s\S]*height: 54,[\s\S]*showDimensions: true/);
  assert.doesNotMatch(ordersHtml, /class="cut-bar-items"/);
});

test('cutting plan renders waste as rebar weight by diameter', () => {
  assert.match(ordersHtml, /function straightStockWasteWeightKg\(wasteMm, diameter\)/);
  assert.match(ordersHtml, /IronBendRebar\?\.kgPerMeter\?\.\(diameterNumber\)/);
  assert.match(ordersHtml, /פחת למוט<br>\$\{straightStockWeightText\(straightStockWasteWeightKg\(bar\.wasteMm, group\.diameter\)\)\}/);
  assert.match(ordersHtml, /<span>פחת כולל<\/span><b>\$\{straightStockWeightText\(totalWasteKg\)\}<\/b>/);
  assert.match(ordersHtml, /\.cut-summary-card b\{display:block;direction:ltr;text-align:right/);
});

test('cutting plan prints as compact A4 landscape without splitting a cutting pattern', () => {
  assert.match(ordersHtml, /@page\{size:A4 landscape;margin:8mm\}/);
  assert.match(ordersHtml, /body\.straight-stock-printing \.cut-quantity-table thead\{display:table-header-group\}/);
  assert.match(ordersHtml, /body\.straight-stock-printing \.cut-bar-row\{[^}]*break-inside:avoid;page-break-inside:avoid/);
  assert.match(ordersHtml, /body\.straight-stock-printing \.cut-shape-thumb\{width:92px;height:64px/);
  assert.match(ordersHtml, /\.cut-bar-track,\.cut-piece,\.cut-shape-thumb,\.cut-shape-thumb-preview\{print-color-adjust:exact/);
});

test('cutting plan totals required stock bars in a table by diameter and stock length', () => {
  assert.match(ordersHtml, /const stockQuantities = new Map\(\)/);
  assert.match(ordersHtml, /const key = `\$\{group\.diameter\}\|\$\{stockLengthMm\}`/);
  assert.match(ordersHtml, /class="cut-quantity-table"/);
  assert.match(ordersHtml, /<th>קוטר<\/th><th>אורך מוט<\/th><th>כמות מוטות<\/th>/);
  assert.match(ordersHtml, /\$\{straightStockLengthText\(row\.stockLengthMm\)\}<\/td><td class="cut-table-number">\$\{row\.count\} PCS/);
});
