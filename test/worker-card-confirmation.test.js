'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/worker-visual.html'), 'utf8');
const inlineScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('const state='));
assert.ok(inlineScript, 'Worker page must contain its client script');
const script = inlineScript.replace(/^\s*load\(\);if\(!SCAN_ENTRY\)ws\(\);\s*$/m, '');
const token = 'HZ-2026-086-000042';
const originalCard = { item_id: 42, html: '<div class="pc-print-face">כרטיס המקור</div>', read_only: true };
const receipt = action => ({ id: 701, item_id: 42, action, occurred_at: '2026-10-15T09:12:34.000Z' });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(fetchImpl, { search = '?scan=1&card=' + token } = {}) {
  const nodes = new Map(), requests = [], timers = new Map();
  let nextTimer = 1, renders = 0;
  const node = id => {
    if (!nodes.has(id)) {
      const value = {
        id, textContent: '', innerHTML: '', value: '', className: '', disabled: false,
        hidden: false, dataset: {}, style: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener() {}, scrollIntoView() {}, focus() {},
        querySelectorAll() { return [node('save-button'), node('status-button'), node('unit-button')]; },
      };
      let inputValue = '';
      Object.defineProperty(value, 'value', {
        get: () => inputValue,
        set: next => { inputValue = String(next); },
        enumerable: true,
      });
      value.classList = {
        add(...names) { value.className = [...new Set([...value.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove(...names) { value.className = value.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle(name, force) {
          const has = value.className.split(/\s+/).includes(name);
          const enabled = force === undefined ? !has : force;
          if (enabled) this.add(name); else this.remove(name);
          return enabled;
        },
        contains(name) { return value.className.split(/\s+/).includes(name); },
      };
      nodes.set(id, value);
    }
    return nodes.get(id);
  };
  const item = {
    id: 42, order_id: 6, order_num: 'HZ-2026-086', quantity: 12,
    status: 'ממתין', produced_qty: 2, actual_weight_kg: 5, note: 'הערה שמורה', weight: 30,
  };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, DOMException,
    location: { search, origin: 'https://scan.example', protocol: 'https:', host: 'scan.example', replace(url) { this.redirect = url; } },
    document: {
      body: node('body'), getElementById: node,
      querySelector: selector => node(selector.startsWith('#') ? selector.slice(1) : selector),
      querySelectorAll: selector => selector === '.tabs button' ? [] : [node('save-button'), node('status-button'), node('unit-button')],
    },
    navigator: { onLine: true },
    fetch: (url, options = {}) => { requests.push({ url, options }); return fetchImpl(url, options); },
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(),
    fixtureItem: item,
    countRender: () => { renders++; },
    console,
  });
  context.window = context;
  vm.runInContext(script, context, { filename: 'worker-visual.html' });
  const run = source => vm.runInContext(source, context);
  run('render = () => countRender(); state.items = [fixtureItem]; state.focusItemId = 42; state.scanToken = "' + token + '";');
  node('actual-weight-42').value = '17.5';
  node('produced-qty-42').value = '7';
  node('production-note-42').value = 'הערה שהעובד עדיין עורך';
  return {
    context, node, requests, timers, item, run,
    feedback: () => node('operationFeedback'),
    renders: () => renders,
    expireTimers: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.fn()); },
  };
}

function assertDraftPreserved(f) {
  assert.equal(f.node('actual-weight-42').value, '17.5');
  assert.equal(f.node('produced-qty-42').value, '7');
  assert.equal(f.node('production-note-42').value, 'הערה שהעובד עדיין עורך');
  assert.equal(f.item.actual_weight_kg, 5);
  assert.equal(f.item.produced_qty, 2);
  assert.equal(f.item.note, 'הערה שמורה');
  assert.equal(f.renders(), 0, 'A failed or uncertain write must not replace the draft controls');
}

function assertReceiptVisible(f) {
  assert.equal(f.feedback().dataset.state, 'success');
  assert.match(f.feedback().textContent, /701/, 'Success must include the persisted receipt number');
  assert.match(f.feedback().textContent, /\d{1,2}:\d{2}/, 'Success must include the server receipt time');
}

test('scan confirmation remains visible in direct-camera entry mode and is announced accessibly', () => {
  const panelStart = html.indexOf('<section class="scan-panel">');
  const panelEnd = html.indexOf('</section>', panelStart);
  const feedbackIndex = html.indexOf('id="operationFeedback"');
  assert.ok(feedbackIndex >= 0, 'A persistent confirmation region is required');
  assert.ok(feedbackIndex < panelStart || feedbackIndex > panelEnd, 'Confirmation must not be inside the scan panel hidden on camera entry');
  const tag = html.slice(html.lastIndexOf('<', feedbackIndex), html.indexOf('>', feedbackIndex) + 1);
  assert.match(tag, /aria-live="(?:polite|assertive)"/);
});

test('opening a QR waits for a persisted matching scan receipt before confirming', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.run('state.focusItemId = null; state.scanToken = null; state.items = [];');
  const loading = f.context.load();
  assert.equal(f.feedback().dataset.state, 'pending');
  assert.notEqual(f.feedback().dataset.state, 'success');
  pending.resolve(response({ items: [f.item], scan_receipt: receipt('opened'), original_card: originalCard }));
  await loading;
  assertReceiptVisible(f);
  assert.equal(f.run('state.focusItemId'), 42);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.match(f.requests[0].url, /&original=1/);
  assert.equal(f.run('state.originalCard.html'), originalCard.html);
});

