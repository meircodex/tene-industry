'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const {
  buildOrderCommercialSummary,
  classifyOrderItem,
  summaryLine,
} = require('../services/orderCommercialSummary');

function item(overrides = {}) {
  return {
    id: overrides.id || 1,
    shape_name: 'מוט ישר',
    diameter: 12,
    quantity: 1,
    total_length_mm: 5000,
    total_weight: 10,
    segments: JSON.stringify([{ length_mm: 5000, angle_deg: null }]),
    ...overrides,
  };
}

function line(summary, key) {
  const result = summaryLine(summary, key);
  assert.ok(result, `missing summary line ${key}`);
  return result;
}

function cageSnapshot() {
  return calculatePileCage({
    shapeId: 'commercial-summary-cage',
    roundPileCage: true,
    pileDiameterMm: 600,
    pileLengthMm: 12000,
    longitudinalBars: {
      totalBars: 10,
      defaultDiameterMm: 20,
      defaultLengthMm: 12000,
      pattern: [{ type: 'straight', lengthMm: 12000 }, { type: 'L', lengthMm: 12000, bendLengthMm: 200 }],
    },
    spiral: {
      barDiameterMm: 8,
      outerDiameterMm: 480,
      pitchMode: 'zones',
      zones: [{ name: 'A', lengthMm: 3000, pitchMm: 150 }, { name: 'B', lengthMm: 2000, noWrap: true }, { name: 'C', lengthMm: 7000, pitchMm: 200 }],
    },
    hoops: { enabled: true, hoopBarDiameterMm: 18, outerDiameterMm: 420, spacingMode: 'byQuantity', quantity: 5, firstHoopOffsetMm: 1500, spacingMm: 300 },
  });
}

test('commercial summary treats cutting and bending as overlapping kg services', () => {
  const summary = buildOrderCommercialSummary([
    item({ id: 1, quantity: 87, total_length_mm: 4400, total_weight: 523.10, segments: JSON.stringify([{ length_mm: 4400, angle_deg: null }]) }),
    item({ id: 2, quantity: 131, total_length_mm: 4905, total_weight: 950, segments: JSON.stringify([{ length_mm: 1000, angle_deg: 90 }, { length_mm: 3905, angle_deg: null }]) }),
    item({ id: 3, quantity: 1, total_length_mm: 4875, total_weight: 8.33, segments: JSON.stringify([{ length_mm: 1000, angle_deg: 90 }, { length_mm: 1500, angle_deg: 90 }, { length_mm: 1000, angle_deg: 135 }, { length_mm: 1375, angle_deg: null }]) }),
  ]);

  assert.equal(line(summary, 'processed_rebar_kg').value, 1481.43);
  assert.equal(summaryLine(summary, 'round_wire_coil_kg'), null);
  assert.equal(line(summary, 'cutting_kg').value, 1481.43);
  assert.equal(line(summary, 'bending_kg').value, 958.33);
  assert.equal(line(summary, 'bending_kg').unit, 'kg');
  assert.equal(line(summary, 'bending_kg').contributors.length, 2, 'bend count must not multiply the service');
});

test('full 6/12 metre straight stock is material only while other straight lengths are cut', () => {
  const summary = buildOrderCommercialSummary([
    item({ id: 1, total_length_mm: 6000, total_weight: 6, segments: JSON.stringify([{ length_mm: 6000, angle_deg: null }]) }),
    item({ id: 2, total_length_mm: 12000, total_weight: 12, segments: JSON.stringify([{ length_mm: 12000, angle_deg: null }]) }),
    item({ id: 3, total_length_mm: 5000, total_weight: 5, segments: JSON.stringify([{ length_mm: 5000, angle_deg: null }]) }),
  ]);
  assert.equal(line(summary, 'processed_rebar_kg').value, 23);
  assert.equal(summaryLine(summary, 'round_wire_coil_kg'), null);
  assert.equal(line(summary, 'cutting_kg').value, 5);
  assert.equal(summaryLine(summary, 'bending_kg'), null);
});

test('an explicitly sourced coil spiral is round-wire material plus cutting and spiral processing, never generic bending', () => {
  const summary = buildOrderCommercialSummary([item({
    shape_name: 'ספירלה',
    diameter: 8,
    quantity: 1,
    total_weight: 100,
    material_source: 'coil',
    spiral_diameter_mm: 480,
    spiral_turns: 50,
    shape_snapshot_json: JSON.stringify({ family: 'spirals', shapeType: 'spiral', data: { spiral: { turns: 50 } } }),
  })]);
  assert.equal(line(summary, 'round_wire_coil_kg').value, 100);
  assert.equal(line(summary, 'cutting_kg').value, 100);
  assert.equal(line(summary, 'spiral_processing_kg').value, 100);
  assert.equal(summaryLine(summary, 'bending_kg'), null);
});

