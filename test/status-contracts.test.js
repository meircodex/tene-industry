const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ORDER_STATUS,
  ITEM_STATUS,
  normalizeOrderStatus,
  isValidOrderTransition,
  allowedOrderTransitions,
  isValidOrderStatus,
  isValidItemStatus
} = require('../status-contracts');

test('order status aliases normalize to canonical values', () => {
  assert.equal(normalizeOrderStatus('אושרה'), ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
  assert.equal(normalizeOrderStatus('מאושר'), ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
  assert.equal(normalizeOrderStatus('סופק'), ORDER_STATUS.DELIVERED_CONFIRMED);
  assert.equal(normalizeOrderStatus('בוטל'), ORDER_STATUS.CANCELLED);
});
test('english order status aliases normalize for legacy integrations', () => {
  assert.equal(normalizeOrderStatus('approved'), ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
  assert.equal(normalizeOrderStatus('approved_waiting_production'), ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
  assert.equal(normalizeOrderStatus('planned'), ORDER_STATUS.PRODUCTION_QUEUE);
  assert.equal(normalizeOrderStatus('production_queue'), ORDER_STATUS.PRODUCTION_QUEUE);
  assert.equal(normalizeOrderStatus('in_production'), ORDER_STATUS.IN_PRODUCTION);
});

test('order status transitions accept valid moves and reject invalid skips', () => {
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.APPROVED_WAITING_PRODUCTION),
    true
  );
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.IN_PRODUCTION),
    false
  );
  assert.deepEqual(
    allowedOrderTransitions(ORDER_STATUS.SENT),
    [ORDER_STATUS.DELIVERED_CONFIRMED]
  );
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING),
    true
  );
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.LOADING, ORDER_STATUS.ON_THE_WAY),
    true
  );
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY),
    true
  );
  assert.equal(
    isValidOrderTransition(ORDER_STATUS.PARTIAL_DELIVERY, ORDER_STATUS.LOADING),
    true
  );
});

test('production item statuses are centralized', () => {
  assert.equal(isValidItemStatus(ITEM_STATUS.WAITING), true);
  assert.equal(isValidItemStatus(ITEM_STATUS.IN_PRODUCTION), true);
  assert.equal(isValidItemStatus(ITEM_STATUS.DONE), true);
  assert.equal(isValidItemStatus('bad-status'), false);
});

test('manual status choices allow skips and corrections with matching browser/server contracts', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const browser = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/status-contracts-client'), 'utf8'), browser);
  const { assertOrderStatusTransition } = require('../services/orderContracts');
  for (const from of Object.values(ORDER_STATUS)) {
    const choices = allowedOrderTransitions(from, { allowSkip: true });
    assert.deepEqual(Array.from(browser.window.IronBendStatus.allowedOrderTransitions(from, { allowSkip: true })), choices);
    if (from === ORDER_STATUS.CANCELLED) {
      assert.deepEqual(choices, []);
      assert.throws(() => assertOrderStatusTransition({ from, to: ORDER_STATUS.IN_PRODUCTION, role: 'admin', allowSkip: true }), { statusCode: 409 });
      continue;
    }
    for (const to of Object.values(ORDER_STATUS).filter(value => value !== from)) {
      assert.equal(isValidOrderTransition(from, to, { allowSkip: true }), true, `${from} -> ${to}`);
      assertOrderStatusTransition({ from, to, role: 'admin', allowSkip: true });
    }
  }
  for (const from of [ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.CUSTOMER_PENDING_APPROVAL]) {
    for (const to of [ORDER_STATUS.IN_PRODUCTION, ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.DELIVERED_CONFIRMED]) {
      assert.throws(() => assertOrderStatusTransition({ from, to, role: 'office', allowSkip: true }), { statusCode: 403 });
      assert.equal(assertOrderStatusTransition({ from, to, role: 'manager', allowSkip: true }).isApproval, true);
    }
  }
  assert.throws(() => assertOrderStatusTransition({ from: ORDER_STATUS.IN_PRODUCTION, to: ORDER_STATUS.LOADING, role: 'production', allowSkip: true }), { statusCode: 403 });
  assert.throws(() => assertOrderStatusTransition({ from: ORDER_STATUS.IN_PRODUCTION, to: ORDER_STATUS.APPROVED_WAITING_PRODUCTION, role: 'office', allowSkip: true }), { statusCode: 403 });
  assert.throws(() => assertOrderStatusTransition({ from: ORDER_STATUS.IN_PRODUCTION, to: 'bad-status', role: 'admin', allowSkip: true }), { statusCode: 400 });
});

test('order dropdown keeps all stages visible for pending, supplied and paid orders', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../public/orders.html'), 'utf8');
  const fragment = source.slice(source.indexOf('function canSelectOrderStatus('), source.indexOf('async function changeListOrderStatus('));
  const context = { ORDER_STATUS, allowedOrderTransitions: status => allowedOrderTransitions(status, { allowSkip: true }), escHtml: value => String(value), window: { IronBendAuth: { currentUser: () => ({ role: 'admin' }) } } };
  vm.createContext(context);
  vm.runInContext(fragment, context);
  for (const status of [ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.PARTIAL_DELIVERY, ORDER_STATUS.DELIVERED_CONFIRMED]) {
    for (const payment_status of ['unpaid', 'paid']) {
      const html = context.orderStatusSelect({ id: 86, order_num: 'TEST', status, payment_status });
      for (const option of Object.values(ORDER_STATUS)) assert.ok(html.includes(`value="${option}"`), `${status}/${payment_status}: ${option}`);
    }
  }
  context.window.IronBendAuth.currentUser = () => ({ role: 'office' });
  assert.equal(context.canSelectOrderStatus({ status: ORDER_STATUS.PENDING_APPROVAL }, ORDER_STATUS.IN_PRODUCTION), false);
  assert.equal(context.canSelectOrderStatus({ status: ORDER_STATUS.APPROVED_WAITING_PRODUCTION }, ORDER_STATUS.DONE_WAITING_PICKUP), true);
});


test('unknown order statuses are rejected by the order contract', () => {
  assert.equal(isValidOrderStatus(ORDER_STATUS.PENDING_APPROVAL), true);
  assert.equal(isValidOrderStatus('bad-order-status'), false);
});
