'use strict';

const crypto = require('node:crypto');
const { ITEM_STATUS, ORDER_STATUS } = require('../status-contracts');
const { createOrderCancellationService, OrderCancellationError } = require('./orderCancellation');
const { stableCanonicalStringify } = require('./physicalSpecFingerprint');

const EPSILON = 0.0001;
const REALITIES = new Set(['PRODUCED_AS_RECORDED', 'NOT_ACTUALLY_PRODUCED', 'PARTIALLY_PRODUCED']);
const round = value => Math.round((Number(value) || 0) * 1000) / 1000;
const sameQty = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) <= EPSILON;
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function fail(code, statusCode = 400, details = null) {
  throw new OrderCancellationError(code, statusCode, details);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(`invalid_${field}`);
  return number;
}

function nonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`invalid_${field}`);
  return round(number);
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (text.length < 3 || text.length > 1000) fail(`invalid_${field}`);
  return text;
}

function optionalText(value, maxLength = 200) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > maxLength) fail('invalid_text');
  return text || null;
}

function historicalStatus(order, item) {
  const values = [order?.status, item?.status].filter(Boolean).join(' ').toLowerCase();
  return item?.completed_at != null
    || [ITEM_STATUS.DONE, ITEM_STATUS.DELIVERED, ITEM_STATUS.CANCELLED].includes(item?.status)
    || [ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.DELIVERED_CONFIRMED, ORDER_STATUS.CANCELLED, ORDER_STATUS.PARTIAL_DELIVERY, ORDER_STATUS.SENT].includes(order?.status)
    || /completed|closed|cancelled|archiv|הושל|סגור|בוטל|סופק/.test(values);
}

function legacyEvidence(item) {
  const refs = item.source_production_refs || {};
  const cards = refs.production_card_weight_ids || [];
  const events = refs.production_output_event_ids || [];
  const missing = [];
  if (!cards.length) missing.push('missing_production_card_weights');
  if (!events.length) missing.push('missing_production_output_events');
  if (!Number(item.measured_produced_weight_kg || 0)) missing.push('missing_measured_production_weight');
  return {
    mode: missing.length ? 'LEGACY_MANUAL_RECONCILIATION' : 'EVIDENCE_BACKED',
    missing_evidence: missing,
    note: missing.length
      ? 'נתוני הייצור ההיסטוריים חסרים חלקית; הכמות הפיזית היא הצהרת פיוס ידנית ומתועדת.'
      : 'קיימות ראיות ייצור שמורות; התיקון עדיין אינו משנה את רשומות המקור.',
  };
}

