'use strict';

const crypto = require('crypto');
const { ITEM_STATUS, ORDER_STATUS } = require('../status-contracts');
const { buildCanonicalPhysicalSpec } = require('./canonicalPhysicalSpec');
const { stableCanonicalStringify, buildPhysicalSpecFingerprint } = require('./physicalSpecFingerprint');

const EPSILON = 0.0001;
const PRODUCTION_STATES = Object.freeze({
  NOT_PRODUCED: 'NOT_PRODUCED',
  PARTIALLY_PRODUCED: 'PARTIALLY_PRODUCED',
  FULLY_PRODUCED: 'FULLY_PRODUCED',
});

class OrderCancellationError extends Error {
  constructor(code, statusCode = 400, details = null) {
    super(code);
    this.name = 'OrderCancellationError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fail(code, statusCode = 400, details = null) {
  throw new OrderCancellationError(code, statusCode, details);
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function nonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`invalid_${field}`);
  return round(number);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(`invalid_${field}`);
  return number;
}

function text(value, field, { required = false, maxLength = 1000 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`missing_${field}`);
    return null;
  }
  const result = String(value).trim();
  if (result.length > maxLength) fail(`invalid_${field}`);
  if (required && !result) fail(`missing_${field}`);
  return result || null;
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedIdempotencyKey(value, fallback) {
  const key = String(value || fallback || '').trim();
  if (!key || key.length > 200) fail('invalid_idempotency_key');
  return key;
}

function sameQty(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= EPSILON;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function itemProductionState(orderedQty, producedQty) {
  if (producedQty <= EPSILON) return PRODUCTION_STATES.NOT_PRODUCED;
  if (producedQty + EPSILON >= orderedQty) return PRODUCTION_STATES.FULLY_PRODUCED;
  return PRODUCTION_STATES.PARTIALLY_PRODUCED;
}

function dispositionType(stockQty, scrapQty) {
  if (stockQty > EPSILON && scrapQty > EPSILON) return 'SPLIT_STOCK_AND_SCRAP';
  if (stockQty > EPSILON) return 'FINISHED_GOODS_STOCK';
  if (scrapQty > EPSILON) return 'SCRAP';
  return 'NONE';
}

function orderItems(db, orderId, itemIds = null) {
  const ids = itemIds ? [...new Set(itemIds.map(value => positiveInteger(value, 'item_id')))] : null;
  const filter = ids?.length ? `AND i.id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT i.*, p.order_id AS pallet_order_id, o.order_num, o.status AS order_status
    FROM items i
    JOIN pallets p ON p.id=i.pallet_id
    JOIN orders o ON o.id=p.order_id
    WHERE p.order_id=? ${filter}
    ORDER BY i.id
  `).all(orderId, ...(ids || []));
  if (ids && rows.length !== ids.length) fail('item_not_found_for_order', 404, { requested_item_ids: ids });
  return rows;
}

function productionEvidence(db, item) {
  const orderedQty = round(Math.max(0, Number(item.quantity || 0)));
  const cardRows = db.prepare(`
    SELECT id,card_index,card_total,card_qty,actual_weight_kg,updated_at
    FROM production_card_weights
    WHERE item_id=?
    ORDER BY id
  `).all(item.id);
  const eventRows = db.prepare(`
    SELECT id,event_uid,delta_weight_kg,occurred_at,production_day,source
    FROM production_output_events
    WHERE item_id=?
    ORDER BY id
  `).all(item.id);

  const cardQty = round(cardRows.reduce((sum, row) => (
    Number(row.actual_weight_kg || 0) > 0 ? sum + Number(row.card_qty || 0) : sum
  ), 0));
  const eventWeight = round(eventRows.reduce((sum, row) => sum + Number(row.delta_weight_kg || 0), 0));
  const measuredWeight = Math.max(0, Number(item.actual_weight_kg || 0), eventWeight);
  const unitWeight = Number(item.weight_per_unit || 0);
  const measuredQty = unitWeight > 0 && measuredWeight > 0
    ? clamp(Math.round(measuredWeight / unitWeight), 0, orderedQty)
    : 0;
  const statusQty = [ITEM_STATUS.DONE, ITEM_STATUS.DELIVERED].includes(String(item.status || '')) ? orderedQty : 0;
  const reportedQty = clamp(Number(item.produced_qty || 0), 0, orderedQty);
  const confirmedQty = round(clamp(Math.max(reportedQty, cardQty, measuredQty, statusQty), 0, orderedQty));
  const productionDate = eventRows.length
    ? eventRows[eventRows.length - 1].occurred_at
    : item.completed_at || item.started_at || null;

  return {
    confirmed_qty: confirmedQty,
    reported_qty: reportedQty,
    card_qty: cardQty,
    measured_qty_estimate: measuredQty,
    measured_weight_kg: measuredWeight || null,
    production_date: productionDate,
    source_refs: {
      production_card_weight_ids: cardRows.map(row => Number(row.id)),
      production_output_event_ids: eventRows.map(row => Number(row.id)),
      production_card_rows: cardRows.map(row => ({
        id: Number(row.id), card_index: Number(row.card_index), card_total: Number(row.card_total),
        card_qty: Number(row.card_qty || 0), actual_weight_kg: Number(row.actual_weight_kg || 0), updated_at: row.updated_at,
      })),
      production_output_events: eventRows.map(row => ({
        id: Number(row.id), event_uid: row.event_uid, delta_weight_kg: Number(row.delta_weight_kg || 0),
        occurred_at: row.occurred_at, production_day: row.production_day, source: row.source,
      })),
    },
  };
}

