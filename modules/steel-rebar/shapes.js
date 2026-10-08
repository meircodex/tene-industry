'use strict';

(function initSteelRebarShapes(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./weights').rebarKgPerMeter);
    return;
  }
  const kgPerMeter = root.IronBendRebar && root.IronBendRebar.kgPerMeter;
  root.IronBendSteelRebarShapes = Object.freeze(factory(kgPerMeter));
})(typeof globalThis !== 'undefined' ? globalThis : this, function steelRebarShapesFactory(rebarKgPerMeter) {

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function requireWeightCalculator() {
  if (typeof rebarKgPerMeter !== 'function') throw new Error('steel_rebar_weight_calculator_unavailable');
  return rebarKgPerMeter;
}

function shapeText(value) {
  return String(value || '').toLowerCase();
}

function toLengths(segments) {
  return (segments || []).map(segment => Number(segment.length_mm) || 0);
}

function isKnownOpenUName(shape) {
  return /open|hook|anchor|צורת ח|צורת u|פתוח|פתוחה|\bu\b/.test(shape);
}

function isKnownFactoryName(shape) {
  return /open|hook|anchor|closed|stirrup|overlap|צורת ח|צורת u|פתוח|פתוחה|חפיפה|אצבע|מסגרת|חישוק|\bu\b/.test(shape);
}

function isKnownClosedName(shape) {
  return /closed|stirrup|overlap|חפיפה|אצבע|מסגרת|חישוק/.test(shape);
}

function isSpiralName(shapeName) {
  return /spiral|ring|coil|spring|helix|ספיר|ספירלה|טבעת|סליל|לולאה|קפיץ/.test(shapeText(shapeName));
}

function positiveNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function normalizeSpiralParams(item = {}) {
  const spiralDiameterMm = positiveNumber(
    item.spiral_diameter_mm,
    item.spiralDiameterMm,
    item.spiral_diameter,
    item.spiralDiameter,
    item.coil_diameter_mm,
    item.ring_diameter_mm
  );
  const turns = positiveNumber(
    item.spiral_turns,
    item.spiralTurns,
    item.turns,
    item.wraps,
    item.coils,
    item.windings
  );
  const hasSpiralDimensions = spiralDiameterMm > 0 && turns > 0;
  const isSpiral = isSpiralName(item.shape_name || item.shapeName || item.shape || item.type);
  return {
    isSpiral: hasSpiralDimensions && (isSpiral || !Array.isArray(item.sides) || item.sides.length <= 2),
    spiralDiameterMm,
    turns,
  };
}

function spiralCutLengthMm(spiralDiameterMm, turns) {
  const diameter = Number(spiralDiameterMm) || 0;
  const wrapCount = Number(turns) || 0;
  return Math.round(Math.PI * diameter * wrapCount);
}

function normalizeBarShapeType(input, sides, angles) {
  const explicit = String(input.shapeType || input.shape_type || '').trim();
  if (explicit) return explicit;
  return sides.length === 1 && angles.length === 0 ? 'straight_bar' : 'custom_bent_bar';
}

function buildBarsShapeContract(input = {}, options = {}) {
  const sides = Array.isArray(input.sides) ? input.sides.map(value => Number(value) || 0) : [];
  const angles = Array.isArray(input.angles) ? input.angles.map(value => Number(value) || 0) : [];
  const is3d = input.is3d === 1 || input.is3d === true || input.is_3d === 1 || input.is_3d === true;
  const azAngles = is3d && Array.isArray(input.azAngles) ? input.azAngles.map(value => Number(value) || 0) : null;
  const elAngles = is3d && Array.isArray(input.elAngles) ? input.elAngles.map(value => Number(value) || 0) : null;
  const diameter = positiveNumber(input.diameter, input.diameterMm, input.barDiameterMm);
  const quantity = Math.max(1, Math.round(positiveNumber(options.quantity, input.quantity, 1)));
  const unitLengthMm = sides.reduce((sum, value) => sum + value, 0);
  const unitWeightKg = round((unitLengthMm / 1000) * requireWeightCalculator()(diameter), 3);
  const totalLengthMm = round(unitLengthMm * quantity, 1);
  const totalWeightKg = round(unitWeightKg * quantity, 3);
  const shapeType = normalizeBarShapeType(input, sides, angles);
  const roundedBends = shapeType === 'rounded_end_bar' || input.roundedBends === true;
  const radiusCandidate = Number(input.radiusMm ?? input.radius_mm ?? input.radius);
  const radiusMm = Number.isFinite(radiusCandidate) && radiusCandidate > 0 ? radiusCandidate : null;
  const segments = sides.map((lengthMm, index) => ({
    index: index + 1,
    lengthMm,
    length_mm: lengthMm,
    bendAfterDeg: index < angles.length ? angles[index] : null,
    angle_deg: index < angles.length ? angles[index] : null,
    ...(roundedBends && index < angles.length ? { bendRadiusMm: radiusMm, bend_radius_mm: radiusMm } : {}),
  }));
  return {
    data: { sides, angles, diameter, ...(roundedBends ? { roundedBends: true, radiusMm } : {}), ...(is3d ? { is3d: 1, azAngles, elAngles } : {}) },
    calculated: {
      totalLengthMm: unitLengthMm,
      weightKg: unitWeightKg,
      unitLengthMm,
      unitWeightKg,
      quantity,
      componentTotalLengthMm: totalLengthMm,
      totalWeightKg,
      bendCount: angles.length,
    },
    generic: { family: 'bars', shapeType, diameter, segments, totalLengthMm: unitLengthMm, bendCount: angles.length, ...(roundedBends ? { roundedBends: true, radiusMm } : {}), ...(is3d ? { is3d: 1, azAngles, elAngles } : {}) },
    component: {
      family: 'bars',
      shapeType,
      diameterMm: diameter,
      quantity,
      unitLengthMm,
      totalLengthMm,
      unitWeightKg,
      weightKg: totalWeightKg,
      sides,
      angles,
      ...(roundedBends ? { roundedBends: true, radiusMm } : {}),
      ...(is3d ? { is3d: 1, azAngles, elAngles } : {}),
      segments,
    },
  };
}

function calculateHelicalSpiral(input = {}) {
  const axialLengthMm = positiveNumber(input.axialLengthMm, input.axial_length_mm);
  const pitchMm = positiveNumber(input.pitchMm, input.pitch_mm);
  const effectiveDiameterMm = positiveNumber(
    input.effectiveDiameterMm,
    input.spiralDiameterMm,
    input.spiral_diameter_mm,
  );
  const barDiameterMm = positiveNumber(input.barDiameterMm, input.bar_diameter_mm, input.diameterMm, input.diameter);
  if (!(axialLengthMm > 0)) throw new Error('invalid_spiral_axial_length');
  if (!(pitchMm > 0)) throw new Error('invalid_spiral_pitch');
  if (!(effectiveDiameterMm > 0)) throw new Error('invalid_spiral_diameter');
  if (!(barDiameterMm > 0)) throw new Error('invalid_spiral_bar_diameter');

  const circumferenceRawMm = Math.PI * effectiveDiameterMm;
  const turnsRaw = axialLengthMm / pitchMm;
  const helicalLengthPerTurnRawMm = Math.sqrt(circumferenceRawMm ** 2 + pitchMm ** 2);
  const helicalCutLengthRawMm = turnsRaw * helicalLengthPerTurnRawMm;
  const helicalCutLengthMm = round(helicalCutLengthRawMm, 1);
  const barWeightKg = round((helicalCutLengthMm / 1000) * requireWeightCalculator()(barDiameterMm), 3);
  return {
    axialLengthMm: round(axialLengthMm, 1),
    pitchMm: round(pitchMm, 1),
    effectiveDiameterMm: round(effectiveDiameterMm, 1),
    barDiameterMm: round(barDiameterMm, 1),
    circumferenceMm: round(circumferenceRawMm, 1),
    turns: round(turnsRaw, 2),
    turnsRaw,
    helicalLengthPerTurnMm: round(helicalLengthPerTurnRawMm, 1),
    helicalCutLengthMm,
    barWeightKg,
    calculation: Object.freeze({
      mode: 'helical_axial_pitch',
      units: 'mm',
      formula: 'turns=axialLength/pitch; cut=turns*sqrt((pi*diameter)^2+pitch^2)',
      precision: Object.freeze({ turns: 2, lengthMm: 1, weightKg: 3 }),
    }),
  };
}

function buildSpiralShapeContract(input = {}) {
  const barDiameter = positiveNumber(input.barDiameter, input.barDiameterMm, input.diameter, input.diameterMm);
  const spiralDiameter = positiveNumber(input.spiralDiameter, input.spiralDiameterMm, input.spiral_diameter_mm);
  const turns = positiveNumber(input.turns, input.spiralTurns, input.spiral_turns);
  const totalLengthMm = spiralCutLengthMm(spiralDiameter, turns);
  const weightKg = round((totalLengthMm / 1000) * requireWeightCalculator()(barDiameter), 3);
  return {
    data: { barDiameter, spiralDiameter, turns },
    calculated: { totalLengthMm, weightKg, unitLengthMm: totalLengthMm, unitWeightKg: weightKg },
    generic: { family: 'spirals', shapeType: input.shapeType || 'spiral', barDiameter, spiralDiameter, turns, totalLengthMm },
  };
}

function buildRingShapeContract(input = {}) {
  const barDiameterMm = positiveNumber(input.barDiameterMm, input.barDiameter, input.diameterMm, input.diameter);
  const bendingDiameterMm = positiveNumber(
    input.bendingDiameterMm,
    input.spiralDiameterMm,
    input.ringDiameterMm,
    input.ring_diameter_mm,
  );
  const overlapCandidate = Number(
    input.overlapMm
      ?? input.overlap_mm
      ?? input.ringOverlapMm
      ?? input.ring_overlap_mm
      ?? 0
  );
  const overlapMm = Number.isFinite(overlapCandidate) && overlapCandidate >= 0 ? overlapCandidate : 0;
  const quantity = Math.max(1, Math.round(positiveNumber(input.quantity, 1)));
  const standalone = buildSpiralShapeContract({
    shapeType: 'ring',
    barDiameter: barDiameterMm,
    spiralDiameter: bendingDiameterMm,
    turns: 1,
  });
  const circumferenceMm = standalone.calculated.totalLengthMm;
  const unitLengthMm = round(circumferenceMm + overlapMm, 1);
  const unitWeightKg = round((unitLengthMm / 1000) * requireWeightCalculator()(barDiameterMm), 3);
  return {
    ...standalone,
    data: { ...standalone.data, ringDiameterMm: bendingDiameterMm, bendingDiameterMm, overlapMm, circumferenceMm, quantity },
    calculated: { ...standalone.calculated, circumferenceMm, overlapMm, totalLengthMm: unitLengthMm, unitLengthMm, weightKg: unitWeightKg, unitWeightKg },
    generic: { ...standalone.generic, shapeType: 'ring', ringDiameterMm: bendingDiameterMm, bendingDiameterMm, overlapMm, circumferenceMm, totalLengthMm: unitLengthMm, quantity },
    component: {
      family: 'spirals',
      shapeType: 'ring',
      diameterMm: barDiameterMm,
      bendingDiameterMm,
      ringDiameterMm: bendingDiameterMm,
      overlapMm,
      circumferenceMm,
      spiralDiameterMm: bendingDiameterMm,
      turns: 1,
      quantity,
      unitLengthMm,
      totalLengthMm: round(unitLengthMm * quantity, 1),
      unitWeightKg,
      weightKg: round(unitWeightKg * quantity, 3),
    },
  };
}

function normalizeOpenU(segments) {
  if (segments.length !== 3) return null;
  const [a, b, c] = toLengths(segments);
  if (a === b && b !== c) {
    return [
      { ...segments[0], angle_deg: 90 },
      { ...segments[2], angle_deg: 90 },
      { ...segments[1], angle_deg: segments[1].angle_deg ?? 0 },
    ];
  }
  if (b === c && a !== b) {
    return [
      { ...segments[1], angle_deg: 90 },
      { ...segments[0], angle_deg: 90 },
      { ...segments[2], angle_deg: segments[2].angle_deg ?? 0 },
    ];
  }
  return segments;
}

function normalizeClosedStirrup(segments) {
  if (segments.length !== 6) return null;
  const [a, b, c, d, e, f] = toLengths(segments);

  // Preferred factory path: [tail,height,width,height,width,tail].
  if (b === d && c === e && a === f && a < Math.max(b, c)) return segments;

  // Legacy OCR path: [height,width,height,width,tail,tail].
  if (a === c && b === d && e === f && e < Math.max(a, b)) {
    return [
      { ...segments[4], angle_deg: 90 },
      { ...segments[0], angle_deg: 90 },
      { ...segments[1], angle_deg: 90 },
      { ...segments[2], angle_deg: 90 },
      { ...segments[3], angle_deg: 90 },
      { ...segments[5], angle_deg: segments[5].angle_deg ?? 0 },
    ];
  }

  return segments;
}

function normalizeFactorySegments(shapeName, sourceSegments) {
  const segments = (sourceSegments || []).map(segment => ({ ...segment }));
  const shape = shapeText(shapeName);

  if (isKnownClosedName(shape)) {
    const closed = normalizeClosedStirrup(segments);
    if (closed) return closed;
  }

  if (isKnownOpenUName(shape) || isKnownFactoryName(shape)) {
    const openU = normalizeOpenU(segments);
    if (openU) return openU;
  }

  return segments;
}

function normalizeFactoryShapeName(shapeName, segments, options = {}) {
  const shape = String(shapeName || '');
  const lower = shapeText(shape);
  const lengths = toLengths(segments);
  const spiral = normalizeSpiralParams({ shape_name: shapeName, ...options });

  if (spiral.isSpiral) return 'spiral';
  if (isSpiralName(lower) && lengths.length <= 1) return 'straight bar';
  if ((isKnownOpenUName(lower) || isKnownFactoryName(lower)) && lengths.length === 3 && lengths[0] === lengths[2]) {
    return 'open U-shaped bar';
  }
  if (isKnownClosedName(lower) && lengths.length === 6 && lengths[0] === lengths[5] && lengths[1] === lengths[3] && lengths[2] === lengths[4]) {
    return 'closed stirrup 90-degree overlap';
  }
  return shape;
}

return {
  isSpiralName,
  normalizeSpiralParams,
  spiralCutLengthMm,
  buildBarsShapeContract,
  buildSpiralShapeContract,
  calculateHelicalSpiral,
  buildRingShapeContract,
  normalizeFactorySegments,
  normalizeFactoryShapeName,
};
});
