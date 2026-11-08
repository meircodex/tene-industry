'use strict';

const {
  RAW_MATERIAL_DIAGNOSTIC,
  calculateObservedRawMaterialBalance,
  classifyRawMaterialIntegrity,
  compareDiagnostics,
} = require('./rawMaterialBalanceModel');

const RECOGNIZED_RESERVATION_STATUSES = new Set(['active', 'consumed', 'released']);
const SUPPORTING_PRODUCTION_STATUSES = new Set(['בייצור', 'הושלם', 'in_production', 'done', 'completed']);
const INVALID_PHYSICAL_BUCKET_IDENTITY = 'invalid_physical_bucket_identity';

function roundKg(value) {
  return Number(Number(value || 0).toFixed(3));
}

function parseDiameter(value) {
  if (value === null || value === undefined) return { valid: false, value: null, reason: 'missing_diameter' };
  const inputType = typeof value;
  if (inputType !== 'number' && inputType !== 'string') {
    return { valid: false, value: null, reason: 'non_numeric_diameter' };
  }
  if (inputType === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { valid: false, value: null, reason: 'empty_diameter' };
    value = trimmed;
  }
  const diameter = Number(value);
  if (Number.isNaN(diameter)) return { valid: false, value: null, reason: 'non_numeric_diameter' };
  if (!Number.isFinite(diameter)) return { valid: false, value: null, reason: 'non_finite_diameter' };
  if (diameter <= 0) return { valid: false, value: null, reason: 'non_positive_diameter' };
  return { valid: true, value: diameter, reason: null };
}

function normalizeDiameter(value) {
  return parseDiameter(value).value;
}

function normalizeMaterialType(value, nullDefault = null) {
  if (value === null || value === undefined) return nullDefault;
  return String(value).trim().toLowerCase();
}