function productionCorrectionHistory(db, itemId) {
  const currentRows = db.prepare(`
    SELECT id,correction_uid,correction_qty,effective_produced_qty_before,effective_produced_qty_after,
           reason,actor_id,created_at
    FROM production_record_correction_events
    WHERE source_order_item_id=?
    ORDER BY id
  `).all(itemId);
  const historicalRows = db.prepare(`
    SELECT id,CAST(id AS TEXT) AS correction_uid,production_correction_qty AS correction_qty,
           effective_produced_qty_before,effective_produced_qty_after,
           (SELECT reason FROM historical_production_reconciliation_transactions t WHERE t.id=reconciliation_transaction_id) AS reason,
           (SELECT actor_id FROM historical_production_reconciliation_transactions t WHERE t.id=reconciliation_transaction_id) AS actor_id,
           created_at
    FROM historical_production_reconciliation_items
    WHERE source_order_item_id=? AND production_correction_qty>0
    ORDER BY id
  `).all(itemId);
  const rows = [...currentRows, ...historicalRows];
  return {
    corrected_qty: round(rows.reduce((sum, row) => sum + Number(row.correction_qty || 0), 0)),
    events: rows.map(row => ({
      id: Number(row.id), correction_uid: row.correction_uid, correction_qty: round(row.correction_qty),
      effective_produced_qty_before: round(row.effective_produced_qty_before),
      effective_produced_qty_after: round(row.effective_produced_qty_after),
      reason: row.reason, actor_id: row.actor_id == null ? null : Number(row.actor_id), created_at: row.created_at,
    })),
  };
}

function effectiveProductionEvidence(db, item) {
  const recorded = productionEvidence(db, item).confirmed_qty;
  const corrections = productionCorrectionHistory(db, item.id).corrected_qty;
  return {
    recorded_produced_qty: recorded,
    corrected_produced_qty: corrections,
    effective_produced_qty: round(Math.max(0, recorded - corrections)),
  };
}

function effectiveProductionQuantity(db, item) {
  return effectiveProductionEvidence(db, item).effective_produced_qty;
}

function materialConsumptionEvidence(db, itemId) {
  const rows = db.prepare(`
    SELECT e.id,e.event_uid,e.event_type,COALESCE(SUM(l.consumed_kg),0) AS quantity_kg
    FROM material_consumption_events_v2 e
    JOIN material_consumption_event_lines_v2 l ON l.consumption_event_id=e.id
    WHERE e.item_id=?
    GROUP BY e.id,e.event_uid,e.event_type
    ORDER BY e.id
  `).all(itemId);
  const netKg = round(rows.reduce((sum, row) => (
    sum + (row.event_type === 'reversal' ? -Number(row.quantity_kg || 0) : Number(row.quantity_kg || 0))
  ), 0));
  return {
    net_consumed_kg: Math.max(0, netKg),
    events: rows.map(row => ({
      id: Number(row.id), event_uid: row.event_uid, event_type: row.event_type, quantity_kg: round(row.quantity_kg),
    })),
  };
}

function packageItemIds(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed)
    ? [...new Set(parsed.map(Number).filter(id => Number.isInteger(id) && id > 0))]
    : [];
}

function logisticsEvidence(db, orderId, itemId, producedQty) {
  const cardRows = db.prepare(`
    SELECT s.status AS session_status,c.state,COALESCE(SUM(c.quantity),0) AS quantity
    FROM order_loading_session_cards c
    JOIN order_loading_sessions s ON s.id=c.session_id
    WHERE s.order_id=? AND c.parent_item_id=?
    GROUP BY s.status,c.state
  `).all(orderId, itemId);
  let deliveredCards = 0;
  let pickedCards = 0;
  for (const row of cardRows) {
    if (row.session_status === 'completed' && row.state === 'loaded') deliveredCards += Number(row.quantity || 0);
    if (row.session_status === 'active' && row.state === 'loaded') pickedCards += Number(row.quantity || 0);
  }

  const packageRows = db.prepare(`
    SELECT pk.id,pk.item_ids,pk.quantity,pk.status,
      EXISTS(
        SELECT 1
        FROM order_loading_session_packages sp
        JOIN order_loading_sessions s ON s.id=sp.session_id
        WHERE sp.package_id=pk.id AND s.status='completed' AND sp.state='loaded'
      ) AS delivered_by_session,
      EXISTS(
        SELECT 1
        FROM order_loading_session_packages sp
        JOIN order_loading_sessions s ON s.id=sp.session_id
        WHERE sp.package_id=pk.id AND s.status='active' AND sp.state='loaded'
      ) AS picked_by_session
    FROM packages pk
    WHERE pk.order_id=?
    ORDER BY pk.id
  `).all(orderId);

  let deliveredPackages = 0;
  let packedPackages = 0;
  let pickedPackages = 0;
  const ambiguousPackageIds = [];
  const packedPackageIds = [];
  for (const row of packageRows) {
    const ids = packageItemIds(row.item_ids);
    if (!ids.includes(Number(itemId))) continue;
    const exact = ids.length === 1;
    const delivered = Boolean(row.delivered_by_session) || row.status === 'shipped';
    const picked = Boolean(row.picked_by_session);
    const packed = ['packed', 'ready', 'staged'].includes(String(row.status || ''));
    if (!exact) {
      if (delivered || picked || packed) ambiguousPackageIds.push(Number(row.id));
      continue;
    }
    if (delivered) deliveredPackages += Number(row.quantity || 0);
    else if (picked) pickedPackages += Number(row.quantity || 0);
    else if (packed) {
      packedPackages += Number(row.quantity || 0);
      packedPackageIds.push(Number(row.id));
    }
  }

  // The legacy package and newer card routes can describe the same departure.
  // Taking the larger independently-audited value prevents a duplicate count.
  const deliveredQty = round(clamp(Math.max(deliveredCards, deliveredPackages), 0, producedQty));
  const pickedQty = round(clamp(Math.max(pickedCards, pickedPackages), 0, Math.max(0, producedQty - deliveredQty)));
  return {
    delivered_qty: deliveredQty,
    packed_qty: round(clamp(packedPackages, 0, producedQty)),
    picked_qty: pickedQty,
    packed_package_ids: packedPackageIds,
    ambiguous_package_ids: [...new Set(ambiguousPackageIds)],
    source_refs: {
      delivered_cards_qty: round(deliveredCards),
      delivered_packages_qty: round(deliveredPackages),
      picked_cards_qty: round(pickedCards),
      picked_packages_qty: round(pickedPackages),
    },
  };
}