for (const missingOriginal of [undefined, { ...originalCard, item_id: 99 }, { ...originalCard, html: '' }]) {
  test('an acknowledged camera scan cannot start production without the matching original work card: ' + JSON.stringify(missingOriginal), async () => {
    const f = fixture(async () => response({ items: [f.item], scan_receipt: receipt('opened'), original_card: missingOriginal }));
    f.run('state.focusItemId = null; state.scanToken = null; state.items = [];');
    await f.context.load();
    assert.equal(f.feedback().dataset.state, 'failed');
    assert.match(f.feedback().textContent, /701/, 'A persisted scan receipt should remain distinguishable from a missing card image');
    assert.equal(f.run('state.focusItemId'), null);
    assert.equal(f.run('state.items.length'), 0);
    assert.equal(f.renders(), 0, 'Never expose production controls for an absent or different original card');
  });
}

test('manual queue scanning also requires server confirmation instead of trusting a locally matched item', async () => {
  const f = fixture(async () => response({ items: [f.item] }), { search: '' });
  f.run('state.focusItemId = null; state.scanToken = null;');
  f.node('cardScanInput').value = token;
  await f.context.openScannedCard();
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /^\/api\/worker-card\?card=/);
  assert.equal(f.feedback().dataset.state, 'unknown');
  assert.equal(f.run('state.focusItemId'), null);
  assert.equal(f.renders(), 0);
});

test('manual queue scanning confirms only the persisted matching receipt', async () => {
  const f = fixture(async () => response({ items: [f.item], scan_receipt: receipt('opened') }), { search: '' });
  f.run('state.focusItemId = null; state.scanToken = null;');
  f.node('cardScanInput').value = token;
  await f.context.openScannedCard();
  assertReceiptVisible(f);
  assert.equal(f.run('state.focusItemId'), 42);
});

for (const invalid of [
  undefined,
  { ...receipt('opened'), id: 0 },
  { ...receipt('opened'), item_id: 99 },
  { ...receipt('opened'), action: 'updated' },
  { ...receipt('opened'), occurred_at: 'not-a-date' },
]) {
  test('opening does not claim a recorded scan with invalid receipt: ' + JSON.stringify(invalid), async () => {
    const f = fixture(async () => response({ items: [{ id: 42, order_id: 6 }], scan_receipt: invalid, original_card: originalCard }));
    f.run('state.focusItemId = null; state.scanToken = null; state.items = [];');
    await f.context.load();
    assert.equal(f.feedback().dataset.state, 'unknown');
    assert.ok(f.feedback().textContent.trim());
    assert.equal(f.requests.length, 1);
  });
}