test('rings are priced as iron plus cutting, bending and ring processing per unit', () => {
  const summary = buildOrderCommercialSummary([
    item({ id: 1, shape_id: 's15', shape_name: 'ספסל', quantity: 4, total_weight: 10, segments: JSON.stringify([{ length_mm: 500, angle_deg: 90 }, { length_mm: 1000, angle_deg: 90 }, { length_mm: 500, angle_deg: null }]) }),
    item({ id: 2, shape_name: 'טבעת', quantity: 5, total_weight: 13.19, spiral_diameter_mm: 420, spiral_turns: 1, shape_snapshot_json: JSON.stringify({ family: 'spirals', shapeType: 'ring', data: { ringDiameterMm: 420 } }) }),
  ]);
  assert.equal(line(summary, 'processed_rebar_kg').value, 23.19);
  assert.equal(summaryLine(summary, 'round_wire_coil_kg'), null);
  assert.equal(line(summary, 'cutting_kg').value, 23.19);
  assert.equal(line(summary, 'bending_kg').value, 23.19);
  assert.equal(line(summary, 'bending_kg').contributors.length, 2);
  assert.equal(line(summary, 'chairs_units').value, 4);
  assert.equal(line(summary, 'chairs_units').unit, 'unit');
  assert.equal(line(summary, 'rings_units').value, 5);
  assert.equal(line(summary, 'rings_units').unit, 'unit');
  assert.equal(line(summary, 'rings_units').label, 'עיבוד טבעות');
});

test('hoops are kept distinct from rings and are priced as bent hoop processing', () => {
  const summary = buildOrderCommercialSummary([item({
    id: 3,
    shape_name: 'חישוק',
    quantity: 7,
    total_weight: 21,
    shape_snapshot_json: JSON.stringify({ shapeType: 'closed_stirrup', data: {} }),
  })]);
  assert.equal(line(summary, 'bending_kg').value, 21);
  assert.equal(summaryLine(summary, 'rings_units'), null);
  assert.equal(line(summary, 'hoops_units').value, 7);
  assert.equal(line(summary, 'hoops_units').label, 'עיבוד חישוקים');
});

test('column penetration details are a separate per-unit add-on with cutting and bending', () => {
  const summary = buildOrderCommercialSummary([item({
    id: 4,
    shape_name: 'פרט חדירה לעמודים',
    quantity: 30,
    total_weight: 188.7,
  })]);
  assert.equal(line(summary, 'cutting_kg').value, 188.7);
  assert.equal(line(summary, 'bending_kg').value, 188.7);
  assert.equal(line(summary, 'column_penetration_units').value, 30);
  assert.equal(line(summary, 'column_penetration_units').label, 'פרטי חדירה לעמודים');
  assert.equal(summaryLine(summary, 'rings_units'), null);
  assert.equal(summaryLine(summary, 'hoops_units'), null);
});

test('imported two-direction inclined details classify as column penetration units', () => {
  const summary = buildOrderCommercialSummary([
    item({ id: 19, shape_name: 'טיפוס B 250/250/80 / מוטה Φ16@20 ב-2 כיוונים', quantity: 208, total_weight: 1193 }),
    item({ id: 24, shape_name: 'טיפוס C 280/280/90 / מוטה Φ16@20 ב-2 כיוונים', quantity: 30, total_weight: 188.7 }),
  ]);
  assert.equal(line(summary, 'column_penetration_units').value, 238);
  assert.equal(line(summary, 'bending_kg').value, 1381.7);
  assert.equal(line(summary, 'cutting_kg').value, 1381.7);
});

test('mesh and pile cages are independent finished-product kg rows without material double counting', () => {
  const cage = cageSnapshot();
  const summary = buildOrderCommercialSummary([
    item({ id: 1, shape_name: 'רשת', quantity: 3, total_weight: 120, shape_snapshot_json: JSON.stringify({ family: 'mesh', shapeType: 'mesh_rectangular', data: {} }) }),
    item({ id: 2, shape_name: 'corrupt legacy straight', quantity: 2, total_weight: 29.64, shape_snapshot_json: JSON.stringify(cage), segments: '[]' }),
  ]);
  assert.equal(line(summary, 'mesh_kg').value, 120);
  assert.equal(line(summary, 'pile_cages_kg').value, 689.04);
  assert.equal(line(summary, 'pile_cages_kg').contributors[0].pile_components.length, 4);
  assert.equal(summary.material_weight_kg, 809.04);
  assert.equal(summaryLine(summary, 'processed_rebar_kg'), null);
  assert.equal(summaryLine(summary, 'cutting_kg'), null);
});

