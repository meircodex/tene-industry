const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { rebarKgPerMeter } = require('../constants');
const { buildFullShapeSnapshot, isShapeDataContractV2 } = require('../services/shapeSnapshot');
const {
  buildPortalShapeDraft,
  portalShapeDraftToOrderItem,
  validatePortalShapeDraft,
} = require('../services/customerPortalShapeDraft');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('portal straight bar creates a valid Shape V2 snapshot', () => {
  const item = portalShapeDraftToOrderItem({
    elementName: 'קורה 1',
    diameter: 12,
    quantity: 20,
    shapeDraft: {
      family: 'bars',
      shapeType: 'straight',
      data: { length: 1000 },
    },
  });

  assert.equal(isShapeDataContractV2(item.shapeSnapshot), true);
  assert.equal(item.shapeSnapshot.family, 'bars');
  assert.equal(item.shapeSnapshot.shapeType, 'straight_bar');
  assert.deepEqual(item.shapeSnapshot.data.sides, [1000]);
  assert.deepEqual(item.shapeSnapshot.data.angles, []);
  assert.equal(item.totalLengthMm, 1000);
  assert.equal(item.quantity, 20);
});

test('portal L shape creates snapshot from sides and 90 degree angle', () => {
  const item = portalShapeDraftToOrderItem({
    elementName: 'עמוד 2',
    diameter: 12,
    quantity: 3,
    shapeDraft: {
      family: 'bars',
      shapeType: 'l',
      data: { sides: [1000, 300], angles: [90] },
    },
  });

  assert.equal(isShapeDataContractV2(item.shapeSnapshot), true);
  assert.equal(item.shapeSnapshot.shapeType, 'l_bar');
  assert.deepEqual(item.shapeSnapshot.data.sides, [1000, 300]);
  assert.deepEqual(item.shapeSnapshot.data.angles, [90]);
  assert.deepEqual(JSON.parse(item.segments), [
    { length_mm: 1000, angle_deg: 90 },
    { length_mm: 300, angle_deg: null },
  ]);
  assert.match(item.shapeDimsText, /A=1000/);
  assert.match(item.shapeDimsText, /90°/);
});

test('portal shape snapshot does not store order item quantity', () => {
  const item = portalShapeDraftToOrderItem({
    diameter: 16,
    quantity: 55,
    shapeDraft: { family: 'bars', shapeType: 'u', data: { sides: [200, 600, 200], angles: [90, 90] } },
  });
  const snapshotJson = JSON.stringify(item.shapeSnapshot);
  assert.equal(/quantity|qty|production_qty/.test(snapshotJson), false);
  assert.equal(item.quantity, 55);
});

test('portal shape draft calculates length and weight server-side', () => {
  const item = portalShapeDraftToOrderItem({
    diameter: 12,
    quantity: 10,
    shapeDraft: { family: 'bars', shapeType: 'l', data: { sides: [1000, 300], angles: [90] } },
  });
  const expectedUnit = 1.3 * rebarKgPerMeter(12);
  assert.equal(item.totalLengthMm, 1300);
  assert.ok(Math.abs(item.weightPerUnit - expectedUnit) < 0.000001);
  assert.ok(Math.abs(item.totalWeight - (expectedUnit * 10)) < 0.000001);
  assert.equal(item.shapeSnapshot.calculated.weightKg, item.weightPerUnit);
});

test('portal accepts the same Shape V2 3D bar contract as the factory editor', () => {
  const editorSnapshot = buildFullShapeSnapshot({
    shapeId: 'factory-3d-bench',
    shapeVersion: 4,
    shapeType: 'bench_bar',
    family: 'bars',
    displayName: 'ספסל',
    data: { sides: [280, 170, 300, 170, 280], angles: [90, 90, 90, 90], diameter: 12, is3d: 1, azAngles: [0, 90, 90, 90, 90], elAngles: [90, 0, 0, 0, 90] },
    calculated: { totalLengthMm: 1200, weightKg: 1 },
    machineOutput: { generic: {} },
    validation: { valid: true, errors: [] },
  });
  const item = portalShapeDraftToOrderItem({ shapeSnapshot: editorSnapshot, qty: 3 });

  assert.equal(item.shapeSnapshot.family, 'bars');
  assert.equal(item.shapeSnapshot.shapeType, 'bench_bar');
  assert.equal(item.shapeSnapshot.data.is3d, 1);
  assert.deepEqual(item.shapeSnapshot.data.azAngles, [0, 90, 90, 90, 90]);
  assert.equal(item.quantity, 3);
  assert.equal(item.totalLengthMm, 1200);
});