function createHistoricalProductionReconciliationService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('invalid database');
  const cancellation = createOrderCancellationService(db);

  function itemContext(orderId, itemId) {
    const order = db.prepare('SELECT id,order_num,status FROM orders WHERE id=?').get(orderId);
    if (!order) fail('order_not_found', 404);
    const item = db.prepare(`
      SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id
      WHERE p.order_id=? AND i.id=?
    `).get(orderId, itemId);
    if (!item) fail('item_not_found_for_order', 404);
    if (!historicalStatus(order, item)) fail('historical_order_item_required', 409);
    return { order, item };
  }

  function existingReconciliation(itemId) {
    return db.prepare(`
      SELECT h.*,t.reconciliation_uid,t.reason,t.actor_id,t.actor_name,t.created_at AS transaction_created_at
      FROM historical_production_reconciliation_items h
      JOIN historical_production_reconciliation_transactions t ON t.id=h.reconciliation_transaction_id
      WHERE h.source_order_item_id=?
    `).get(itemId) || null;
  }

  function warehouse(value) {
    const id = positiveInteger(value, 'destination_warehouse_id');
    const row = db.prepare('SELECT id,warehouse_code,name,requires_location FROM finished_goods_warehouses WHERE id=? AND active=1').get(id);
    if (!row) fail('destination_warehouse_not_found', 404);
    return row;
  }

  function review({ order_id, orderId, item_id, itemId } = {}) {
    const normalizedOrderId = positiveInteger(order_id ?? orderId, 'order_id');
    const normalizedItemId = positiveInteger(item_id ?? itemId, 'item_id');
    const { order, item: rawItem } = itemContext(normalizedOrderId, normalizedItemId);
    const base = cancellation.review({ order_id: normalizedOrderId, item_id: normalizedItemId, scope: 'item' }).items[0];
    const existing = existingReconciliation(normalizedItemId);
    const unreconciledPhysicalQty = round(Math.max(0, base.confirmed_produced_qty
      - base.delivered_qty - base.previous_stock_qty - base.previous_scrap_qty));
    return {
      order_id: normalizedOrderId,
      order_num: order.order_num,
      order_status: order.status,
      item_id: normalizedItemId,
      item_label: base.item_label,
      historical: true,
      already_reconciled: Boolean(existing),
      existing_reconciliation: existing ? {
        reconciliation_uid: existing.reconciliation_uid,
        reconciliation_transaction_id: Number(existing.reconciliation_transaction_id),
        production_reality: existing.production_reality,
        effective_produced_qty_after: Number(existing.effective_produced_qty_after),
        created_at: existing.transaction_created_at,
      } : null,
      originally_ordered_qty: base.ordered_qty,
      originally_recorded_produced_qty: base.recorded_produced_qty,
      effective_physical_produced_qty: base.confirmed_produced_qty,
      delivered_qty: base.delivered_qty,
      packed_qty: base.packed_qty,
      picked_qty: base.picked_qty,
      existing_stock_disposition_qty: base.previous_stock_qty,
      existing_scrap_disposition_qty: base.previous_scrap_qty,
      unreconciled_physical_qty: unreconciledPhysicalQty,
      historical_correction_state: Number(base.erroneous_production_correction_qty || 0) > 0 ? 'CORRECTED' : 'UNCORRECTED',
      production_state: base.production_state,
      physical_spec: base.physical_spec,
      physical_spec_fingerprint: base.physical_spec_fingerprint,
      production_date: base.production_date,
      calculated_produced_weight_kg: base.calculated_produced_weight_kg,
      measured_produced_weight_kg: base.measured_produced_weight_kg,
      source_production_refs: base.source_production_refs,
      downstream_evidence: base.downstream_evidence,
      legacy_evidence: legacyEvidence(base),
      warehouses: cancellation.listWarehouses(),
      reconciliation_preview: {
        before: {
          recorded_produced_qty: base.recorded_produced_qty,
          effective_produced_qty: base.confirmed_produced_qty,
          stock_qty: base.previous_stock_qty,
          scrap_qty: base.previous_scrap_qty,
        },
      },
    };
  }

  function normalizeInput(input) {
    const orderId = positiveInteger(input.order_id ?? input.orderId, 'order_id');
    const itemId = positiveInteger(input.item_id ?? input.itemId, 'item_id');
    const productionReality = String(input.production_reality ?? input.productionReality ?? 'PRODUCED_AS_RECORDED').trim();
    if (!REALITIES.has(productionReality)) fail('invalid_production_reality');
    const actualInput = input.actual_produced_qty ?? input.actualProducedQty;
    const actualProducedQty = actualInput === undefined || actualInput === null || actualInput === '' ? null : nonNegative(actualInput, 'actual_produced_qty');
    const actorId = input.actor_id ?? input.actorId;
    return {
      orderId, itemId, productionReality, actualProducedQty,
      stockQty: nonNegative(input.stock_disposition_qty ?? input.stockDispositionQty ?? 0, 'stock_disposition_qty'),
      scrapQty: nonNegative(input.scrap_disposition_qty ?? input.scrapDispositionQty ?? 0, 'scrap_disposition_qty'),
      warehouseId: input.destination_warehouse_id ?? input.destinationWarehouseId ?? null,
      location: optionalText(input.destination_location ?? input.destinationLocation ?? input.location),
      reason: requiredText(input.reason ?? input.correction_reason, 'historical_reconciliation_reason'),
      actorId: actorId == null || actorId === '' ? null : positiveInteger(actorId, 'actor_id'),
      actorName: optionalText(input.actor_name ?? input.actorName),
      authorized: input.historical_reconciliation_authorized === true,
      idempotencyKey: String(input.idempotency_key ?? input.idempotencyKey ?? '').trim(),
    };
  }

  function result(transactionId, replay = false) {
    const transaction = db.prepare('SELECT * FROM historical_production_reconciliation_transactions WHERE id=?').get(transactionId);
    if (!transaction) fail('historical_reconciliation_not_found', 404);
    const item = db.prepare(`
      SELECT h.*,l.lot_uid,l.warehouse_id,l.location_code
      FROM historical_production_reconciliation_items h
      LEFT JOIN historical_finished_goods_lots l ON l.reconciliation_transaction_id=h.reconciliation_transaction_id
        AND l.source_order_item_id=h.source_order_item_id
      WHERE h.reconciliation_transaction_id=?
    `).get(transactionId);
    return {
      success: true, replay,
      historical_reconciliation_transaction_id: Number(transaction.id),
      historical_reconciliation_uid: transaction.reconciliation_uid,
      order_id: Number(transaction.order_id),
      item: item && { ...item, source_production_refs: JSON.parse(item.source_production_refs_json), reconciliation: JSON.parse(item.reconciliation_json) },
    };
  }

  function reconcile(input = {}) {
    const value = normalizeInput(input);
    if (!value.authorized) fail('historical_reconciliation_not_authorized', 403);
    if (!value.idempotencyKey || value.idempotencyKey.length > 200) fail('invalid_idempotency_key');
    const fingerprint = hash(stableCanonicalStringify({
      operation: 'historical_production_reconciliation',
      order_id: value.orderId, item_id: value.itemId, production_reality: value.productionReality,
      actual_produced_qty: value.actualProducedQty, stock_qty: value.stockQty, scrap_qty: value.scrapQty,
      warehouse_id: value.warehouseId, location: value.location, reason: value.reason,
    }));
    const commit = db.transaction(() => {
      const replay = db.prepare('SELECT id,payload_fingerprint FROM historical_production_reconciliation_transactions WHERE idempotency_key=?').get(value.idempotencyKey);
      if (replay) {
        if (replay.payload_fingerprint !== fingerprint) fail('idempotency_key_conflict', 409);
        return result(replay.id, true);
      }
      const current = review({ order_id: value.orderId, item_id: value.itemId });
      if (current.already_reconciled) fail('historical_item_already_reconciled', 409, current.existing_reconciliation);
      const effectiveBefore = current.effective_physical_produced_qty;
      let effectiveAfter = effectiveBefore;
      if (value.productionReality === 'NOT_ACTUALLY_PRODUCED') {
        if (value.actualProducedQty != null && value.actualProducedQty > EPSILON) fail('not_actually_produced_requires_zero_actual_quantity', 409);
        effectiveAfter = 0;
      } else if (value.productionReality === 'PARTIALLY_PRODUCED') {
        if (value.actualProducedQty == null) fail('actual_produced_quantity_required', 409);
        effectiveAfter = value.actualProducedQty;
        if (effectiveAfter >= effectiveBefore - EPSILON) fail('partial_production_requires_lower_actual_quantity', 409);
      }
      if (effectiveAfter > effectiveBefore + EPSILON) fail('actual_produced_quantity_exceeds_effective_production', 409);
      const requiredPhysicalQty = Math.max(current.delivered_qty, current.packed_qty, current.picked_qty,
        round(current.existing_stock_disposition_qty + current.existing_scrap_disposition_qty));
      if (effectiveAfter + EPSILON < requiredPhysicalQty) {
        fail('downstream_physical_evidence_requires_reconciliation', 409, {
          item_id: value.itemId, requested_actual_produced_qty: effectiveAfter, required_physical_qty: requiredPhysicalQty,
          delivered_qty: current.delivered_qty, packed_qty: current.packed_qty, picked_qty: current.picked_qty,
          existing_stock_qty: current.existing_stock_disposition_qty, existing_scrap_qty: current.existing_scrap_disposition_qty,
        });
      }
      if (Number(current.downstream_evidence?.net_material_consumed_kg || 0) > EPSILON && effectiveAfter < effectiveBefore - EPSILON) {
        fail('material_consumption_requires_reversal_before_historical_correction', 409, current.downstream_evidence);
      }
      const eligibleQty = round(Math.max(0, effectiveAfter - current.delivered_qty
        - current.existing_stock_disposition_qty - current.existing_scrap_disposition_qty));
      if (!sameQty(value.stockQty + value.scrapQty, eligibleQty)) {
        fail('disposition_quantity_must_equal_unreconciled_physical_quantity', 409, { eligible_produced_qty: eligibleQty });
      }
      let destination = null;
      if (value.stockQty > EPSILON) {
        destination = warehouse(value.warehouseId);
        if (destination.requires_location && !value.location) fail('destination_location_required', 409, { warehouse_id: destination.id });
      }
      const rawItem = itemContext(value.orderId, value.itemId).item;
      const correctionQty = round(effectiveBefore - effectiveAfter);
      const transactionRow = db.prepare(`
        INSERT INTO historical_production_reconciliation_transactions
          (reconciliation_uid,order_id,idempotency_key,payload_fingerprint,reason,actor_id,actor_name)
        VALUES (?,?,?,?,?,?,?)
      `).run(crypto.randomUUID(), value.orderId, value.idempotencyKey, fingerprint, value.reason, value.actorId, value.actorName);
      const transactionId = Number(transactionRow.lastInsertRowid);
      const sourceRefs = { ...current.source_production_refs, historical_reconciliation_transaction_id: transactionId };
      const calculatedWeight = effectiveAfter > 0 && current.originally_ordered_qty > 0
        ? round(Number(rawItem.total_weight || 0) * effectiveAfter / current.originally_ordered_qty) : 0;
      const measuredWeight = correctionQty > EPSILON ? null : current.measured_produced_weight_kg;
      let lotId = null;
      if (value.stockQty > EPSILON) {
        const lot = db.prepare(`
          INSERT INTO historical_finished_goods_lots
            (lot_uid,warehouse_id,location_code,source_order_id,source_order_item_id,reconciliation_transaction_id,
             source_production_refs_json,physical_spec_json,physical_spec_fingerprint,produced_quantity,available_quantity,
             calculated_weight_kg,measured_weight_kg,production_date,actor_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(crypto.randomUUID(), destination.id, value.location, value.orderId, value.itemId, transactionId,
          JSON.stringify(sourceRefs), JSON.stringify(current.physical_spec), current.physical_spec_fingerprint,
          value.stockQty, value.stockQty, round(calculatedWeight * value.stockQty / effectiveAfter),
          measuredWeight == null ? null : round(measuredWeight * value.stockQty / effectiveAfter), current.production_date, value.actorId);
        lotId = Number(lot.lastInsertRowid);
        db.prepare(`
          INSERT INTO historical_finished_goods_movements
            (movement_uid,movement_type,lot_id,warehouse_id,location_code,quantity,source_order_id,source_order_item_id,reconciliation_transaction_id,actor_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(crypto.randomUUID(), 'historical_reconciliation_to_stock', lotId, destination.id, value.location, value.stockQty, value.orderId, value.itemId, transactionId, value.actorId);
      }
      if (value.scrapQty > EPSILON) {
        db.prepare(`
          INSERT INTO historical_finished_goods_scrap_movements
            (movement_uid,movement_type,source_order_id,source_order_item_id,reconciliation_transaction_id,source_production_refs_json,
             quantity,calculated_weight_kg,measured_weight_kg,reason,actor_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(crypto.randomUUID(), 'historical_reconciliation_scrap_write_off', value.orderId, value.itemId, transactionId,
          JSON.stringify(sourceRefs), value.scrapQty, round(calculatedWeight * value.scrapQty / effectiveAfter),
          measuredWeight == null ? null : round(measuredWeight * value.scrapQty / effectiveAfter), value.reason, value.actorId);
      }
      const reconciliation = {
        before: current.reconciliation_preview.before,
        after: {
          actual_produced_qty: effectiveAfter, historical_production_correction_qty: correctionQty,
          stock_disposition_qty: value.stockQty, scrap_disposition_qty: value.scrapQty,
          delivered_qty: current.delivered_qty, unexplained_qty: 0,
        },
        legacy_evidence: current.legacy_evidence,
      };
      db.prepare(`
        INSERT INTO historical_production_reconciliation_items
          (reconciliation_transaction_id,order_id,source_order_item_id,ordered_qty,recorded_produced_qty,effective_produced_qty_before,
           production_correction_qty,effective_produced_qty_after,delivered_qty,packed_qty,picked_qty,previous_stock_qty,previous_scrap_qty,
           eligible_produced_qty,stock_disposition_qty,scrap_disposition_qty,unreconciled_physical_qty,production_reality,source_production_refs_json,reconciliation_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(transactionId, value.orderId, value.itemId, current.originally_ordered_qty, current.originally_recorded_produced_qty,
        effectiveBefore, correctionQty, effectiveAfter, current.delivered_qty, current.packed_qty, current.picked_qty,
        current.existing_stock_disposition_qty, current.existing_scrap_disposition_qty, eligibleQty, value.stockQty, value.scrapQty,
        0, value.productionReality, JSON.stringify(sourceRefs), JSON.stringify(reconciliation));
      db.prepare(`
        INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run('item', value.itemId, current.order_num, 'historical_production_reconciliation', 'effective_produced_qty',
        JSON.stringify({ recorded_produced_qty: current.originally_recorded_produced_qty, effective_produced_qty: effectiveBefore }),
        JSON.stringify({ effective_produced_qty: effectiveAfter, correction_qty: correctionQty, stock_qty: value.stockQty, scrap_qty: value.scrapQty, transaction_id: transactionId }),
        value.reason, value.actorId, value.actorName);
      return result(transactionId, false);
    });
    return commit.immediate();
  }

  return { review, reconcile };
}

module.exports = { createHistoricalProductionReconciliationService };