function keyPart(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

function demandKey(orderId, itemId) {
  return `${keyPart(orderId)}|${keyPart(itemId)}`;
}

function physicalBucketKey(diameter, materialType) {
  return `${keyPart(normalizeDiameter(diameter))}|${keyPart(normalizeMaterialType(materialType))}`;
}

function compareIds(left, right) {
  return (Number(left.rawMaterialId || 0) - Number(right.rawMaterialId || 0))
    || (Number(left.orderId || 0) - Number(right.orderId || 0))
    || (Number(left.itemId || 0) - Number(right.itemId || 0))
    || (Number(left.usageId || 0) - Number(right.usageId || 0))
    || (Number(left.reservationId || 0) - Number(right.reservationId || 0))
    || String(left.type || '').localeCompare(String(right.type || ''), 'en');
}

function supportingProductionEvidence(row, usageId) {
  const status = row?.item_status ?? null;
  const normalizedStatus = String(status || '').trim().toLowerCase();
  return {
    usageId,
    producedQty: row?.produced_qty === null || row?.produced_qty === undefined ? null : Number(row.produced_qty),
    status,
    startedAt: row?.started_at ?? null,
    completedAt: row?.completed_at ?? null,
    recognizedStatus: SUPPORTING_PRODUCTION_STATUSES.has(normalizedStatus),
  };
}

function comparePhysicalBuckets(left, right) {
  const leftDiameter = normalizeDiameter(left.diameter);
  const rightDiameter = normalizeDiameter(right.diameter);
  const numericDiameterOrder = Number(leftDiameter) - Number(rightDiameter);
  return (Number.isNaN(numericDiameterOrder) ? 0 : numericDiameterOrder)
    || keyPart(leftDiameter).localeCompare(keyPart(rightDiameter), 'en')
    || keyPart(left.materialType).localeCompare(keyPart(right.materialType), 'en');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

function diagnosticKey(row) {
  return JSON.stringify(canonicalValue({
    code: row.code,
    scope: row.scope,
    entity: row.entity,
    evidence: row.evidence,
  }));
}

function deduplicateDiagnostics(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = diagnosticKey(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort(compareDiagnostics);
}

function deduplicateSupportingEvidence(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = JSON.stringify(canonicalValue(row));
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => left.usageId - right.usageId
    || JSON.stringify(canonicalValue(left)).localeCompare(JSON.stringify(canonicalValue(right)), 'en'));
}

function describeRawDiameter(value) {
  if (Buffer.isBuffer(value)) {
    return {
      rawDiameterType: 'blob',
      rawDiameterByteLength: value.length,
      rawDiameterHex: value.toString('hex'),
    };
  }
  const inputType = typeof value;
  if (value === null || value === undefined || inputType === 'number' || inputType === 'string') {
    return { rawDiameter: value ?? null };
  }
  if (value instanceof Uint8Array) {
    return {
      rawDiameterType: 'uint8array',
      rawDiameterByteLength: value.byteLength,
      rawDiameterHex: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex'),
    };
  }
  if (Array.isArray(value)) return { rawDiameterType: 'array' };
  if (value instanceof Number) return { rawDiameterType: 'boxed_number' };
  if (value instanceof String) return { rawDiameterType: 'boxed_string' };
  return { rawDiameterType: inputType };
}

function invalidPhysicalBucketDiagnostic({
  sourceKind,
  sourceRowId,
  rawMaterialId = null,
  orderId = null,
  itemId = null,
  rawDiameter,
  materialType,
  reason,
}) {
  const sourceIdField = sourceKind === 'usage' ? 'usageId' : 'reservationId';
  return {
    code: INVALID_PHYSICAL_BUCKET_IDENTITY,
    severity: 'error',
    scope: 'reference',
    entity: {
      rawMaterialId,
      orderId,
      itemId,
      diameter: null,
      materialType,
    },
    evidence: {
      sourceKind,
      sourceRowId,
      [sourceIdField]: sourceRowId,
      orderId,
      itemId,
      rawMaterialId,
      ...describeRawDiameter(rawDiameter),
      materialType,
      reason,
    },
    explanationKey: 'physical_bucket_diameter_is_invalid',
  };
}

function summarizeMaterialBuckets(materialBuckets) {
  const summary = {
    usageCount: 0,
    usageRowsKg: 0,
    reservationCount: 0,
    activeReservationCount: 0,
    activeReservedKg: 0,
    consumedReservationCount: 0,
    consumedReservationKg: 0,
    releasedReservationCount: 0,
    releasedReservationKg: 0,
    unknownReservationCount: 0,
    unknownReservedKg: 0,
    usageIds: [],
    reservationIds: [],
    supportingProductionEvidence: [],
  };
  for (const bucket of materialBuckets) {
    summary.usageCount += bucket.usageRows.length;
    summary.usageRowsKg += bucket.totals.usageRowsKg;
    summary.reservationCount += bucket.reservations.length;
    summary.activeReservationCount += bucket.totals.activeReservationCount;
    summary.activeReservedKg += bucket.totals.activeReservedKg;
    summary.consumedReservationCount += bucket.totals.consumedReservationCount;
    summary.consumedReservationKg += bucket.totals.consumedReservationKg;
    summary.releasedReservationCount += bucket.totals.releasedReservationCount;
    summary.releasedReservationKg += bucket.totals.releasedReservationKg;
    summary.unknownReservationCount += bucket.totals.unknownReservationCount;
    summary.unknownReservedKg += bucket.totals.unknownReservedKg;
    summary.usageIds.push(...bucket.usageRows.map(row => row.usageId));
    summary.reservationIds.push(...bucket.reservations.map(row => row.reservationId));
    summary.supportingProductionEvidence.push(...bucket.supportingProductionEvidence);
  }
  summary.usageRowsKg = roundKg(summary.usageRowsKg);
  summary.activeReservedKg = roundKg(summary.activeReservedKg);
  summary.consumedReservationKg = roundKg(summary.consumedReservationKg);
  summary.releasedReservationKg = roundKg(summary.releasedReservationKg);
  summary.unknownReservedKg = roundKg(summary.unknownReservedKg);
  summary.usageIds.sort((left, right) => left - right);
  summary.reservationIds.sort((left, right) => left - right);
  summary.supportingProductionEvidence = deduplicateSupportingEvidence(summary.supportingProductionEvidence);
  const recognizedReservationCount = summary.activeReservationCount
    + summary.consumedReservationCount
    + summary.releasedReservationCount;
  summary.relationship = summary.usageCount && recognizedReservationCount
    ? 'usage_and_reservation'
    : summary.usageCount
      ? 'usage_only'
      : recognizedReservationCount
        ? 'reservation_only'
        : 'none';
  return summary;
}

function emptyObserved(overrides = {}) {
  return {
    receivedKg: 0,
    legacyUsedCounterKg: 0,
    usageRowsKg: 0,
    scrappedCounterKg: 0,
    activeReservedKg: 0,
    consumedReservationKg: 0,
    releasedReservationKg: 0,
    ...overrides,
  };
}

function buildRawMaterialReconciliationReport(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('better_sqlite3_db_required');
  const clock = options.clock || (() => new Date());
  const generated = clock();
  const generatedAt = generated instanceof Date ? generated.toISOString() : new Date(generated).toISOString();

  const hasAdjustment=db.pragma('table_info(raw_material)').some(c=>c.name==='stock_adjustment_kg');
  const rawMaterials = db.prepare(`
    SELECT id, diameter, COALESCE(material_type, 'coil') AS material_type,
           COALESCE(weight_received, 0) AS weight_received,
           ${hasAdjustment ? 'COALESCE(stock_adjustment_kg,0)' : '0'} AS stock_adjustment_kg,
           COALESCE(weight_used, 0) AS weight_used,
           COALESCE(weight_scrapped, 0) AS weight_scrapped,
           COALESCE(active, 1) AS active
    FROM raw_material
    ORDER BY id
  `).all().map(row => {
    const diameterIdentity = parseDiameter(row.diameter);
    return {
      ...row,
      raw_diameter: row.diameter,
      diameter: diameterIdentity.value,
      diameterIdentity,
      material_type: normalizeMaterialType(row.material_type),
    };
  });
  const usages = db.prepare(`
    SELECT u.id, u.raw_material_id, u.order_id, u.item_id,
           COALESCE(u.weight_used, 0) AS weight_used,
           rm.id AS existing_raw_material_id,
           o.id AS existing_order_id,
           i.id AS existing_item_id, i.order_id AS item_order_id,
           i.produced_qty, i.status AS item_status, i.started_at, i.completed_at
    FROM raw_material_usage u
    LEFT JOIN raw_material rm ON rm.id=u.raw_material_id
    LEFT JOIN orders o ON o.id=u.order_id
    LEFT JOIN items i ON i.id=u.item_id
    ORDER BY u.id
  `).all();
  const reservations = db.prepare(`
    SELECT r.id, r.order_id, r.item_id, r.diameter,
           r.material_type,
           COALESCE(r.reserved_kg, 0) AS reserved_kg, r.status,
           o.id AS existing_order_id,
           i.id AS existing_item_id, i.order_id AS item_order_id,
           i.produced_qty, i.status AS item_status, i.started_at, i.completed_at
    FROM inventory_reservations r
    LEFT JOIN orders o ON o.id=r.order_id
    LEFT JOIN items i ON i.id=r.item_id
    ORDER BY r.id
  `).all().map(row => {
    const diameterIdentity = parseDiameter(row.diameter);
    return {
      ...row,
      raw_diameter: row.diameter,
      diameter: diameterIdentity.value,
      diameterIdentity,
      material_type: normalizeMaterialType(row.material_type),
    };
  });

  const rawMaterialById = new Map(rawMaterials.map(row => [row.id, row]));
  const usagesByLot = new Map();
  const demands = new Map();
  const stockPositions = new Map();
  const orphans = [];
  const referenceIssues = [];
  const referenceDiagnostics = [];

  function demand(orderId, itemId) {
    const key = demandKey(orderId, itemId);
    if (!demands.has(key)) demands.set(key, {
      orderId: orderId ?? null,
      itemId: itemId ?? null,
      materialBuckets: new Map(),
    });
    return demands.get(key);
  }

  function stock(diameter, materialType) {
    const normalizedDiameter = normalizeDiameter(diameter);
    const normalizedMaterialType = normalizeMaterialType(materialType);
    const key = physicalBucketKey(normalizedDiameter, normalizedMaterialType);
    if (!stockPositions.has(key)) stockPositions.set(key, {
      diameter: normalizedDiameter,
      materialType: normalizedMaterialType,
      rawMaterialIds: [],
      receivedKg: 0,
      stockAdjustmentKg: 0,
      legacyUsedCounterKg: 0,
      usageRowsKg: 0,
      scrappedCounterKg: 0,
      activeReservedKg: 0,
      consumedReservationKg: 0,
      releasedReservationKg: 0,
      unknownReservationCount: 0,
      unknownReservedKg: 0,
      reservationIds: [],
    });
    return stockPositions.get(key);
  }

  function materialBucket(currentDemand, diameter, materialType) {
    const normalizedDiameter = normalizeDiameter(diameter);
    const normalizedMaterialType = normalizeMaterialType(materialType);
    const key = physicalBucketKey(normalizedDiameter, normalizedMaterialType);
    if (!currentDemand.materialBuckets.has(key)) currentDemand.materialBuckets.set(key, {
      diameter: normalizedDiameter,
      materialType: normalizedMaterialType,
      usageRows: [],
      reservations: [],
    });
    return currentDemand.materialBuckets.get(key);
  }

  function exactOwnership(row) {
    return row.order_id !== null
      && row.item_id !== null
      && row.existing_order_id !== null
      && row.existing_item_id !== null
      && Number(row.item_order_id) === Number(row.order_id);
  }

  function ownershipMismatch(row) {
    return row.order_id !== null
      && row.item_id !== null
      && row.existing_order_id !== null
      && row.existing_item_id !== null
      && Number(row.item_order_id) !== Number(row.order_id);
  }

  for (const row of rawMaterials) {
    if (!row.diameterIdentity.valid) continue;
    const currentStock = stock(row.diameter, row.material_type);
    currentStock.rawMaterialIds.push(row.id);
    currentStock.receivedKg += Number(row.weight_received || 0);
    currentStock.stockAdjustmentKg += Number(row.stock_adjustment_kg || 0);
    currentStock.legacyUsedCounterKg += Number(row.weight_used || 0);
    currentStock.scrappedCounterKg += Number(row.weight_scrapped || 0);
  }

  for (const row of usages) {
    const currentDemand = demand(row.order_id, row.item_id);
    const weight = Number(row.weight_used || 0);
    const evidence = supportingProductionEvidence(row, row.id);
    const material = rawMaterialById.get(row.raw_material_id);
    const validPhysicalIdentity = Boolean(material?.diameterIdentity.valid);
    if (material && validPhysicalIdentity) {
      if (!usagesByLot.has(row.raw_material_id)) usagesByLot.set(row.raw_material_id, []);
      usagesByLot.get(row.raw_material_id).push(row);
      stock(material.diameter, material.material_type).usageRowsKg += weight;
      if (exactOwnership(row)) {
        materialBucket(currentDemand, material.diameter, material.material_type).usageRows.push({
          usageId: row.id,
          weightUsedKg: roundKg(weight),
          supportingProductionEvidence: evidence,
        });
      }
    }
    if (material && !validPhysicalIdentity) {
      referenceDiagnostics.push(invalidPhysicalBucketDiagnostic({
        sourceKind: 'usage',
        sourceRowId: row.id,
        rawMaterialId: row.raw_material_id,
        orderId: row.order_id,
        itemId: row.item_id,
        rawDiameter: material.raw_diameter,
        materialType: material.material_type,
        reason: material.diameterIdentity.reason,
      }));
    }

    const missing = [];
    if (row.existing_raw_material_id === null) missing.push('raw_material');
    if (row.order_id !== null && row.existing_order_id === null) missing.push('order');
    if (row.item_id !== null && row.existing_item_id === null) missing.push('item');
    if (missing.length) {
      const orphan = {
        type: RAW_MATERIAL_DIAGNOSTIC.ORPHANED_USAGE,
        sourceKind: 'usage',
        usageId: row.id,
        rawMaterialId: row.raw_material_id ?? null,
        orderId: row.order_id ?? null,
        itemId: row.item_id ?? null,
        missing,
      };
      orphans.push(orphan);
      referenceDiagnostics.push(...classifyRawMaterialIntegrity({
        balance: calculateObservedRawMaterialBalance(emptyObserved()),
        scope: 'reference',
        entity: { rawMaterialId: row.raw_material_id, orderId: row.order_id, itemId: row.item_id },
        usageCount: 0,
        orphanedUsages: [orphan],
      }));
    }
    if (ownershipMismatch(row)) {
      const mismatch = {
        type: RAW_MATERIAL_DIAGNOSTIC.ITEM_ORDER_MISMATCH,
        sourceKind: 'usage',
        sourceRowId: row.id,
        usageId: row.id,
        referencedOrderId: row.order_id,
        itemId: row.item_id,
        actualItemOrderId: row.item_order_id,
        rawMaterialId: row.raw_material_id ?? null,
        diameter: material?.diameter ?? null,
        materialType: material?.material_type ?? null,
      };
      referenceIssues.push(mismatch);
      referenceDiagnostics.push(...classifyRawMaterialIntegrity({
        balance: calculateObservedRawMaterialBalance(emptyObserved()),
        scope: 'reference',
        entity: { rawMaterialId: row.raw_material_id, orderId: row.order_id, itemId: row.item_id },
        usageCount: 0,
        itemOrderMismatches: [mismatch],
      }));
    }
    if (!exactOwnership(row) || !validPhysicalIdentity) {
      referenceDiagnostics.push(...classifyRawMaterialIntegrity({
        balance: calculateObservedRawMaterialBalance(emptyObserved({ usageRowsKg: weight })),
        scope: 'reference',
        entity: { rawMaterialId: row.raw_material_id, orderId: row.order_id, itemId: row.item_id },
        usageCount: 1,
        usageIds: [row.id],
        supportingProductionEvidence: [evidence],
      }));
    }
  }

  for (const row of reservations) {
    const currentDemand = demand(row.order_id, row.item_id);
    const weight = Number(row.reserved_kg || 0);
    const validPhysicalIdentity = row.diameterIdentity.valid;
    const currentStock = validPhysicalIdentity ? stock(row.diameter, row.material_type) : null;
    if (currentStock) currentStock.reservationIds.push(row.id);

    if (exactOwnership(row) && validPhysicalIdentity) {
      materialBucket(currentDemand, row.diameter, row.material_type).reservations.push({
        reservationId: row.id,
        reservedKg: roundKg(weight),
        status: row.status ?? null,
      });
    }
    if (!validPhysicalIdentity) {
      referenceDiagnostics.push(invalidPhysicalBucketDiagnostic({
        sourceKind: 'reservation',
        sourceRowId: row.id,
        orderId: row.order_id,
        itemId: row.item_id,
        rawDiameter: row.raw_diameter,
        materialType: row.material_type,
        reason: row.diameterIdentity.reason,
      }));
    }

    if (row.status === 'active') {
      if (currentStock) currentStock.activeReservedKg += weight;
    } else if (row.status === 'consumed') {
      if (currentStock) currentStock.consumedReservationKg += weight;
    } else if (row.status === 'released') {
      if (currentStock) currentStock.releasedReservationKg += weight;
    } else {
      const unknown = {
        reservationId: row.id,
        rawStatus: row.status ?? null,
        reservedKg: roundKg(weight),
        orderId: row.order_id ?? null,
        itemId: row.item_id ?? null,
        diameter: row.diameter,
        materialType: row.material_type,
      };
      if (currentStock) {
        currentStock.unknownReservationCount += 1;
        currentStock.unknownReservedKg += weight;
      }
      if (!exactOwnership(row) || !validPhysicalIdentity) {
        referenceDiagnostics.push(...classifyRawMaterialIntegrity({
          balance: calculateObservedRawMaterialBalance(emptyObserved()),
          scope: 'reference',
          entity: { orderId: row.order_id, itemId: row.item_id, diameter: row.diameter, materialType: row.material_type },
          usageCount: 0,
          unknownReservations: [unknown],
        }));
      }
    }

    const missing = [];
    if (row.existing_order_id === null) missing.push('order');
    if (row.item_id !== null && row.existing_item_id === null) missing.push('item');
    if (missing.length) {
      const orphan = {
        type: RAW_MATERIAL_DIAGNOSTIC.ORPHANED_RESERVATION,
        sourceKind: 'reservation',
        reservationId: row.id,
        orderId: row.order_id ?? null,
        itemId: row.item_id ?? null,
        diameter: row.diameter,
        materialType: row.material_type,
        missing,
      };
      orphans.push(orphan);
      referenceDiagnostics.push(...classifyRawMaterialIntegrity({
        balance: calculateObservedRawMaterialBalance(emptyObserved()),
        scope: 'reference',
        entity: { orderId: row.order_id, itemId: row.item_id, diameter: row.diameter, materialType: row.material_type },
        usageCount: 0,
        orphanedReservations: [orphan],
      }));
    }
    if (ownershipMismatch(row)) {
      const mismatch = {
        type: RAW_MATERIAL_DIAGNOSTIC.ITEM_ORDER_MISMATCH,
        sourceKind: 'reservation',
        sourceRowId: row.id,
        reservationId: row.id,
        referencedOrderId: row.order_id,
        itemId: row.item_id,
        actualItemOrderId: row.item_order_id,
        rawMaterialId: null,
        diameter: row.diameter,
        materialType: row.material_type,
      };
      referenceIssues.push(mismatch);
      referenceDiagnostics.push(...classifyRawMaterialIntegrity({
        balance: calculateObservedRawMaterialBalance(emptyObserved()),
        scope: 'reference',
        entity: { orderId: row.order_id, itemId: row.item_id, diameter: row.diameter, materialType: row.material_type },
        usageCount: 0,
        itemOrderMismatches: [mismatch],
      }));
    }
  }

  const lots = rawMaterials.map(row => {
    const lotUsages = usagesByLot.get(row.id) || [];
    const observedBalance = calculateObservedRawMaterialBalance({
      receivedKg: row.weight_received,
      stockAdjustmentKg: row.stock_adjustment_kg,
      legacyUsedCounterKg: row.weight_used,
      usageRowsKg: lotUsages.reduce((sum, usage) => sum + Number(usage.weight_used || 0), 0),
      scrappedCounterKg: row.weight_scrapped,
      activeReservedKg: 0,
      consumedReservationKg: 0,
      releasedReservationKg: 0,
    });
    return {
      rawMaterialId: row.id,
      diameter: row.diameter,
      materialType: row.material_type,
      active: Boolean(row.active),
      usageIds: lotUsages.map(usage => usage.id),
      observedBalance,
      reservationAllocation: {
        status: 'unavailable',
        reason: 'inventory_reservations_has_no_raw_material_id',
      },
      diagnostics: classifyRawMaterialIntegrity({
        balance: observedBalance,
        scope: 'lot',
        entity: { rawMaterialId: row.id, diameter: row.diameter, materialType: row.material_type },
        usageCount: 0,
      }),
    };
  });

  const positionRows = [...stockPositions.values()].map(row => {
    const observedBalance = calculateObservedRawMaterialBalance(row);
    const diagnostics = classifyRawMaterialIntegrity({
      balance: observedBalance,
      scope: 'bucket',
      entity: { diameter: row.diameter, materialType: row.materialType },
      usageCount: 0,
      ambiguousReservationAllocation: row.reservationIds.length
        ? {
          reservationIds: [...row.reservationIds].sort((left, right) => left - right),
          rawMaterialIds: [...row.rawMaterialIds].sort((left, right) => left - right),
          reservationScope: 'diameter_material_bucket',
        }
        : null,
    });
    return {
      diameter: row.diameter,
      materialType: row.materialType,
      rawMaterialIds: [...row.rawMaterialIds].sort((left, right) => left - right),
      reservationScope: 'diameter_material_bucket',
      unknownReservationCount: row.unknownReservationCount,
      unknownReservedKg: roundKg(row.unknownReservedKg),
      observedBalance,
      diagnostics,
    };
  }).sort(comparePhysicalBuckets);

  const demandRows = [...demands.values()].map(row => {
    const materialBuckets = [...row.materialBuckets.values()].map(bucket => {
      const usageRows = [...bucket.usageRows].sort((left, right) => left.usageId - right.usageId);
      const reservations = [...bucket.reservations].sort((left, right) => left.reservationId - right.reservationId);
      const activeRows = reservations.filter(candidate => candidate.status === 'active');
      const consumedRows = reservations.filter(candidate => candidate.status === 'consumed');
      const releasedRows = reservations.filter(candidate => candidate.status === 'released');
      const unknownRows = reservations.filter(candidate => !RECOGNIZED_RESERVATION_STATUSES.has(candidate.status));
      const usageIds = usageRows.map(candidate => candidate.usageId);
      const relevantReservations = [...activeRows, ...consumedRows, ...releasedRows]
        .sort((left, right) => left.reservationId - right.reservationId);
      const supportingEvidence = deduplicateSupportingEvidence(
        usageRows.flatMap(candidate => candidate.supportingProductionEvidence)
      );
      const exactDemandOverlaps = usageRows.length && activeRows.length ? [{
        orderId: row.orderId,
        itemId: row.itemId,
        diameter: bucket.diameter,
        materialType: bucket.materialType,
        usageIds,
        reservationIds: activeRows.map(candidate => candidate.reservationId),
        usageRowsKg: roundKg(usageRows.reduce((sum, candidate) => sum + candidate.weightUsedKg, 0)),
        activeReservedKg: roundKg(activeRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0)),
      }] : [];
      const duplicateReservationGroups = activeRows.length > 1 ? [{
        orderId: row.orderId,
        itemId: row.itemId,
        diameter: bucket.diameter,
        materialType: bucket.materialType,
        activeRowCount: activeRows.length,
        totalActiveReservedKg: roundKg(activeRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0)),
        reservations: activeRows.map(candidate => ({
          reservationId: candidate.reservationId,
          reservedKg: candidate.reservedKg,
        })),
        reservationIds: activeRows.map(candidate => candidate.reservationId),
      }] : [];
      const observedBalance = calculateObservedRawMaterialBalance(emptyObserved({
        usageRowsKg: usageRows.reduce((sum, candidate) => sum + candidate.weightUsedKg, 0),
        activeReservedKg: activeRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0),
        consumedReservationKg: consumedRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0),
        releasedReservationKg: releasedRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0),
      }));
      const diagnostics = classifyRawMaterialIntegrity({
        balance: observedBalance,
        scope: 'demand',
        entity: {
          orderId: row.orderId,
          itemId: row.itemId,
          diameter: bucket.diameter,
          materialType: bucket.materialType,
        },
        usageCount: usageRows.length,
        usageIds,
        reservations: relevantReservations,
        supportingProductionEvidence: supportingEvidence,
        exactDemandOverlaps,
        duplicateReservationGroups,
        unknownReservations: unknownRows.map(candidate => ({
          reservationId: candidate.reservationId,
          rawStatus: candidate.status,
          reservedKg: candidate.reservedKg,
          orderId: row.orderId,
          itemId: row.itemId,
          diameter: bucket.diameter,
          materialType: bucket.materialType,
        })),
      });
      return {
        diameter: bucket.diameter,
        materialType: bucket.materialType,
        usageRows,
        reservations,
        totals: {
          usageRowsKg: observedBalance.observed.usageRowsKg,
          activeReservationCount: activeRows.length,
          activeReservedKg: observedBalance.observed.activeReservedKg,
          consumedReservationCount: consumedRows.length,
          consumedReservationKg: observedBalance.observed.consumedReservationKg,
          releasedReservationCount: releasedRows.length,
          releasedReservationKg: observedBalance.observed.releasedReservationKg,
          unknownReservationCount: unknownRows.length,
          unknownReservedKg: roundKg(unknownRows.reduce((sum, candidate) => sum + candidate.reservedKg, 0)),
        },
        supportingProductionEvidence: supportingEvidence,
        diagnostics,
      };
    }).sort(comparePhysicalBuckets);
    const diagnostics = deduplicateDiagnostics(materialBuckets.flatMap(bucket => bucket.diagnostics));
    const summary = summarizeMaterialBuckets(materialBuckets);

    return {
      orderId: row.orderId,
      itemId: row.itemId,
      supportingProductionEvidence: summary.supportingProductionEvidence,
      usageCount: summary.usageCount,
      usageRowsKg: summary.usageRowsKg,
      reservationCount: summary.reservationCount,
      activeReservationCount: summary.activeReservationCount,
      activeReservedKg: summary.activeReservedKg,
      consumedReservationCount: summary.consumedReservationCount,
      consumedReservationKg: summary.consumedReservationKg,
      releasedReservationCount: summary.releasedReservationCount,
      releasedReservationKg: summary.releasedReservationKg,
      unknownReservationCount: summary.unknownReservationCount,
      unknownReservedKg: summary.unknownReservedKg,
      relationship: summary.relationship,
      usageIds: summary.usageIds,
      reservationIds: summary.reservationIds,
      materialBuckets,
      diagnostics,
    };
  }).sort((left, right) => Number(left.orderId || 0) - Number(right.orderId || 0)
    || Number(left.itemId || 0) - Number(right.itemId || 0));

  const diagnostics = deduplicateDiagnostics([
    ...lots.flatMap(row => row.diagnostics),
    ...positionRows.flatMap(row => row.diagnostics),
    ...demandRows.flatMap(row => row.diagnostics),
    ...referenceDiagnostics,
  ]);
  const diagnosticCounts = {};
  for (const row of diagnostics) diagnosticCounts[row.code] = (diagnosticCounts[row.code] || 0) + 1;

  const unknownReservationCount = reservations.filter(row => !RECOGNIZED_RESERVATION_STATUSES.has(row.status)).length;
  const unknownReservedKg = roundKg(reservations
    .filter(row => !RECOGNIZED_RESERVATION_STATUSES.has(row.status))
    .reduce((sum, row) => sum + Number(row.reserved_kg || 0), 0));

  return {
    reportVersion: 1,
    generatedAt,
    summary: {
      rawMaterialCount: rawMaterials.length,
      reservationCount: reservations.length,
      usageCount: usages.length,
      unknownReservationCount,
      unknownReservedKg,
      diagnosticCounts: Object.fromEntries(Object.entries(diagnosticCounts).sort(([left], [right]) => left.localeCompare(right, 'en'))),
    },
    lots,
    stockPositions: positionRows,
    demands: demandRows,
    orphans: orphans.sort(compareIds),
    referenceIssues: referenceIssues.sort(compareIds),
    diagnostics,
  };
}

module.exports = {
  INVALID_PHYSICAL_BUCKET_IDENTITY,
  buildRawMaterialReconciliationReport,
};
