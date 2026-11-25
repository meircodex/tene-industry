'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPortalClient } = require('./helpers/customer-portal-client');

test('portal date mask presents day first and validates calendar dates before converting to ISO', () => {
  const client = loadPortalClient();
  const input = client.element('delivDate');
  input.setCustomValidity = message => { input.error = message; };
  input.reportValidity = () => { input.reported = true; };
  input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end; };

  for (const value of ['29022028', '2028-02-29']) {
    input.value = value;
    input.selectionStart = value.length;
    client.run("maskPortalDate(document.getElementById('delivDate'))");
    assert.equal(input.value, '29/02/2028');
    assert.equal(input.selectionStart, 10);
    assert.equal(input.selectionEnd, 10);
    assert.equal(client.run("readPortalDate(document.getElementById('delivDate'))"), '2028-02-29');
  }

  input.value = '2027-02-29';
  input.selectionStart = input.value.length;
  client.run("maskPortalDate(document.getElementById('delivDate'))");
  assert.equal(input.value, '29/02/2027');
  assert.equal(client.run("readPortalDate(document.getElementById('delivDate'))"), null);
  assert.match(input.error, /יום\/חודש\/שנה/);
  assert.equal(input.reported, true);
  assert.equal(client.run("parsePortalDate('')"), '');
});

test('an ISO delivery date from an existing draft displays day first and stays ISO when saved', () => {
  const client = loadPortalClient();
  const storage = new Map();
  client.context.localStorage = {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  client.run('ME = { id: 1 }; addItem()');
  const key = client.run('portalDraftStorageKey()');
  const draft = JSON.parse(storage.get(key));
  draft.deliveryDate = '2028-02-29';
  storage.set(key, JSON.stringify(draft));

  assert.equal(client.run('restorePortalDraft()'), true);
  assert.equal(client.element('delivDate').value, '29/02/2028');
  assert.equal(JSON.parse(storage.get(key)).deliveryDate, '2028-02-29');
});

test('submitting a day-first delivery date sends the existing ISO API value', async () => {
  const client = loadPortalClient();
  client.run('addItem()');
  const today = client.run('portalDateFormatter.format()');
  client.element('delivDate').value = today.split('-').reverse().join('/');

  const requests = [];
  client.context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ success: true, orderId: 1 }) };
  };
  client.context.showPortalOrderReceipt = async () => {};

  await client.run('submitOrder()');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/c/order');
  assert.equal(requests[0].body.deliveryDate, today);
});

test('the shared display formatter zero-pads dates and preserves the recorded calendar day', () => {
  const { formatPortalDate } = require('../public/portal-dates');
  assert.equal(formatPortalDate('2026-01-05'), '05/01/2026');
  assert.equal(formatPortalDate('2026-11-25T23:07:06.789Z'), '25/11/2026');
  assert.equal(formatPortalDate('2026-11-25 09:07:06', { withTime: true }), '25/11/2026 09:07');
  assert.equal(formatPortalDate('2026-11-25', { withTime: true }), '25/11/2026');
  assert.equal(formatPortalDate('invalid'), '');
  assert.equal(formatPortalDate(null), '');
});

test('order history, details and finance display dates from ISO data', () => {
  const client = loadPortalClient();
  client.context.order = {
    id: 1, order_num: 'QA', status: 'נשלחה לבדיקה', created_at: '2026-11-25 09:07:00',
    delivery_date: '2026-12-06', delivery_time: '10:30', pallets: [],
  };
  client.run(`
    renderDetail(order);
    PORTAL_FINANCE = {
      summary: {}, sites: [], history: [order],
      payments: { status: 'ready', rows: [{ invoiceNum: 'QA-INVOICE', dueDate: '2026-12-03' }] },
    };
    renderCustomerFinanceDashboard();
  `);
  const detail = client.element('detailContent').innerHTML;
  assert.match(detail, /<bdi>25\/11\/2026<\/bdi>/);
  assert.match(detail, /<bdi>06\/12\/2026<\/bdi> <bdi>10:30<\/bdi>/);
  assert.doesNotMatch(detail, /2026-(?:11|12)-\d{2}/);

  const finance = client.element('customerFinanceDashboard').innerHTML;
  assert.match(finance, /אספקה<\/span><bdi>06\/12\/2026<\/bdi>/);
  assert.match(finance, /מועד <bdi>03\/12\/2026<\/bdi>/);
  assert.doesNotMatch(finance, /2026-12-\d{2}/);
  assert.match(client.run('portalOrderCardsHtml([order])'), /אספקה: <bdi>06\/12\/2026<\/bdi>/);
});
