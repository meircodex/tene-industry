'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const axios = require('axios');

const config = {
  PRIORITY_BASE_URL: 'https://priority.invalid',
  PRIORITY_COMPANY: 'DEMO',
  PRIORITY_USER: 'local-test',
  PRIORITY_PASS: 'unused-by-stub',
};
const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
Object.assign(process.env, config);
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const priority = require('../priority');
const customer = { name: 'תקרה, שלב "ג"', phone: '0500000000', address: 'אתר הבנייה' };
const order = { order_num: '105', delivery_date: '2026-11-20', general_notes: 'לפי תכנית' };
const item = { diameter: 8, shape_name: 'כיפוף לתקרה', total_weight: 139, billing_weight: 140 };
const customerLookup = "CUSTOMERS?$filter=PHONE eq '0500000000'&$select=CUSTNAME,CUSTDES";
const priceLookup = "PRICELISTS?$filter=CUST eq 'C105'&$top=1";

function stubPriority(t, responses) {
  const methods = {};
  for (const method of ['get', 'post', 'patch']) {
    methods[method] = t.mock.fn(async (path, body) => {
      const handler = responses[method];
      assert.ok(handler, `Unexpected Priority ${method.toUpperCase()} ${path}`);
      return { data: await handler(path, body) };
    });
  }
  const create = t.mock.method(axios, 'create', () => methods);
  return { ...methods, create };
}

test('unconfigured Priority returns local fallbacks without constructing HTTP clients', async t => {
  t.after(() => { process.env.PRIORITY_PASS = config.PRIORITY_PASS; });
  delete process.env.PRIORITY_PASS;
  const http = stubPriority(t, {});
  assert.equal(priority.isConfigured(), false);
  assert.deepEqual(await priority.findOrCreateCustomer({ ...customer, priorityId: 'C105' }), {
    mocked: true, CUSTNAME: 'C105',
  });
  assert.deepEqual(await priority.createOrder(order, customer, [item]), { ORDNAME: 'P-105', mocked: true });
  assert.deepEqual(await priority.createDeliveryNote('P-105'), { mocked: true });
  assert.deepEqual(await priority.updateOrderStatus('P-105', 'סופק – אושר'), { mocked: true });
  assert.equal(await priority.getCustomerPrice('C105'), null);
  assert.equal(http.create.mock.callCount(), 0);
});

test('Priority order reuses the customer and sends priced Hebrew lines to the HTTP stub', async t => {
  const http = stubPriority(t, {
    get(path) {
      if (path === customerLookup) return { value: [{ CUSTNAME: 'C105', CUSTDES: customer.name }] };
      if (path === priceLookup) return { value: [{ PRICE: 3 }] };
      assert.fail(`Unexpected Priority GET ${path}`);
    },
    post(path) {
      assert.equal(path, 'ORDERS');
      return { ORDNAME: 'P-105' };
    },
  });

  assert.equal(priority.isConfigured(), true);
  assert.deepEqual(await priority.createOrder(order, customer, [item, { ...item, billing_weight: null }]), {
    ORDNAME: 'P-105',
  });
  assert.deepEqual(http.get.mock.calls.map(call => call.arguments[0]), [customerLookup, priceLookup]);
  assert.equal(http.post.mock.callCount(), 1);
  const [path, { CURDATE, ...body }] = http.post.mock.calls[0].arguments;
  assert.equal(path, 'ORDERS');
  assert.match(CURDATE, /^\d{8}$/);
  assert.deepEqual(body, {
    CUSTNAME: 'C105', DUEDATE: '20261120', REMARK: 'לפי תכנית',
    ORDLINES_SUBFORM: [
      { KLINE: 1, PART: 'REBAR-8', PDES: 'ברזל Ø8 - כיפוף לתקרה', TQUANT: 140, PRICE: 3, QPRICE: 420 },
      { KLINE: 2, PART: 'REBAR-8', PDES: 'ברזל Ø8 - כיפוף לתקרה', TQUANT: 139, PRICE: 3, QPRICE: 417 },
    ],
  });
  for (const call of http.create.mock.calls) {
    assert.equal(call.arguments[0].baseURL, 'https://priority.invalid/odata/Priority/DEMO/');
  }
});

test('Priority creates a missing customer and tolerates an unavailable price list', async t => {
  const http = stubPriority(t, {
    get(path) {
      if (path === customerLookup) return { value: [] };
      assert.equal(path, priceLookup);
      throw new Error('Price list unavailable');
    },
    post(path) {
      if (path === 'CUSTOMERS') return { CUSTNAME: 'C105' };
      assert.equal(path, 'ORDERS');
      return { ORDNAME: 'P-105' };
    },
  });

  assert.deepEqual(await priority.createOrder(order, customer, [item]), { ORDNAME: 'P-105' });
  assert.equal(http.post.mock.callCount(), 2);
  assert.deepEqual(http.post.mock.calls[0].arguments, ['CUSTOMERS', {
    CUSTDES: customer.name, PHONE: customer.phone, ADDRESS: customer.address, CONTACTNAME: '', CONTACTPHONE: '',
  }]);
  assert.equal(http.post.mock.calls[1].arguments[1].ORDLINES_SUBFORM[0].QPRICE, 0);
  assert.equal(await priority.getCustomerPrice('C105'), null);
});

test('Priority delivery, status updates and price reads use the stubbed endpoints', async t => {
  const http = stubPriority(t, {
    post: () => ({ DOCNO: 'DN-105' }),
    patch: () => ({ ORDNAME: 'P-105' }),
    get(path) {
      if (path === priceLookup) return { value: [{ PRICE: 3 }] };
      assert.equal(path, "PRICELISTS?$filter=CUST eq 'C106'&$top=1");
      return { value: [] };
    },
  });

  assert.deepEqual(await priority.createDeliveryNote('P-105'), { DOCNO: 'DN-105' });
  assert.deepEqual(await priority.updateOrderStatus('P-105', 'סופק – אושר'), { ORDNAME: 'P-105' });
  await priority.updateOrderStatus('P-105', 'הושלם – ממתין לאיסוף');
  assert.deepEqual(await priority.getCustomerPrice('C105'), { PRICE: 3 });
  assert.equal(await priority.getCustomerPrice('C106'), null);
  assert.deepEqual(http.post.mock.calls.map(call => call.arguments), [["ORDERS('P-105')/LOGPART_SUBFORM", {}]]);
  assert.deepEqual(http.patch.mock.calls.map(call => call.arguments), [
    ["ORDERS('P-105')", { STATDES: 'CLOSED' }],
    ["ORDERS('P-105')", { STATDES: 'OPEN' }],
  ]);
});
