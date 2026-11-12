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
    const quantity = Number(item.quantity ?? item.qty ?? item.production_qty ?? 1);
    return Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
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
    const shape = parseJsonObject(snapshot);
    const metrics = shapeSnapshotMetrics(snapshot) || {};
    const quantity = itemQuantity(item);
    const totalLengthMm = metrics.totalLengthMm ?? positiveNumberOrNull(item.totalLengthMm ?? item.total_length_mm ?? item.length_mm ?? item.length);
    const calculated = shape?.calculated || {};
    const snapUnit = positiveNumberOrNull(calculated.unitWeightKg) ?? metrics.weightKg ?? null;
    const snapTotal = metrics.totalWeightKg ?? null;
    const dbUnit = positiveNumberOrNull(item.weightPerUnit ?? item.weight_per_unit);
    const dbTotal = positiveNumberOrNull(item.totalWeight ?? item.total_weight);
    const actual = positiveNumberOrNull(item.actual_weight_kg ?? item.actualWeightKg);
    const result = (unit, total, source, requiresReview = false) => ({totalLengthMm,unitWeightKg:unit,totalWeightKg:quantity === 0 ? 0 : total,quantity,weightSource:source,requiresWeightReview:requiresReview});
    if (actual !== null) return result(quantity ? actual / quantity : null, actual, 'actual');
    // A weighed lift package is a line weight, regardless of package count.
    const measuredLine = positiveNumberOrNull(calculated.weighedKg ?? shape?.data?.weighedKg);
    if (isShapeDataContractV2(shape) && shape.family === 'lifts' && measuredLine !== null) return result(quantity ? measuredLine / quantity : null, measuredLine, 'measured_line');
    if (calculated.weightBasis === 'line') {
      const total = snapTotal ?? metrics.weightKg ?? dbTotal;
      return result(quantity && total !== null ? total / quantity : null, total, 'snapshot_line');
    }
    // Saved high precision unit/total pairs are authoritative over rounded
    // editor mirrors. In particular, 45 x 13.2145 is 594.6525, not 13.215.
    if (dbUnit !== null && dbTotal !== null && Math.abs(dbUnit * quantity - dbTotal) <= 0.001) return result(dbUnit, dbTotal, 'saved_unit_total');
    if (shape?.family === 'mesh' || calculated.weightBasis === 'unit' || positiveNumberOrNull(calculated.unitWeightKg) !== null) {
      const unit = dbUnit ?? snapUnit;
      if (unit !== null) return result(unit, unit * quantity, 'explicit_unit');
    }
    if (dbUnit !== null && snapUnit === null) return result(dbUnit, dbUnit * quantity, 'saved_unit_total');
    if (dbTotal !== null && (snapUnit === null || (snapTotal !== null && Math.abs(snapUnit-snapTotal)<0.0005))) return result(dbUnit ?? (quantity ? dbTotal / quantity : null), dbTotal, 'saved_total');
    let unitWeightKg = snapUnit ?? dbUnit ?? (snapTotal !== null ? snapTotal / quantity : null);
    let totalWeightKg;
    if (snapUnit !== null && snapTotal !== null && quantity > 1 && Math.abs(snapUnit - snapTotal) < 0.0005) {
      // Legacy mirrors without an explicit basis cannot be disambiguated.
      // Preserve their total and surface the ambiguity instead of guessing.
      totalWeightKg = snapTotal;
      unitWeightKg = dbUnit ?? snapTotal / quantity;
    } else if (snapUnit !== null) {
      totalWeightKg = snapUnit * quantity;
    } else if (snapTotal !== null) {
      totalWeightKg = snapTotal;
    } else if (dbUnit !== null) {
      totalWeightKg = dbUnit * quantity;
    } else {
      totalWeightKg = dbTotal;
    }
    return result(unitWeightKg, totalWeightKg, 'legacy_snapshot', snapUnit !== null && snapTotal !== null && quantity > 1 && Math.abs(snapUnit - snapTotal) < 0.0005);
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
