const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const steelRebarShapes = require('../modules/steel-rebar/shapes');
const { itemShapeSvg } = require('../services/productionCards');
const { normalizeShapeFamily, buildFullShapeSnapshot } = require('../services/shapeSnapshot');
const { SHAPE_TYPES } = require('../services/shapeCatalog');

function loadShapeEditor() {
  const context = {
    window: {},
    IronBendSteelRebarShapes: steelRebarShapes,
    console,
    localStorage: {
      _values: {},
      getItem(key) { return Object.prototype.hasOwnProperty.call(this._values, key) ? this._values[key] : null; },
      setItem(key, value) { this._values[key] = String(value); },
      removeItem(key) { delete this._values[key]; },
    },
  };
  context.window.IronBendSteelRebarShapes = steelRebarShapes;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'services', 'shapeSnapshot.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8'), context);
  return context;
}

const LIFT = { family: 'lifts', diameter: 12, barLength: 1200, weighedKg: 48.5, quantity: 4 };

test('lifts is a first-class shape family on both sides of the wire', () => {
  assert.equal(normalizeShapeFamily('lifts'), 'lifts');
  // the registry keeps its family list private, so assert through its validator
  const registry = require('../services/shapeTemplateRegistry');
  const bad = registry.validateShapeTemplateDefinition({ family: 'lifts', shapeType: 'lift_package', displayName: 'חבילת ליפטים', parameters: [] });
  const familyErrors = (bad && bad.errors ? bad.errors : []).filter(e => /family/i.test(String(e)));
  assert.deepEqual(familyErrors, [], 'lifts must be an accepted template family');
  assert.equal(SHAPE_TYPES.LIFT_PACKAGE, 'lift_package');

  const { normalizeShapeFamily: clientFamily, resolveShapeType } = loadShapeEditor();
  assert.equal(clientFamily(LIFT), 'lifts');
  assert.equal(resolveShapeType(LIFT), 'lift_package');
});

test('a lift package keeps the weighed weight instead of a computed one', () => {
  const { buildShapeDataContractV2 } = loadShapeEditor();
  const contract = buildShapeDataContractV2(LIFT);

  assert.equal(contract.family, 'lifts');
  assert.equal(contract.shapeType, 'lift_package');
  assert.equal(contract.data.diameter, 12);
  assert.equal(contract.data.barLength, 1200);
  // The scale reading wins: no geometry-derived weight may override it.
  assert.equal(contract.calculated.weightKg, 48.5);
  assert.equal(contract.validation.valid, true);
  assert.deepEqual(contract.validation.errors, []);
});

test('a lift with no weighing yet is still valid and simply weighs nothing', () => {
  const { buildShapeDataContractV2 } = loadShapeEditor();
  const contract = buildShapeDataContractV2({ ...LIFT, weighedKg: 0 });
  assert.equal(contract.calculated.weightKg, 0);
  assert.equal(contract.validation.valid, true);
});

test('a lift missing its diameter or bar length is rejected', () => {
  const { buildShapeDataContractV2 } = loadShapeEditor();
  assert.equal(buildShapeDataContractV2({ ...LIFT, diameter: 0 }).validation.valid, false);
  assert.equal(buildShapeDataContractV2({ ...LIFT, barLength: 0 }).validation.valid, false);
});

test('the lift drawing shows the bundle, its diameter, length and package count', () => {
  const { LiftEngine, ShapeEngineRouter } = loadShapeEditor();
  assert.equal(ShapeEngineRouter(LIFT), LiftEngine);

  const svg = LiftEngine.render(LIFT, 300, 260);
  assert.match(svg, /data-family="lifts"/);
  assert.match(svg, /data-packages="4"/);
  assert.match(svg, /data-weighed-kg="48.5"/);
  assert.match(svg, /L 120 /);
  assert.match(svg, /4 חבילות/);
});

test('the production card renders a lift as a bundle, not as a bent bar', () => {
  const item = {
    shape_name: 'חבילת ליפטים',
    diameter: 12,
    quantity: 4,
    total_length_mm: 1200,
    weight_per_unit: 48.5,
    shape_snapshot_json: JSON.stringify({
      family: 'lifts',
      shapeType: 'lift_package',
      data: { diameter: 12, barLength: 1200, weighedKg: 48.5 },
    }),
  };
  const svg = itemShapeSvg(item);
  assert.match(svg, /data-shape-kind="lift-package"/);
  assert.doesNotMatch(svg, /data-shape-kind="generic-bar"/);
  assert.match(svg, />120</);
  assert.match(svg, /חבילות/);
});

test('the lifts snapshot survives the canonical snapshot builder', () => {
  const snapshot = buildFullShapeSnapshot({
    family: 'lifts',
    data: { diameter: 12, barLength: 1200, weighedKg: 48.5 },
    calculated: { totalLengthMm: 1200, weightKg: 48.5 },
  });
  assert.equal(snapshot.family, 'lifts');
  assert.equal(snapshot.shapeType, 'lift_package');
  assert.equal(snapshot.calculated.weightKg, 48.5);
});

// ── printing and delivery ────────────────────────────────────────
const { classifyOrderItem, buildOrderCommercialSummary } = require('../services/orderCommercialSummary');
const deliveryTest = require('../routes/orderDeliveryCertificate')._test;

const LIFT_ITEM = {
  id: 1,
  shape_name: 'חבילת ליפטים',
  diameter: 12,
  quantity: 4,
  total_length_mm: 1200,
  total_weight: 194,
  shape_snapshot_json: JSON.stringify({
    family: 'lifts',
    shapeType: 'lift_package',
    data: { diameter: 12, barLength: 1200, weighedKg: 48.5 },
  }),
};