test('saving shows pending then confirms only after the server persisted the update', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const saving = f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'pending');
  assert.equal(f.item.produced_qty, 2, 'No optimistic saved state before acknowledgment');
  pending.resolve(response({ ok: true, receipt: receipt('updated') }));
  await saving;
  assertReceiptVisible(f);
  assert.equal(f.item.produced_qty, 7);
  assert.equal(f.item.actual_weight_kg, 17.5);
  assert.equal(f.item.note, 'הערה שהעובד עדיין עורך');
  assert.equal(f.requests[0].options.cache, 'no-store');
  const body = JSON.parse(f.requests[0].options.body);
  assert.equal(body.card, token);
  assert.equal(body.produced_qty, 7);
  assert.equal(body.actual_weight_kg, 17.5);
  assert.equal(f.renders(), 1);
});

for (const [label, body] of [
  ['missing receipt', { ok: true }],
  ['missing ok flag', { receipt: receipt('updated') }],
  ['invalid receipt id', { ok: true, receipt: { ...receipt('updated'), id: -1 } }],
  ['another item receipt', { ok: true, receipt: { ...receipt('updated'), item_id: 99 } }],
  ['another action receipt', { ok: true, receipt: receipt('opened') }],
  ['invalid receipt timestamp', { ok: true, receipt: { ...receipt('updated'), occurred_at: '' } }],
]) {
  test('HTTP 200 with ' + label + ' is uncertain and preserves the entered draft', async () => {
    const f = fixture(async () => response(body));
    await f.context.saveProductionFields(42);
    assert.equal(f.feedback().dataset.state, 'unknown');
    assertDraftPreserved(f);
    f.expireTimers();
    assert.equal(f.requests.length, 1, 'Uncertain writes must not be retried automatically');
  });
}

test('explicit server rejection visibly fails, preserves inputs, and permits manual correction', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1
    ? response({ error: 'כמות לא תקינה' }, 400)
    : response({ ok: true, receipt: receipt('updated') }));
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'failed');
  assertDraftPreserved(f);
  await f.context.saveProductionFields(42);
  assertReceiptVisible(f);
  assert.equal(f.requests.length, 2);
});

test('a network error reports uncertain persistence and never silently discards the draft', async () => {
  const f = fixture(async () => { throw new TypeError('Failed to fetch'); });
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'unknown');
  assertDraftPreserved(f);
  f.expireTimers();
  assert.equal(f.requests.length, 1);
});

test('an unreadable success response is uncertain and preserves the draft', async () => {
  const f = fixture(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }));
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'unknown');
  assertDraftPreserved(f);
});

test('an explicit HTTP error still fails clearly when its body is not JSON', async () => {
  const f = fixture(async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('HTML error page'); } }));
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'failed');
  assertDraftPreserved(f);
});

test('request timeout reports unknown instead of hanging or claiming that the write failed', async () => {
  const f = fixture((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const saving = f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'pending');
  assert.ok(f.timers.size, 'The request needs a bounded timeout');
  f.expireTimers();
  await saving;
  assert.equal(f.feedback().dataset.state, 'unknown');
  assertDraftPreserved(f);
  assert.equal(f.requests.length, 1);
});

test('duplicate save, status change, and unit increment are blocked while a write is pending', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const first = f.context.saveProductionFields(42);
  const second = f.context.saveProductionFields(42);
  const status = f.context.setStatus(42, 'production');
  const increment = f.context.adjustProducedQty(42, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.node('produced-qty-42').value, '7', 'A blocked increment must preserve the pending draft');
  pending.resolve(response({ ok: true, receipt: receipt('updated') }));
  await Promise.all([first, second, status, increment]);
  assertReceiptVisible(f);
  assert.equal(f.item.status, 'ממתין');
});

