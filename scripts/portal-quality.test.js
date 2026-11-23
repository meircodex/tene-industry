'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright-core');

const PORTAL_TOKEN = 'smoke-only-token';
const AXE = require.resolve('axe-core/axe.min.js');
const orderLine = { shapeName: 'ישר', diameter: 12, quantity: 25, sides: [1000], angles: [] };
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' });

async function isolatedPortal(t) {
  const server = spawn(process.execPath, [path.join(__dirname, 'portal-smoke-server.js'), '0'], {
    env: { ...process.env, PORTAL_SMOKE_QUALITY_FIXTURES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exit = once(server, 'exit');
      server.kill('SIGTERM');
      await exit;
    }
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Smoke server startup timed out\n' + log)), 15000);
    server.stderr.on('data', chunk => { log += chunk; });
    server.stdout.on('data', chunk => {
      log += chunk;
      const match = /Isolated QA: (http:\/\/127\.0\.0\.1:\d+)(?=\/customer)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Smoke server exited with ${code}\n${log}`)); });
  });

  async function request(route, body, token = PORTAL_TOKEN) {
    const url = new URL('/api/c/' + route, base);
    if (body === undefined && token) url.searchParams.set('token', token);
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token === null ? body : { ...body, token }),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await response.json() : await response.text();
    return { response, data };
  }

  return { base, request, url: base + '/customer.html?token=' + PORTAL_TOKEN };
}

async function browserPage(t, width = 390) {
  const browser = await chromium.launch({
    ...(process.env.PORTAL_CHROMIUM ? { executablePath: process.env.PORTAL_CHROMIUM } : {}),
    args: ['--no-sandbox'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(8000);
  return page;
}

async function openHome(page, url) {
  await page.goto(url);
  await page.locator('#ordersList .order-card').first().waitFor();
}

async function assertAccessible(page, screen) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run();
    return result.violations.filter(v => ['critical', 'serious'].includes(v.impact))
      .map(v => ({ id: v.id, elements: v.nodes.map(node => node.target) }));
  });
  assert.deepEqual(violations, [], screen);
}

test('portal draft saves, survives Back and reload, and replays an interrupted submit', async t => {
  const { request, url } = await isolatedPortal(t);
  const page = await browserPage(t);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHome(page, url);
  await page.locator('#newOrderAction').click();
  await page.locator('.line-qty').fill('25');
  await page.locator('.line-element').fill('קורה לבדיקה');
  await page.locator('#delivDate').fill(businessDate.format());
  await page.locator('#delivAddr').fill('רחוב בדיקה');
  await page.locator('#orderNotes').fill('נשמר גם לפני יציאה מהשדה');
  await page.getByRole('button', { name: 'שמור טיוטה' }).click();
  assert.match(await page.locator('#toast').innerText(), /הטיוטה נשמרה/);

  const draft = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('ironbend.portal.draft.customer.'));
    return JSON.parse(localStorage.getItem(key));
  });
  assert.ok(draft.idempotencyKey);
  await page.goBack();
  await page.locator('#screenHome').waitFor();
  await page.goForward();
  await page.locator('#screenOrder').waitFor();
  await page.reload();
  await page.locator('#screenOrder').waitFor();
  assert.equal(await page.locator('.line-qty').inputValue(), '25');
  assert.equal(await page.locator('.line-element').inputValue(), 'קורה לבדיקה');
  assert.equal(await page.locator('#delivAddr').inputValue(), 'רחוב בדיקה');
  assert.equal(await page.locator('#orderNotes').inputValue(), 'נשמר גם לפני יציאה מהשדה');

  // Commit the request on the smoke server, then drop its response in the browser.
  let submittedId;
  let postedKey;
  await page.route('**/api/c/order', async route => {
    postedKey = route.request().postDataJSON().idempotency_key;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    submittedId = (await response.json()).orderId;
    await route.abort('failed');
  }, { times: 1 });
  await page.locator('#submitOrderBtn').click();
  await page.getByText('אין חיבור לשרת. בדוק את החיבור ונסה שוב.').waitFor();
  assert.equal(postedKey, draft.idempotencyKey);

  await page.reload();
  await page.locator('#screenOrder').waitFor();
  const replayResponse = page.waitForResponse(response => response.url().endsWith('/api/c/order'));
  await page.locator('#submitOrderBtn').click();
  const replay = await (await replayResponse).json();
  assert.equal(replay.replay, true);
  assert.equal(replay.orderId, submittedId);
  await page.locator('#screenDetail').waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('ironbend.portal.draft.customer.'))), false);
  assert.equal((await request('order', { items: [orderLine] })).data.code, 'idempotency_key_required');
  assert.deepEqual(errors, []);
});

test('customer catalog is token-scoped and lift and pile shapes confirm with canonical data', async t => {
  const { request, url } = await isolatedPortal(t);
  const page = await browserPage(t);
  const errors = [];
  const catalogRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.url().includes('shape-definitions')) catalogRequests.push(new URL(req.url()).pathname); });
  for (const token of [null, 'smoke-expired-token']) {
    assert.equal((await request('shape-definitions', undefined, token)).response.status, 401);
  }
  const catalog = await request('shape-definitions');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.response.headers.get('cache-control'), 'no-store');
  assert.equal(catalog.data.permissions.canManage, false);
  assert.equal(catalog.data.archived, undefined);
  assert.equal(catalog.data.entries[0].itemCode, '9501');

  await openHome(page, url);
  await page.locator('#newOrderAction').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.line-shape').click();
  await page.waitForFunction(() => window._seEditor?._sharedShapes?.some(shape => shape.itemCode === '9501'));
  assert(!catalogRequests.includes('/api/shape-definitions'));
  await page.locator('#seItemCode').fill('9501');
  await page.locator('#seItemCode').press('Enter');
  await page.waitForFunction(() => window._seEditor?.current?.catalogIdentity?.itemCode === '9501');
  await assertAccessible(page, 'desktop bar editor');
  await page.locator('[data-edit-family=lifts]').click();
  await page.waitForFunction(() => window._seEditor?.current?.family === 'lifts');
  await assertAccessible(page, 'desktop lift editor');
  await page.locator('[data-lift-field=barLength]').fill('125');
  await page.locator('[data-lift-field=weighedKg]').fill('22.87');
  await page.locator('#seOk').click();
  await page.locator('#seOverlay').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.line-shape').getAttribute('title'), /ליפטים/);
  const lift = await page.evaluate(() => portalOrderItemPayload(orderItems[0]));
  assert.equal(lift.shapeSnapshot.family, 'lifts');
  assert.equal(lift.shapeSnapshot.data.barLength, 1250);
  assert.equal((await request('quote', { items: [lift] })).data.breakdown[0].weight, 22.87);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.line-shape').click();
  await page.locator('[data-edit-family=piles]').click();
  await page.locator('[data-pile-field=hoopQuantity]').fill('3');
  await assertAccessible(page, 'pile editor');
  await page.locator('#seOk').click();
  await page.locator('#seOverlay').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.line-shape').getAttribute('title'), /כלונס/);
  const pile = await page.evaluate(() => portalOrderItemPayload(orderItems[0]));
  assert.equal(pile.shapeSnapshot.family, 'piles');
  assert.equal(pile.shapeSnapshot.data.pileDiameter, 600);
  assert.equal(pile.shapeSnapshot.data.hoops.quantity, 3);
  const quote = await request('quote', { items: [pile] });
  assert.equal(quote.response.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.breakdown[0].weight, await page.evaluate(() => portalItemShapeMetrics(orderItems[0]).totalWeightKg));
  await page.locator('.line-shape').click();
  assert.equal(await page.locator('[data-pile-field=pileDiameter]').inputValue(), '60');
  assert.deepEqual(errors, []);
});

test('approval immediately updates home and physical weight agrees across the portal', async t => {
  const { request, url } = await isolatedPortal(t);
  const page = await browserPage(t);
  const created = await request('order', { idempotency_key: 'approve-fixture', items: [orderLine] });
  assert.equal(created.response.status, 200);
  const { orderId, orderNum } = created.data;
  const quote = await request('quote', { items: [orderLine] });
  assert.equal(quote.data.breakdown[0].weight, 22.2);
  await openHome(page, url);
  await page.locator('#newOrderAction').click();
  await page.locator('.line-qty').fill('25');
  await page.locator('#quoteBtn').click();
  assert.match(await page.locator('.line-mobile-meta').innerText(), /25 מ׳.*22\.20/s);
  await page.locator('#priceBox').waitFor();
  assert.match(await page.locator('#priceBreakdown').innerText(), /22\.20/);
  await page.goBack();
  await page.locator('#screenHome').waitFor();
  const orderList = page.locator('#ordersList');
  const pendingLabel = `פתיחת הזמנה ${orderNum} — ממתינה לאישורך`;
  const card = orderList.getByRole('button', { name: pendingLabel, exact: true });
  assert.equal(await card.getAttribute('aria-label'), pendingLabel);
  const bounds = await card.boundingBox();
  assert(bounds && bounds.y + Math.min(60, bounds.height) < 750, JSON.stringify(bounds));
  assert.match(await card.innerText(), /ממתינה לאישורך/);
  assert.match(await card.locator('..').innerText(), /22\.20/);
  await page.setViewportSize({ width: 1280, height: 900 });
  const home = await page.locator('#screenHome').boundingBox();
  assert(home && Math.abs(home.x - (1280 - home.x - home.width)) <= 1, JSON.stringify(home));
  await page.setViewportSize({ width: 390, height: 844 });
  await assertAccessible(page, 'home');
  await card.click();
  const approve = page.getByRole('button', { name: 'אשר פרטים ושלח לבדיקה' });
  await approve.waitFor();
  assert.match(await page.locator('.item-detail-pills').innerText(), /100 ס״מ.*22\.20/s);
  assert.match(await page.locator('#detailContent').innerText(), /משקל לחיוב\s+22\.87/);
  await assertAccessible(page, 'order approval');
  await approve.click();
  await page.getByText('פרטי ההזמנה אושרו ונשלחו לבדיקה', { exact: true }).waitFor();
  await page.goBack();
  await page.locator('#screenHome').waitFor();
  await orderList.getByRole('button', { name: `פתיחת הזמנה ${orderNum} — נשלחה לבדיקה`, exact: true }).waitFor();
  assert.equal(await card.count(), 0);

  const html = await request(`orders/${orderId}/print`);
  assert.match(html.data, /22\.20/);
  const legacy = (await request('me')).data.orders.find(order => order.order_num === 'QA-LEGACY');
  assert.equal(legacy.delivery_date, null);
  assert.doesNotMatch((await request(`orders/${legacy.id}/print`)).data, /2020-01-01/);
  const documents = (await request(`orders/${legacy.id}/documents`)).data.documents;
  assert.equal(documents[0].issued_at, null);
  assert.doesNotMatch((await request(`orders/${legacy.id}/documents/invoice/${documents[0].id}`)).data, /2020-01-01/);
});

test('login loading and authentication failures show localized feedback', async t => {
  const { base, url } = await isolatedPortal(t);
  const page = await browserPage(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/c/me?*', async route => { await waiting; await route.continue(); }, { times: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#screenLoading').waitFor();
  assert.equal(await page.locator('#screenAuth').isVisible(), false);
  release();
  await page.locator('#screenHome').waitFor();

  await page.goto(base + '/customer.html?token=smoke-expired-token');
  await page.locator('#screenAuth').waitFor();
  assert.match(await page.locator('#portalAuthError').innerText(), /פג תוקפו/);
  await page.route('**/api/c/me?*', route => route.fulfill({ status: 429, body: 'Too many requests' }), { times: 1 });
  await page.goto(url);
  await page.locator('#screenAuth').waitFor();
  assert.match(await page.locator('#portalAuthError').innerText(), /יותר מדי ניסיונות/);
  await assertAccessible(page, 'login');
});

test('profile email, delivery date, upload and zoom are validated on mobile', async t => {
  const { request, url } = await isolatedPortal(t);
  const page = await browserPage(t);
  assert.equal((await request('profile', { name: 'לקוח בדיקה', email: 'invalid' })).response.status, 400);
  const today = businessDate.format();
  const yesterday = businessDate.format(new Date(Date.now() - 864e5));
  const tomorrow = businessDate.format(new Date(Date.now() + 864e5));
  for (const [date, status] of [[yesterday, 400], ['2099-02-30', 400], [today, 200], [tomorrow, 200]]) {
    const result = await request('order', { idempotency_key: 'test-date-' + date, deliveryDate: date, items: [orderLine] });
    assert.equal(result.response.status, status, JSON.stringify(result.data));
  }

  await openHome(page, url);
  await page.locator('#homeTabProfile').click();
  await page.locator('#profileCustomerEmail').fill('invalid');
  await page.locator('#saveProfileBtn').click();
  assert.match(await page.locator('#toast').innerText(), /אימייל תקינה/);
  await assertAccessible(page, 'profile');
  await page.locator('#newOrderAction').click();
  assert.equal(await page.locator('#delivDate').getAttribute('min'), today);
  await page.locator('#delivDate').fill(yesterday);
  await page.locator('#submitOrderBtn').click();
  assert.match(await page.locator('#toast').innerText(), /מהיום ואילך/);
  assert.doesNotMatch(await page.locator('meta[name=viewport]').getAttribute('content'), /maximum-scale|user-scalable/);
  assert.equal(await page.locator('#portalSourceFiles').isVisible(), false);
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'בחר מסמך מקור' }).click();
  await (await picker).setFiles({ name: 'בדיקה.csv', mimeType: 'text/csv', buffer: Buffer.from('one,two') });
  assert.match(await page.locator('#portalFileList').innerText(), /בדיקה\.csv/);
  await assertAccessible(page, 'new order');
  await page.evaluate(() => toast('הודעת בדיקה'));
  const toastBounds = await page.locator('#toast').boundingBox();
  assert(toastBounds && toastBounds.y < 100);
  assert.equal(await page.locator('#toast').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
});

test('trusted device PIN changes through the masked form and signs in with the new PIN', async t => {
  const { request, base } = await isolatedPortal(t);
  const page = await browserPage(t);
  const auth = await request('auth/password', { phone: '0500000901', password: 'smoke-pin-enrollment' }, null);
  assert.equal(auth.response.status, 200);
  await page.goto(base + '/customer.html?enroll=' + auth.data.enrollmentToken);
  await page.locator('#deviceEnrollPin').fill('617243');
  await page.locator('#deviceEnrollPinConfirm').fill('617243');
  await page.locator('#deviceEnrollPanel button').first().click();
  await page.locator('#screenHome').waitFor();
  await page.reload();
  await page.locator('#screenHome').waitFor();
  await page.locator('#changePinBtn').click();
  for (const [selector, value] of [['#portalOldPin', '617243'], ['#portalNewPin', '731268'], ['#portalConfirmPin', '731268']]) {
    assert.equal(await page.locator(selector).getAttribute('type'), 'password');
    await page.locator(selector).fill(value);
  }
  await page.locator('#savePortalPinBtn').click();
  await page.getByText('קוד הכניסה עודכן', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'התנתק', exact: true }).click();
  await page.locator('#trustedDevicePin').fill('617243');
  await page.locator('#trustedDeviceLogin button').first().click();
  await page.waitForFunction(() => document.getElementById('portalAuthError').textContent.includes('שגוי'));
  await page.locator('#trustedDevicePin').fill('731268');
  await page.locator('#trustedDeviceLogin button').first().click();
  await page.locator('#screenHome').waitFor();
});
