'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/customer.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../public/order-line-renderer.js'), 'utf8');
const rendererCss = fs.readFileSync(path.join(__dirname, '../public/order-line-renderer.css'), 'utf8');
const editor = fs.readFileSync(path.join(__dirname, '../public/new-order-editor.js'), 'utf8');

test('customer portal has linked delivery/auth labels and honest step state', () => {
  for (const id of ['deviceEnrollPin', 'deviceEnrollPinConfirm', 'trustedDevicePin', 'portalAccessCode', 'authPhone', 'authPassword', 'authName', 'authOtp', 'orderSiteId', 'delivDate', 'delivTime', 'delivMode', 'delivAddr', 'orderNotes']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `missing label for ${id}`);
  }
  assert.match(html, /class="active" aria-current="step">1\. פריטים וצורות/);
  assert.match(html, /הקובץ יועלה עם ההזמנה/);
  assert.doesNotMatch(html, /OCR מלא לפורטל יחובר כ-endpoint נפרד/);
});

test('trusted-device access uses a one-use five-minute enrollment and session-only portal token', () => {
  assert.match(html, /האישור הראשוני תקף לחמש דקות ולשימוש אחד/);
  assert.match(html, /\/api\/c\/device\/activate/);
  assert.match(html, /\/api\/c\/auth\/device-pin/);
  assert.match(html, /sessionStorage\?\.setItem\('ib_portal_session'/);
  assert.match(html, /credentials:'same-origin'/);
  assert.match(html, /קישור ל-5 דקות/);
  assert.match(html, /res\.data\?\.enrollmentToken/);
  assert.match(html, /revokePortalDeviceAccess/);
});

test('mobile login sizing and price-list rendering cover the audited viewport/data gaps', () => {
  assert.match(html, /@media\(max-height:680px\) and \(max-width:600px\)/);
  assert.match(html, /\.auth-logo img\{width:190px\}/);
  assert.match(html, /const previewRows = items\.map\(/);
  assert.match(html, /window\.open\('', '_blank', 'width=900,height=1100'\)/);
  assert.match(html, /הדפדפן חסם פתיחת חלון הדפסה/);
});

test('currency and actionable validation helpers are functional', () => {
  const start = html.indexOf('function formatMoney(');
  const helperStart = html.indexOf('function portalErrorMessage(');
  const source = html.slice(start, html.indexOf('\n}', start) + 2)
    + html.slice(helperStart, html.indexOf('\n}', helperStart) + 2);
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(context.formatMoney(91.464), '₪91.46');
  assert.match(context.portalErrorMessage({ error: 'length must be positive' }), /אורכי קטעים חיוביים/);
  assert.match(context.portalErrorMessage('network'), /אין חיבור לשרת/);
});

test('customer-facing prices use the shared two-decimal formatter', () => {
  assert.doesNotMatch(html, /₪'\+price\.toFixed\(0\)/);
  assert.match(html, /formatMoney\(ppu\)/);
  assert.match(html, /formatMoney\(data\.billingPrice-data\.totalPrice\)/);
  assert.match(html, /formatMoney\(data\.billingPrice\)/);
});

test('factory and customer adapters consume one canonical order-line renderer', () => {
  assert.match(html, /IronBendOrderLineRenderer\.render/);
  assert.match(editor, /IronBendOrderLineRenderer\.render/);
  assert.match(html, /order-line-renderer\.css\?v=2/);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /order-line-renderer\.css\?v=2/);
  assert.match(rendererCss, /\.ib-order-lines \.order-lines-head/);
  const context = vm.createContext({ window: {} });
  vm.runInContext(renderer, context);
  const markup = context.window.IronBendOrderLineRenderer.render({
    id: 4, lineLabel: '1/1', elementName: 'קורה', qty: 2, diameter: 12,
    hasShape: true, unitLengthCm: 100, totalLength: '1 מ\"', weight: '1.78 ק\"ג',
    shapeSketch: '<svg aria-hidden="true"></svg>', diameterOptions: '<option>Ø12</option>',
    openCall: 'openShapeEditor(1,4)', updateQtyCall: 'updateLineQuantity(1,4,this)',
    updateElementCall: 'updateLineElementName(1,4,this)', updateDiamCall: 'updateLineDiameter(1,4,this)', deleteCall: 'removeItem(1,4)'
  });
  for (const cls of ['order-line-row', 'line-element', 'line-shape', 'line-diameter-select', 'line-qty', 'line-weight', 'line-delete', 'line-mobile-meta']) assert.match(markup, new RegExp(`class="[^"]*${cls}`));
 assert.match(markup, /data-item-id="4"/);
  const table = context.window.IronBendOrderLineRenderer.table({ rowsHtml: markup, addCall:'addItem()' });
  assert.match(table, /class="order-lines-table ib-order-lines"/);
  for (const label of ['מס׳','אלמנט','צורה ומידות','קוטר','כמות','אורך','סה״כ','משקל','הוסף פריט']) assert.match(table, new RegExp(label));
});

test('factory order editor cache version is bumped with the shared table integration', () => {
  const factory = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(factory, /new-order-editor\.js\?v=7/);
  assert.match(editor, /unitLengthCm:\s*unitLenCm/);
  assert.doesNotMatch(editor, /\bunitLengthCm,\s*totalLength/);
});

test('order submission contracts preserve idempotency and retryable source files/history', () => {
  assert.match(html, /idempotency_key: portalDraftIdempotencyKey/);
  assert.match(html, /source-documents/);
  assert.match(html, /form\.append\('file', entry\.file, entry\.name\)/);
  assert.match(html, /entry\.uploaded = true/);
  assert.match(html, /createdOrderId && portalSourceFiles\.some/);
  assert.match(html, /portalHistoryUrl\(\)/);
  assert.match(html, /portalHistoryFilters\.offset \+= portalHistoryFilters\.limit/);
  assert.match(html, /id="portalHistoryStatus"/);
  assert.match(html, /id="portalHistoryFrom"/);
  assert.match(html, /id="portalHistoryTo"/);
});