test('status changes require an action-matching receipt before changing the local card', async () => {
  const f = fixture(async () => response({ ok: true, receipt: receipt('updated') }));
  await f.context.setStatus(42, 'production');
  assert.equal(f.feedback().dataset.state, 'unknown');
  assert.equal(f.item.status, 'ממתין');
  assert.equal(f.renders(), 0);
});

test('acknowledged status change updates the card and keeps its receipt visible', async () => {
  const f = fixture(async () => response({ ok: true, receipt: receipt('status_changed') }));
  await f.context.setStatus(42, 'production');
  assertReceiptVisible(f);
  assert.equal(f.item.status, 'בייצור');
  assert.equal(f.renders(), 1);
  assert.equal(JSON.parse(f.requests[0].options.body).status, 'בייצור');
});

test('a save response carrying another item is uncertain even when its receipt matches', async () => {
  const f = fixture(async () => response({ ok: true, receipt: receipt('updated'), item: { id: 99, produced_qty: 11, note: 'כרטיס אחר' } }));
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'unknown');
  assertDraftPreserved(f);
  assert.equal(f.item.id, 42);
});

test('a status response carrying another item cannot change the displayed card identity or status', async () => {
  const f = fixture(async () => response({ ok: true, receipt: receipt('status_changed'), item: { id: 99, status: 'בייצור' } }));
  await f.context.setStatus(42, 'production');
  assert.equal(f.feedback().dataset.state, 'unknown');
  assert.equal(f.item.id, 42);
  assert.equal(f.item.status, 'ממתין');
  assert.equal(f.renders(), 0);
});

test('an uncertain write can be retried explicitly with the exact original payload and operation key', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new TypeError('response lost after write');
    return response({ ok: true, receipt: receipt('updated') });
  });
  await f.context.saveProductionFields(42);
  assert.equal(f.feedback().dataset.state, 'unknown');
  const retry = f.node('operationRetry');
  assert.equal(retry.hidden, false);
  assert.equal(typeof retry.onclick, 'function');
  await retry.onclick();
  assertReceiptVisible(f);
  assert.equal(f.requests.length, 2);
  const original = JSON.parse(f.requests[0].options.body), retried = JSON.parse(f.requests[1].options.body);
  assert.ok(original.request_id, 'A retry must identify the original operation');
  assert.deepEqual(retried, original, 'Manual retry must not submit a different operation under the same key');
  assert.equal(retry.hidden, true);
});

test('editing an uncertain draft blocks its old retry and a new save sends a new operation key', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new TypeError('response lost after write');
    return response({ ok: true, receipt: receipt('updated') });
  });
  await f.context.saveProductionFields(42);
  const original = JSON.parse(f.requests[0].options.body);
  f.node('production-note-42').value = 'עריכה חדשה שלא שייכת לבקשה הקודמת';
  await f.node('operationRetry').onclick();
  assert.equal(f.feedback().dataset.state, 'failed');
  assert.equal(f.requests.length, 1, 'Retry cannot silently submit stale data after an edit');
  assert.equal(f.node('production-note-42').value, 'עריכה חדשה שלא שייכת לבקשה הקודמת');
  assert.equal(f.item.note, 'הערה שמורה');
  assert.equal(f.renders(), 0);
  await f.context.saveProductionFields(42);
  assertReceiptVisible(f);
  const updated = JSON.parse(f.requests[1].options.body);
  assert.notEqual(updated.request_id, original.request_id, 'A changed command needs a fresh idempotency key');
  assert.equal(updated.note, 'עריכה חדשה שלא שייכת לבקשה הקודמת');
  assert.equal(f.item.note, updated.note);
});
