'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPortalClient } = require('./helpers/customer-portal-client');

const emptyCopy = /לא נמצאו יתרות חשבוניות/;
const failedCopy = /רשימת החשבוניות לתשלום לא נטענה/;
const invoice = { invoiceNum: 'TEST-17', siteName: 'אתר בדיקה', status: 'due_now', amount: 1250 };

function setup(payment) {
  const portal = loadPortalClient();
  const calls = [];
  portal.run('TOKEN = "fixture"; canViewCustomerFinance = () => true;');
  portal.context.fetch = async href => {
    const path = new URL(href, 'http://portal.test').pathname;
    calls.push(path);
    if (path.endsWith('/payments-due')) return payment();
    const data = path.endsWith('/summary') ? { summary: { dueNow: 1250, canSeeMoney: true } }
      : path.endsWith('/sites') ? { sites: [] } : { orders: [] };
    return response(data);
  };
  return { ...portal, calls, dashboard: portal.element('customerFinanceDashboard') };
}

const response = (data, ok = true) => ({ ok, json: async () => data });

for (const [label, payment] of [
  ['HTTP 503, even with an empty payments array', () => response({ payments: [] }, false)],
  ['network rejection', () => { throw new Error('offline'); }],
  ['invalid JSON', () => ({ ok: true, json: async () => { throw new SyntaxError('invalid'); } })],
  ['invalid response shape', () => response({ error: 'bad response' })],
]) {
  test('due invoice section reports ' + label + ' without erasing the valid summary', async () => {
    const portal = setup(payment);
    await portal.run('loadCustomerFinanceDashboard()');
    assert.match(portal.dashboard.innerHTML, /1,250/);
    assert.match(portal.dashboard.innerHTML, failedCopy);
    assert.doesNotMatch(portal.dashboard.innerHTML, emptyCopy);
    assert.match(portal.dashboard.innerHTML, /נסה שוב/);
  });
}

test('only a successful empty list claims no due invoices, and restricted results explain access', async () => {
  let payload = { payments: [] };
  const portal = setup(() => response(payload));
  await portal.run('loadCustomerFinanceDashboard()');
  assert.match(portal.dashboard.innerHTML, emptyCopy);
  assert.doesNotMatch(portal.dashboard.innerHTML, failedCopy);
  payload = { financeHidden: true, payments: [] };
  await portal.run('loadCustomerFinanceDashboard()');
  assert.match(portal.dashboard.innerHTML, /אינה זמינה בהרשאות שלך/);
  assert.doesNotMatch(portal.dashboard.innerHTML, emptyCopy);
});

test('retry fetches just the invoice list, guards concurrent clicks, and restores focus after recovery', async () => {
  let attempt = 0;
  let resolveRetry;
  const portal = setup(() => ++attempt === 1 ? response({}, false)
    : new Promise(resolve => { resolveRetry = resolve; }));
  await portal.run('loadCustomerFinanceDashboard()');
  const dashboardBefore = portal.dashboard.innerHTML;
  const region = portal.element('portalFinancePayments');
  const retry = portal.element('portalFinancePaymentsRetry');
  portal.context.document.activeElement = retry;
  let focused = 0;
  region.focus = () => { focused++; };
  const pending = portal.run('retryPortalFinancePayments()');
  await portal.run('retryPortalFinancePayments()');
  assert.equal(attempt, 2);
  assert.equal(portal.dashboard.innerHTML, dashboardBefore);
  resolveRetry(response({ payments: [invoice], canSeeMoney: true }));
  await pending;
  assert.match(region.innerHTML, /TEST-17/);
  assert.doesNotMatch(region.innerHTML, failedCopy);
  assert.equal(portal.dashboard.innerHTML, dashboardBefore);
  assert.equal(focused, 1);
  assert.deepEqual(portal.calls.slice(4), ['/api/c/finance/payments-due']);
});

test('an old retry cannot render invoices into a different signed-in session', async () => {
  let attempt = 0;
  let resolveRetry;
  const portal = setup(() => ++attempt === 1 ? response({}, false)
    : new Promise(resolve => { resolveRetry = resolve; }));
  await portal.run('loadCustomerFinanceDashboard()');
  const pending = portal.run('retryPortalFinancePayments()');
  portal.run('TOKEN = "different-fixture"; PORTAL_FINANCE = null;');
  resolveRetry(response({ payments: [invoice] }));
  await pending;
  assert.doesNotMatch(portal.element('portalFinancePayments').innerHTML, /TEST-17/);
});

test('a retry that fails again restores the retry action without reloading the dashboard', async () => {
  const portal = setup(() => response({}, false));
  await portal.run('loadCustomerFinanceDashboard()');
  const region = portal.element('portalFinancePayments');
  const retry = portal.element('portalFinancePaymentsRetry');
  portal.context.document.activeElement = retry;
  region.focus = () => { portal.context.document.activeElement = region; };
  let focused = 0;
  retry.focus = () => { focused++; };
  await portal.run('retryPortalFinancePayments()');
  assert.match(region.innerHTML, failedCopy);
  assert.match(region.innerHTML, /נסה שוב/);
  assert.equal(focused, 1);
  assert.equal(portal.calls.length, 5);
});

test('a successful list renders invoices on first view', async () => {
  const portal = setup(() => response({ payments: [invoice], canSeeMoney: true }));
  await portal.run('loadCustomerFinanceDashboard()');
  assert.match(portal.dashboard.innerHTML, /TEST-17/);
  assert.doesNotMatch(portal.dashboard.innerHTML, emptyCopy);
  assert.doesNotMatch(portal.dashboard.innerHTML, failedCopy);
});
