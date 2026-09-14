'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { createOrderCancellationService } = require('../services/orderCancellation');
const { ITEM_STATUS, ORDER_STATUS } = require('../status-contracts');

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  ensureCoreSchema(db);
  const actorId = Number(db.prepare(`INSERT INTO users (username,display_name,role) VALUES ('cancel-test','Cancellation Test','manager')`).run().lastInsertRowid);
  return { db, service: createOrderCancellationService(db), actorId };
}

function seedItem(db, { orderNum, quantity = 100, producedQty = 60, status = ITEM_STATUS.IN_PRODUCTION } = {}) {
  const orderId = Number(db.prepare(`
    INSERT INTO orders (order_num,status,total_weight,billing_weight) VALUES (?,?,?,?)
  `).run(orderNum, ORDER_STATUS.IN_PRODUCTION, quantity * 2, quantity * 2).lastInsertRowid);
  const palletId = Number(db.prepare(`INSERT INTO pallets (order_id,pallet_num,total_weight) VALUES (?,?,?)`)
    .run(orderId, 1, quantity * 2).lastInsertRowid);
  const itemId = Number(db.prepare(`
    INSERT INTO items
      (pallet_id,order_id,item_uid,shape_id,shape_name,diameter,segments,total_length_mm,quantity,production_qty,produced_qty,weight_per_unit,total_weight,status,actual_weight_kg,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).run(
    palletId, orderId, `order-${orderId}:item-1`, 'straight_bar', 'straight_bar', 12,
    JSON.stringify([{ length_mm: 1000, angle_deg: 0 }]), 1000, quantity, quantity, producedQty, 2, quantity * 2, status,
    producedQty * 2,
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_output_events
      (event_uid,item_id,order_id,source,before_weight_kg,after_weight_kg,delta_weight_kg,production_day,occurred_at,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(`event-${orderId}`, itemId, orderId, 'test', 0, producedQty * 2, producedQty * 2, '2026-09-03', '2026-09-03T06:00:00.000Z', '{}');
  return { orderId, itemId };
}

test('order cancellation preserves production and creates traceable stock/scrap atomically', () => {
  const { db, service, actorId } = setup();
  try {
    const { orderId, itemId } = seedItem(db, { orderNum: 'CANCEL-100-60' });
    db.prepare(`
      INSERT INTO inventory_reservations (order_id,item_id,diameter,material_type,reserved_kg,status)
      VALUES (?,?,?,?,?,?)
    `).run(orderId, itemId, 12, 'coil', 200, 'active');

    const review = service.review({ order_id: orderId });
    assert.equal(review.items.length, 1);
    assert.deepEqual(
      {
        ordered: review.items[0].ordered_qty,
        produced: review.items[0].confirmed_produced_qty,
        delivered: review.items[0].delivered_qty,
        eligible: review.items[0].eligible_produced_qty,
        unproduced: review.items[0].cancelled_unproduced_qty,
        state: review.items[0].production_state,
      },
      { ordered: 100, produced: 60, delivered: 0, eligible: 60, unproduced: 40, state: 'PARTIALLY_PRODUCED' },
    );
    assert.match(review.items[0].physical_spec_fingerprint, /^physical-spec:v1:sha256:/);

    const warehouse = review.warehouses[0];
    const payload = {
      order_id: orderId,
      scope: 'order',
      reason: 'הלקוח ביטל את העבודה',
      actor_id: actorId,
      idempotency_key: 'cancel-100-60-v1',
      items: [{
        item_id: itemId,
        stock_disposition_qty: 45,
        scrap_disposition_qty: 15,
        destination_warehouse_id: warehouse.id,
        destination_location: 'FG-A-01',
      }],
    };
    const result = service.cancel(payload);
    assert.equal(result.success, true);
    assert.equal(result.replay, false);

    const item = db.prepare(`SELECT produced_qty,status,cancelled_unproduced_qty,production_stopped_at FROM items WHERE id=?`).get(itemId);
    assert.equal(item.produced_qty, 60, 'cancellation must not rewrite confirmed production');
    assert.equal(item.status, ITEM_STATUS.CANCELLED);
    assert.equal(item.cancelled_unproduced_qty, 40);
    assert.ok(item.production_stopped_at);
    assert.equal(db.prepare(`SELECT status FROM orders WHERE id=?`).get(orderId).status, ORDER_STATUS.CANCELLED);

    const lot = db.prepare(`SELECT * FROM finished_goods_lots WHERE source_order_item_id=?`).get(itemId);
    assert.equal(lot.produced_quantity, 45);
    assert.equal(lot.available_quantity, 45);
    assert.equal(lot.location_code, 'FG-A-01');
    assert.match(lot.physical_spec_fingerprint, /^physical-spec:v1:sha256:/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM finished_goods_movements WHERE lot_id=?`).get(lot.id).count, 1);
    const scrap = db.prepare(`SELECT quantity,reason FROM finished_goods_scrap_movements WHERE source_order_item_id=?`).get(itemId);
    assert.deepEqual(scrap, { quantity: 15, reason: 'הלקוח ביטל את העבודה' });

    const disposition = db.prepare(`SELECT * FROM order_cancellation_item_dispositions WHERE source_order_item_id=?`).get(itemId);
    assert.deepEqual(
      {
        stock: disposition.stock_disposition_qty,
        scrap: disposition.scrap_disposition_qty,
        unproduced: disposition.cancelled_unproduced_qty,
        state: disposition.production_state,
        type: disposition.disposition_type,
      },
      { stock: 45, scrap: 15, unproduced: 40, state: 'PARTIALLY_PRODUCED', type: 'SPLIT_STOCK_AND_SCRAP' },
    );
    assert.equal(JSON.parse(disposition.reconciliation_json).unexplained_qty, 0);

    const reservation = db.prepare(`SELECT reserved_kg,status FROM inventory_reservations WHERE item_id=?`).get(itemId);
    assert.deepEqual(reservation, { reserved_kg: 80, status: 'released' });
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM inventory_reservation_release_events`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM production_output_events WHERE item_id=?`).get(itemId).count, 1);

    const replay = service.cancel(payload);
    assert.equal(replay.replay, true);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM finished_goods_lots`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM finished_goods_scrap_movements`).get().count, 1);
  } finally {
    db.close();
  }
});