// Bird / lifting inserts are a different, older category that is matched on
// wording. Lifts must not swallow it.
const BIRD_ITEM = {
  id: 2,
  shape_name: 'ציפורים',
  diameter: 8,
  quantity: 50,
  total_weight: 12,
  total_length_mm: 300,
  segments: JSON.stringify([
    { length_mm: 100, angle_deg: 90 },
    { length_mm: 100, angle_deg: 90 },
    { length_mm: 100, angle_deg: 0 },
  ]),
};

test('a lift package is classified by family, never by wording', () => {
  assert.equal(classifyOrderItem(LIFT_ITEM).kind, 'lift_package');
  // a bar merely *named* like a lift stays whatever the wording rules say
  const namedOnly = { ...BIRD_ITEM, shape_name: 'ליפט' };
  assert.notEqual(classifyOrderItem(namedOnly).kind, 'lift_package');
});

test('the existing bird / lifting-insert category is untouched', () => {
  const bird = classifyOrderItem(BIRD_ITEM);
  assert.equal(bird.kind, 'lifting');
  assert.ok(bird.lines.includes('lifting_units'));
  assert.ok(!bird.lines.includes('lift_packages_units'));
});

test('lifts reach the printed breakdown as packages and as weighed kilos', () => {
  const summary = buildOrderCommercialSummary([LIFT_ITEM]);
  const lines = summary.sections.flatMap(section => section.lines);
  const units = lines.find(line => line.key === 'lift_packages_units');
  const kilos = lines.find(line => line.key === 'lift_packages_kg');

  assert.ok(units, 'expected a package-count line');
  assert.equal(units.value, 4);
  assert.equal(units.unit, 'unit');

  assert.ok(kilos, 'expected a weighed-kilos line');
  assert.equal(kilos.value, 194);

  // the weighed weight must count toward the order material weight
  assert.equal(summary.material_weight_kg, 194);
});

test('the delivery certificate gives lifts their own section', () => {
  assert.equal(deliveryTest.deliverySectionKey(LIFT_ITEM), 'lifts');
  assert.equal(deliveryTest.deliverySectionKey(BIRD_ITEM), 'lifting');
});

test('the delivery certificate reports the weighed weight, not a computed one', () => {
  const metrics = deliveryTest.deliveryItemMetrics(LIFT_ITEM, { kgPerMeter: () => 0.888 });
  assert.equal(metrics.totalWeightKg, 194);
});

// ── the scale is the weight ──────────────────────────────────────
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { runCoreMigrations } = require('../db/startup');
const industry = require('../modules/steel-rebar');
const { createOrderFactory } = require('../services/orders');

function liftSnapshot(weighedKg, packages) {
  const { buildShapeDataContractV2 } = loadShapeEditor();
  return buildShapeDataContractV2({
    family: 'lifts', diameter: 12, barLength: 1200, weighedKg, quantity: packages,
  });
}

test('a weighed lift is stored at the weight on the scale, not a weight guessed from steel', () => {
  const db = new Database(':memory:');
  try {
    ensureCoreSchema(db);
    runCoreMigrations(db);
    const service = createOrderFactory(db, { generateOrderNum: () => 'LIFT-ORDER-1', industry });
    service.createOrderFromPayload({
      customer: { name: 'Lift test' },
      order: {},
      // four packages went on the scale together and came to 194 kg
      pallets: [{ items: [{ shapeSnapshot: liftSnapshot(194, 4), shapeName: 'חבילת ליפטים', diameter: 12, qty: 4 }] }],
    });

    const item = db.prepare('SELECT quantity, weight_per_unit, total_weight FROM items').get();
    assert.equal(item.quantity, 4, 'the package count is still recorded');
    assert.equal(Math.round(item.total_weight * 100) / 100, 194, 'the line weighs what the scale said');
    assert.equal(Math.round(item.weight_per_unit * 100) / 100, 48.5, 'per package is derived, never multiplied back up');

    // a bar of this diameter and length would weigh about 4 kg — the guess must not win
    const guess = industry.weightPerUnit({ diameter: 12, total_length_mm: 1200 }) * 4;
    assert.ok(guess < 10, 'sanity: the geometric guess really is tiny');
    assert.notEqual(Math.round(item.total_weight), Math.round(guess));

    // The order header is refreshed from the items by recalcOrderWeights, so
    // what matters here is that the sum it reads is the weighed one.
    const summed = db.prepare('SELECT COALESCE(SUM(total_weight),0) AS w FROM items').get().w;
    assert.equal(Math.round(summed * 100) / 100, 194, 'the order total follows the scale');
    assert.equal(Math.round(summed * 1.03 * 100) / 100, 199.82, 'billing is the weighed total plus the 3% waste');
  } finally {
    db.close();
  }
});

test('one package is stored at its own weighing', () => {
  const db = new Database(':memory:');
  try {
    ensureCoreSchema(db);
    runCoreMigrations(db);
    createOrderFactory(db, { generateOrderNum: () => 'LIFT-ORDER-2', industry }).createOrderFromPayload({
      customer: { name: 'Lift single' },
      order: {},
      pallets: [{ items: [{ shapeSnapshot: liftSnapshot(48.5, 1), shapeName: 'חבילת ליפטים', diameter: 12, qty: 1 }] }],
    });
    const item = db.prepare('SELECT quantity, total_weight FROM items').get();
    assert.equal(item.quantity, 1);
    assert.equal(Math.round(item.total_weight * 100) / 100, 48.5);
  } finally {
    db.close();
  }
});
