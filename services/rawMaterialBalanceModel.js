'use strict';

const RAW_MATERIAL_DIAGNOSTIC = Object.freeze({
  PROBABLE_DOUBLE_COUNT: 'probable_double_count',
  COUNTER_USAGE_MISMATCH: 'counter_usage_mismatch',
  OVER_RESERVED: 'over_reserved',
  NEGATIVE_OBSERVED_AVAILABLE: 'negative_observed_available',
  USAGE_WITHOUT_RESERVATION: 'usage_without_reservation',
  RELEASED_RESERVATION_WITH_USAGE: 'released_reservation_with_usage',
  CONSUMED_RESERVATION_WITHOUT_USAGE: 'consumed_reservation_without_usage',
  ORPHANED_USAGE: 'orphaned_usage',
  ORPHANED_RESERVATION: 'orphaned_reservation',
  ITEM_ORDER_MISMATCH: 'item_order_mismatch',
  AMBIGUOUS_HISTORICAL_CONSUMPTION: 'ambiguous_historical_consumption',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required',
  DUPLICATE_RESERVATION: 'duplicate_reservation',
  AMBIGUOUS_RESERVATION_ALLOCATION: 'ambiguous_reservation_allocation',
  UNKNOWN_RESERVATION_STATUS: 'unknown_reservation_status',
});

const DIAGNOSTIC_DEFINITION = Object.freeze({
  [RAW_MATERIAL_DIAGNOSTIC.PROBABLE_DOUBLE_COUNT]: ['warning', 'exact_demand_usage_and_active_reservation_overlap'],
  [RAW_MATERIAL_DIAGNOSTIC.COUNTER_USAGE_MISMATCH]: ['error', 'legacy_counter_differs_from_usage_rows'],
  [RAW_MATERIAL_DIAGNOSTIC.OVER_RESERVED]: ['error', 'active_reservation_exceeds_observed_on_hand'],
  [RAW_MATERIAL_DIAGNOSTIC.NEGATIVE_OBSERVED_AVAILABLE]: ['error', 'observed_available_is_negative'],
  [RAW_MATERIAL_DIAGNOSTIC.USAGE_WITHOUT_RESERVATION]: ['review', 'usage_has_no_related_reservation'],
  [RAW_MATERIAL_DIAGNOSTIC.RELEASED_RESERVATION_WITH_USAGE]: ['warning', 'released_reservation_retains_legacy_usage'],
  [RAW_MATERIAL_DIAGNOSTIC.CONSUMED_RESERVATION_WITHOUT_USAGE]: ['error', 'consumed_reservation_has_no_usage_row'],
  [RAW_MATERIAL_DIAGNOSTIC.ORPHANED_USAGE]: ['error', 'usage_reference_is_orphaned'],
  [RAW_MATERIAL_DIAGNOSTIC.ORPHANED_RESERVATION]: ['error', 'reservation_reference_is_orphaned'],
  [RAW_MATERIAL_DIAGNOSTIC.ITEM_ORDER_MISMATCH]: ['error', 'item_belongs_to_different_order'],
  [RAW_MATERIAL_DIAGNOSTIC.AMBIGUOUS_HISTORICAL_CONSUMPTION]: ['review', 'legacy_usage_is_not_confirmed_consumption'],
  [RAW_MATERIAL_DIAGNOSTIC.MANUAL_REVIEW_REQUIRED]: ['review', 'legacy_evidence_requires_manual_review'],
  [RAW_MATERIAL_DIAGNOSTIC.DUPLICATE_RESERVATION]: ['review', 'multiple_active_reservations_require_review'],
  [RAW_MATERIAL_DIAGNOSTIC.AMBIGUOUS_RESERVATION_ALLOCATION]: ['review', 'reservation_has_no_raw_material_lot_link'],
  [RAW_MATERIAL_DIAGNOSTIC.UNKNOWN_RESERVATION_STATUS]: ['review', 'reservation_status_is_unknown'],
});

