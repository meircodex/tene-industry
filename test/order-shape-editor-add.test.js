const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ordersPath = path.join(__dirname, '..', 'public', 'orders.html');
const newOrderPath = path.join(__dirname, '..', 'public', 'index.html');
const newOrderEditorPath = path.join(__dirname, '..', 'public', 'new-order-editor.js');
const orders = () => fs.readFileSync(ordersPath, 'utf8');
const newOrder = () => fs.readFileSync(newOrderPath, 'utf8');
const newOrderEditor = () => fs.readFileSync(newOrderEditorPath, 'utf8');

test('orders manual add uses the shared shape editor, not the legacy manual form', () => {
  const html = orders();
  assert.match(html, /src="\/shape-editor\.js\?v=77"/);
  assert.match(html, /new ShapeEditorModal\(shapeSelectedFromOrder\)/);
  assert.match(html, /function openAddManualItem\(event\) \{[\s\S]*openOrderShapeEditorForAdd\(event, orderId\);[\s\S]*?\n\}/);
  assert.doesNotMatch(html, /openManualItemAdd/);
  assert.doesNotMatch(html, /itemEditOverlay/);
  assert.doesNotMatch(html, /saveItemEdit/);
  assert.doesNotMatch(html, /prompt\('/);
  assert.match(html, /function openOrderShapeEditorForAdd\(event, orderId\) \{[\s\S]*editor\.open\(\{[\s\S]*quantity: 1,[\s\S]*?\n  \}\);[\s\S]*?\n\}/);
});

test('orders item shape edits go through the shared shape editor', () => {
  const html = orders();
  assert.match(html, /function openItemEdit\(event, orderId, itemId\) \{[\s\S]*ensureOrderShapeEditor\(\)[\s\S]*editor\.open\(\{ \.\.\.orderShapeDataFromItem\(item\), quantity: Number\(item\.quantity\) \|\| 1 \}\);[\s\S]*?\n\}/);
  assert.match(html, /async function shapeSelectedFromOrder\(data\) \{[\s\S]*method: isNewItem \? 'POST' : 'PATCH'[\s\S]*openDetail\(ctx\.orderId\)/);
  assert.match(html, /orderItemQuantity = Math\.max\(1, Number\(data\?\.orderItemQuantity/);
  assert.match(html, /const isShapeContractV2 = Number\(data\?\.contractVersion\) === 2[\s\S]*data\?\.data && data\?\.calculated && data\?\.machineOutput/);
  assert.match(html, /shapeSnapshot: isShapeContractV2 \? data : null/);
});

test('orders missing intake source add flow offers a manual shape editor fallback', () => {
  const html = orders();
  assert.match(html, /sourceParsed'\)\.innerHTML = mode === 'add'/);
  assert.match(html, /openOrderShapeEditorForAdd\(event, \$\{Number\(orderId\) \|\| 0\}\)/);
});

test('orders items can be deleted from the order detail screen', () => {
  const html = orders();
  assert.match(html, /deleteOrderItem\(event, \$\{o\.id\}, \$\{item\.id\}\)/);
  assert.match(html, /fetch\(`\/api\/orders\/\$\{orderId\}\/items\/\$\{itemId\}`,[\s\S]*method: 'DELETE'/);
  assert.match(html, /confirm\('/);
});

test('orders expose explicit edit controls and a non-browser correction-reason dialog', () => {
  const html = orders();
  assert.match(html, /id="orderEditOverlay"/);
  assert.match(html, /function openOrderEdit\(event, orderId\)/);
  assert.match(html, /fetch\(`\/api\/orders\/\$\{orderEditOrder\.id\}`, \{[\s\S]*method: 'PATCH'/);
  assert.match(html, /function requestCorrectionReason\(\)/);
  assert.match(html, /itemHasStartedProduction\(item\)/);
  assert.match(html, /סיבת תיקון לאחר תחילת ייצור/);
  assert.match(html, /disabled title="לא מוחקים כרטיסייה שכבר התחילה ייצור"/);
  assert.doesNotMatch(html, /prompt\('/);
});

test('new order CSV import maps location aliases to struct element state', () => {
  const js = newOrderEditor();
  assert.match(js, /STRUCT_ELEMENT_ALIASES/);
  for (const alias of ['מיקום', 'שם אלמנט', 'שם האלמנט', 'אלמנט', 'location', 'mark', 'item_label', 'itemLabel']) {
    assert.match(js, new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(js, /structElement: elementName/);
  assert.match(js, /struct_element: elementName/);
});

test('new order first shape consumes the temporary startup row', () => {
  const html = newOrder();
  const js = newOrderEditor();
  assert.match(html, /function isPristineOrderItemPlaceholder\(item\)/);
  assert.match(html, /const placeholder = \(pallet\.items \|\| \[\]\)\.find\(isPristineOrderItemPlaceholder\)/);
  assert.match(html, /if \(placeholder\) \{[\s\S]*openShapeEditor\(palletId, placeholder\.id\);[\s\S]*return;[\s\S]*\}/);
  assert.match(js, /const hasConfiguredItem = pallet\.items\.some\(item => !window\.isPristineOrderItemPlaceholder\(item\)\)/);
  assert.match(js, /pallet\.items = pallet\.items\.filter\(item => !window\.isPristineOrderItemPlaceholder\(item\)\)/);
});

test('new order local multi-drafts stay client-side and expose compact draft actions', () => {
  const js = newOrderEditor();
  assert.match(js, /NEW_ORDER_DRAFTS_KEY = 'ironbend:new-order:drafts:v2'/);
  assert.match(js, /function scheduleDraftAutosave\(\)/);
  assert.match(js, /function continueDraft\(draftId\)/);
  assert.match(js, /function deleteDraft\(draftId\)/);
  assert.match(js, /function showDraftRestoreBanner\(\)/);
  assert.match(js, /MAX_LOCAL_DRAFTS = 20/);
  assert.match(js, /DRAFT_TTL_MS = 14 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(js, /writeJsonStorage\(NEW_ORDER_DRAFTS_KEY/);
  assert.doesNotMatch(js, /\/api\/order-drafts|\/api\/drafts|order_drafts|draft_orders/);
});
