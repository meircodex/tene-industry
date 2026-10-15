'use strict';

const crypto = require('crypto');
const { rebarKgPerMeter } = require('../constants');
const {
  ORDER_STATUS,
  normalizeOrderStatus,
  isValidOrderStatus,
  isValidOrderTransition,
  allowedOrderTransitions,
} = require('../status-contracts');
const {
  SHAPE_V2_REQUIRED_FIELDS,
  parseJsonObject,
  isShapeDataContractV2,
  shapeDataContractV2Json,
} = require('./shapeSnapshot');

const ORDER_CONTRACT = Object.freeze({
  version: 1,
  identity: Object.freeze(['id', 'order_num', 'stable_order_id']),
  approvalRoles: Object.freeze(['manager', 'admin']),
  statusField: 'status',
});

const ORDER_ITEM_CONTRACT = Object.freeze({
  version: 1,
  identity: Object.freeze(['id', 'item_uid']),
  quantityField: 'quantity',
  shapeSnapshotField: 'shape_snapshot_json',
});


function createStableOrderId(orderNum) {
  const value = String(orderNum || '').trim();
  if (!value) throw Object.assign(new Error('order_num is required for stable order identity'), { statusCode: 400 });
  return value;
}

function buildOrderItemUid(orderId, itemId) {
  return 'order-' + Number(orderId) + ':item-' + Number(itemId);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function parseSegments(value) {
  const parsed = parseJsonArray(value);
  return parsed.map(segment => {
    if (typeof segment === 'number') return { length_mm: numberOrNull(segment), angle_deg: 0 };
    return {
      ...segment,
      length_mm: numberOrNull(segment.length_mm ?? segment.lengthMm ?? segment.length),
      angle_deg: numberOrNull(segment.angle_deg ?? segment.angleDeg ?? segment.angle) ?? 0,
    };
  });
}

function isSpiralInput(input = {}) {
  const shapeName = String(input.shapeType || input.shapeName || input.shape_name || '').toLowerCase();
  return shapeName.includes('spiral') || shapeName.includes('\u05e1\u05e4\u05d9\u05e8\u05dc') || Boolean(input.spiral || input.spiralDiameterMm || input.spiral_diameter_mm || input.spiralTurns || input.spiral_turns);
}

function buildFullShapeSnapshot(input = {}) {
  const now = new Date().toISOString();
  const totalLengthMm = Number(firstDefined(input.totalLengthMm, input.total_length_mm, input.length, 0));
  const diameter = Number(firstDefined(input.diameter, input.diameterMm, input.barDiameter, input.barDiameterMm, 12));
  const segments = parseSegments(firstDefined(input.segments, input.sides, []));
  const weightKg = Number(firstDefined(
    input.weightKg,
    input.weight_kg,
    input.total_weight,
    input.totalWeight,
    Number.isFinite(diameter) && Number.isFinite(totalLengthMm) ? rebarKgPerMeter(diameter) * (totalLengthMm / 1000) : 0
  ));
  const spiral = input.spiral || (
    isSpiralInput(input)
      ? {
          diameterMm: numberOrNull(input.spiralDiameterMm ?? input.spiral_diameter_mm),
          turns: numberOrNull(input.spiralTurns ?? input.spiral_turns ?? input.turns),
        }
      : null
  );

  return {
    contract: 'SHAPE_DATA_CONTRACT_V2',
    contractVersion: '2.0',
    shapeVersion: '1.0',
    shapeId: input.shapeId || input.shape_id || crypto.randomUUID(),
    shapeType: input.shapeType || (isSpiralInput(input) ? 'spiral' : 'custom'),
    family: input.family || (isSpiralInput(input) ? 'spirals' : 'rebar'),
    source: input.source || 'shape-editor',
    approvedAt: input.approvedAt || now,
    displayName: input.displayName || input.shapeName || input.shape_name || 'shape',
    shapeName: input.shapeName || input.shape_name || input.displayName || 'shape',

    data: {
      segments,
      diameter,
      is3d: !!(input.is3d ?? input.is_3d),
      spiral,
    },

    calculated: {
      totalLengthMm: Number.isFinite(totalLengthMm) ? totalLengthMm : 0,
      weightKg: Number.isFinite(weightKg) ? weightKg : 0,
    },

    machineOutput: {
      generic: {
        bends: [],
        lengthMm: Number.isFinite(totalLengthMm) ? totalLengthMm : 0,
      },
      machineProfiles: {
        MEP: {},
        PEDAX: {},
        SCHNELL: {},
      },
    },

    validation: {
      valid: true,
      messages: [],
      timestamp: now,
    },
  };
}

function shapeV2SnapshotCandidate(item = {}) {
  return item.shapeSnapshot
    ?? item.shape_snapshot
    ?? item.shapeData
    ?? item.shape_data
    ?? item.shapeContract
    ?? item.shape_contract
    ?? item.shape_snapshot_json
    ?? null;
}

function shapeDataContractV2FromItem(item = {}) {
  const candidate = shapeV2SnapshotCandidate(item);
  if (!isShapeDataContractV2(candidate)) return null;
  return parseJsonObject(candidate);
}

function shapeSegmentsFromContract(snapshot) {
  const genericSegments = snapshot?.machineOutput?.generic?.segments;
  if (Array.isArray(genericSegments) && genericSegments.length) {
    return genericSegments.map(segment => ({
      length_mm: numberOrNull(segment.lengthMm ?? segment.length_mm ?? segment.length),
      angle_deg: numberOrNull(segment.bendAfterDeg ?? segment.angle_deg ?? segment.angle) ?? 0,
    }));
  }
  const dataSegments = Array.isArray(snapshot?.data?.segments) ? snapshot.data.segments : [];
  if (dataSegments.length) {
    return dataSegments.map(segment => ({
      length_mm: numberOrNull(segment.length_mm ?? segment.lengthMm ?? segment.length),
      angle_deg: numberOrNull(segment.angle_deg ?? segment.angleDeg ?? segment.angle) ?? 0,
    }));
  }
  const sides = Array.isArray(snapshot?.data?.sides) ? snapshot.data.sides : [];
  const angles = Array.isArray(snapshot?.data?.angles) ? snapshot.data.angles : [];
  return sides.map((length, index) => ({
    length_mm: numberOrNull(length),
    angle_deg: numberOrNull(angles[index]) ?? 0,
  }));
}

function legacyShapeFieldsFromContract(snapshot) {
  if (!isShapeDataContractV2(snapshot)) return {};
  const segments = shapeSegmentsFromContract(snapshot).filter(segment => Number.isFinite(segment.length_mm) && segment.length_mm > 0);
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput?.generic || {};
  const diameter = data.diameter ?? data.diameterMm ?? generic.diameter ?? generic.diameterMm ?? data.barDiameter ?? data.barDiameterMm ?? generic.barDiameter ?? generic.barDiameterMm ?? data.longitudinalDiameter ?? data.longitudinalDiameterMm ?? null;
  const totalLengthMm = numberOrNull(snapshot.calculated?.totalLengthMm ?? generic.totalLengthMm ?? generic.lengthMm);
  const spiralDiameterMm = numberOrNull(
    data.spiral?.diameterMm
      ?? data.spiral?.diameter
      ?? data.spiralDiameterMm
      ?? data.spiral_diameter_mm
      ?? data.spiralDiameter
      ?? generic.spiralDiameterMm
      ?? generic.spiral_diameter_mm
      ?? generic.spiralDiameter
  );
  const spiralTurns = numberOrNull(
    data.spiral?.turns
      ?? data.spiralTurns
      ?? data.spiral_turns
      ?? data.turns
      ?? generic.spiralTurns
      ?? generic.spiral_turns
      ?? generic.turns
  );
  const isSpiral = snapshot.family === 'spirals' || snapshot.shapeType === 'spiral' || (spiralDiameterMm > 0 && spiralTurns > 0);
  return {
    shapeId: snapshot.shapeId,
    shapeName: isSpiral ? 'spiral' : (snapshot.displayName || snapshot.shapeType || snapshot.shapeId),
    shape_name: isSpiral ? 'spiral' : (snapshot.displayName || snapshot.shapeType || snapshot.shapeId),
    diameter: numberOrNull(diameter),
    segments: isSpiral ? [] : segments,
    sides: isSpiral ? [] : segments.map(segment => segment.length_mm),
    angles: isSpiral ? [] : segments.map(segment => segment.angle_deg),
    totalLengthMm,
    total_length_mm: totalLengthMm,
    spiralDiameterMm,
    spiral_diameter_mm: spiralDiameterMm,
    spiralTurns,
    spiral_turns: spiralTurns,
  };
}

function withShapeContractLegacyFields(item = {}) {
  const snapshot = shapeDataContractV2FromItem(item);
  if (!snapshot) return item;
  const legacy = legacyShapeFieldsFromContract(snapshot);
  return {
    ...item,
    shapeId: item.shapeId ?? item.shape_id ?? legacy.shapeId,
    shapeName: item.shapeName ?? item.shape_name ?? legacy.shapeName,
    shape_name: item.shape_name ?? item.shapeName ?? legacy.shape_name,
    diameter: item.diameter ?? legacy.diameter,
    segments: item.segments ?? legacy.segments,
    sides: item.sides ?? legacy.sides,
    angles: item.angles ?? legacy.angles,
    totalLengthMm: item.totalLengthMm ?? item.total_length_mm ?? legacy.totalLengthMm,
    total_length_mm: item.total_length_mm ?? item.totalLengthMm ?? legacy.total_length_mm,
    spiralDiameterMm: item.spiralDiameterMm ?? item.spiral_diameter_mm ?? legacy.spiralDiameterMm,
    spiral_diameter_mm: item.spiral_diameter_mm ?? item.spiralDiameterMm ?? legacy.spiral_diameter_mm,
    spiralTurns: item.spiralTurns ?? item.spiral_turns ?? legacy.spiralTurns,
    spiral_turns: item.spiral_turns ?? item.spiralTurns ?? legacy.spiral_turns,
  };
}

function buildShapeSnapshot(item = {}) {
  const snapshot = {
    contract: 'ORDER_ITEM_SHAPE_SNAPSHOT',
    version: ORDER_ITEM_CONTRACT.version,
    shapeId: item.shapeId ?? item.shape_id ?? null,
    shapeName: item.shapeName ?? item.shape_name ?? null,
    diameter: numberOrNull(item.diameter),
    totalLengthMm: numberOrNull(item.totalLengthMm ?? item.total_length_mm),
    spiralDiameterMm: numberOrNull(item.spiralDiameterMm ?? item.spiral_diameter_mm),
    spiralTurns: numberOrNull(item.spiralTurns ?? item.spiral_turns),
    is3d: Boolean(item.is3d ?? item.is_3d),
    segments: parseJsonArray(item.segments).map(segment => ({
      length_mm: numberOrNull(segment.length_mm ?? segment.length),
      angle_deg: numberOrNull(segment.angle_deg ?? segment.angle),
    })),
  };
  return Object.freeze(snapshot);
}

function shapeSnapshotJson(item = {}) {
  const candidate = shapeV2SnapshotCandidate(item);
  const contractJson = shapeDataContractV2Json(candidate);
  if (contractJson) return contractJson;
  return JSON.stringify(buildFullShapeSnapshot(item));
}

function canManagerApproveOrder(role) {
  return ORDER_CONTRACT.approvalRoles.includes(String(role || ''));
}

function isOrderApprovalTransition(from, to) {
  const normalizedFrom = normalizeOrderStatus(from);
  const normalizedTo = normalizeOrderStatus(to);
  return normalizedTo === ORDER_STATUS.APPROVED_WAITING_PRODUCTION && (
    normalizedFrom === ORDER_STATUS.PENDING_APPROVAL ||
    normalizedFrom === ORDER_STATUS.CUSTOMER_PENDING_APPROVAL
  );
}

function assertOrderStatusTransition({ from, to, role, allowSkip = false }) {
  const normalizedFrom = normalizeOrderStatus(from);
  const normalizedTo = normalizeOrderStatus(to);
  if (!isValidOrderStatus(normalizedTo)) {
    throw Object.assign(new Error('invalid order status'), { statusCode: 400, allowed: Object.values(ORDER_STATUS) });
  }
  if (!isValidOrderTransition(normalizedFrom, normalizedTo, { allowSkip })) {
    throw Object.assign(new Error('invalid order status transition'), {
      statusCode: 409,
      from: normalizedFrom,
      to: normalizedTo,
      allowed: allowedOrderTransitions(normalizedFrom, { allowSkip }),
    });
  }
  // A manual skip out of an approval stage must record the same approval as
  // the regular path; jumping directly to production cannot bypass it.
  const isApproval = isOrderApprovalTransition(normalizedFrom, normalizedTo) ||
    (allowSkip && normalizedTo === ORDER_STATUS.APPROVED_WAITING_PRODUCTION) || (allowSkip &&
    [ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.CUSTOMER_PENDING_APPROVAL].includes(normalizedFrom) &&
    ![ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.CUSTOMER_PENDING_APPROVAL, ORDER_STATUS.CANCELLED].includes(normalizedTo));
  if (isApproval && !canManagerApproveOrder(role)) {
    throw Object.assign(new Error('manager approval required'), { statusCode: 403 });
  }
  if (normalizedTo === ORDER_STATUS.LOADING && !['manager', 'admin'].includes(String(role || ''))) {
    throw Object.assign(new Error('manager or admin loading status required'), { statusCode: 403 });
  }
  return { from: normalizedFrom, to: normalizedTo, isApproval };
}

module.exports = {
  ORDER_CONTRACT,
  ORDER_ITEM_CONTRACT,
  SHAPE_V2_REQUIRED_FIELDS,
  createStableOrderId,
  buildOrderItemUid,
  buildFullShapeSnapshot,
  buildShapeSnapshot,
  isShapeDataContractV2,
  legacyShapeFieldsFromContract,
  withShapeContractLegacyFields,
  shapeSnapshotJson,
  canManagerApproveOrder,
  isOrderApprovalTransition,
  assertOrderStatusTransition,
};
