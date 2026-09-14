'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPortalClient } = require('./helpers/customer-portal-client');
const { portalShapeDraftToOrderItem } = require('../services/customerPortalShapeDraft');
const { itemShapeMetrics } = require('../services/shapeSnapshot');

const straight = { family: 'bars', shapeType: 'straight_bar', presetId: 's1', presetName: 'ישר', diameter: 12, sides: [1000], angles: [] };
const near = (actual, expected, tolerance = 0.001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('editor quantity, unit weight and element name survive the portal row and payload', () => {
  const client = loadPortalClient();
  const payload = client.select(straight);
  assert.equal(payload.quantity, 20);
  assert.equal(payload.elementName, 'קורה 1');
  assert.deepEqual(payload.shapeSnapshot.data.sides, [1000]);
  assert.equal(payload.shapeSnapshot.calculated.totalWeightKg, undefined);
  assert.equal(payload.shapeSnapshot.orderItemQuantity, undefined);
  assert.equal(payload.shapeSnapshot.structElement, undefined);
  near(client.json('portalItemShapeMetrics(orderItems[0])').totalWeightKg, 17.76);
  assert.match(client.element('itemsList').innerHTML, /17\.76/);
  assert.match(client.element('itemsList').innerHTML, /קורה 1/);
  const item = portalShapeDraftToOrderItem(payload);
  assert.equal(item.quantity, 20);
  assert.equal(item.elementName, 'קורה 1');
  assert.equal(item.shapeName, 'ישר');
  near(item.totalWeight, 17.76);
});

test('quantity edits, duplicate isolation and reopening the editor keep current values', () => {
  const client = loadPortalClient();
  client.select(straight);
  client.element('priceBox').style.display = '';
  client.run("updateField(orderItems[0].id, 'qty', 7); duplicatePortalItem(orderItems[0].id);");
  assert.equal(client.element('priceBox').style.display, 'none');
  near(client.json('portalItemShapeMetrics(orderItems[0])').totalWeightKg, 6.216);
  client.run('orderItems[1].shapeSnapshot.data.sides[0] = 2000');
  assert.equal(client.json('orderItems[0].shapeSnapshot.data.sides[0]'), 1000);
  client.run('portalShapeEditor = { open(data) { window.openedEditor = data; } }; openPortalShapeEditor(orderItems[0].id)');
  assert.equal(client.json('window.openedEditor').quantity, 7);
  assert.equal(client.json('window.openedEditor').structElement, 'קורה 1');
  client.select({ ...straight, diameter: 16, sides: [1500] }, 4, 'עמוד ב');
  const updated = client.json('portalOrderItemPayload(orderItems[0])');
  assert.equal(updated.quantity, 4);
  assert.equal(updated.diameter, 16);
  assert.equal(updated.elementName, 'עמוד ב');
  assert.deepEqual(updated.shapeSnapshot.data.sides, [1500]);
});

test('the untouched default row can be normalized without opening the editor', () => {
  const client = loadPortalClient();
  client.run('addItem()');
  const item = portalShapeDraftToOrderItem(client.json('portalOrderItemPayload(orderItems[0])'));
  assert.equal(item.shapeName, 'ישר');
  assert.equal(item.totalLengthMm, 1000);
  assert.equal(item.quantity, 1);
  near(item.totalWeight, 0.888);
});

test('legacy root geometry is accepted, but malformed snapshots do not silently fall back', () => {
  const item = portalShapeDraftToOrderItem({ shapeName: 'ישר', diameter: 12, sides: [1000], angles: [], qty: 20, structElement: 'קורה ישנה' });
  assert.equal(item.elementName, 'קורה ישנה');
  near(item.totalWeight, 17.76);
  for (const snapshot of ['{broken', { contractVersion: 2 }, { contractVersion: 1 }]) {
    assert.throws(() => portalShapeDraftToOrderItem({ diameter: 12, sides: [1000], qty: 1, shapeSnapshot: snapshot }), { code: 'invalid_shape_snapshot' });
  }
});

test('a changed row cannot display an earlier in-flight quote', async () => {
  const client = loadPortalClient();
  client.select(straight);
  let release;
  client.context.fetch = () => new Promise(resolve => { release = resolve; });
  const calculating = client.run('calcQuote()');
  client.run("updateField(orderItems[0].id, 'qty', 2)");
  release({ json: async () => ({ breakdown: [], totalPrice: 1, billingPrice: 1, wastePct: 3 }) });
  await calculating;
  assert.equal(client.element('priceBox').style.display, 'none');
  assert.equal(client.element('quoteBtn').disabled, false);
});

test('quote and submission use identical item bodies and clear state for the next order', async () => {
  const client = loadPortalClient();
  client.select(straight);
  const sent = [];
  client.context.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return { json: async () => url === '/api/c/quote'
      ? { breakdown: [{ diameter: 12, weight: 17.76, pricePerKg: 5, price: 88.8 }], totalPrice: 88.8, billingPrice: 93.24, wastePct: 5 }
      : { success: true, orderNum: 'TEST-1', orderId: 1 } };
  };
  await client.run('calcQuote()');
  assert.match(client.element('priceBreakdown').innerHTML, /5%/);
  assert.match(client.element('priceBreakdown').innerHTML, /93\.24/);
  await client.run('submitOrder()');
  assert.deepEqual(sent[0].body.items, sent[1].body.items);
  client.run('showHome = async () => {};');
  await client.timers.find(timer => timer.delay === 1200).fn();
  assert.equal(client.json('orderItems.length'), 0);
  assert.equal(client.element('submitOrderBtn').disabled, false);
});