test('cancellation rejects an incomplete disposition and never returns production to raw material', () => {
  const { db, service, actorId } = setup();
  try {
    const { orderId, itemId } = seedItem(db, { orderNum: 'CANCEL-REJECT', quantity: 10, producedQty: 4 });
    const warehouse = service.listWarehouses()[0];
    assert.throws(() => service.cancel({
      order_id: orderId,
      scope: 'order',
      reason: 'בדיקת התאמה',
      actor_id: actorId,
      idempotency_key: 'cancel-reject-v1',
      items: [{ item_id: itemId, stock_disposition_qty: 3, scrap_disposition_qty: 0, destination_warehouse_id: warehouse.id, destination_location: 'A1' }],
    }), error => error.code === 'disposition_quantity_must_equal_eligible_produced_qty');
    assert.equal(db.prepare(`SELECT status FROM items WHERE id=?`).get(itemId).status, ITEM_STATUS.IN_PRODUCTION);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM raw_material`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM finished_goods_lots`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM finished_goods_scrap_movements`).get().count, 0);
  } finally {
    db.close();
  }
});

test('complete cancellation can finish remaining items after an item-level disposition', () => {
  const { db, service, actorId } = setup();
  try {
    const { orderId, itemId } = seedItem(db, { orderNum: 'CANCEL-REMAINING', quantity: 10, producedQty: 2 });
    const palletId = db.prepare('SELECT pallet_id FROM items WHERE id=?').get(itemId).pallet_id;
    const remainingItemId = Number(db.prepare(`
      INSERT INTO items
        (pallet_id,order_id,item_uid,shape_id,shape_name,diameter,segments,total_length_mm,quantity,production_qty,produced_qty,weight_per_unit,total_weight,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      palletId, orderId, `order-${orderId}:item-2`, 'straight_bar', 'straight_bar', 12,
      JSON.stringify([{ length_mm: 800, angle_deg: 0 }]), 800, 5, 5, 0, 2, 10, ITEM_STATUS.WAITING,
    ).lastInsertRowid);
    const warehouse = service.listWarehouses()[0];

    service.cancel({
      order_id: orderId,
      scope: 'item',
      reason: 'ביטול פריט ראשון',
      actor_id: actorId,
      idempotency_key: 'cancel-remaining-item',
      items: [{ item_id: itemId, stock_disposition_qty: 2, scrap_disposition_qty: 0, destination_warehouse_id: warehouse.id, destination_location: 'FG-02' }],
    });

    const review = service.review({ order_id: orderId });
    assert.equal(review.can_cancel, true);
    assert.equal(review.items.find(item => item.item_id === itemId).already_cancelled, true);
    assert.equal(review.items.find(item => item.item_id === remainingItemId).already_cancelled, false);

    service.cancel({
      order_id: orderId,
      scope: 'order',
      reason: 'ביטול יתרת ההזמנה',
      actor_id: actorId,
      idempotency_key: 'cancel-remaining-order',
      items: [{ item_id: remainingItemId, stock_disposition_qty: 0, scrap_disposition_qty: 0 }],
    });

    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, ORDER_STATUS.CANCELLED);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_cancellation_item_dispositions WHERE order_id=?').get(orderId).count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finished_goods_lots WHERE source_order_item_id=?').get(itemId).count, 1);
  } finally {
    db.close();
  }
});

