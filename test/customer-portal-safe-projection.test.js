const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { ORDER_STATUS } = require('../status-contracts');
const { customerStatusFromOrder } = require('../services/customerPortalStatus');
const {
  projectPortalOrder,
  projectPortalOrderDetail,
  projectPortalItem,
} = require('../services/customerPortalProjection');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('customer portal maps internal statuses to customer-facing labels', () => {
  const approved = customerStatusFromOrder({ status: ORDER_STATUS.APPROVED_WAITING_PRODUCTION });
  assert.equal(approved.customer_status, 'approved');
  assert.notEqual(approved.customer_status_label, ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
  assert.equal(approved.customer_status_label, 'אושרה');

  const pendingInternal = projectPortalOrder({ id: 1, order_num: 'HZ-1', status: ORDER_STATUS.PENDING_APPROVAL }, { caps: {} });
  assert.equal(pendingInternal.status, 'נשלחה לבדיקה');
  assert.equal(pendingInternal.customerStatus, 'submitted_review');
});

test('customer portal projection hides prices unless explicitly allowed', () => {
  const order = { id: 2, order_num: 'HZ-2', status: 'ממתינה לאישור לקוח', portal_price: 1234, total_weight: 500, site_id: 17, site_name: 'מגדל א' };
  const hidden = projectPortalOrder(order, { caps: { seePrice: false } });
  assert.equal(hidden.customerCanViewPrice, false);
  assert.equal('portal_price' in hidden, false);
  assert.equal('totalPrice' in hidden, false);

  const visible = projectPortalOrder(order, { caps: { seePrice: true } });
  assert.equal(visible.customerCanViewPrice, true);
  assert.equal(visible.portal_price, 1234);
  assert.equal(visible.totalPrice, 1234);
  assert.equal(visible.site_id, 17);
  assert.equal(visible.site_name, 'מגדל א');
});

test('customer portal item projection does not expose production-only fields', () => {
  const item = projectPortalItem({
    id: 5,
    shape_name: 'L',
    diameter: 12,
    quantity: 4,
    total_length_mm: 1300,
    total_weight: 18.2,
    status: 'בייצור פנימי',
    machine: 'A',
    production_qty: 5,
    cost: 100,
    margin: 40,
    internal_notes: 'office only',
    supplier: 'secret',
  });
  for (const forbidden of ['status', 'machine', 'production_qty', 'cost', 'margin', 'internal_notes', 'supplier']) {
    assert.equal(forbidden in item, false, `${forbidden} leaked to portal item projection`);
  }
  assert.equal(item.shape_name, 'L');
  assert.equal(item.quantity, 4);
  assert.equal(item.total_weight, 18.2);
});

test('customer portal does not use note as element name fallback', () => {
  const item = projectPortalItem({
    id: 6,
    shape_name: 'straight',
    diameter: 12,
    quantity: 1,
    note: 'להתקשר לפני אספקה',
  });

  assert.equal(item.elementName, '');
  assert.equal(item.struct_element, null);
  assert.equal(item.note, 'להתקשר לפני אספקה');
});

test('customer portal order detail returns safe pallets/items and no raw internal status', () => {
  const detail = projectPortalOrderDetail(
    { id: 7, order_num: 'HZ-7', status: ORDER_STATUS.APPROVED_WAITING_PRODUCTION, portal_price: 999 },
    [{ id: 1, pallet_num: 1, items: [{ id: 10, status: 'פנימי', machine: 'B', production_qty: 3, total_weight: 11 }] }],
    [],
    { caps: { seePrice: false } }
  );
  assert.equal(detail.status, 'אושרה');
  assert.equal('portal_price' in detail, false);
  assert.equal(detail.pallets.length, 1);
  assert.equal(detail.pallets[0].items.length, 1);
  assert.equal('status' in detail.pallets[0].items[0], false);
  assert.equal('machine' in detail.pallets[0].items[0], false);
  assert.equal('production_qty' in detail.pallets[0].items[0], false);
});

test('customer portal route does not let portal submit own production fields', () => {
  const route = read('routes/portal.js');
  const submitStart = route.indexOf("router.post('/c/order'");
  assert.ok(submitStart > -1, 'portal order endpoint exists');
  const submitEnd = route.indexOf("router.get('/c/approve/:token'", submitStart);
  const submitBlock = route.slice(submitStart, submitEnd);
  const insertMatch = submitBlock.match(/INSERT INTO items \(([^)]+)\)/);
  assert.ok(insertMatch, 'items insert exists in portal order endpoint');
  assert.doesNotMatch(insertMatch[1], /production_qty/);
  assert.doesNotMatch(insertMatch[1], /machine/);
  assert.doesNotMatch(submitBlock, /assignResource\(item\.diameter\)/);
});

test('customer portal order detail endpoint uses safe projection', () => {
  const route = read('routes/portal.js');
  const detailStart = route.indexOf("router.get('/c/orders/:orderId'");
  assert.ok(detailStart > -1, 'portal order detail endpoint exists');
  const detailBlock = route.slice(detailStart, route.indexOf('return router;', detailStart));
  assert.match(detailBlock, /projectPortalOrderDetail/);
  assert.doesNotMatch(detailBlock, /segments,struct_element,struct_floor,sheet_num,status,note/);
});