test('HTTP quote -> submission -> database -> detail -> print preserve the real editor values', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-portal-values-'));
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'portal-values-tests-only', BCRYPT_ROUNDS: '4', DB_PATH: path.join(tmpDir, 'values.db'), BACKUP_DIR: path.join(tmpDir, 'backups') });
  const intake = require('../intake');
  const originalSend = intake.sendWhatsApp;
  intake.sendWhatsApp = async () => { throw new Error('Tests must not send WhatsApp'); };
  const { server, db, closeServer } = require('../server');
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    intake.sendWhatsApp = originalSend;
    const resolved = path.resolve(tmpDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tene-portal-values-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const customerId = db.prepare("INSERT INTO customers(name,phone,price_tier,discount_pct,portal_can_expose_prices) VALUES ('בדיקת ערכים','','list',0,1)").run().lastInsertRowid;
  const token = 'portal-values-test-token';
  const userId = db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,active,token,token_expires_at) VALUES (?,'0509000999','בדיקה','customer_admin',1,?,'2099-01-01T00:00:00Z')").run(customerId, token).lastInsertRowid;
  const siteId = db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?,'אתר בדיקה','active')").run(customerId).lastInsertRowid;
  db.prepare('INSERT INTO customer_site_users(customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,1)').run(customerId, siteId, userId);
  const book = db.prepare("INSERT INTO pricing_price_books(code,name,price_type,status) VALUES ('VALUES','בדיקה','general','active')").run().lastInsertRowid;
  for (const diameter of [8, 12, 16]) db.prepare("INSERT INTO pricing_price_items(price_book_id,sku,diameter,description,price_before_vat) VALUES (?,?,?,'ברזל לבדיקה',5)").run(book, `D${diameter}`, diameter);
  async function post(url, data) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...data }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const cases = [
    { name: 'default without editor', waste: 3 },
    { name: 'straight x20', shape: straight, qty: 20, waste: 3, expected: 91.46 },
    { name: 'zero waste', shape: straight, qty: 20, waste: 0, expected: 88.8 },
    { name: 'configured waste', shape: straight, qty: 20, waste: 5, expected: 93.24 },
    { name: 'discounted unit price precision', shape: straight, qty: 20, waste: 3, discount: 11.12, expected: 81.29 },
    { name: '3D bench', shape: { ...straight, shapeType: 'bench_bar', presetName: 'ספסל', sides: [280, 170, 300, 170, 280], angles: [90, 90, 90, 90], is3d: 1, azAngles: [0, 90, 90, 90, 90], elAngles: [90, 0, 0, 0, 90] }, qty: 3, waste: 5 },
    { name: 'mesh', shape: { family: 'mesh', presetName: 'רשת', length: 6000, width: 2500, longitudinalDiameter: 8, longitudinalSpacing: 200, transverseDiameter: 8, transverseSpacing: 200, edgeLeft: 0, edgeRight: 0, edgeTop: 0, edgeBottom: 0 }, qty: 4, waste: 3 },
    { name: 'ring', shape: { family: 'spirals', shapeType: 'ring', presetName: 'טבעת', barDiameter: 12, ringDiameter: 600, overlap: 100 }, qty: 6, waste: 3 },
    { name: 'spiral', shape: { family: 'spirals', shapeType: 'spiral', presetName: 'ספירלה', barDiameter: 8, spiralDiameter: 600, turns: 20 }, qty: 3, waste: 3 },
    { name: 'pile', shape: { family: 'piles', roundPileCage: true, presetName: 'כלונס', pileDiameter: 60, pileLength: 1200, longitudinalBars: 6, longitudinalDiameter: 16, straightBarCount: 3, bentBarCount: 3, straightBarLength: 1200, bentBarLength: 1220, bendLength: 20, spiralDiameter: 8, spiralOuterDiameter: 48, spiralZones: [{ name: 'A', length: 1200, pitch: 15 }], hoopDiameter: 12, hoopOuterDiameter: 42, hoopQuantity: 3, hoopStart: 150, hoopSpacing: 300 }, qty: 2, waste: 3 },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('WASTE_PCT_DEFAULT',?)").run(String(scenario.waste));
    db.prepare('UPDATE customers SET discount_pct=? WHERE id=?').run(scenario.discount || 0, customerId);
    const client = loadPortalClient();
    if (scenario.shape) client.select(scenario.shape, scenario.qty, `אלמנט ${scenario.name}`);
    else client.run('addItem()');
    client.run("updateField(orderItems[0].id, 'note', 'קומה 2')");
    const payload = client.json('portalOrderItemPayload(orderItems[0])');
    assert.equal(payload.editorData, undefined, 'editor-only units must not enter the API payload');
    const quote = await post('/api/c/quote', { items: [payload] });
    assert.equal(quote.status, 'priced');
    if (scenario.discount) assert.equal(quote.breakdown[0].pricePerKg, 4.444);
    if (scenario.shape) {
      client.run('portalShapeEditor = { open(data) { window.reopened = data; } }; openPortalShapeEditor(orderItems[0].id);');
      const reopened = client.json('window.reopened');
      const reopenedPayload = client.select(reopened, payload.quantity, payload.elementName);
      const requote = await post('/api/c/quote', { items: [reopenedPayload] });
      assert.equal(requote.billingPrice, quote.billingPrice, 'reopening the editor must not change units or values');
      near(portalShapeDraftToOrderItem(reopenedPayload).totalLengthMm, portalShapeDraftToOrderItem(payload).totalLengthMm);
    }
    const result = await post('/api/c/order', { items: [payload], siteId, deliveryDate: '2026-10-01', deliveryTime: '10:30', deliveryAddress: 'כתובת בדיקה', notes: 'הערת הזמנה' });
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(result.orderId);
    const item = db.prepare('SELECT * FROM items WHERE order_id=?').get(result.orderId);
    const expected = portalShapeDraftToOrderItem(payload);
    assert.equal(order.portal_price, quote.billingPrice);
    assert.equal(result.summary.portalPrice, quote.billingPrice);
    assert.equal(quote.wastePct, scenario.waste);
    assert.equal(order.waste_pct_charged, scenario.waste);
    if (scenario.expected != null) assert.equal(quote.billingPrice, scenario.expected);
    assert.equal(item.quantity, payload.quantity);
    assert.equal(item.struct_element, payload.elementName);
    assert.equal(item.note, 'קומה 2');
    assert.equal(item.diameter, expected.diameter);
    near(item.total_weight, expected.totalWeight);
    near(item.total_length_mm, expected.totalLengthMm);
    near(itemShapeMetrics(item).totalWeightKg, expected.totalWeight);
    near(client.json('portalItemShapeMetrics(orderItems[0])').totalWeightKg, expected.totalWeight, 0.005);
    near(quote.totalWeight, order.total_weight, 0.005);
    assert.equal(order.site_id, siteId);
    assert.equal(order.delivery_date, '2026-10-01');
    assert.equal(order.delivery_time, '10:30');
    assert.equal(order.delivery_address, 'כתובת בדיקה');
    const snapshot = JSON.parse(item.shape_snapshot_json);
    assert.equal(snapshot.orderItemQuantity, undefined);
    if (scenario.shape?.sides) assert.deepEqual(snapshot.data.sides, scenario.shape.sides);
    if (scenario.shape?.angles) assert.deepEqual(snapshot.data.angles, scenario.shape.angles);
    if (scenario.shape?.family === 'mesh') {
      for (const key of ['length', 'width', 'longitudinalDiameter', 'transverseDiameter', 'longitudinalSpacing', 'transverseSpacing']) {
        assert.equal(snapshot.data[key], scenario.shape[key]);
      }
    }
    if (scenario.shape?.is3d) {
      assert.deepEqual(snapshot.data.azAngles, scenario.shape.azAngles);
      assert.deepEqual(snapshot.data.elAngles, scenario.shape.elAngles);
    }
    const response = await fetch(`${base}/api/c/orders/${order.id}?token=${token}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.portal_price, quote.billingPrice);
    const print = await fetch(`${base}/api/c/orders/${order.id}/print?token=${token}`);
    assert.equal(print.status, 200);
    const printed = await print.text();
    assert.ok(printed.includes(payload.elementName));
    assert.ok(printed.includes('קומה 2'));
  });
});
