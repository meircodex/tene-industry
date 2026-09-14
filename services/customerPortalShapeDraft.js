'use strict';

const crypto = require('crypto');
const { VALID_DIAMETERS, rebarKgPerMeter } = require('../constants');
const {
  buildBarsShapeContract,
  buildSpiralShapeContract,
  buildRingShapeContract,
} = require('../modules/steel-rebar/shapes');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const {
  buildFullShapeSnapshot,
  isShapeDataContractV2,
  parseJsonObject,
} = require('./shapeSnapshot');

const ALLOWED_FAMILIES = new Set(['bars', 'mesh', 'piles', 'spirals']);
const SHAPE_TYPE_ALIASES = Object.freeze({
  straight: 'straight_bar',
  straight_bar: 'straight_bar',
  bar: 'straight_bar',
  'ישר': 'straight_bar',
  'מוט ישר': 'straight_bar',
  l: 'l_bar',
  l_bar: 'l_bar',
  u: 'u_bar',
  u_bar: 'u_bar',
  stirrup: 'stirrup',
  stirrups: 'stirrup',
  custom: 'custom_bar',
  custom_bar: 'custom_bar',
});

function portalDraftError(message, code = 'invalid_shape_draft', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function cleanText(value, fallback = '') {
  const text = String(value ?? fallback ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\bon[a-z]+\s*=\s*\S+/gi, '')
    .replace(/script/gi, '')
    .replace(/\bjavascript\s*:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 240);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(value, fieldName) {
  const n = numberOrNull(value);
  if (n === null || n <= 0) throw portalDraftError(`${fieldName} must be positive`);
  return n;
}

function normalizeQuantity(value) {
  const n = Math.round(Number(value ?? 1));
  if (!Number.isFinite(n) || n < 1) throw portalDraftError('quantity must be positive');
  if (n > 100000) throw portalDraftError('quantity is too large');
  return n;
}

function normalizeDiameter(value) {
  const diameter = positiveNumber(value, 'diameter');
  const allowed = Array.isArray(VALID_DIAMETERS) ? VALID_DIAMETERS.map(Number) : [];
  if (allowed.length && !allowed.includes(diameter)) {
    throw portalDraftError('diameter is not supported', 'unsupported_diameter');
  }
  return diameter;
}

function normalizeAngle(value, fallback = null) {
  const n = numberOrNull(value);
  if (n === null) return fallback;
  if (n < -360 || n > 360) throw portalDraftError('angle is out of range');
  return n;
}

function normalizeSides(values, expectedCount = null) {
  if (!Array.isArray(values)) throw portalDraftError('sides are required');
  const sides = values.map((value, index) => positiveNumber(value, `side ${index + 1}`));
  if (expectedCount !== null && sides.length !== expectedCount) {
    throw portalDraftError(`expected ${expectedCount} sides`);
  }
  if (!sides.length) throw portalDraftError('at least one side is required');
  if (sides.length > 12) throw portalDraftError('too many sides');
  return sides;
}

function shapeTypeLabel(shapeType) {
  switch (shapeType) {
    case 'straight_bar': return 'מוט ישר';
    case 'l_bar': return 'L';
    case 'u_bar': return 'U';
    case 'stirrup': return 'חישוק';
    default: return 'צורה';
  }
}

function normalizeShapeType(value) {
  const key = String(value || 'straight_bar').trim().toLowerCase();
  const shapeType = SHAPE_TYPE_ALIASES[key];
  if (!shapeType) throw portalDraftError('shape type is not supported', 'unsupported_shape_type');
  return shapeType;
}

function draftInput(input = {}) {
  const draft = input.shapeDraft && typeof input.shapeDraft === 'object' ? input.shapeDraft : input;
  const data = draft.data && typeof draft.data === 'object' ? draft.data : {};
  return { draft, data };
}

function normalizeDraftGeometry(input = {}) {
  const { draft, data } = draftInput(input);
  const family = String(draft.family || input.family || 'bars');
  if (!ALLOWED_FAMILIES.has(family)) {
    throw portalDraftError('shape family is not supported', 'unsupported_shape_family');
  }
  const legacyType = Array.isArray(input.sides)
    ? (input.sides.length === 1 ? 'straight_bar' : 'custom_bar')
    : (input.shapeName || input.shape_name);
  const shapeType = normalizeShapeType(draft.shapeType || input.shapeType || legacyType);

  if (shapeType === 'straight_bar') {
    const length = positiveNumber(data.A ?? data.a ?? data.length ?? data.lengthMm ?? data.sides?.[0] ?? input.length ?? input.sides?.[0], 'length');
    return { family, shapeType, sides: [length], angles: [] };
  }

  if (shapeType === 'l_bar') {
    const sides = normalizeSides(data.sides || [data.A ?? data.a, data.B ?? data.b], 2);
    const angle = normalizeAngle(data.angle ?? data.angles?.[0], 90);
    return { family, shapeType, sides, angles: [angle] };
  }

  if (shapeType === 'u_bar') {
    const sides = normalizeSides(data.sides || [data.A ?? data.a, data.B ?? data.b, data.C ?? data.c], 3);
    const angles = [
      normalizeAngle(data.angleA ?? data.angles?.[0], 90),
      normalizeAngle(data.angleB ?? data.angles?.[1], 90),
    ];
    return { family, shapeType, sides, angles };
  }

  if (shapeType === 'stirrup') {
    const width = positiveNumber(data.width ?? data.W ?? data.w ?? data.sides?.[0], 'width');
    const height = positiveNumber(data.height ?? data.H ?? data.h ?? data.sides?.[1], 'height');
    const overlap = numberOrNull(data.overlap ?? data.overlapMm);
    const sides = overlap && overlap > 0 ? [width, height, width, height, overlap] : [width, height, width, height];
    const angles = sides.slice(0, -1).map(() => 90);
    return { family, shapeType, sides, angles };
  }

  const sides = normalizeSides(data.sides || input.sides);
  const rawAngles = Array.isArray(data.angles) ? data.angles : (Array.isArray(input.angles) ? input.angles : []);
  const angles = sides.slice(0, -1).map((_, index) => normalizeAngle(rawAngles[index], index < rawAngles.length ? null : 180));
  return { family, shapeType, sides, angles };
}

function segmentsFromSides(sides, angles) {
  return sides.map((length, index) => ({
    length_mm: length,
    angle_deg: index < sides.length - 1 ? normalizeAngle(angles[index], null) : null,
  }));
}

function buildDimsText(sides, angles) {
  const sideLabels = sides.map((length, index) => `${String.fromCharCode(65 + index)}=${Math.round(length)}`);
  const angleLabels = angles
    .filter(angle => Number.isFinite(Number(angle)) && Math.abs(Number(angle)) > 0.001 && Math.abs(Number(angle) - 180) > 0.001)
    .map(angle => `${Math.round(Number(angle) * 10) / 10}\u00b0`);
  return [...sideLabels, ...angleLabels].join(' \u00b7 ');
}

function buildShapePreview(shapeType, sides, angles) {
  const title = shapeTypeLabel(shapeType);
  const dims = buildDimsText(sides, angles);
  return `<svg viewBox="0 0 180 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title} ${dims}">
    <rect x="1" y="1" width="178" height="78" rx="8" fill="#fff" stroke="#d8e2ef"/>
    <text x="90" y="21" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#25364d">${title}</text>
    <text x="90" y="53" text-anchor="middle" font-family="Arial" font-size="10" fill="#526070">${dims}</text>
  </svg>`;
}

function buildPortalPreview(title, dimensions) {
  const safeTitle = cleanText(title, 'Shape');
  const safeDimensions = cleanText(dimensions, '');
  return `<svg viewBox="0 0 180 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${safeTitle} ${safeDimensions}">
    <rect x="1" y="1" width="178" height="78" rx="8" fill="#fff" stroke="#d8e2ef"/>
    <text x="90" y="27" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#25364d">${safeTitle}</text>
    <text x="90" y="55" text-anchor="middle" font-family="Arial" font-size="10" fill="#526070">${safeDimensions}</text>
  </svg>`;
}

function rounded(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function readShapeSnapshot(input = {}) {
  const candidate = input.shapeSnapshot
    ?? input.shape_snapshot
    ?? input.shapeDraft?.shapeSnapshot
    ?? input.shapeDraft?.shape_snapshot
    ?? null;
  const snapshot = parseJsonObject(candidate);
  if (candidate != null && !isShapeDataContractV2(snapshot)) {
    throw portalDraftError('shape snapshot is invalid', 'invalid_shape_snapshot');
  }
  return isShapeDataContractV2(snapshot) ? snapshot : null;
}

function assertApprovedSnapshot(snapshot) {
  if (!snapshot) return;
  const errors = Array.isArray(snapshot.validation?.errors) ? snapshot.validation.errors : [];
  if (snapshot.validation?.valid === false || errors.length) {
    throw portalDraftError('shape editor data is not valid', 'invalid_shape_snapshot');
  }
}

function requireSupportedFamily(value) {
  const family = String(value || 'bars');
  if (!ALLOWED_FAMILIES.has(family)) {
    throw portalDraftError('shape family is not supported', 'unsupported_shape_family');
  }
  return family;
}

function canonicalShapeId(value, fallback) {
  const cleaned = cleanText(value || fallback, '');
  return cleaned || fallback;
}

function meshBarCount(total, spacing, edgeStart = 0, edgeEnd = 0) {
  const length = Math.max(1, Number(total) || 1);
  const pitch = Math.max(1, Number(spacing) || 1);
  const start = Math.min(length, Math.max(0, Number(edgeStart) || 0));
  const end = Math.max(start, length - Math.min(length, Math.max(0, Number(edgeEnd) || 0)));
  const positions = [];
  for (let mm = start; mm <= end + 0.001; mm += pitch) positions.push(Math.min(end, mm));
  if (!positions.length || positions[positions.length - 1] !== end) positions.push(end);
  return positions.length;
}

function normalizeMeshData(data = {}) {
  const length = positiveNumber(data.length, 'mesh length');
  const width = positiveNumber(data.width, 'mesh width');
  const longitudinalDiameter = normalizeDiameter(data.longitudinalDiameter);
  const longitudinalSpacing = positiveNumber(data.longitudinalSpacing, 'longitudinal spacing');
  const transverseDiameter = normalizeDiameter(data.transverseDiameter);
  const transverseSpacing = positiveNumber(data.transverseSpacing, 'transverse spacing');
  const edge = field => {
    const n = numberOrNull(data[field]);
    if (n === null || n < 0) throw portalDraftError(`${field} must be zero or greater`);
    return n;
  };
  const out = {
    length,
    width,
    longitudinalDiameter,
    longitudinalSpacing,
    transverseDiameter,
    transverseSpacing,
    edgeLeft: edge('edgeLeft'),
    edgeRight: edge('edgeRight'),
    edgeTop: edge('edgeTop'),
    edgeBottom: edge('edgeBottom'),
  };
  if (out.edgeLeft + out.edgeRight >= out.length || out.edgeTop + out.edgeBottom >= out.width) {
    throw portalDraftError('mesh cover leaves no reinforcement area');
  }
  return out;
}

function buildMeshSnapshot(snapshot, data) {
  const longitudinalBarCount = meshBarCount(data.width, data.longitudinalSpacing, data.edgeTop, data.edgeBottom);
  const transverseBarCount = meshBarCount(data.length, data.transverseSpacing, data.edgeLeft, data.edgeRight);
  const longitudinalTotalLengthMm = longitudinalBarCount * data.length;
  const transverseTotalLengthMm = transverseBarCount * data.width;
  const totalLengthMm = longitudinalTotalLengthMm + transverseTotalLengthMm;
  const weightKg = rounded(
    (longitudinalTotalLengthMm / 1000) * rebarKgPerMeter(data.longitudinalDiameter)
      + (transverseTotalLengthMm / 1000) * rebarKgPerMeter(data.transverseDiameter),
  );
  const calculated = {
    longitudinalBarCount,
    transverseBarCount,
    longitudinalTotalLengthMm,
    transverseTotalLengthMm,
    totalLengthMm,
    weightKg,
  };
  const shapeType = snapshot.shapeType || 'mesh_rectangular';
  return {
    shapeSnapshot: buildFullShapeSnapshot({
      shapeVersion: snapshot.shapeVersion,
      shapeId: canonicalShapeId(snapshot.shapeId, `portal-mesh-${crypto.randomUUID()}`),
      shapeType,
      family: 'mesh',
      source: 'customer-portal',
      displayName: cleanText(snapshot.displayName, 'רשת'),
      data,
      calculated,
      machineOutput: {
        generic: { family: 'mesh', shapeType, ...data, longitudinalBarCount, transverseBarCount, totalLengthMm, weightKg },
      },
      validation: { valid: true, warnings: [], errors: [] },
    }),
    family: 'mesh',
    shapeType,
    shapeId: canonicalShapeId(snapshot.shapeId, 'portal-mesh'),
    diameter: data.longitudinalDiameter,
    sides: [],
    angles: [],
    segments: [],
    totalLengthMm,
    weightPerUnit: weightKg,
    shapeDimsText: `L=${Math.round(data.length)} · W=${Math.round(data.width)} · Ø${data.longitudinalDiameter}@${data.longitudinalSpacing} / Ø${data.transverseDiameter}@${data.transverseSpacing}`,
  };
}

function buildBarsSnapshot(snapshot, rawData = {}) {
  const sides = normalizeSides(rawData.sides);
  const angles = (Array.isArray(rawData.angles) ? rawData.angles : []).map((angle, index) => normalizeAngle(angle, index < sides.length - 1 ? 180 : null));
  if (![sides.length - 1, sides.length].includes(angles.length)) {
    throw portalDraftError('angles do not match sides');
  }
  const diameter = normalizeDiameter(rawData.diameter ?? rawData.diameterMm);
  const is3d = rawData.is3d === 1 || rawData.is3d === true;
  const contract = buildBarsShapeContract({
    ...rawData,
    sides,
    angles,
    diameter,
    is3d,
    azAngles: is3d ? rawData.azAngles : null,
    elAngles: is3d ? rawData.elAngles : null,
    shapeType: snapshot.shapeType,
  });
  const shapeType = snapshot.shapeType || (sides.length === 1 ? 'straight_bar' : 'custom_bar');
  const shapeId = canonicalShapeId(snapshot.shapeId, `portal-${shapeType}-${crypto.randomUUID()}`);
  const shapeSnapshot = buildFullShapeSnapshot({
    shapeVersion: snapshot.shapeVersion,
    shapeId,
    shapeType,
    family: 'bars',
    source: 'customer-portal',
    displayName: cleanText(snapshot.displayName, shapeTypeLabel(shapeType)),
    data: { ...contract.data, segments: contract.generic.segments, shapeType },
    calculated: {
      totalLengthMm: contract.calculated.unitLengthMm,
      weightKg: contract.calculated.unitWeightKg,
      bendCount: contract.calculated.bendCount,
    },
    machineOutput: { generic: contract.generic },
    validation: { valid: true, warnings: [], errors: [] },
  });
  return {
    shapeSnapshot,
    family: 'bars',
    shapeType,
    shapeId,
    diameter,
    sides,
    angles,
    segments: contract.generic.segments.map(segment => ({ length_mm: segment.lengthMm, angle_deg: segment.angle_deg })),
    totalLengthMm: contract.calculated.unitLengthMm,
    weightPerUnit: contract.calculated.unitWeightKg,
    shapeDimsText: buildDimsText(sides, angles),
  };
}

function buildSpiralSnapshot(snapshot, rawData = {}) {
  const shapeType = String(snapshot.shapeType || rawData.shapeType || 'spiral');
  const barDiameter = normalizeDiameter(rawData.barDiameter ?? rawData.barDiameterMm ?? rawData.diameter);
  const isRing = shapeType === 'ring' || rawData.ringDiameterMm != null || rawData.bendingDiameterMm != null;
  const contract = isRing
    ? buildRingShapeContract({
      barDiameterMm: barDiameter,
      bendingDiameterMm: rawData.bendingDiameterMm ?? rawData.ringDiameterMm ?? rawData.spiralDiameter,
      overlapMm: rawData.overlapMm ?? rawData.overlap ?? 0,
      quantity: 1,
    })
    : buildSpiralShapeContract({
      barDiameter,
      spiralDiameter: rawData.spiralDiameter ?? rawData.spiralDiameterMm,
      turns: rawData.turns,
      shapeType,
    });
  const snapshotType = isRing ? 'ring' : shapeType;
  const shapeId = canonicalShapeId(snapshot.shapeId, `portal-${snapshotType}-${crypto.randomUUID()}`);
  const shapeSnapshot = buildFullShapeSnapshot({
    shapeVersion: snapshot.shapeVersion,
    shapeId,
    shapeType: snapshotType,
    family: 'spirals',
    source: 'customer-portal',
    displayName: cleanText(snapshot.displayName, isRing ? 'טבעת' : 'ספירלה'),
    data: { ...contract.data, shapeType: snapshotType },
    calculated: { ...contract.calculated, totalLengthMm: contract.calculated.unitLengthMm ?? contract.calculated.totalLengthMm, weightKg: contract.calculated.unitWeightKg ?? contract.calculated.weightKg },
    machineOutput: { generic: contract.generic },
    validation: { valid: true, warnings: [], errors: [] },
  });
  const unitLengthMm = Number(contract.calculated.unitLengthMm ?? contract.calculated.totalLengthMm);
  const unitWeightKg = Number(contract.calculated.unitWeightKg ?? contract.calculated.weightKg);
  return {
    shapeSnapshot,
    family: 'spirals',
    shapeType: snapshotType,
    shapeId,
    diameter: barDiameter,
    sides: [],
    angles: [],
    segments: [],
    totalLengthMm: unitLengthMm,
    weightPerUnit: unitWeightKg,
    shapeDimsText: isRing
      ? `Ø${barDiameter} · טבעת Ø${Math.round(contract.data.ringDiameterMm)} · חפיפה ${Math.round(contract.data.overlapMm || 0)}`
      : `Ø${barDiameter} · ספירלה Ø${Math.round(contract.data.spiralDiameter)} · ${contract.data.turns} ליפופים`,
  };
}

function buildPileSnapshot(snapshot, rawData = {}) {
  const pile = calculatePileCage({
    ...rawData,
    shapeId: canonicalShapeId(snapshot.shapeId, `portal-pile-${crypto.randomUUID()}`),
    shapeVersion: snapshot.shapeVersion,
    roundPileCage: true,
  });
  if (!pile.validation?.valid) {
    throw portalDraftError('pile cage data is not valid', 'invalid_shape_snapshot');
  }
  const snapshotType = 'round_pile_cage';
  const shapeId = canonicalShapeId(snapshot.shapeId, `portal-pile-${crypto.randomUUID()}`);
  const shapeSnapshot = {
    ...pile,
    shapeId,
    source: 'customer-portal',
    displayName: cleanText(snapshot.displayName, 'כלוב כלונס עגול'),
  };
  const primaryDiameter = Number(pile.data?.longitudinalBars?.defaultDiameterMm ?? rawData.longitudinalDiameter ?? rawData.longitudinalDiameterMm);
  return {
    shapeSnapshot,
    family: 'piles',
    shapeType: snapshotType,
    shapeId,
    diameter: primaryDiameter,
    sides: [],
    angles: [],
    segments: [],
    totalLengthMm: Number(pile.calculated.totalLengthMm),
    weightPerUnit: Number(pile.calculated.weightKg),
    shapeDimsText: `כלוב Ø${Math.round(pile.data?.general?.pileDiameterMm || rawData.pileDiameter || 0)} · L ${Math.round(pile.data?.general?.pileLengthMm || rawData.pileLength || 0)}`,
  };
}

function normalizeShapeSnapshotDraft(input = {}) {
  const snapshot = readShapeSnapshot(input);
  if (!snapshot) return null;
  assertApprovedSnapshot(snapshot);
  const family = requireSupportedFamily(snapshot.family);
  const rawData = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const quantity = normalizeQuantity(input.quantity ?? input.qty ?? input.orderItemQuantity);
  const normalized = family === 'mesh'
    ? buildMeshSnapshot(snapshot, normalizeMeshData(rawData))
    : family === 'piles'
      ? buildPileSnapshot(snapshot, rawData)
      : family === 'spirals'
        ? buildSpiralSnapshot(snapshot, rawData)
        : buildBarsSnapshot(snapshot, rawData);
  // Every server-built snapshot describes one shape, never an order quantity.
  // Ring/pile engines may include total aliases for that single unit.
  for (const payload of [normalized.shapeSnapshot.data, normalized.shapeSnapshot.calculated, normalized.shapeSnapshot.machineOutput?.generic]) {
    if (!payload) continue;
    delete payload.quantity;
    delete payload.qty;
    if (Number(payload.weightKg) > 0) delete payload.totalWeightKg;
  }
  return { ...normalized, quantity, fromShapeSnapshot: true };
}

function validatePortalShapeDraft(input = {}, ctx = {}) {
  if (ctx && ctx.canCreateOrders === false) {
    throw portalDraftError('portal user cannot create orders', 'portal_order_create_forbidden', 403);
  }
  const snapshotDraft = normalizeShapeSnapshotDraft(input);
  if (snapshotDraft) return snapshotDraft;
  const { data } = draftInput(input);
  const geometry = normalizeDraftGeometry(input);
  const diameter = normalizeDiameter(input.diameter ?? data.diameter ?? data.diameterMm);
  const quantity = normalizeQuantity(input.quantity ?? input.qty);
  return { ...geometry, diameter, quantity };
}

function buildPortalShapeDraft(input = {}, ctx = {}) {
  const normalized = validatePortalShapeDraft(input, ctx);
  if (normalized.fromShapeSnapshot) {
    const elementName = cleanText(
      input.elementName ?? input.structElement ?? input.struct_element ?? readShapeSnapshot(input)?.structElement ?? input.shapeName ?? normalized.shapeSnapshot.displayName,
      normalized.shapeSnapshot.displayName || 'Shape',
    );
    const note = cleanText(input.note ?? input.noteForCustomer, '');
    const shapeName = cleanText(input.shapeName ?? normalized.shapeSnapshot.displayName ?? elementName, elementName);
    const totalWeight = normalized.weightPerUnit * normalized.quantity;
    const shapeSnapshot = {
      ...normalized.shapeSnapshot,
      displayName: shapeName,
      source: 'customer-portal',
    };
    return {
      ...normalized,
      elementName,
      note,
      shapeName,
      shapeSnapshot,
      shapeSnapshotJson: JSON.stringify(shapeSnapshot),
      segmentsJson: JSON.stringify(normalized.segments),
      totalWeight,
      shapePreview: buildPortalPreview(shapeName, normalized.shapeDimsText),
    };
  }
  const elementName = cleanText(input.elementName ?? input.structElement ?? input.struct_element ?? input.shapeName, shapeTypeLabel(normalized.shapeType));
  const note = cleanText(input.note ?? input.noteForCustomer, '');
  const totalLengthMm = normalized.sides.reduce((sum, length) => sum + length, 0);
  const weightPerUnit = (totalLengthMm / 1000) * rebarKgPerMeter(normalized.diameter);
  const totalWeight = weightPerUnit * normalized.quantity;
  const bendCount = normalized.angles.filter(angle => Number.isFinite(Number(angle)) && Math.abs(Number(angle) - 180) > 0.001).length;
  const segments = segmentsFromSides(normalized.sides, normalized.angles);
  const shapeId = cleanText(input.shapeId || `portal-${normalized.shapeType}-${crypto.createHash('sha1').update(JSON.stringify({ sides: normalized.sides, angles: normalized.angles, diameter: normalized.diameter })).digest('hex').slice(0, 10)}`);
  const displayName = cleanText(input.shapeName, shapeTypeLabel(normalized.shapeType));
  const snapshot = buildFullShapeSnapshot({
    shapeVersion: 1,
    shapeId,
    shapeType: normalized.shapeType,
    family: normalized.family,
    source: 'customer-portal',
    displayName,
    data: {
      diameter: normalized.diameter,
      sides: normalized.sides,
      angles: normalized.angles,
      segments,
      shapeType: normalized.shapeType,
    },
    calculated: {
      totalLengthMm,
      weightKg: weightPerUnit,
      bendCount,
    },
    machineOutput: {
      generic: {
        family: normalized.family,
        shapeType: normalized.shapeType,
        diameter: normalized.diameter,
        totalLengthMm,
        weightKg: weightPerUnit,
        bendCount,
        segments,
      },
    },
    validation: { valid: true, warnings: [], errors: [] },
  });
  if (!isShapeDataContractV2(snapshot)) {
    throw portalDraftError('shape snapshot is invalid', 'invalid_shape_snapshot');
  }
  return {
    ...normalized,
    elementName,
    note,
    shapeId,
    shapeName: displayName,
    shapeSnapshot: snapshot,
    shapeSnapshotJson: JSON.stringify(snapshot),
    segments,
    segmentsJson: JSON.stringify(segments),
    totalLengthMm,
    weightPerUnit,
    totalWeight,
    shapeDimsText: buildDimsText(normalized.sides, normalized.angles),
    shapePreview: buildShapePreview(normalized.shapeType, normalized.sides, normalized.angles),
  };
}

function portalShapeDraftToOrderItem(input = {}, ctx = {}) {
  const draft = buildPortalShapeDraft(input, ctx);
  return {
    shapeId: draft.shapeId,
    shapeName: draft.shapeName,
    elementName: draft.elementName,
    note: draft.note,
    diameter: draft.diameter,
    quantity: draft.quantity,
    segments: draft.segmentsJson,
    sides: draft.sides,
    angles: draft.angles,
    totalLengthMm: draft.totalLengthMm,
    weightPerUnit: draft.weightPerUnit,
    totalWeight: draft.totalWeight,
    shapeSnapshot: draft.shapeSnapshot,
    shapeSnapshotJson: draft.shapeSnapshotJson,
    shapeDimsText: draft.shapeDimsText,
    shapePreview: draft.shapePreview,
    publicItem: {
      itemNum: ctx.itemIndex || null,
      elementName: draft.elementName,
      shapeName: draft.shapeName,
      shapePreview: draft.shapePreview,
      shapeDimsText: draft.shapeDimsText,
      diameter: draft.diameter,
      quantity: draft.quantity,
      lengthM: +(draft.totalLengthMm / 1000).toFixed(3),
      totalLengthM: +((draft.totalLengthMm * draft.quantity) / 1000).toFixed(3),
      weightKg: +draft.totalWeight.toFixed(3),
      noteForCustomer: draft.note,
    },
  };
}

function parsePortalShapeSnapshot(value) {
  const snapshot = parseJsonObject(value);
  return isShapeDataContractV2(snapshot) ? snapshot : null;
}

module.exports = {
  buildPortalShapeDraft,
  validatePortalShapeDraft,
  portalShapeDraftToOrderItem,
  parsePortalShapeSnapshot,
};