const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, review: 2 });
const SCOPE_ORDER = Object.freeze({ lot: 0, bucket: 1, demand: 2, reference: 3 });
const OBSERVED_FIELDS = Object.freeze([
  'receivedKg',
  'legacyUsedCounterKg',
  'usageRowsKg',
  'scrappedCounterKg',
  'activeReservedKg',
  'consumedReservationKg',
  'releasedReservationKg',
]);

function roundKg(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeObservedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('raw_material_observed_input_required');
  }

  const normalized = {};
  for (const field of OBSERVED_FIELDS) {
    const value = input[field] === undefined || input[field] === null ? 0 : Number(input[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`invalid_raw_material_quantity:${field}`);
    }
    normalized[field] = roundKg(value);
  }
  return normalized;
}

function calculateObservedRawMaterialBalance(input) {
  const observed = normalizeObservedInput(input);
  const stockAdjustmentKg=Number(input.stockAdjustmentKg||0);
  if(!Number.isFinite(stockAdjustmentKg))throw new RangeError('invalid_raw_material_quantity:stockAdjustmentKg');
  if(stockAdjustmentKg)observed.stockAdjustmentKg=roundKg(stockAdjustmentKg);
  const counterPhysicalOnHand = roundKg(
    observed.receivedKg + stockAdjustmentKg - observed.legacyUsedCounterKg - observed.scrappedCounterKg
  );
  const usageRowPhysicalOnHand = roundKg(
    observed.receivedKg + stockAdjustmentKg - observed.usageRowsKg - observed.scrappedCounterKg
  );
  const reservationAwareAvailableFromCounter = roundKg(
    counterPhysicalOnHand - observed.activeReservedKg
  );
  const reservationAwareAvailableFromUsageRows = roundKg(
    usageRowPhysicalOnHand - observed.activeReservedKg
  );
  const counterUsageDeltaKg = roundKg(observed.legacyUsedCounterKg - observed.usageRowsKg);

  return {
    observed,
    counterPhysicalOnHand,
    usageRowPhysicalOnHand,
    reservationAwareAvailableFromCounter,
    reservationAwareAvailableFromUsageRows,
    discrepancies: counterUsageDeltaKg === 0 ? [] : [{
      code: RAW_MATERIAL_DIAGNOSTIC.COUNTER_USAGE_MISMATCH,
      counterUsageDeltaKg,
    }],
    futureAuthoritativeBalance: {
      status: 'review_required',
      physicalOnHand: null,
      available: null,
      formula: {
        physicalOnHand: 'approvedReceipts-confirmedConsumption-confirmedScrap',
        available: 'physicalOnHand-openReserved',
      },
      reason: 'confirmed_consumption_ledger_unavailable',
    },
  };
}

function diagnostic(code, scope, entity, evidence = {}) {
  const definition = DIAGNOSTIC_DEFINITION[code];
  if (!definition) throw new Error(`unknown_raw_material_diagnostic:${code}`);
  if (!Object.hasOwn(SCOPE_ORDER, scope)) throw new Error(`invalid_raw_material_diagnostic_scope:${scope}`);
  return {
    code,
    severity: definition[0],
    scope,
    entity: {
      rawMaterialId: entity.rawMaterialId ?? null,
      orderId: entity.orderId ?? null,
      itemId: entity.itemId ?? null,
      diameter: entity.diameter ?? null,
      materialType: entity.materialType ?? null,
    },
    evidence,
    explanationKey: definition[1],
  };
}

function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), 'en');
}

function compareDiagnostics(left, right) {
  return (SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    || left.code.localeCompare(right.code, 'en')
    || (SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope])
    || compareNullable(left.entity.rawMaterialId, right.entity.rawMaterialId)
    || compareNullable(left.entity.orderId, right.entity.orderId)
    || compareNullable(left.entity.itemId, right.entity.itemId)
    || compareNullable(left.entity.diameter, right.entity.diameter)
    || compareNullable(left.entity.materialType, right.entity.materialType)
    || JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence), 'en');
}

