'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { ensureCoreSchema } = require('../db/coreSchema');
const { createHistoricalProductionReconciliationService } = require('../services/historicalProductionReconciliation');
const { effectiveProductionQuantity } = require('../services/orderCancellation');
const { ITEM_STATUS, ORDER_STATUS } = require('../status-contracts');
const statusContracts = require('../status-contracts');
const productionActuals = require('../services/productionActuals');
const createReportsRouter = require('../routes/reports');

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  ensureCoreSchema(db);
  const actorId = Number(db.prepare("INSERT INTO users (username,display_name,role) VALUES ('historical-test','Historical Test','manager')").run().lastInsertRowid);
  return { db, actorId, service: createHistoricalProductionReconciliationService(db) };
}

function historicalItem(db, { orderNum, orderStatus = ORDER_STATUS.DONE_WAITING_PICKUP, itemStatus = ITEM_STATUS.DONE, quantity = 100, producedQty = 100 } = {}) {
  const orderId = Number(db.prepare('INSERT INTO orders (order_num,status,total_weight,billing_weight) VALUES (?,?,?,?)')
    .run(orderNum, orderStatus, quantity * 2, quantity * 2).lastInsertRowid);
  const palletId = Number(db.prepare('INSERT INTO pallets (order_id,pallet_num,total_weight) VALUES (?,?,?)').run(orderId, 1, quantity * 2).lastInsertRowid);
  const itemId = Number(db.prepare(`
    INSERT INTO items
      (pallet_id,order_id,item_uid,shape_id,shape_name,diameter,segments,total_length_mm,quantity,production_qty,produced_qty,weight_per_unit,total_weight,status,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).run(palletId, orderId, `legacy-${orderId}:1`, 'straight_bar', 'straight_bar', 12,
    JSON.stringify([{ length_mm: 1000, angle_deg: 0 }]), 1000, quantity, quantity, producedQty, 2, quantity * 2, itemStatus).lastInsertRowid);
  return { orderId, itemId };
}

test('completed legacy item supports a zero physical-production correction without creating stock or scrap', () => {
  const { db, actorId, service } = setup();
  try {
    const { orderId, itemId } = historicalItem(db, { orderNum: 'HIST-FALSE-100' });
    const review = service.review({ order_id: orderId, item_id: itemId });
    assert.equal(review.legacy_evidence.mode, 'LEGACY_MANUAL_RECONCILIATION');
    assert.equal(review.originally_recorded_produced_qty, 100);
    assert.equal(review.effective_physical_produced_qty, 100);
    const payload = {
      order_id: orderId, item_id: itemId, production_reality: 'NOT_ACTUALLY_PRODUCED',
      stock_disposition_qty: 0, scrap_disposition_qty: 0,
      reason: 'השלמה היסטורית: הרישום נסגר ללא ייצור פיזי', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-zero-v1',
    };
    const result = service.reconcile(payload);
    assert.equal(result.replay, false);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, ORDER_STATUS.DONE_WAITING_PICKUP, 'commercial order is not reopened or changed');
    assert.equal(db.prepare('SELECT produced_qty FROM items WHERE id=?').get(itemId).produced_qty, 100, 'original legacy value is preserved');
    const event = db.prepare('SELECT * FROM historical_production_reconciliation_items WHERE source_order_item_id=?').get(itemId);
    assert.deepEqual({ recorded: event.recorded_produced_qty, correction: event.production_correction_qty, after: event.effective_produced_qty_after, stock: event.stock_disposition_qty, scrap: event.scrap_disposition_qty },
      { recorded: 100, correction: 100, after: 0, stock: 0, scrap: 0 });
    assert.equal(effectiveProductionQuantity(db, db.prepare('SELECT * FROM items WHERE id=?').get(itemId)), 0, 'canonical production truth uses the correction');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_finished_goods_lots').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_finished_goods_scrap_movements').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='historical_production_reconciliation'").get().count, 1);
    assert.equal(service.reconcile(payload).replay, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_production_reconciliation_items').get().count, 1);
  } finally { db.close(); }
});

test('cancelled legacy item reconciles partial physical production into traceable stock and scrap', () => {
  const { db, actorId, service } = setup();
  try {
    const { orderId, itemId } = historicalItem(db, { orderNum: 'HIST-PARTIAL-100', orderStatus: ORDER_STATUS.CANCELLED, itemStatus: ITEM_STATUS.CANCELLED });
    const warehouse = service.review({ order_id: orderId, item_id: itemId }).warehouses[0];
    service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'PARTIALLY_PRODUCED', actual_produced_qty: 40,
      stock_disposition_qty: 25, scrap_disposition_qty: 15, destination_warehouse_id: warehouse.id, destination_location: 'LEGACY-A1',
      reason: 'השלמה היסטורית: נוצרו ארבעים יחידות בלבד', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-partial-v1',
    });
    const event = db.prepare('SELECT * FROM historical_production_reconciliation_items WHERE source_order_item_id=?').get(itemId);
    assert.deepEqual({ correction: event.production_correction_qty, actual: event.effective_produced_qty_after, stock: event.stock_disposition_qty, scrap: event.scrap_disposition_qty },
      { correction: 60, actual: 40, stock: 25, scrap: 15 });
    assert.equal(db.prepare('SELECT produced_quantity FROM historical_finished_goods_lots WHERE source_order_item_id=?').get(itemId).produced_quantity, 25);
    assert.equal(db.prepare('SELECT quantity FROM historical_finished_goods_scrap_movements WHERE source_order_item_id=?').get(itemId).quantity, 15);
    assert.equal(effectiveProductionQuantity(db, db.prepare('SELECT * FROM items WHERE id=?').get(itemId)), 40);
    const availability = db.prepare(`
      SELECT available_quantity,source_lot_count
      FROM finished_goods_availability
      WHERE physical_spec_fingerprint=(SELECT physical_spec_fingerprint FROM historical_finished_goods_lots WHERE source_order_item_id=?)
    `).get(itemId);
    assert.deepEqual(availability, { available_quantity: 25, source_lot_count: 1 }, 'historical lots are available through the canonical finished-goods read model');
  } finally { db.close(); }
});

test('as-recorded historical production supports stock-only and scrap-only dispositions without a correction', () => {
  const { db, actorId, service } = setup();
  try {
    const stockOnly = historicalItem(db, { orderNum: 'HIST-STOCK-ONLY' });
    const warehouse = service.review({ order_id: stockOnly.orderId, item_id: stockOnly.itemId }).warehouses[0];
    assert.throws(() => service.reconcile({
      order_id: stockOnly.orderId, item_id: stockOnly.itemId, production_reality: 'PRODUCED_AS_RECORDED',
      stock_disposition_qty: 100, scrap_disposition_qty: 0, destination_warehouse_id: warehouse.id,
      reason: 'ייצור היסטורי תקין למלאי', actor_id: actorId, historical_reconciliation_authorized: true,
      idempotency_key: 'historical-stock-location-required',
    }), error => error.code === 'destination_location_required');
    service.reconcile({
      order_id: stockOnly.orderId, item_id: stockOnly.itemId, production_reality: 'PRODUCED_AS_RECORDED',
      stock_disposition_qty: 100, scrap_disposition_qty: 0, destination_warehouse_id: warehouse.id, destination_location: 'FG-H-01',
      reason: 'ייצור היסטורי תקין למלאי', actor_id: actorId, historical_reconciliation_authorized: true,
      idempotency_key: 'historical-stock-only',
    });
    const stockEvent = db.prepare('SELECT production_correction_qty,stock_disposition_qty,scrap_disposition_qty FROM historical_production_reconciliation_items WHERE source_order_item_id=?').get(stockOnly.itemId);
    assert.deepEqual(stockEvent, { production_correction_qty: 0, stock_disposition_qty: 100, scrap_disposition_qty: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM production_record_correction_events WHERE source_order_item_id=?').get(stockOnly.itemId).count, 0);

    const scrapOnly = historicalItem(db, { orderNum: 'HIST-SCRAP-ONLY' });
    service.reconcile({
      order_id: scrapOnly.orderId, item_id: scrapOnly.itemId, production_reality: 'PRODUCED_AS_RECORDED',
      stock_disposition_qty: 0, scrap_disposition_qty: 100,
      reason: 'ייצור היסטורי תקין לגריטה', actor_id: actorId, historical_reconciliation_authorized: true,
      idempotency_key: 'historical-scrap-only',
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_finished_goods_lots WHERE source_order_item_id=?').get(scrapOnly.itemId).count, 0);
    assert.equal(db.prepare('SELECT quantity FROM historical_finished_goods_scrap_movements WHERE source_order_item_id=?').get(scrapOnly.itemId).quantity, 100);
  } finally { db.close(); }
});

test('historical reconciliation blocks an existing disposition and stays idempotent under repeated commits', () => {
  const { db, actorId, service } = setup();
  try {
    const { orderId, itemId } = historicalItem(db, { orderNum: 'HIST-CONFLICT-STOCK' });
    const cancellationId = Number(db.prepare(`
      INSERT INTO order_cancellation_transactions (cancellation_uid,order_id,scope_type,idempotency_key,payload_fingerprint,reason)
      VALUES (?,?,?,?,?,?)
    `).run('legacy-existing-disposition', orderId, 'item', 'legacy-existing-disposition-key', 'seed', 'seeded legacy evidence').lastInsertRowid);
    db.prepare(`
      INSERT INTO order_cancellation_item_dispositions
        (cancellation_transaction_id,order_id,source_order_item_id,ordered_qty,recorded_produced_qty,confirmed_produced_qty,
         eligible_produced_qty,stock_disposition_qty,scrap_disposition_qty,cancelled_unproduced_qty,production_state,disposition_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(cancellationId, orderId, itemId, 100, 100, 100, 0, 70, 0, 0, 'FULLY_PRODUCED', 'FINISHED_GOODS_STOCK');
    assert.throws(() => service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'PARTIALLY_PRODUCED', actual_produced_qty: 40,
      stock_disposition_qty: 0, scrap_disposition_qty: 0, reason: 'תיקון הסותר מלאי קיים', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-existing-stock-conflict',
    }), error => error.code === 'downstream_physical_evidence_requires_reconciliation');

    const clean = historicalItem(db, { orderNum: 'HIST-IDEMPOTENT' });
    const payload = {
      order_id: clean.orderId, item_id: clean.itemId, production_reality: 'NOT_ACTUALLY_PRODUCED',
      stock_disposition_qty: 0, scrap_disposition_qty: 0, reason: 'אין ייצור פיזי בתיק ההיסטורי', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-repeated-commit',
    };
    assert.equal(service.reconcile(payload).replay, false);
    assert.equal(createHistoricalProductionReconciliationService(db).reconcile(payload).replay, true, 'a second service instance sees the same atomic idempotency record');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_production_reconciliation_transactions WHERE idempotency_key=?').get(payload.idempotency_key).count, 1);
  } finally { db.close(); }
});

