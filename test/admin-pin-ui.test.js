'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const resetStart = html.indexOf('async function resetUserPin');
const resetEnd = html.indexOf('// ── PERSONAL WORKER INVITATIONS', resetStart);
const script = `let usersData = [{ id: 7, display_name: 'עובד בדיקה', username: 'worker' }];\n${html.slice(resetStart, resetEnd)}`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(fetchImpl) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', open: false,
      showModal() { this.open = true; },
      close() { this.open = false; this.onclose?.(); },
    });
    return nodes.get(id);
  };
  const alerts = [];
  const context = vm.createContext({
    document: { getElementById: node },
    confirm: () => true,
    alert: message => alerts.push(message),
    fetch: fetchImpl,
    loadUsers: () => Promise.resolve(),
    navigator: { clipboard: { writeText: async () => {} } },
    toast: () => {},
  });
  vm.runInContext(script, context);
  return { context, node, alerts };
}

test('cancelled confirmation does not make a reset request', async () => {
  let calls = 0;
  const f = fixture(() => { calls++; });
  f.context.confirm = () => false;
  await f.context.resetUserPin(7);
  assert.equal(calls, 0);
});

test('double submit while reset is in flight sends only one request', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(() => { calls++; return pending.promise; });
  const first = f.context.resetUserPin(7);
  const second = f.context.resetUserPin(7);
  assert.equal(calls, 1);
  pending.resolve({ ok: true, json: async () => ({ user: { display_name: 'עובד בדיקה' }, temporaryPin: '1234' }) });
  await Promise.all([first, second]);
});

test('network failure reports an error and clears the busy guard', async () => {
  let calls = 0;
  const f = fixture(() => { calls++; return Promise.reject(new Error('offline')); });
  await f.context.resetUserPin(7);
  assert.equal(calls, 1);
  assert.equal(f.context.resetUserPin.inFlight, false);
  assert.equal(f.alerts.length, 1);
});

test('closing the dialog clears the displayed PIN, including close-event cleanup', () => {
  const f = fixture(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  f.node('temporaryPinUser').textContent = 'למשתמש: עובד בדיקה';
  f.node('temporaryPinValue').textContent = '1234';
  f.node('temporaryPinDialog').onclose = f.context.clearTemporaryPinDialog;
  f.node('temporaryPinDialog').open = true;
  f.node('temporaryPinDialog').close();
  assert.equal(f.node('temporaryPinValue').textContent, '');
  assert.equal(f.node('temporaryPinUser').textContent, '');
  assert.match(html, /temporaryPinDialog[^>]*onclose="clearTemporaryPinDialog\(\)"/);
  assert.match(html, /#temporaryPinDialog::backdrop\s*\{\s*background:rgba\(15,23,42/);
});