function classifyRawMaterialIntegrity(input = {}) {
  const balance = input.balance || calculateObservedRawMaterialBalance(input.observed || input);
  const observed = balance.observed;
  const scope = input.scope || 'demand';
  const entity = input.entity || {};
  const usageCount = Number(input.usageCount || 0);
  const usageIds = [...(input.usageIds || [])].sort((left, right) => left - right);
  const reservations = [...(input.reservations || [])].sort((left, right) => left.reservationId - right.reservationId);
  const bucketEvidence = {
    orderId: entity.orderId ?? null,
    itemId: entity.itemId ?? null,
    diameter: entity.diameter ?? null,
    materialType: entity.materialType ?? null,
    usageIds,
    reservationIds: reservations.map(row => row.reservationId),
    reservations,
  };
  const evidenceForStatuses = statuses => {
    const matchingReservations = reservations.filter(row => statuses.has(row.status));
    return {
      ...bucketEvidence,
      reservationIds: matchingReservations.map(row => row.reservationId),
      reservations: matchingReservations,
    };
  };
  const diagnostics = [];
  const add = (code, evidence, diagnosticScope = scope, diagnosticEntity = entity) => {
    diagnostics.push(diagnostic(code, diagnosticScope, diagnosticEntity, evidence));
  };

  if (scope !== 'demand' && scope !== 'reference' && balance.discrepancies.length) {
    add(RAW_MATERIAL_DIAGNOSTIC.COUNTER_USAGE_MISMATCH, {
      legacyUsedCounterKg: observed.legacyUsedCounterKg,
      usageRowsKg: observed.usageRowsKg,
      counterUsageDeltaKg: balance.discrepancies[0].counterUsageDeltaKg,
    });
  }
  if (scope === 'bucket' && observed.activeReservedKg > Math.min(balance.counterPhysicalOnHand, balance.usageRowPhysicalOnHand)) {
    add(RAW_MATERIAL_DIAGNOSTIC.OVER_RESERVED, {
      activeReservedKg: observed.activeReservedKg,
      counterPhysicalOnHand: balance.counterPhysicalOnHand,
      usageRowPhysicalOnHand: balance.usageRowPhysicalOnHand,
    });
  }
  if (scope === 'bucket' && (balance.reservationAwareAvailableFromCounter < 0 || balance.reservationAwareAvailableFromUsageRows < 0)) {
    add(RAW_MATERIAL_DIAGNOSTIC.NEGATIVE_OBSERVED_AVAILABLE, {
      reservationAwareAvailableFromCounter: balance.reservationAwareAvailableFromCounter,
      reservationAwareAvailableFromUsageRows: balance.reservationAwareAvailableFromUsageRows,
    });
  }

  for (const overlap of input.exactDemandOverlaps || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.PROBABLE_DOUBLE_COUNT, overlap, 'demand', {
      orderId: overlap.orderId,
      itemId: overlap.itemId,
      diameter: overlap.diameter,
      materialType: overlap.materialType,
    });
  }

  const totalReservationKg = roundKg(
    observed.activeReservedKg + observed.consumedReservationKg + observed.releasedReservationKg
  );
  if (scope === 'demand' && usageCount > 0 && totalReservationKg === 0) {
    add(RAW_MATERIAL_DIAGNOSTIC.USAGE_WITHOUT_RESERVATION, {
      ...bucketEvidence,
      usageCount,
      usageRowsKg: observed.usageRowsKg,
    });
  }
  if (scope === 'demand' && observed.releasedReservationKg > 0 && usageCount > 0) {
    add(RAW_MATERIAL_DIAGNOSTIC.RELEASED_RESERVATION_WITH_USAGE, {
      ...evidenceForStatuses(new Set(['released'])),
      releasedReservationKg: observed.releasedReservationKg,
      usageRowsKg: observed.usageRowsKg,
    });
  }
  if (scope === 'demand' && observed.consumedReservationKg > 0 && usageCount === 0) {
    add(RAW_MATERIAL_DIAGNOSTIC.CONSUMED_RESERVATION_WITHOUT_USAGE, {
      ...evidenceForStatuses(new Set(['consumed'])),
      consumedReservationKg: observed.consumedReservationKg,
    });
  }
  if (usageCount > 0 && input.emitHistoricalAmbiguity !== false) {
    add(RAW_MATERIAL_DIAGNOSTIC.AMBIGUOUS_HISTORICAL_CONSUMPTION, {
      usageCount,
      usageIds,
      usageRowsKg: observed.usageRowsKg,
      supportingProductionEvidence: input.supportingProductionEvidence || null,
    });
  }

  for (const group of input.duplicateReservationGroups || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.DUPLICATE_RESERVATION, group, 'demand', {
      orderId: group.orderId,
      itemId: group.itemId,
      diameter: group.diameter,
      materialType: group.materialType,
    });
  }
  for (const unknown of input.unknownReservations || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.UNKNOWN_RESERVATION_STATUS, unknown, 'reference', {
      orderId: unknown.orderId,
      itemId: unknown.itemId,
      diameter: unknown.diameter,
      materialType: unknown.materialType,
    });
  }
  for (const orphan of input.orphanedUsages || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.ORPHANED_USAGE, orphan, 'reference', {
      rawMaterialId: orphan.rawMaterialId,
      orderId: orphan.orderId,
      itemId: orphan.itemId,
    });
  }
  for (const orphan of input.orphanedReservations || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.ORPHANED_RESERVATION, orphan, 'reference', {
      orderId: orphan.orderId,
      itemId: orphan.itemId,
      diameter: orphan.diameter,
      materialType: orphan.materialType,
    });
  }
  for (const mismatch of input.itemOrderMismatches || []) {
    add(RAW_MATERIAL_DIAGNOSTIC.ITEM_ORDER_MISMATCH, mismatch, 'reference', {
      rawMaterialId: mismatch.rawMaterialId,
      orderId: mismatch.referencedOrderId,
      itemId: mismatch.itemId,
      diameter: mismatch.diameter,
      materialType: mismatch.materialType,
    });
  }
  if (input.ambiguousReservationAllocation) {
    add(RAW_MATERIAL_DIAGNOSTIC.AMBIGUOUS_RESERVATION_ALLOCATION, input.ambiguousReservationAllocation, 'bucket');
  }

  const reviewCodes = new Set([
    RAW_MATERIAL_DIAGNOSTIC.PROBABLE_DOUBLE_COUNT,
    RAW_MATERIAL_DIAGNOSTIC.COUNTER_USAGE_MISMATCH,
    RAW_MATERIAL_DIAGNOSTIC.RELEASED_RESERVATION_WITH_USAGE,
    RAW_MATERIAL_DIAGNOSTIC.AMBIGUOUS_HISTORICAL_CONSUMPTION,
    RAW_MATERIAL_DIAGNOSTIC.ORPHANED_USAGE,
    RAW_MATERIAL_DIAGNOSTIC.ORPHANED_RESERVATION,
    RAW_MATERIAL_DIAGNOSTIC.ITEM_ORDER_MISMATCH,
    RAW_MATERIAL_DIAGNOSTIC.DUPLICATE_RESERVATION,
    RAW_MATERIAL_DIAGNOSTIC.UNKNOWN_RESERVATION_STATUS,
  ]);
  const diagnosticCodes = [...new Set(diagnostics.filter(row => reviewCodes.has(row.code)).map(row => row.code))].sort();
  if (diagnosticCodes.length) add(RAW_MATERIAL_DIAGNOSTIC.MANUAL_REVIEW_REQUIRED, { diagnosticCodes });

  return diagnostics.sort(compareDiagnostics);
}

module.exports = {
  RAW_MATERIAL_DIAGNOSTIC,
  calculateObservedRawMaterialBalance,
  classifyRawMaterialIntegrity,
  compareDiagnostics,
};
