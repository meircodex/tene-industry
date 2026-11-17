'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const warehousePage = fs.readFileSync(path.join(__dirname, '..', 'public', 'warehouse.html'), 'utf8');
const orderPrintRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'orderPrintA4.js'), 'utf8');
const scannerPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'scan.html'), 'utf8');
const customerScanPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'customer-scan.html'), 'utf8');
const navigation = fs.readFileSync(path.join(__dirname, '..', 'public', 'nav.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8'));

test('public QR opens customer registration while the in-app scanner server-authorizes production codes', () => {
  assert.match(orderPrintRoute, /customerScanUrl\(req, `TENE-ORDER-/);
  assert.doesNotMatch(orderPrintRoute, /web\+ironbend:\/\/open\/order\//);
  assert.match(orderPrintRoute, /QRCode\.toDataURL\(orderQrToken/);
  assert.doesNotMatch(orderPrintRoute, /QRCode\.toDataURL\(fullOrderUrl/);
  assert.match(warehousePage, /orderIdFromQr/);
  assert.match(warehousePage, /scanOrderQrValue/);
  assert.match(warehousePage, /\/api\/loading\/card-sessions/);
  assert.doesNotMatch(warehousePage, /\/api\/loading\/sessions/);
  assert.doesNotMatch(warehousePage, /deliverySelectorCard/);
  assert.match(warehousePage, /CARD_LOADING_STORAGE_KEY/);
  assert.match(warehousePage, /localStorage\.setItem\(CARD_LOADING_STORAGE_KEY/);
  assert.match(warehousePage, /visibilitychange/);
  assert.match(warehousePage, /resumeCardCamera\(\{quiet:true\}\)/);
  assert.match(warehousePage, /BarcodeDetector/);
  assert.match(warehousePage, /wakeLock/);
  assert.match(warehousePage, /partial-departure/);
  assert.match(warehousePage, /כרטיסי עבודה/);
  assert.match(scannerPage, /normalizedScan/);
  assert.match(scannerPage, /customer-scan/);
  assert.match(scannerPage, /web\+ironbend/);
  assert.match(scannerPage, /BarcodeDetector/);
  assert.match(scannerPage, /\/api\/qr-access\/scan/);
  assert.match(scannerPage, /location\.href=result\.target/);
  assert.match(navigation, /href:'\/scan\.html'/);
  assert.match(navigation, /SETTINGS_IDS = \[[^\]]*'scanner'/);
  assert.match(customerScanPage, /href="\/customer\.html\?source=qr"/);
  assert.match(customerScanPage, /הרשמה או כניסה לפורטל/);
  assert.match(customerScanPage, /אינה מציגה מספר הזמנה, כרטיס עבודה או נתוני ייצור/);
  assert.doesNotMatch(customerScanPage, /href="[^"]*(?:scan|worker|warehouse)\.html/);
  assert.deepEqual(manifest.protocol_handlers, [
    { protocol: 'web+ironbend', url: '/scan.html?protocol=%s' },
  ]);
});

test('A4 order rows keep dimensions on the canonical shape drawing, without a duplicate dimensions column', () => {
  assert.doesNotMatch(orderPrintRoute, /<th>מידות \(ס"מ\)<\/th>/);
  assert.doesNotMatch(orderPrintRoute, /buildDimsHtml/);
  assert.doesNotMatch(orderPrintRoute, /dims-td/);
  assert.match(orderPrintRoute, /shape_svg:\s+productionCards\.itemShapeSvg\(it\)/);
  assert.match(orderPrintRoute, /colspan="7"/);
});