function priorDisposition(db, itemId) {
  const cancellationRow = db.prepare(`
    SELECT COALESCE(SUM(stock_disposition_qty),0) AS stock_qty,
           COALESCE(SUM(scrap_disposition_qty),0) AS scrap_qty,
           COUNT(*) AS disposition_count
    FROM order_cancellation_item_dispositions
    WHERE source_order_item_id=?
  `).get(itemId);
  const historicalRow = db.prepare(`
    SELECT COALESCE(SUM(stock_disposition_qty),0) AS stock_qty,
           COALESCE(SUM(scrap_disposition_qty),0) AS scrap_qty,
           COUNT(*) AS disposition_count
    FROM historical_production_reconciliation_items
    WHERE source_order_item_id=?
  `).get(itemId);
  return {
    stock_qty: round(Number(cancellationRow?.stock_qty || 0) + Number(historicalRow?.stock_qty || 0)),
    scrap_qty: round(Number(cancellationRow?.scrap_qty || 0) + Number(historicalRow?.scrap_qty || 0)),
    disposition_count: Number(cancellationRow?.disposition_count || 0) + Number(historicalRow?.disposition_count || 0),
    cancellation_disposition_count: Number(cancellationRow?.disposition_count || 0),
    historical_disposition_count: Number(historicalRow?.disposition_count || 0),
  };
}

function immutablePhysicalSpec(item) {
  const legacyItem = {
    shape_id: item.shape_id ?? null,
    shape_name: item.shape_name ?? null,
    diameter: item.diameter ?? null,
    total_length_mm: item.total_length_mm ?? null,
    segments: safeJson(item.segments, []),
    spiral_diameter_mm: item.spiral_diameter_mm ?? null,
    spiral_turns: item.spiral_turns ?? null,
    is_3d: item.is_3d ?? null,
  };
  const matchability = buildCanonicalPhysicalSpec({
    shapeSnapshot: item.shape_snapshot_json,
    legacyItem,
    materialGrade: item.material_grade || 'B500B',
  });
  const physicalSpec = matchability.canonicalSpec || {
    version: 1,
    source: 'order-item-immutable-snapshot',
    matchability_status: matchability.status,
    matchability_reasons: matchability.reasonCodes || [],
    shape_snapshot: safeJson(item.shape_snapshot_json, null),
    legacy_item: legacyItem,
  };
  const fingerprint = buildPhysicalSpecFingerprint(matchability)
    || `physical-spec:v1:sha256:${sha256(stableCanonicalStringify(physicalSpec))}`;
  return { physical_spec: physicalSpec, physical_spec_fingerprint: fingerprint, matchability };
}

function cancellationReviewForItem(db, item) {
  const orderedQty = round(Math.max(0, Number(item.quantity || 0)));
  const production = productionEvidence(db, item);
  const correctionHistory = productionCorrectionHistory(db, item.id);
  const effectiveProducedQty = round(Math.max(0, production.confirmed_qty - correctionHistory.corrected_qty));
  // Logistics is read against gross evidence.  Clamping it to the corrected
  // quantity would conceal a delivery or package that must be reconciled first.
  const logistics = logisticsEvidence(db, item.pallet_order_id, item.id, production.confirmed_qty);
  const prior = priorDisposition(db, item.id);
  const materialConsumption = materialConsumptionEvidence(db, item.id);
  const consumedOrDeliveredQty = round(logistics.delivered_qty + prior.stock_qty + prior.scrap_qty);
  const eligibleQty = round(Math.max(0, effectiveProducedQty - consumedOrDeliveredQty));
  const unproducedQty = round(Math.max(0, orderedQty - effectiveProducedQty));
  const accountedProducedQty = round(logistics.delivered_qty + prior.stock_qty + prior.scrap_qty + eligibleQty);
  const physical = immutablePhysicalSpec(item);
  const calculatedWeight = orderedQty > 0
    ? round(Number(item.total_weight || 0) * effectiveProducedQty / orderedQty)
    : 0;

  return {
    item_id: Number(item.id),
    item_label: item.shape_name || `Item ${item.id}`,
    item_status: item.status,
    ordered_qty: orderedQty,
    recorded_produced_qty: production.confirmed_qty,
    erroneous_production_correction_qty: correctionHistory.corrected_qty,
    confirmed_produced_qty: effectiveProducedQty,
    delivered_qty: logistics.delivered_qty,
    packed_qty: logistics.packed_qty,
    picked_qty: logistics.picked_qty,
    previous_stock_qty: prior.stock_qty,
    previous_scrap_qty: prior.scrap_qty,
    eligible_produced_qty: eligibleQty,
    cancelled_unproduced_qty: unproducedQty,
    production_state: itemProductionState(orderedQty, effectiveProducedQty),
    already_cancelled: prior.cancellation_disposition_count > 0,
    production_date: production.production_date,
    calculated_produced_weight_kg: calculatedWeight,
    measured_produced_weight_kg: production.measured_weight_kg,
    physical_spec: physical.physical_spec,
    physical_spec_fingerprint: physical.physical_spec_fingerprint,
    physical_spec_matchability: physical.matchability.status,
    source_production_refs: {
      ...production.source_refs,
      production_record_correction_event_ids: correctionHistory.events.map(event => event.id),
      production_record_corrections: correctionHistory.events,
      logistics: logistics.source_refs,
      packed_package_ids: logistics.packed_package_ids,
    },
    downstream_evidence: {
      delivered_qty: logistics.delivered_qty,
      packed_qty: logistics.packed_qty,
      picked_qty: logistics.picked_qty,
      previously_disposed_qty: round(prior.stock_qty + prior.scrap_qty),
      net_material_consumed_kg: materialConsumption.net_consumed_kg,
      material_consumption_events: materialConsumption.events,
    },
    warnings: logistics.ambiguous_package_ids.length
      ? [{ code: 'packed_quantity_requires_reconciliation', package_ids: logistics.ambiguous_package_ids }]
      : [],
    reconciliation: {
      ordered_qty: orderedQty,
      recorded_produced_qty: production.confirmed_qty,
      erroneous_production_correction_qty: correctionHistory.corrected_qty,
      produced_qty: effectiveProducedQty,
      delivered_qty: logistics.delivered_qty,
      previous_stock_qty: prior.stock_qty,
      previous_scrap_qty: prior.scrap_qty,
      eligible_produced_qty: eligibleQty,
      cancelled_unproduced_qty: unproducedQty,
      accounted_produced_qty: accountedProducedQty,
      unexplained_qty: round(Math.max(0, effectiveProducedQty - accountedProducedQty)),
      valid: sameQty(effectiveProducedQty, accountedProducedQty) && sameQty(orderedQty, effectiveProducedQty + unproducedQty),
    },
  };
}

