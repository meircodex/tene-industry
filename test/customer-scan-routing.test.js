'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'customer-scan.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function loadCameraLink(code, fetchMode, rawSearch) {
  const classes = new Set();
  const listeners = new Map();
  const fetches = [];
  const redirects = [];
  const historyChanges = [];
  const timers = new Map();
  const elements = Object.fromEntries([
    'workCardRouting', 'workCardRoutingTitle', 'workCardRoutingMessage', 'retryWorkCardRouting',
  ].map(id => [id, {
    hidden: true, dataset: {}, textContent: '',
    addEventListener(event, callback) { listeners.set(id + ':' + event, callback); },
  }]));
  vm.runInNewContext(script, {
    URLSearchParams, AbortController,
    document: {
      documentElement: { classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
      } },
      getElementById(id) { return elements[id] || null; },
      addEventListener(event, callback) { listeners.set(event, callback); },
    },
    location: {
      search: rawSearch ?? (code == null ? '' : '?code=' + encodeURIComponent(code)),
      replace(target) { redirects.push(target); },
    },
    history: { replaceState(_state, _title, target) { historyChanges.push(target); } },
    async fetch(url, options) {
      fetches.push({ url, options });
      return fetchMode(url, options);
    },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    classes, elements, fetches, redirects, historyChanges, timers,
    ready() { listeners.get('DOMContentLoaded')?.(); },
    retry() { listeners.get('retryWorkCardRouting:click')?.(); },
  };
}

function modeResponse(mode, ok = true) {
  return { ok, async json() { return { mode }; } };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ordinary camera card links wait for current server mode before opening the worker card', async () => {
  for (const code of [
    'HZ-2026-084-000968',
    'HZ-2026-084-000968-C1OF2',
    'HZ-2026-084-000968-ASSEMBLY',
    'HZ-2026-084-000968-P1-C2-C1OF2',
    'HZ-2026-084|968',
  ]) {
    let releaseMode;
    const page = loadCameraLink(code, () => new Promise(resolve => { releaseMode = resolve; }));
    assert.equal(page.classes.has('work-card-routing'), true, code);
    page.ready();
    assert.equal(page.elements.workCardRouting.hidden, false);
    assert.equal(page.elements.workCardRouting.dataset.state, 'waiting');
    assert.equal(page.redirects.length, 0);
    assert.equal(page.fetches[0].url, '/api/qr-access/mode');
    assert.equal(page.fetches[0].options.cache, 'no-store');
    releaseMode(modeResponse('open'));
    await flush();
    assert.equal(page.redirects[0], '/worker-visual.html?scan=1&card=' + encodeURIComponent(code) + '&source=phone_camera');
    assert.equal(page.timers.size, 0);
    assert.doesNotMatch(page.elements.workCardRoutingMessage.textContent, /נקלטה|נקלט בהצלחה/);
  }
});

test('secure mode keeps the customer portal and strips internal card data', async () => {
  const page = loadCameraLink('HZ-2026-084-000968', () => modeResponse('secure'));
  page.ready();
  await flush();
  assert.equal(page.classes.has('work-card-routing'), false);
  assert.equal(page.elements.workCardRouting.hidden, true);
  assert.deepEqual(page.historyChanges, ['/customer-scan.html']);
  assert.equal(page.redirects.length, 0);
});

test('order QR and invalid or absent production codes remain customer visits without a mode fetch', async () => {
  for (const code of [null, '', 'TENE-ORDER-18', 'tene-order-18', 'HZ-2026-084-000000', 'HZ-2026-084|0', '968', 'https://other.example/worker-visual.html?card=968']) {
    const page = loadCameraLink(code, () => { throw new Error('must not fetch'); });
    page.ready();
    await flush();
    assert.equal(page.classes.has('work-card-routing'), false, String(code));
    assert.equal(page.fetches.length, 0, String(code));
    assert.equal(page.redirects.length, 0, String(code));
    if (code !== null) assert.deepEqual(page.historyChanges, ['/customer-scan.html']);
  }
});

test('unavailable, malformed or denied server mode leaves a visible error and supports retry', async () => {
  for (const failure of [
    () => { throw new Error('offline'); },
    () => modeResponse('open', false),
    () => modeResponse('unknown'),
    () => ({ ok: true, json: async () => null }),
    () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    let attempts = 0;
    const page = loadCameraLink('HZ-2026-084-000968', () => ++attempts === 1 ? failure() : modeResponse('open'));
    page.ready();
    await flush();
    assert.equal(page.classes.has('work-card-routing'), true);
    assert.equal(page.elements.workCardRouting.hidden, false);
    assert.equal(page.elements.workCardRouting.dataset.state, 'error');
    assert.match(page.elements.workCardRoutingMessage.textContent, /לא ניתן לקבל אישור מהמערכת/);
    assert.equal(page.elements.retryWorkCardRouting.hidden, false);
    assert.equal(page.redirects.length, 0);
    assert.equal(page.historyChanges.length, 0);
    page.retry();
    await flush();
    assert.equal(page.redirects.length, 1);
    assert.equal(page.fetches.length, 2);
  }
});

test('a stalled mode request times out visibly instead of silently keeping the operator waiting', async () => {
  const page = loadCameraLink('HZ-2026-084-000968', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  page.ready();
  [...page.timers.values()][0]();
  await flush();
  assert.equal(page.elements.workCardRouting.dataset.state, 'error');
  assert.equal(page.elements.retryWorkCardRouting.hidden, false);
  assert.equal(page.redirects.length, 0);
});

test('card links cannot select an external navigation target with additional query parameters', async () => {
  const code = 'HZ-2026-084-000968';
  const page = loadCameraLink(code, () => modeResponse('open'), '?code=' + code + '&target=https://other.example&next=//other.example');
  page.ready();
  await flush();
  assert.deepEqual(page.redirects, ['/worker-visual.html?scan=1&card=' + code + '&source=phone_camera']);
});