test('historical reconciliation blocks untrusted authority, missing reason, and delivery conflicts without mutation', () => {
  const { db, actorId, service } = setup();
  try {
    const { orderId, itemId } = historicalItem(db, { orderNum: 'HIST-CONFLICT-DELIVERY' });
    assert.throws(() => service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'NOT_ACTUALLY_PRODUCED', stock_disposition_qty: 0, scrap_disposition_qty: 0,
      reason: 'אין ייצור פיזי', actor_id: actorId, idempotency_key: 'historical-no-authority',
    }), error => error.code === 'historical_reconciliation_not_authorized');
    assert.throws(() => service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'NOT_ACTUALLY_PRODUCED', stock_disposition_qty: 0, scrap_disposition_qty: 0,
      reason: '', actor_id: actorId, historical_reconciliation_authorized: true, idempotency_key: 'historical-no-reason',
    }), error => error.code === 'invalid_historical_reconciliation_reason');
    db.prepare('INSERT INTO packages (package_code,order_id,order_num,item_ids,quantity,status) VALUES (?,?,?,?,?,?)')
      .run('HIST-DELIVERED-70', orderId, 'HIST-CONFLICT-DELIVERY', JSON.stringify([itemId]), 70, 'shipped');
    assert.throws(() => service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'PARTIALLY_PRODUCED', actual_produced_qty: 20,
      stock_disposition_qty: 20, scrap_disposition_qty: 0, reason: 'נמצא ייצור נמוך מהרישום', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-delivery-conflict',
    }), error => error.code === 'downstream_physical_evidence_requires_reconciliation');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_production_reconciliation_items').get().count, 0);
  } finally { db.close(); }
});

