const assert = require('node:assert/strict');
const test = require('node:test');

const { itemShapeMetrics } = require('../services/shapeSnapshot');

function snapshotWith(calculated) {
  return JSON.stringify({
    contractVersion: 2,
    shapeVersion: '1.0',
    shapeId: 'test-shape',
    shapeType: 'closed_stirrup',
    family: 'stirrups',
    data: {},
    calculated,
    machineOutput: {},
    validation: { valid: true },
  });
}

test('snapshot unit weight is multiplied by item quantity', () => {
  const metrics = itemShapeMetrics({
    quantity: 16,
    shape_snapshot_json: snapshotWith({ weightKg: 0.8625, totalLengthMm: 1400 }),
  });
  assert.equal(metrics.unitWeightKg, 0.8625);
  assert.ok(Math.abs(metrics.totalWeightKg - 13.8) < 0.001);
});

test('snapshot total weight is never multiplied by quantity again', () => {
  // Order-screen snapshots store only totalWeightKg for the whole quantity;
  // the old code treated it as a unit weight and inflated totals by quantity.
  const metrics = itemShapeMetrics({
    quantity: 16,
    shape_snapshot_json: snapshotWith({ totalWeightKg: 13.8, totalLengthMm: 1400 }),
  });
  assert.ok(Math.abs(metrics.totalWeightKg - 13.8) < 0.001, `expected 13.8, got ${metrics.totalWeightKg}`);
  assert.ok(Math.abs(metrics.unitWeightKg - 0.8625) < 0.001);
});

test('snapshot with unit and matching total resolves to unit x quantity', () => {
  const metrics = itemShapeMetrics({
    quantity: 16,
    shape_snapshot_json: snapshotWith({ weightKg: 0.8625, totalWeightKg: 13.8 }),
  });
  assert.ok(Math.abs(metrics.totalWeightKg - 13.8) < 0.001);
});

test('mirrored equal unit/total fields are treated as a total', () => {
  // Some editor snapshots copy the same number into both fields.
  const metrics = itemShapeMetrics({
    quantity: 16,
    shape_snapshot_json: snapshotWith({ weightKg: 13.8, totalWeightKg: 13.8 }),
  });
  assert.ok(Math.abs(metrics.totalWeightKg - 13.8) < 0.001, `expected 13.8, got ${metrics.totalWeightKg}`);
});

test('without a snapshot, weight_per_unit x quantity wins, then total_weight', () => {
  const fromUnit = itemShapeMetrics({ quantity: 4, weight_per_unit: 2.5 });
  assert.equal(fromUnit.totalWeightKg, 10);

  const fromTotal = itemShapeMetrics({ quantity: 4, total_weight: 11.5 });
  assert.equal(fromTotal.totalWeightKg, 11.5);
});

test('explicit unit weight disambiguates the editor mirror; saved precision is retained', () => {
  const item={quantity:45,weight_per_unit:13.2145,total_weight:594.6525,
    shape_snapshot_json:snapshotWith({weightKg:13.215,unitWeightKg:13.215,totalWeightKg:13.215,totalLengthMm:5350})};
  assert.equal(itemShapeMetrics(item).totalWeightKg,594.6525);
  assert.equal(itemShapeMetrics({...item,weight_per_unit:undefined,total_weight:undefined}).totalWeightKg,13.215*45);
  assert.equal(itemShapeMetrics({...item,quantity:0}).totalWeightKg,0);
  assert.equal(itemShapeMetrics({...item,quantity:46}).totalWeightKg,13.2145*46);
});

test('weighed lift weight belongs to the whole line and actual measurement has priority', () => {
  const shape=JSON.parse(snapshotWith({weightKg:2050,totalWeightKg:2050,weighedKg:2050}));shape.family='lifts';
  const item={quantity:3,shapeSnapshot:shape};
  assert.equal(itemShapeMetrics(item).totalWeightKg,2050);
  assert.equal(itemShapeMetrics({...item,actual_weight_kg:2010}).totalWeightKg,2010);
});

test('new explicit unit/line basis does not depend on equality of legacy fields', () => {
  assert.equal(itemShapeMetrics({quantity:5,shape_snapshot_json:snapshotWith({weightKg:20,totalWeightKg:20,weightBasis:'unit'})}).totalWeightKg,100);
  assert.equal(itemShapeMetrics({quantity:5,shape_snapshot_json:snapshotWith({weightKg:20,totalWeightKg:20,weightBasis:'line'})}).totalWeightKg,20);
  assert.equal(itemShapeMetrics({quantity:5,shape_snapshot_json:snapshotWith({weightKg:20,totalWeightKg:20})}).requiresWeightReview,true);
});
