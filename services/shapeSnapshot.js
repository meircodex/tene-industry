'use strict';

(function initShapeSnapshot(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IronBendShapeSnapshot = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function shapeSnapshotFactory() {
  const CONTRACT_VERSION = 2;
  const MACHINE_PROFILE_NAMES = Object.freeze(['MEP', 'PEDAX', 'SCHNELL']);
  const SHAPE_V2_REQUIRED_FIELDS = Object.freeze([
    'contractVersion',
    'shapeVersion',
    'shapeId',
    'shapeType',
    'family',
    'data',
    'calculated',
    'machineOutput',
    'validation',
  ]);

  function parseJsonObject(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function positiveNumberOrNull(value) {
    const numeric = numberOrNull(value);
    return numeric !== null && numeric > 0 ? numeric : null;
  }

  function buildMachineProfilePlaceholder(status = 'not_implemented') {
    return { status, profileVersion: null, payload: null };
  }

  function buildMachineProfilesPlaceholder(names = MACHINE_PROFILE_NAMES) {
    return names.reduce((profiles, name) => {
      profiles[name] = buildMachineProfilePlaceholder();
      return profiles;
    }, {});
  }

  function normalizeShapeFamily(value) {
    return ['bars', 'mesh', 'piles', 'spirals', 'lifts'].includes(value) ? value : 'bars';
  }

  function normalizeValidation(validation = {}, timestamp = new Date().toISOString()) {
    const errors = Array.isArray(validation.errors) ? [...validation.errors] : [];
    const warnings = Array.isArray(validation.warnings) ? [...validation.warnings] : [];
    const hasValid = Object.prototype.hasOwnProperty.call(validation, 'valid');
    const hasOk = Object.prototype.hasOwnProperty.call(validation, 'ok');
    const valid = hasValid ? Boolean(validation.valid) : hasOk ? Boolean(validation.ok) : errors.length === 0;
    return { ...validation, valid, errors, warnings, timestamp: validation.timestamp || timestamp };
  }

  function buildFullShapeSnapshot(options = {}) {
    const approvedAt = options.approvedAt || new Date().toISOString();
    const family = normalizeShapeFamily(options.family);
    const shapeType = String(options.shapeType || (family === 'mesh' ? 'mesh_rectangular' : family === 'piles' ? 'round_pile_cage' : family === 'spirals' ? 'spiral' : family === 'lifts' ? 'lift_package' : 'custom_bar'));
    const generic = { ...(options.machineOutput?.generic || options.generic || {}), family, shapeType };
    const machineProfiles = options.machineOutput?.machineProfiles || options.machineProfiles || buildMachineProfilesPlaceholder();
    const extra = options.extra && typeof options.extra === 'object' ? options.extra : {};
    return {
      contractVersion: CONTRACT_VERSION,
      shapeVersion: Math.max(1, Math.round(Number(options.shapeVersion || 1) || 1)),
      shapeId: String(options.shapeId || ''),
      shapeType,
      family,
      source: String(options.source || 'unknown'),
      approvedAt,
      displayName: options.displayName ? String(options.displayName) : '',
      data: { ...(options.data || {}) },
      calculated: { ...(options.calculated || {}) },
      machineOutput: { generic, machineProfiles },
      validation: normalizeValidation(options.validation, approvedAt),
      ...extra,
    };
  }

  function isShapeDataContractV2(value) {
    const snapshot = parseJsonObject(value);
    if (!snapshot) return false;
    if (Number(snapshot.contractVersion) !== CONTRACT_VERSION) return false;
    return SHAPE_V2_REQUIRED_FIELDS.every(field => Object.prototype.hasOwnProperty.call(snapshot, field));
  }

  function shapeDataContractV2Json(value) {
    if (typeof value === 'string' && isShapeDataContractV2(value)) return value;
    const snapshot = parseJsonObject(value);
    return isShapeDataContractV2(snapshot) ? JSON.stringify(snapshot) : null;
  }

  function shapeSnapshotMetrics(value) {
    const snapshot = parseJsonObject(value);
    if (!isShapeDataContractV2(snapshot)) return null;
    const calculated = snapshot.calculated || {};
    const generic = snapshot.machineOutput?.generic || {};
    const data = snapshot.data || {};
    return {
      totalLengthMm: positiveNumberOrNull(
        calculated.totalLengthMm
          ?? calculated.totalSteelLengthMm
          ?? calculated.lengthMm
          ?? generic.totalLengthMm
          ?? generic.totalSteelLengthMm
          ?? generic.lengthMm
          ?? data.totalLengthMm
          ?? data.lengthMm
      ),
      // Unit and total weights are kept separate: engines and editors write
      // weightKg/unitWeightKg per bar, while intake and the order screen write
      // totalWeightKg for the whole quantity. Mixing them multiplies totals by
      // quantity twice (inflated delivery certificates and pricing).
      weightKg: positiveNumberOrNull(
        calculated.weightKg
          ?? calculated.unitWeightKg
          ?? generic.weightKg
          ?? generic.unitWeightKg
          ?? data.weightKg
      ),
      totalWeightKg: positiveNumberOrNull(
        calculated.totalWeightKg
          ?? generic.totalWeightKg
          ?? data.totalWeightKg
      ),
    };
  }

  function itemQuantity(item = {}) {
    return Math.max(1, Number(item.quantity ?? item.qty ?? item.production_qty ?? 1) || 1);
  }

  function itemShapeMetrics(item = {}) {
    const snapshot = item.shapeSnapshot
      ?? item.shape_snapshot
      ?? item.shapeData
      ?? item.shape_data
      ?? item.shapeContract
      ?? item.shape_contract
      ?? item.shape_snapshot_json
      ?? null;
    const metrics = shapeSnapshotMetrics(snapshot) || {};
    const quantity = itemQuantity(item);
    const totalLengthMm = metrics.totalLengthMm ?? positiveNumberOrNull(item.totalLengthMm ?? item.total_length_mm ?? item.length_mm ?? item.length);
    const snapUnit = metrics.weightKg ?? null;
    const snapTotal = metrics.totalWeightKg ?? null;
    if(parseJsonObject(snapshot)?.family==='mesh'&&snapUnit!==null)return {totalLengthMm,unitWeightKg:snapUnit,totalWeightKg:Number((snapUnit*quantity).toFixed(3)),quantity};
    const dbUnit = positiveNumberOrNull(item.weightPerUnit ?? item.weight_per_unit);
    let unitWeightKg = snapUnit ?? dbUnit ?? (snapTotal !== null ? snapTotal / quantity : null);
    let totalWeightKg;
    if (snapUnit !== null && snapTotal !== null && quantity > 1 && Math.abs(snapUnit - snapTotal) < 0.0005) {
      // Some editor snapshots mirror the same number into both fields; the
      // value is a total — never multiply it by quantity again.
      totalWeightKg = snapTotal;
      unitWeightKg = dbUnit ?? snapTotal / quantity;
    } else if (snapUnit !== null) {
      totalWeightKg = snapUnit * quantity;
    } else if (snapTotal !== null) {
      totalWeightKg = snapTotal;
    } else if (dbUnit !== null) {
      totalWeightKg = dbUnit * quantity;
    } else {
      totalWeightKg = positiveNumberOrNull(item.totalWeight ?? item.total_weight);
    }
    return { totalLengthMm, unitWeightKg, totalWeightKg, quantity };
  }

  return {
    CONTRACT_VERSION,
    MACHINE_PROFILE_NAMES,
    SHAPE_V2_REQUIRED_FIELDS,
    parseJsonObject,
    numberOrNull,
    positiveNumberOrNull,
    buildMachineProfilePlaceholder,
    buildMachineProfilesPlaceholder,
    normalizeShapeFamily,
    normalizeValidation,
    buildFullShapeSnapshot,
    isShapeDataContractV2,
    shapeDataContractV2Json,
    shapeSnapshotMetrics,
    itemQuantity,
    itemShapeMetrics,
  };
});