function activeWarehouseRows(db) {
  return db.prepare(`
    SELECT id,warehouse_code,name,requires_location
    FROM finished_goods_warehouses
    WHERE active=1
    ORDER BY name,id
  `).all().map(row => ({
    id: Number(row.id), warehouse_code: row.warehouse_code, name: row.name,
    requires_location: Boolean(row.requires_location),
  }));
}

function createOrderCancellationService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('invalid database');
  }

  function listWarehouses() {
    return activeWarehouseRows(db);
  }

  function review({
    order_id, orderId, item_id, itemId, item_ids, itemIds, scope = null,
    production_record_correction_authorized = false,
  } = {}) {
    const normalizedOrderId = positiveInteger(order_id ?? orderId, 'order_id');
    const order = db.prepare('SELECT id,order_num,status FROM orders WHERE id=?').get(normalizedOrderId);
    if (!order) fail('order_not_found', 404);
    const requestedItemIds = item_id ?? itemId
      ? [item_id ?? itemId]
      : (item_ids ?? itemIds ?? null);
    const selectedItems = orderItems(db, normalizedOrderId, requestedItemIds);
    if (!selectedItems.length) fail('order_has_no_items', 409);
    const effectiveScope = scope === 'item' || requestedItemIds ? 'item' : 'order';
    const items = selectedItems.map(item => cancellationReviewForItem(db, item));
    const actionableItems = items.filter(item => !item.already_cancelled);
    return {
      order_id: Number(order.id),
      order_num: order.order_num,
      order_status: order.status,
      scope: effectiveScope,
      warehouses: activeWarehouseRows(db),
      items,
      can_correct_production_record: production_record_correction_authorized === true,
      can_cancel: actionableItems.length > 0
        && actionableItems.every(item => !item.warnings.length && item.reconciliation.valid),
    };
  }

  function warehouseForDisposition(value) {
    const warehouseId = positiveInteger(value, 'destination_warehouse_id');
    const warehouse = db.prepare(`
      SELECT id,warehouse_code,name,requires_location
      FROM finished_goods_warehouses WHERE id=? AND active=1
    `).get(warehouseId);
    if (!warehouse) fail('destination_warehouse_not_found', 404);
    return warehouse;
  }

  function normalizedItemInputs(inputItems) {
    if (!Array.isArray(inputItems) || !inputItems.length) fail('cancellation_items_required');
    const seen = new Set();
    return inputItems.map(raw => {
      const itemId = positiveInteger(raw?.item_id ?? raw?.itemId, 'item_id');
      if (seen.has(itemId)) fail('duplicate_cancellation_item');
      seen.add(itemId);
      const productionReality = String(raw?.production_reality ?? raw?.productionReality ?? 'PRODUCED_AS_RECORDED').trim();
      if (!['PRODUCED_AS_RECORDED', 'NOT_ACTUALLY_PRODUCED', 'PARTIALLY_PRODUCED'].includes(productionReality)) {
        fail('invalid_production_reality');
      }
      const actualProducedInput = raw?.actual_produced_qty ?? raw?.actualProducedQty;
      return {
        item_id: itemId,
        stock_disposition_qty: nonNegative(raw?.stock_disposition_qty ?? raw?.stockDispositionQty ?? raw?.stock_qty ?? 0, 'stock_disposition_qty'),
        scrap_disposition_qty: nonNegative(raw?.scrap_disposition_qty ?? raw?.scrapDispositionQty ?? raw?.scrap_qty ?? 0, 'scrap_disposition_qty'),
        destination_warehouse_id: raw?.destination_warehouse_id ?? raw?.destinationWarehouseId ?? raw?.warehouse_id ?? raw?.warehouseId ?? null,
        destination_location: text(raw?.destination_location ?? raw?.destinationLocation ?? raw?.location ?? raw?.zone, 'destination_location', { maxLength: 200 }),
        scrap_reason: text(raw?.scrap_reason ?? raw?.scrapReason, 'scrap_reason', { maxLength: 1000 }),
        production_reality: productionReality,
        actual_produced_qty: actualProducedInput === undefined || actualProducedInput === null || actualProducedInput === ''
          ? null
          : nonNegative(actualProducedInput, 'actual_produced_qty'),
        production_correction_reason: text(raw?.production_correction_reason ?? raw?.productionCorrectionReason, 'production_correction_reason', { maxLength: 1000 }),
      };
    });
  }

  function releaseActiveReservations({ transactionId, orderId, item, reviewItem, actorId }) {
    const rows = db.prepare(`
      SELECT id,reserved_kg FROM inventory_reservations
      WHERE order_id=? AND item_id=? AND status='active'
      ORDER BY id
    `).all(orderId, item.id);
    let releasedKg = 0;
    const ratio = reviewItem.ordered_qty > EPSILON
      ? reviewItem.cancelled_unproduced_qty / reviewItem.ordered_qty
      : 0;
    for (const row of rows) {
      const before = round(row.reserved_kg);
      const released = round(before * ratio);
      const retained = round(Math.max(0, before - released));
      db.prepare(`
        UPDATE inventory_reservations
        SET status='released', reserved_kg=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='active'
      `).run(released, row.id);
      db.prepare(`
        INSERT INTO inventory_reservation_release_events
          (source_reservation_id,cancellation_transaction_id,order_id,item_id,reserved_kg_before,released_kg,retained_for_production_kg,reason,actor_id)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(row.id, transactionId, orderId, item.id, before, released, retained, 'order_cancellation_unproduced_remainder', actorId || null);
      releasedKg = round(releasedKg + released);
    }
    return { released_reservations: rows.length, released_kg: releasedKg };
  }

  function releaseUnattributedReservations({ transactionId, orderId, actorId }) {
    const rows = db.prepare(`
      SELECT id,reserved_kg FROM inventory_reservations
      WHERE order_id=? AND item_id IS NULL AND status='active'
      ORDER BY id
    `).all(orderId);
    let releasedKg = 0;
    for (const row of rows) {
      const before = round(row.reserved_kg);
      db.prepare(`UPDATE inventory_reservations SET status='released', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`)
        .run(row.id);
      db.prepare(`
        INSERT INTO inventory_reservation_release_events
          (source_reservation_id,cancellation_transaction_id,order_id,item_id,reserved_kg_before,released_kg,retained_for_production_kg,reason,actor_id)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(row.id, transactionId, orderId, null, before, before, 0, 'order_cancellation_unattributed_no_production', actorId || null);
      releasedKg = round(releasedKg + before);
    }
    return { released_reservations: rows.length, released_kg: releasedKg };
  }

  function cancelActiveLoadingForOrder({ orderId, actorId, reason }) {
    const sessions = db.prepare(`
      SELECT id,scan_unit FROM order_loading_sessions WHERE order_id=? AND status='active'
    `).all(orderId);
    for (const session of sessions) {
      db.prepare(`
        UPDATE order_loading_sessions
        SET status='cancelled',cancelled_by=?,cancelled_at=CURRENT_TIMESTAMP,cancel_reason=?
        WHERE id=? AND status='active'
      `).run(actorId || null, reason, session.id);
      if (session.scan_unit === 'production_card') {
        db.prepare(`
          INSERT INTO order_loading_card_events (session_id,event_type,actor_id,details_json)
          VALUES (?,?,?,?)
        `).run(session.id, 'cancelled', actorId || null, JSON.stringify({ reason, source: 'order_cancellation' }));
      } else {
        db.prepare(`
          INSERT INTO order_loading_events (session_id,event_type,actor_id,details_json)
          VALUES (?,?,?,?)
        `).run(session.id, 'cancelled', actorId || null, JSON.stringify({ reason, source: 'order_cancellation' }));
      }
    }
    return sessions.length;
  }

  function markCancelledPackages({ orderId, itemIds, completeOrder }) {
    const rows = db.prepare(`
      SELECT id,item_ids FROM packages
      WHERE order_id=? AND status IN ('packed','ready','staged')
    `).all(orderId);
    let cancelled = 0;
    const selected = new Set(itemIds.map(Number));
    for (const row of rows) {
      const ids = packageItemIds(row.item_ids);
      if (!completeOrder && !ids.length) continue;
      if (!completeOrder && !ids.every(id => selected.has(id))) continue;
      const result = db.prepare(`UPDATE packages SET status='cancelled' WHERE id=? AND status IN ('packed','ready','staged')`).run(row.id);
      cancelled += Number(result.changes || 0);
    }
    return cancelled;
  }

  function transactionResult(transactionId, replay = false) {
    const transaction = db.prepare(`
      SELECT * FROM order_cancellation_transactions WHERE id=?
    `).get(transactionId);
    if (!transaction) fail('cancellation_transaction_not_found', 404);
    const items = db.prepare(`
      SELECT d.*,l.lot_uid,l.warehouse_id,l.location_code
      FROM order_cancellation_item_dispositions d
      LEFT JOIN finished_goods_lots l ON l.cancellation_transaction_id=d.cancellation_transaction_id
        AND l.source_order_item_id=d.source_order_item_id
      WHERE d.cancellation_transaction_id=? ORDER BY d.id
    `).all(transactionId).map(row => ({
      ...row,
      source_production_refs: safeJson(row.source_production_refs_json, {}),
      reconciliation: safeJson(row.reconciliation_json, {}),
    }));
    return {
      success: true,
      replay,
      cancellation_transaction_id: Number(transaction.id),
      cancellation_uid: transaction.cancellation_uid,
      idempotency_key: transaction.idempotency_key,
      order_id: Number(transaction.order_id),
      scope: transaction.scope_type,
      items,
    };
  }

  function cancel(input = {}) {
    const orderId = positiveInteger(input.order_id ?? input.orderId, 'order_id');
    const scope = String(input.scope || (input.item_id || input.itemId ? 'item' : 'order')).trim();
    if (!['order', 'item'].includes(scope)) fail('invalid_cancellation_scope');
    const reason = text(input.reason ?? input.cancellation_reason, 'cancellation_reason', { required: true, maxLength: 1000 });
    if (reason.length < 3) fail('cancellation_reason_too_short');
    const actorId = input.actor_id ?? input.actorId ?? null;
    const parsedActorId = actorId === null || actorId === undefined || actorId === '' ? null : positiveInteger(actorId, 'actor_id');
    const actorName = text(input.actor_name ?? input.actorName, 'actor_name', { maxLength: 200 });
    const itemInputs = normalizedItemInputs(input.items ?? input.item_dispositions ?? input.itemDispositions);
    const itemIds = itemInputs.map(row => row.item_id).sort((left, right) => left - right);
    const correctionAuthorized = input.production_record_correction_authorized === true;
    const requestedItemId = input.item_id ?? input.itemId;
    if (scope === 'item') {
      if (itemIds.length !== 1) fail('item_cancellation_requires_exactly_one_item', 409);
      if (requestedItemId != null && itemIds[0] !== positiveInteger(requestedItemId, 'item_id')) {
        fail('item_cancellation_scope_mismatch', 409);
      }
    }
    const fallbackKey = `order-cancellation:${orderId}:${scope}:${itemIds.join(',')}`;
    const idempotencyKey = normalizedIdempotencyKey(input.idempotency_key ?? input.idempotencyKey, fallbackKey);
    const fingerprint = sha256(stableCanonicalStringify({
      order_id: orderId, scope, reason, item_inputs: itemInputs.map(row => ({ ...row, item_id: Number(row.item_id) })).sort((a, b) => a.item_id - b.item_id),
    }));

    const run = db.transaction(() => {
      const replay = db.prepare(`SELECT id,payload_fingerprint FROM order_cancellation_transactions WHERE idempotency_key=?`).get(idempotencyKey);
      if (replay) {
        if (replay.payload_fingerprint !== fingerprint) fail('idempotency_key_conflict', 409);
        return transactionResult(replay.id, true);
      }

      const order = db.prepare('SELECT id,order_num,status FROM orders WHERE id=?').get(orderId);
      if (!order) fail('order_not_found', 404);
      const rawItems = orderItems(db, orderId, itemIds);
      const selectedItemIds = rawItems.map(item => Number(item.id)).sort((left, right) => left - right);
      if (selectedItemIds.length !== itemIds.length || selectedItemIds.some((id, index) => id !== itemIds[index])) {
        fail('item_not_found_for_order', 404);
      }

      const reviewItems = rawItems.map(item => cancellationReviewForItem(db, item));
      const alreadyCancelled = reviewItems.filter(item => item.already_cancelled).map(item => item.item_id);
      if (alreadyCancelled.length) fail('item_already_cancelled', 409, { item_ids: alreadyCancelled });
      const ambiguous = reviewItems.filter(item => item.warnings.length).map(item => ({ item_id: item.item_id, warnings: item.warnings }));
      if (ambiguous.length) fail('packed_quantity_requires_reconciliation', 409, { items: ambiguous });

      const activeSessions = db.prepare(`SELECT id FROM order_loading_sessions WHERE order_id=? AND status='active'`).all(orderId);
      if (scope === 'item' && activeSessions.length) {
        fail('active_loading_session_requires_reconciliation', 409, { session_ids: activeSessions.map(row => Number(row.id)) });
      }

      const allOrderReviewItems = orderItems(db, orderId).map(item => cancellationReviewForItem(db, item));
      const activeOrderItemIds = allOrderReviewItems
        .filter(item => !item.already_cancelled)
        .map(item => Number(item.item_id))
        .sort((left, right) => left - right);
      const completeOrder = scope === 'order'
        && selectedItemIds.length === activeOrderItemIds.length
        && selectedItemIds.every((id, index) => id === activeOrderItemIds[index]);
      if (scope === 'order' && !completeOrder) fail('complete_order_cancellation_requires_all_items', 409);

      const inputByItem = new Map(itemInputs.map(row => [row.item_id, row]));
      const normalized = [];
      for (const reviewItem of reviewItems) {
        const disposition = inputByItem.get(reviewItem.item_id);
        const effectiveBeforeCorrection = reviewItem.confirmed_produced_qty;
        let effectiveProducedQty = effectiveBeforeCorrection;
        let correctionQty = 0;
        let correctionReason = null;
        if (disposition.production_reality !== 'PRODUCED_AS_RECORDED') {
          if (!correctionAuthorized) fail('production_record_correction_not_authorized', 403, { item_id: reviewItem.item_id });
          if (disposition.production_reality === 'NOT_ACTUALLY_PRODUCED') {
            if (disposition.actual_produced_qty != null && disposition.actual_produced_qty > EPSILON) {
              fail('not_actually_produced_requires_zero_actual_quantity', 409, { item_id: reviewItem.item_id });
            }
            effectiveProducedQty = 0;
          } else {
            if (disposition.actual_produced_qty == null) fail('actual_produced_quantity_required', 409, { item_id: reviewItem.item_id });
            effectiveProducedQty = disposition.actual_produced_qty;
          }
          if (effectiveProducedQty > effectiveBeforeCorrection + EPSILON) {
            fail('actual_produced_quantity_exceeds_effective_production', 409, {
              item_id: reviewItem.item_id, effective_produced_qty: effectiveBeforeCorrection,
            });
          }
          correctionQty = round(effectiveBeforeCorrection - effectiveProducedQty);
          if (correctionQty <= EPSILON) {
            fail('production_record_correction_requires_lower_actual_quantity', 409, { item_id: reviewItem.item_id });
          }
          correctionReason = disposition.production_correction_reason;
          if (!correctionReason || correctionReason.length < 3) {
            fail('production_record_correction_reason_required', 409, { item_id: reviewItem.item_id });
          }
          const requiredPhysicalQty = Math.max(
            reviewItem.delivered_qty,
            reviewItem.packed_qty,
            reviewItem.picked_qty,
            round(reviewItem.previous_stock_qty + reviewItem.previous_scrap_qty),
          );
          if (effectiveProducedQty + EPSILON < requiredPhysicalQty) {
            fail('downstream_physical_evidence_requires_reconciliation', 409, {
              item_id: reviewItem.item_id,
              requested_actual_produced_qty: effectiveProducedQty,
              required_physical_qty: requiredPhysicalQty,
              delivered_qty: reviewItem.delivered_qty,
              packed_qty: reviewItem.packed_qty,
              picked_qty: reviewItem.picked_qty,
              previously_disposed_qty: round(reviewItem.previous_stock_qty + reviewItem.previous_scrap_qty),
            });
          }
          const materialConsumption = materialConsumptionEvidence(db, reviewItem.item_id);
          if (materialConsumption.net_consumed_kg > EPSILON) {
            fail('material_consumption_requires_reversal_before_production_correction', 409, {
              item_id: reviewItem.item_id,
              net_consumed_kg: materialConsumption.net_consumed_kg,
              consumption_events: materialConsumption.events,
            });
          }
        }
        const eligibleProducedQty = round(Math.max(0, effectiveProducedQty
          - reviewItem.delivered_qty - reviewItem.previous_stock_qty - reviewItem.previous_scrap_qty));
        const cancelledUnproducedQty = round(Math.max(0, reviewItem.ordered_qty - effectiveProducedQty));
        const stockQty = disposition.stock_disposition_qty;
        const scrapQty = disposition.scrap_disposition_qty;
        if (!sameQty(stockQty + scrapQty, eligibleProducedQty)) {
          fail('disposition_quantity_must_equal_eligible_produced_qty', 409, {
            item_id: reviewItem.item_id,
            stock_disposition_qty: stockQty,
            scrap_disposition_qty: scrapQty,
            eligible_produced_qty: eligibleProducedQty,
          });
        }
        let warehouse = null;
        let location = null;
        if (stockQty > EPSILON) {
          warehouse = warehouseForDisposition(disposition.destination_warehouse_id);
          location = disposition.destination_location;
          if (warehouse.requires_location && !location) {
            fail('destination_location_required', 409, { item_id: reviewItem.item_id, warehouse_id: warehouse.id });
          }
        }
        const scrapReason = scrapQty > EPSILON ? (disposition.scrap_reason || reason) : null;
        if (scrapQty > EPSILON && (!scrapReason || scrapReason.length < 3)) fail('scrap_reason_required', 409, { item_id: reviewItem.item_id });
        const effectiveReviewItem = {
          ...reviewItem,
          confirmed_produced_qty: effectiveProducedQty,
          erroneous_production_correction_qty: round(reviewItem.erroneous_production_correction_qty + correctionQty),
          eligible_produced_qty: eligibleProducedQty,
          cancelled_unproduced_qty: cancelledUnproducedQty,
          production_state: itemProductionState(reviewItem.ordered_qty, effectiveProducedQty),
          // A corrected recorded weight is no longer reliable measured physical
          // weight; retain it in original event history but use calculated weight.
          measured_produced_weight_kg: correctionQty > EPSILON ? null : reviewItem.measured_produced_weight_kg,
          reconciliation: {
            ...reviewItem.reconciliation,
            recorded_produced_qty: reviewItem.recorded_produced_qty,
            erroneous_production_correction_qty: round(reviewItem.erroneous_production_correction_qty + correctionQty),
            produced_qty: effectiveProducedQty,
            eligible_produced_qty: eligibleProducedQty,
            cancelled_unproduced_qty: cancelledUnproducedQty,
            accounted_produced_qty: round(reviewItem.delivered_qty + reviewItem.previous_stock_qty + reviewItem.previous_scrap_qty + eligibleProducedQty),
            unexplained_qty: 0,
            valid: sameQty(reviewItem.ordered_qty, effectiveProducedQty + cancelledUnproducedQty),
          },
        };
        normalized.push({
          reviewItem: effectiveReviewItem, originalReviewItem: reviewItem, disposition,
          stockQty, scrapQty, warehouse, location, scrapReason,
          correctionQty, correctionReason, effectiveBeforeCorrection,
        });
      }

      const unassignedReservations = completeOrder
        ? db.prepare(`SELECT id FROM inventory_reservations WHERE order_id=? AND item_id IS NULL AND status='active'`).all(orderId)
        : [];
      const normalizedByItemId = new Map(normalized.map(entry => [entry.reviewItem.item_id, entry.reviewItem]));
      const hasPhysicalProduction = allOrderReviewItems.some(item => (
        (normalizedByItemId.get(item.item_id) || item).confirmed_produced_qty > EPSILON
      ));
      if (unassignedReservations.length && hasPhysicalProduction) {
        fail('unattributed_reservation_requires_reconciliation', 409, { reservation_ids: unassignedReservations.map(row => Number(row.id)) });
      }

      const transactionRow = db.prepare(`
        INSERT INTO order_cancellation_transactions
          (cancellation_uid,order_id,scope_type,idempotency_key,payload_fingerprint,reason,actor_id,actor_name)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(crypto.randomUUID(), orderId, scope, idempotencyKey, fingerprint, reason, parsedActorId, actorName);
      const transactionId = Number(transactionRow.lastInsertRowid);

      let releasedReservationCount = 0;
      let releasedReservationKg = 0;
      for (const entry of normalized) {
        const item = rawItems.find(row => Number(row.id) === entry.reviewItem.item_id);
        let sourceRefs = { ...entry.reviewItem.source_production_refs };
        if (entry.correctionQty > EPSILON) {
          const correction = db.prepare(`
            INSERT INTO production_record_correction_events
              (correction_uid,correction_type,cancellation_transaction_id,source_order_id,source_order_item_id,
               recorded_produced_qty,correction_qty,effective_produced_qty_before,effective_produced_qty_after,
               reason,source_production_refs_json,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            crypto.randomUUID(), 'ERRONEOUS_PRODUCTION_RECORD', transactionId, orderId, item.id,
            entry.originalReviewItem.recorded_produced_qty, entry.correctionQty,
            entry.effectiveBeforeCorrection, entry.reviewItem.confirmed_produced_qty,
            entry.correctionReason, JSON.stringify(sourceRefs), parsedActorId,
          );
          const correctionEventId = Number(correction.lastInsertRowid);
          sourceRefs = {
            ...sourceRefs,
            production_record_correction_event_ids: [
              ...(sourceRefs.production_record_correction_event_ids || []), correctionEventId,
            ],
          };
          db.prepare(`
            INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(
            'item', item.id, order.order_num, 'erroneous_production_record_corrected', 'effective_produced_qty',
            JSON.stringify({ recorded_produced_qty: entry.originalReviewItem.recorded_produced_qty, effective_produced_qty: entry.effectiveBeforeCorrection }),
            JSON.stringify({ correction_qty: entry.correctionQty, effective_produced_qty: entry.reviewItem.confirmed_produced_qty, correction_event_id: correctionEventId }),
            entry.correctionReason, parsedActorId, actorName,
          );
        }
        const productionQty = entry.reviewItem.confirmed_produced_qty;
        const calculatedWeight = productionQty > 0 && entry.reviewItem.ordered_qty > 0
          ? round(Number(item.total_weight || 0) * productionQty / entry.reviewItem.ordered_qty)
          : 0;
        const measuredWeight = entry.reviewItem.measured_produced_weight_kg;
        let lotId = null;

        if (entry.stockQty > EPSILON) {
          const lot = db.prepare(`
            INSERT INTO finished_goods_lots
              (lot_uid,warehouse_id,location_code,source_order_id,source_order_item_id,cancellation_transaction_id,
               source_production_refs_json,physical_spec_json,physical_spec_fingerprint,produced_quantity,available_quantity,
               calculated_weight_kg,measured_weight_kg,production_date,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            crypto.randomUUID(), entry.warehouse.id, entry.location, orderId, item.id, transactionId,
            JSON.stringify(sourceRefs), JSON.stringify(entry.reviewItem.physical_spec), entry.reviewItem.physical_spec_fingerprint,
            entry.stockQty, entry.stockQty,
            round(calculatedWeight * entry.stockQty / productionQty), measuredWeight == null ? null : round(measuredWeight * entry.stockQty / productionQty),
            entry.reviewItem.production_date, parsedActorId,
          );
          lotId = Number(lot.lastInsertRowid);
          db.prepare(`
            INSERT INTO finished_goods_movements
              (movement_uid,movement_type,lot_id,warehouse_id,location_code,quantity,source_order_id,source_order_item_id,cancellation_transaction_id,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(crypto.randomUUID(), 'cancellation_to_stock', lotId, entry.warehouse.id, entry.location, entry.stockQty, orderId, item.id, transactionId, parsedActorId);
        }

        if (entry.scrapQty > EPSILON) {
          db.prepare(`
            INSERT INTO finished_goods_scrap_movements
              (movement_uid,movement_type,source_order_id,source_order_item_id,cancellation_transaction_id,source_production_refs_json,
               quantity,calculated_weight_kg,measured_weight_kg,reason,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            crypto.randomUUID(), 'cancellation_scrap_write_off', orderId, item.id, transactionId, JSON.stringify(sourceRefs),
            entry.scrapQty, round(calculatedWeight * entry.scrapQty / productionQty), measuredWeight == null ? null : round(measuredWeight * entry.scrapQty / productionQty),
            entry.scrapReason, parsedActorId,
          );
        }

        const reconciliation = {
          ...entry.reviewItem.reconciliation,
          recorded_produced_qty: entry.originalReviewItem.recorded_produced_qty,
          erroneous_production_correction_qty: entry.reviewItem.erroneous_production_correction_qty,
          eligible_produced_qty: entry.reviewItem.eligible_produced_qty,
          stock_disposition_qty: entry.stockQty,
          scrap_disposition_qty: entry.scrapQty,
          explained_produced_qty: round(entry.reviewItem.delivered_qty + entry.reviewItem.previous_stock_qty + entry.reviewItem.previous_scrap_qty + entry.stockQty + entry.scrapQty),
          unexplained_qty: 0,
        };
        db.prepare(`
          INSERT INTO order_cancellation_item_dispositions
            (cancellation_transaction_id,order_id,source_order_item_id,ordered_qty,recorded_produced_qty,confirmed_produced_qty,erroneous_production_correction_qty,delivered_qty,packed_qty,picked_qty,
             previous_stock_qty,previous_scrap_qty,eligible_produced_qty,stock_disposition_qty,scrap_disposition_qty,cancelled_unproduced_qty,
             production_state,disposition_type,source_production_refs_json,reconciliation_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          transactionId, orderId, item.id, entry.reviewItem.ordered_qty, entry.originalReviewItem.recorded_produced_qty,
          productionQty, entry.reviewItem.erroneous_production_correction_qty,
          entry.reviewItem.delivered_qty, entry.reviewItem.packed_qty, entry.reviewItem.picked_qty,
          entry.reviewItem.previous_stock_qty, entry.reviewItem.previous_scrap_qty, entry.reviewItem.eligible_produced_qty,
          entry.stockQty, entry.scrapQty, entry.reviewItem.cancelled_unproduced_qty,
          entry.reviewItem.production_state, dispositionType(entry.stockQty, entry.scrapQty),
          JSON.stringify(sourceRefs), JSON.stringify(reconciliation),
        );
        db.prepare(`
          UPDATE items
          SET status=?, cancelled_at=CURRENT_TIMESTAMP, cancelled_by=?, cancellation_reason=?,
              production_stopped_at=CURRENT_TIMESTAMP, cancelled_unproduced_qty=?
          WHERE id=?
        `).run(ITEM_STATUS.CANCELLED, parsedActorId, reason, entry.reviewItem.cancelled_unproduced_qty, item.id);
        const released = releaseActiveReservations({ transactionId, orderId, item, reviewItem: entry.reviewItem, actorId: parsedActorId });
        releasedReservationCount += released.released_reservations;
        releasedReservationKg = round(releasedReservationKg + released.released_kg);
        db.prepare(`UPDATE material_requirements_v2 SET status='cancelled' WHERE order_id=? AND item_id=? AND status='open'`).run(orderId, item.id);
        db.prepare(`
          UPDATE allocation_plan_lines_v2
          SET status='released', released_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE status='active' AND allocation_plan_id IN (
            SELECT p.id FROM allocation_plans_v2 p
            JOIN material_requirements_v2 r ON r.id=p.material_requirement_id
            WHERE r.order_id=? AND r.item_id=?
          )
        `).run(orderId, item.id);
        db.prepare(`
          UPDATE allocation_plans_v2
          SET status='cancelled',released_by=?,released_at=CURRENT_TIMESTAMP,release_reason='order_cancellation_unproduced_remainder',updated_at=CURRENT_TIMESTAMP
          WHERE status='active' AND material_requirement_id IN (
            SELECT id FROM material_requirements_v2 WHERE order_id=? AND item_id=? AND status='cancelled'
          )
        `).run(parsedActorId, orderId, item.id);
        db.prepare(`
          INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          'item', item.id, order.order_num, 'cancellation_disposition', 'production_reconciliation',
          JSON.stringify({ status: item.status, produced_qty: item.produced_qty }),
          JSON.stringify(reconciliation), reason, parsedActorId, actorName,
        );
      }

      if (completeOrder) {
        const released = releaseUnattributedReservations({ transactionId, orderId, actorId: parsedActorId });
        releasedReservationCount += released.released_reservations;
        releasedReservationKg = round(releasedReservationKg + released.released_kg);
        cancelActiveLoadingForOrder({ orderId, actorId: parsedActorId, reason });
      }
      markCancelledPackages({ orderId, itemIds: selectedItemIds, completeOrder });

      const remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? AND i.status<>?`)
        .get(orderId, ITEM_STATUS.CANCELLED).count || 0);
      if (remaining === 0) {
        db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.CANCELLED, orderId);
        db.prepare(`
          INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run('order', orderId, order.order_num, 'cancellation_completed', 'status', order.status, ORDER_STATUS.CANCELLED, reason, parsedActorId, actorName);
      }

      const result = transactionResult(transactionId, false);
      result.released_reservations = { count: releasedReservationCount, kg: releasedReservationKg };
      return result;
    });

    return run.immediate();
  }

  return { listWarehouses, review, cancel };
}

module.exports = {
  OrderCancellationError,
  PRODUCTION_STATES,
  effectiveProductionEvidence,
  effectiveProductionQuantity,
  createOrderCancellationService,
};