test('production summary reads corrected effective production rather than the immutable legacy value', async () => {
  const { db, actorId, service } = setup();
  let server;
  try {
    const { orderId, itemId } = historicalItem(db, { orderNum: 'HIST-REPORT-TRUTH' });
    db.prepare('UPDATE items SET machine=? WHERE id=?').run('Legacy-machine', itemId);
    const warehouse = service.review({ order_id: orderId, item_id: itemId }).warehouses[0];
    service.reconcile({
      order_id: orderId, item_id: itemId, production_reality: 'PARTIALLY_PRODUCED', actual_produced_qty: 40,
      stock_disposition_qty: 20, scrap_disposition_qty: 20, destination_warehouse_id: warehouse.id, destination_location: 'FG-REPORT-01',
      reason: 'דוח ייצור חייב להשתמש בביצוע הפיזי', actor_id: actorId,
      historical_reconciliation_authorized: true, idempotency_key: 'historical-report-truth',
    });
    const app = express();
    const allow = () => (_req, _res, next) => next();
    app.use(createReportsRouter({
      db, requireRole: allow, requireAnyRole: allow, statusContracts, productionActuals, workerCardActivity: {},
    }));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const day = new Date().toISOString().slice(0, 10);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reports/summary?from=${day}&to=${day}`);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.machineEfficiency.find(row => row.machine === 'Legacy-machine').total_units, 40);
    assert.equal(summary.production[0].actual_weight_kg, 80, 'the production-weight series also uses the effective 40/100 physical ratio');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