test('an authorized false-production correction preserves gross records but cancels all quantity as unproduced', () => {
  const { db, service, actorId } = setup();
  try {
    const { orderId, itemId } = seedItem(db, { orderNum: 'CANCEL-FALSE-PRODUCTION', quantity: 100, producedQty: 60 });
    const basePayload = {
      order_id: orderId,
      scope: 'order',
      reason: 'ביטול לאחר תיקון רישום',
      actor_id: actorId,
      items: [{
        item_id: itemId,
        stock_disposition_qty: 0,
        scrap_disposition_qty: 0,
        production_reality: 'NOT_ACTUALLY_PRODUCED',
        production_correction_reason: 'דיווח מכונה שגוי; לא בוצע חיתוך בפועל',
      }],
    };

    assert.throws(() => service.cancel({ ...basePayload, idempotency_key: 'false-production-unauthorized' }),
      error => error.code === 'production_record_correction_not_authorized');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM production_record_correction_events').get().count, 0);

    const payload = { ...basePayload, idempotency_key: 'false-production-authorized', production_record_correction_authorized: true };
    const result = service.cancel(payload);
    assert.equal(result.replay, false);
    const original = db.prepare('SELECT produced_qty,actual_weight_kg FROM items WHERE id=?').get(itemId);
    assert.deepEqual(original, { produced_qty: 60, actual_weight_kg: 120 }, 'gross production evidence remains untouched');
    const correction = db.prepare(`SELECT * FROM production_record_correction_events WHERE source_order_item_id=?`).get(itemId);
    assert.deepEqual(
      {
        type: correction.correction_type,
        recorded: correction.recorded_produced_qty,
        reversed: correction.correction_qty,
        before: correction.effective_produced_qty_before,
        after: correction.effective_produced_qty_after,
      },
      { type: 'ERRONEOUS_PRODUCTION_RECORD', recorded: 60, reversed: 60, before: 60, after: 0 },
    );
    const disposition = db.prepare(`SELECT recorded_produced_qty,confirmed_produced_qty,erroneous_production_correction_qty,cancelled_unproduced_qty FROM order_cancellation_item_dispositions WHERE source_order_item_id=?`).get(itemId);
    assert.deepEqual(disposition, {
      recorded_produced_qty: 60, confirmed_produced_qty: 0, erroneous_production_correction_qty: 60, cancelled_unproduced_qty: 100,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finished_goods_lots').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finished_goods_scrap_movements').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM production_output_events WHERE item_id=?').get(itemId).count, 1);

    const replay = service.cancel(payload);
    assert.equal(replay.replay, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM production_record_correction_events').get().count, 1);
  } finally {
    db.close();
  }
});

test('partial false-production correction disposes only the physically produced remainder and blocks contradicting packages', () => {
  const { db, service, actorId } = setup();
  try {
    const { orderId, itemId } = seedItem(db, { orderNum: 'CANCEL-PARTIAL-FALSE', quantity: 100, producedQty: 60 });
    const warehouse = service.listWarehouses()[0];
    const payload = {
      order_id: orderId,
      scope: 'order',
      reason: 'ביטול עם ייצור חלקי בפועל',
      actor_id: actorId,
      production_record_correction_authorized: true,
      idempotency_key: 'partial-false-production',
      items: [{
        item_id: itemId,
        stock_disposition_qty: 20,
        scrap_disposition_qty: 5,
        destination_warehouse_id: warehouse.id,
        destination_location: 'FG-25',
        production_reality: 'PARTIALLY_PRODUCED',
        actual_produced_qty: 25,
        production_correction_reason: 'נרשמו 60 יחידות אך יוצרו רק 25 בפועל',
      }],
    };
    service.cancel(payload);
    const disposition = db.prepare(`SELECT recorded_produced_qty,confirmed_produced_qty,erroneous_production_correction_qty,stock_disposition_qty,scrap_disposition_qty,cancelled_unproduced_qty FROM order_cancellation_item_dispositions WHERE source_order_item_id=?`).get(itemId);
    assert.deepEqual(disposition, {
      recorded_produced_qty: 60, confirmed_produced_qty: 25, erroneous_production_correction_qty: 35,
      stock_disposition_qty: 20, scrap_disposition_qty: 5, cancelled_unproduced_qty: 75,
    });
    assert.equal(db.prepare('SELECT produced_quantity FROM finished_goods_lots WHERE source_order_item_id=?').get(itemId).produced_quantity, 20);
    assert.equal(db.prepare('SELECT quantity FROM finished_goods_scrap_movements WHERE source_order_item_id=?').get(itemId).quantity, 5);

    const { orderId: blockedOrderId, itemId: blockedItemId } = seedItem(db, { orderNum: 'CANCEL-CORRECTION-CONFLICT', quantity: 100, producedQty: 60 });
    db.prepare(`INSERT INTO packages (package_code,order_id,order_num,item_ids,quantity,status) VALUES (?,?,?,?,?,?)`)
      .run('PKG-CORRECTION-CONFLICT', blockedOrderId, 'CANCEL-CORRECTION-CONFLICT', JSON.stringify([blockedItemId]), 30, 'packed');
    assert.throws(() => service.cancel({
      ...payload,
      order_id: blockedOrderId,
      idempotency_key: 'partial-false-production-conflict',
      items: [{
        ...payload.items[0], item_id: blockedItemId, stock_disposition_qty: 25, scrap_disposition_qty: 0,
      }],
    }), error => error.code === 'downstream_physical_evidence_requires_reconciliation');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM production_record_correction_events WHERE source_order_item_id=?').get(blockedItemId).count, 0);
  } finally {
    db.close();
  }
});
