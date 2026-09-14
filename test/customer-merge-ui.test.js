'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/customer-merge.js'), 'utf8');
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const nodes = new Map(), requests = [], effects = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, hidden: false, open: false, style: {}, textContent: '', innerHTML: '', listeners: {},
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelectorAll() { return Array.from(nodes.values()); },
    });
    return nodes.get(id);
  };
  const preview = { source: { id: 2, name: 'כפול' }, target: { id: 1, name: 'ראשי' }, taxId: '512345678', token: 'signed-test-preview', counts: [], warnings: ['יש לבדוק הרשאות פורטל'], blockers: [], activePortalUsersToSuspend: 1, canMerge: true };
  const context = vm.createContext({
    document: { getElementById: node },
    isSystemAdmin: () => true,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/customers/1') return response({ id: 1, name: 'ראשי', tax_id: preview.taxId });
      if (url === '/api/customers/merge/preview') return response(preview);
      if (url.startsWith('/api/customers?q=')) return response([{ id: 1, name: 'ראשי' }, { id: 2, name: '<כפול>', tax_id: null }]);
      if (url === '/api/customers/merge/confirm') return response({ success: true, targetId: 1, taxId: preview.taxId });
      throw new Error('Unexpected test URL: ' + url);
    },
    closeModal: () => effects.push('close-edit'),
    window: { showToast: message => effects.push(message) },
    loadList: async taxId => effects.push('list:' + taxId),
    selectCustomer: async id => effects.push('select:' + id),
  });
  vm.runInContext(source, context);
  const approve = () => {
    node('customerMergeAcknowledge').checked = true;
    node('customerMergeConfirmTaxId').value = preview.taxId;
    context.updateCustomerMergeConfirmation();
  };
  return { context, node, requests, effects, preview, approve };
}

test('merge UI is admin-only; manual search excludes the primary card and escapes customer text', async () => {
  const f = fixture();
  f.context.isSystemAdmin = () => false;
  await f.context.openCustomerMerge(1);
  assert.equal(f.requests.length, 0);
  f.context.isSystemAdmin = () => true;
  await f.context.openCustomerMerge(1);
  assert.equal(f.node('customerMergeDialog').open, true);
  assert.match(f.node('customerMergeResults').innerHTML, /&lt;כפול&gt;/);
  assert.doesNotMatch(f.node('customerMergeResults').innerHTML, /selectCustomerMergeSource\(1\)/);
});

test('merge UI requires checkbox and matching tax ID; success refreshes the primary card', async () => {
  const f = fixture();
  await f.context.openCustomerMerge(1, 2);
  assert.equal(f.node('customerMergeConfirm').disabled, true);
  await f.context.confirmCustomerMerge();
  assert.equal(f.requests.filter(row => row.url.endsWith('/confirm')).length, 0);
  f.node('customerMergeAcknowledge').checked = true;
  f.node('customerMergeConfirmTaxId').value = '111111111';
  f.context.updateCustomerMergeConfirmation();
  assert.equal(f.node('customerMergeConfirm').disabled, true);
  f.approve();
  assert.equal(f.node('customerMergeConfirm').disabled, false);
  await f.context.confirmCustomerMerge();
  const sent = f.requests.find(row => row.url.endsWith('/confirm'));
  assert.deepEqual(JSON.parse(sent.options.body), { token: f.preview.token, acknowledge: true, confirmTaxId: f.preview.taxId });
  assert.equal(f.node('customerMergeDialog').open, false);
  assert.ok(f.effects.includes('list:512345678'));
  assert.ok(f.effects.includes('select:1'));
});

test('cancel invalidates an outstanding preview and never submits a merge', async () => {
  const f = fixture(), pending = deferred(), original = f.context.fetch;
  f.context.fetch = (url, options) => url.endsWith('/preview') ? pending.promise : original(url, options);
  const opening = f.context.openCustomerMerge(1, 2);
  await new Promise(resolve => setImmediate(resolve));
  f.context.closeCustomerMerge();
  pending.resolve(response(f.preview));
  await opening;
  assert.equal(f.node('customerMergeDialog').open, false);
  assert.equal(f.node('customerMergePreview').innerHTML, '');
  assert.equal(f.requests.filter(row => row.url.endsWith('/confirm')).length, 0);
});

test('double-click and close during submission do not duplicate or interrupt a merge', async () => {
  const f = fixture(), pending = deferred(), original = f.context.fetch;
  await f.context.openCustomerMerge(1, 2);
  f.approve();
  let confirms = 0;
  f.context.fetch = (url, options) => {
    if (url.endsWith('/confirm')) { confirms++; return pending.promise; }
    return original(url, options);
  };
  const first = f.context.confirmCustomerMerge();
  await f.context.confirmCustomerMerge();
  f.context.closeCustomerMerge();
  let cancelled = false;
  f.node('customerMergeDialog').listeners.cancel({ preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.equal(f.node('customerMergeDialog').open, true);
  assert.equal(confirms, 1);
  pending.resolve(response({ success: true, targetId: 1, taxId: f.preview.taxId }));
  await first;
});

test('stale preview errors disable confirmation until another preview is approved', async () => {
  const f = fixture();
  await f.context.openCustomerMerge(1, 2);
  f.approve();
  f.context.fetch = async () => response({ code: 'stale_merge_preview', error: 'הנתונים השתנו' }, false);
  await f.context.confirmCustomerMerge();
  assert.equal(f.node('customerMergeDialog').open, true);
  assert.equal(f.node('customerMergeConfirm').disabled, true);
  assert.equal(f.node('customerMergeStatus').textContent, 'הנתונים השתנו');
});

test('network retries preserve the signed idempotent request', async () => {
  const f = fixture();
  await f.context.openCustomerMerge(1, 2);
  f.approve();
  const bodies = [];
  f.context.fetch = async (url, options) => { bodies.push(options.body); throw new Error('network unavailable'); };
  await f.context.confirmCustomerMerge();
  assert.equal(f.node('customerMergeConfirm').disabled, false);
  await f.context.confirmCustomerMerge();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('editing the chosen tax ID clears prior acknowledgement and confirmation', async () => {
  const f = fixture();
  await f.context.openCustomerMerge(1, 2);
  f.approve();
  f.node('customerMergeTaxId').value = '598765432';
  f.context.invalidateCustomerMergePreview();
  assert.equal(f.node('customerMergeAcknowledge').checked, false);
  assert.equal(f.node('customerMergeConfirmTaxId').value, '');
  assert.equal(f.node('customerMergeConfirm').disabled, true);
});
