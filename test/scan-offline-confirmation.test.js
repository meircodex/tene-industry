'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const scannerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'scan.html'), 'utf8');
const scannerSource = scannerHtml.slice(scannerHtml.indexOf('async function openScannedValue('), scannerHtml.indexOf('function scheduleScan('));

function offlineWorker(cachedResponse = null) {
  const matches = [];
  const sandbox = {
    URL, Response, navigator: { onLine: false },
    self: { addEventListener() {} },
    fetch: async () => { throw new Error('offline'); },
    caches: {
      async match(request) { matches.push(request.url); return cachedResponse?.clone(); },
    },
  };
  vm.runInNewContext(workerSource, sandbox);
  return { matches, request: url => sandbox.networkFirstAPI({ url: 'https://factory.example' + url }) };
}

test('offline service worker never replays stale authorization or scan receipts', async () => {
  for (const endpoint of [
    '/api/worker-card?card=HZ-2026-084-000968',
    '/api/worker-card/968',
    '/api/qr-access/mode',
    '/api/qr-access/scan',
  ]) {
    const stale = new Response(JSON.stringify({
      allowed: true, mode: 'open', items: [{ id: 968 }],
      scan_receipt: { id: 88, item_id: 968, action: 'opened', occurred_at: '2026-10-15T08:00:00.000Z' },
    }), { headers: { 'Content-Type': 'application/json' } });
    const worker = offlineWorker(stale);
    const response = await worker.request(endpoint);
    assert.equal(response.status, 503, endpoint);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'scan_confirmation_unavailable', offline: true });
    assert.deepEqual(worker.matches, [], endpoint);
  }
});

test('unrelated APIs keep their existing cached and empty offline fallback', async () => {
  const cached = new Response(JSON.stringify({ orders: [{ id: 8 }] }), { headers: { 'Content-Type': 'application/json' } });
  const worker = offlineWorker(cached);
  const response = await worker.request('/api/orders');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { orders: [{ id: 8 }] });
  assert.deepEqual(worker.matches, ['https://factory.example/api/orders']);
  const noCache = await offlineWorker().request('/api/dashboard');
  assert.equal(noCache.status, 200);
  assert.deepEqual(await noCache.json(), { offline: true, data: [] });
});

function scanner(fetchResponse) {
  const notices = [];
  const requests = [];
  const timers = new Map();
  const sandbox = {
    opening: false, accessMode: 'open', deviceApproved: true, AbortController,
    normalizedScan: value => ({ kind: 'card', value }),
    stopScanner() {},
    scannerId: () => 'test-scanner',
    setNotice(message, error) { notices.push({ message, error }); },
    location: { href: '' },
    async fetch(url, options) { requests.push({ url, options }); return fetchResponse(url, options); },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(scannerSource, sandbox);
  return { sandbox, notices, requests, timers, open: value => sandbox.openScannedValue(value) };
}

function scanResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => data };
}

test('scanner rejects a successful HTTP response without explicit allowed approval and a local target', async () => {
  for (const response of [
    { offline: true, data: [] },
    { target: '/worker-visual.html?scan=1&card=HZ-2026-084-000968' },
    { allowed: true, target: 'https://other.example/worker-visual.html?scan=1' },
    { allowed: true, target: '//other.example/worker-visual.html?scan=1' },
    { allowed: true, target: '/customer.html?source=qr' },
  ]) {
    const page = scanner(() => scanResponse(response));
    await page.open('HZ-2026-084-000968');
    assert.equal(page.sandbox.location.href, '');
    assert.equal(page.sandbox.opening, false);
    assert.equal(page.notices.at(-1).error, true);
    assert.match(page.notices.at(-1).message, /לא התקבל אישור קליטה/);
    assert.equal(page.timers.size, 0);
  }
});

test('scanner navigation only promises the destination receipt after server authorization', async () => {
  const target = '/worker-visual.html?scan=1&card=HZ-2026-084-000968&source=in_app_scan';
  const page = scanner(() => scanResponse({ allowed: true, target }));
  await page.open('HZ-2026-084-000968');
  assert.equal(page.sandbox.location.href, target);
  assert.equal(page.requests[0].options.cache, 'no-store');
  assert.match(page.notices.at(-1).message, /ממתין לאישור קליטה/);
  assert.doesNotMatch(page.notices.at(-1).message, /נקלטה במערכת/);
});

test('scanner timeout leaves a visible failure with the scanner available for another attempt', async () => {
  const page = scanner((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const attempt = page.open('HZ-2026-084-000968');
  [...page.timers.values()][0]();
  await attempt;
  assert.equal(page.sandbox.location.href, '');
  assert.equal(page.sandbox.opening, false);
  assert.equal(page.notices.at(-1).error, true);
  assert.match(page.notices.at(-1).message, /לא התקבל אישור קליטה/);
  assert.equal(page.timers.size, 0);
});