test('actual item weight wins and historical items fall back to saved theoretical weight', () => {
  const actual = classifyOrderItem(item({ actual_weight_kg: 11.25, total_weight: 10 }));
  const historical = classifyOrderItem(item({ actual_weight_kg: null, total_weight: 10 }));
  assert.deepEqual({ weight: actual.weightKg, source: actual.weightSource }, { weight: 11.25, source: 'actual' });
  assert.deepEqual({ weight: historical.weightKg, source: historical.weightSource }, { weight: 10, source: 'theoretical_saved' });
});

test('top-level kg lines never expose unit counts while drilldown keeps traceable contributors', () => {
  const summary = buildOrderCommercialSummary([item({ id: 77, quantity: 4, total_weight: 10 })]);
  const cutting = line(summary, 'cutting_kg');
  assert.equal(cutting.unit, 'kg');
  assert.equal(cutting.value, 10);
  assert.equal(Object.hasOwn(cutting, 'units'), false);
  assert.deepEqual(cutting.contributors.map(row => ({ item: row.item_id, qty: row.quantity })), [{ item: 77, qty: 4 }]);
  assert.deepEqual(
    { source: cutting.contributors[0].material_source, basis: cutting.contributors[0].material_source_basis },
    { source: 'straight', basis: 'default_processed_rebar' },
  );
});

test('unspecified stock source always defaults to processed building rebar', () => {
  const bent16 = classifyOrderItem(item({ diameter: 16, total_length_mm: 6000, segments: JSON.stringify([{ length_mm: 1000, angle_deg: 90 }, { length_mm: 5000, angle_deg: null }]) }));
  const cutStraight16 = classifyOrderItem(item({ diameter: 16, total_length_mm: 5000, segments: JSON.stringify([{ length_mm: 5000, angle_deg: null }]) }));
  const fullStraight16 = classifyOrderItem(item({ diameter: 16, total_length_mm: 6000, segments: JSON.stringify([{ length_mm: 6000, angle_deg: null }]) }));
  const bent20 = classifyOrderItem(item({ diameter: 20, total_length_mm: 5000, segments: JSON.stringify([{ length_mm: 1000, angle_deg: 90 }, { length_mm: 4000, angle_deg: null }]) }));

  assert.deepEqual({ source: bent16.materialSource, basis: bent16.materialSourceBasis }, { source: 'straight', basis: 'default_processed_rebar' });
  assert.equal(bent16.lines[0], 'processed_rebar_kg');
  assert.equal(cutStraight16.lines[0], 'processed_rebar_kg');
  assert.equal(fullStraight16.lines[0], 'processed_rebar_kg');
  assert.equal(bent20.lines[0], 'processed_rebar_kg');
});

test('an unspecified spiral is processed rebar until its stock source is selected explicitly', () => {
  const spiral = classifyOrderItem(item({
    shape_name: 'ספירלה',
    diameter: 8,
    total_length_mm: 5000,
    total_weight: 10,
    spiral_turns: 20,
    shape_snapshot_json: JSON.stringify({ family: 'spirals', shapeType: 'spiral', data: { spiral: { turns: 20 } } }),
  }));
  assert.deepEqual(
    { source: spiral.materialSource, basis: spiral.materialSourceBasis },
    { source: 'straight', basis: 'default_processed_rebar' },
  );
  assert.equal(spiral.lines[0], 'processed_rebar_kg');
});

test('an explicit material source overrides inference for future stock or machine selection', () => {
  const explicitBar = classifyOrderItem(item({ diameter: 12, total_length_mm: 5000, material_source: 'straight' }));
  const explicitCoil = classifyOrderItem(item({ diameter: 20, total_length_mm: 12000, material_source: 'coil', segments: JSON.stringify([{ length_mm: 12000, angle_deg: null }]) }));

  assert.deepEqual({ source: explicitBar.materialSource, basis: explicitBar.materialSourceBasis }, { source: 'straight', basis: 'explicit' });
  assert.equal(explicitBar.lines[0], 'processed_rebar_kg');
  assert.deepEqual({ source: explicitCoil.materialSource, basis: explicitCoil.materialSourceBasis }, { source: 'coil', basis: 'explicit' });
  assert.equal(explicitCoil.lines[0], 'round_wire_coil_kg');
});

test('commercial summary uses the approved price-list terminology', () => {
  const summary = buildOrderCommercialSummary([
    item({ diameter: 12, total_length_mm: 5000, total_weight: 10 }),
    item({ id: 2, diameter: 20, total_length_mm: 12000, total_weight: 20, material_source: 'coil', segments: JSON.stringify([{ length_mm: 12000, angle_deg: null }]) }),
  ]);
  assert.deepEqual(summary.sections.map(section => section.label), ['ברזל מעובד', 'עיבודים ברזל']);
  assert.equal(line(summary, 'processed_rebar_kg').label, 'ברזל');
  assert.equal(line(summary, 'round_wire_coil_kg').label, 'סלילים עגולים-חוטים');
  assert.equal(line(summary, 'cutting_kg').label, 'חיתוך');
});