test('portal accepts a factory Shape V2 mesh and recalculates its weight server-side', () => {
  const editorSnapshot = buildFullShapeSnapshot({
    shapeId: 'factory-mesh',
    shapeType: 'mesh_rectangular',
    family: 'mesh',
    displayName: 'רשת',
    data: { length: 6000, width: 2500, longitudinalDiameter: 8, longitudinalSpacing: 100, transverseDiameter: 8, transverseSpacing: 100, edgeLeft: 0, edgeRight: 0, edgeTop: 0, edgeBottom: 0 },
    calculated: { totalLengthMm: 1, weightKg: 1 },
    machineOutput: { generic: {} },
    validation: { valid: true, errors: [] },
  });
  const item = portalShapeDraftToOrderItem({ shapeSnapshot: editorSnapshot, qty: 4 });

  assert.equal(item.shapeSnapshot.family, 'mesh');
  assert.equal(item.shapeSnapshot.calculated.longitudinalBarCount, 25);
  assert.equal(item.shapeSnapshot.calculated.transverseBarCount, 60);
  assert.equal(item.totalLengthMm, 300000);
  assert.equal(item.totalWeight, item.weightPerUnit * 4);
  assert.equal(item.shapeSnapshot.calculated.weightKg, item.weightPerUnit);
});

test('portal rejects an invalid Shape V2 payload instead of trusting editor totals', () => {
  const invalidSnapshot = buildFullShapeSnapshot({
    shapeId: 'invalid-mesh',
    shapeType: 'mesh_rectangular',
    family: 'mesh',
    data: {},
    calculated: { totalLengthMm: 999999, weightKg: 999999 },
    machineOutput: { generic: {} },
    validation: { valid: false, errors: ['invalid dimensions'] },
  });
  assert.throws(
    () => buildPortalShapeDraft({ shapeSnapshot: invalidSnapshot, qty: 1 }),
    err => err.code === 'invalid_shape_snapshot',
  );
});

test('portal shape builder blocks users without create-order capability', () => {
  assert.throws(
    () => validatePortalShapeDraft({
      diameter: 12,
      quantity: 1,
      shapeDraft: { family: 'bars', shapeType: 'straight', data: { length: 1000 } },
    }, { canCreateOrders: false }),
    err => err.statusCode === 403 && err.code === 'portal_order_create_forbidden'
  );
});

test('portal shape builder rejects invalid shape data before saving', () => {
  assert.throws(
    () => buildPortalShapeDraft({
      diameter: 12,
      quantity: 1,
      shapeDraft: { family: 'bars', shapeType: 'l', data: { sides: [1000], angles: [90] } },
    }),
    err => err.statusCode === 400
  );
});

test('portal draft public item does not expose machine output or costing fields', () => {
  const item = portalShapeDraftToOrderItem({
    elementName: '<img src=x onerror=alert(1)> קורה',
    note: '<script>alert(1)</script> לפי תכנית',
    diameter: 12,
    quantity: 2,
    cost: 100,
    margin: 20,
    fifo: 'secret',
    machineOutput: { generic: { unsafe: true } },
    shapeDraft: { family: 'bars', shapeType: 'straight', data: { length: 1000 } },
  });

  for (const forbidden of ['machineOutput', 'cost', 'margin', 'fifo', 'shapeSnapshot', 'shape_snapshot_json']) {
    assert.equal(forbidden in item.publicItem, false, `${forbidden} leaked to public draft item`);
  }
  assert.doesNotMatch(item.publicItem.elementName, /<|>|onerror|script/i);
  assert.doesNotMatch(item.publicItem.noteForCustomer, /<|>|script/i);
});

test('portal order route validates draft items and keeps production fields out', () => {
  const route = read('routes/portal.js');
  const submitStart = route.indexOf("router.post('/c/order'");
  assert.ok(submitStart > -1, 'portal order endpoint exists');
  const submitEnd = route.indexOf("router.get('/c/approve/:token'", submitStart);
  const submitBlock = route.slice(submitStart, submitEnd);

  assert.match(submitBlock, /!s\.caps\.canOrder/);
  assert.match(submitBlock, /normalizePortalOrderItems/);
  assert.match(submitBlock, /portalDraftErrorResponse/);
  assert.doesNotMatch(submitBlock, /assignResource\(item\.diameter\)/);

  const insertMatch = submitBlock.match(/INSERT INTO items \(([^)]+)\)/);
  assert.ok(insertMatch, 'items insert exists');
  assert.doesNotMatch(insertMatch[1], /machine|production_qty|cost|margin|fifo/);
  assert.match(insertMatch[1], /shape_snapshot_json/);
  assert.match(insertMatch[1], /struct_element/);
});
