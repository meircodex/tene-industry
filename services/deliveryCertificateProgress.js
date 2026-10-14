'use strict';
const { createHash } = require('node:crypto');
const { effectiveItemWeight } = require('./orderCommercialSummary');

const TERMINAL = new Set(['נשלח', 'סופק', 'סופק – אושר']);
function readArray(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : (value || []);
  if (!Array.isArray(parsed)) throw new Error('invalid_delivery_history');
  return parsed;
}
function quantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('invalid_delivery_history_quantity');
  return number;
}

// Read-only projection of the existing, immutable truck/document snapshots.
// A later item-status rollback must not erase a recorded departure.
function buildDeliveryCertificateProgress(db, orderId, items) {
  const shipped = new Map();
  const cancelledItemIds = new Set();
  let historyNeedsReview = false;
  const notes = db.prepare(`SELECT dn.id,dn.note_num,dn.issued_at,dn.items_json,dn.packages_json,dno.items_json AS scoped_items,
    dc.created_at AS cancelled_at,dc.reason AS cancellation_reason,dc.restored_items_json
    FROM delivery_notes dn LEFT JOIN delivery_note_orders dno
      ON dno.delivery_note_id=dn.id AND dno.order_id=?
    LEFT JOIN delivery_note_cancellations dc ON dc.note_id=dn.id
    WHERE dn.order_id=? OR dno.order_id=? ORDER BY dn.id`).all(orderId, orderId, orderId);
  const add = (map, id, qty) => {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) throw new Error('invalid_delivery_history_item');
    map.set(numericId, (map.get(numericId) || 0) + quantity(qty));
  };
  for (const note of notes) {
    if (note.cancelled_at) {
      for (const row of readArray(note.restored_items_json)) cancelledItemIds.add(Number(row.id));
      continue;
    }
    try {
      const byItem = new Map();
      const packages = readArray(note.packages_json);
      if (packages.length && !note.scoped_items) {
        for (const pack of packages) {
          const ids = readArray(pack.item_ids || pack.item_ids_json);
          if (ids.length !== 1) throw new Error('ambiguous_delivery_package');
          add(byItem, ids[0], pack.quantity);
        }
      } else {
        for (const row of readArray(note.scoped_items || note.items_json)) {
          if (row.order_id && Number(row.order_id) !== Number(orderId)) continue;
          add(byItem, row.parent_item_id || row.id, row.shipment_quantity ?? row.quantity);
        }
      }
      for (const [id, qty] of byItem) add(shipped, id, qty);
    } catch (_) { historyNeedsReview = true; }
  }
  // An audited status rollback cannot erase an earlier manual shipment that
  // predates saved source certificates. A document correction is separate.
  const oldSent = db.prepare("SELECT entity_id FROM audit_log WHERE entity_type='item' AND action='item_status_correction' AND old_value IN ('נשלח','סופק') AND entity_id IN (SELECT i.id FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=?)").all(orderId);
  const previouslySent = new Set(oldSent.map(row => Number(row.entity_id)));
  const rows = items.map(item => {
    const orderedQty = Math.max(0, Number(item.quantity) || 0);
    const documentedQty = Math.min(orderedQty, shipped.get(Number(item.id)) || 0);
    const sentQty = Math.min(orderedQty, Math.max(documentedQty, TERMINAL.has(item.status) || (previouslySent.has(Number(item.id)) && !cancelledItemIds.has(Number(item.id))) ? orderedQty : 0));
    const cancelled = Boolean(item.cancelled_at) || ['בוטל', 'בוטלה'].includes(item.status);
    const remainingQty = cancelled ? 0 : Math.max(0, orderedQty - sentQty);
    const certificateRemaining = cancelled ? 0 : Math.max(0, orderedQty - documentedQty);
    return { id: Number(item.id), ordered_qty: orderedQty, shipped_qty: sentQty, remaining_qty: remainingQty,
      documented_qty: documentedQty, certificate_remaining_qty: certificateRemaining,
      loaded: ['הועמס','נשלח','סופק','סופק – אושר'].includes(item.status) && certificateRemaining > 0, cancelled };
  });
  const total = rows.filter(row => !row.cancelled).length;
  const remaining = rows.filter(row => row.remaining_qty > 0);
  const certificateRemaining = rows.filter(row => row.certificate_remaining_qty > 0);
  const loaded = certificateRemaining.filter(row => row.loaded);
  const activeItems = items.filter(item => !item.cancelled_at && !['בוטל','בוטלה'].includes(item.status));
  const stages = ['ממתין','בייצור','הושלם','הועמס','נשלח','סופק'];
  const completedItems = activeItems.filter(item => stages.indexOf(item.status) >= 2);
  return {
    production_status: completedItems.length === activeItems.length && activeItems.length ? 'הושלם – ממתין לאיסוף' : activeItems.some(item => stages.indexOf(item.status) >= 1) ? 'בייצור' : 'ממתינה לאישור',
    stage_counts: { produced: completedItems.length, loaded: activeItems.filter(item => stages.indexOf(item.status) >= 3).length, sent: activeItems.filter(item => stages.indexOf(item.status) >= 4).length, delivered: activeItems.filter(item => stages.indexOf(item.status) >= 5).length },
    certificates: notes.map(note => ({ id: note.id, note_num: note.note_num, issued_at: note.issued_at,
      cancelled_at: note.cancelled_at, cancellation_reason: note.cancellation_reason,
      can_cancel: !note.cancelled_at && String(note.note_num || '').startsWith('CERT-'),
      replaces_note_ids: db.prepare('SELECT cancelled_note_id FROM delivery_note_replacements WHERE new_note_id=?').all(note.id).map(row => row.cancelled_note_id) })),
    total_item_count: total,
    shipped_item_count: rows.filter(row => !row.cancelled && row.remaining_qty === 0 && row.shipped_qty > 0).length,
    partially_shipped_item_count: rows.filter(row => row.shipped_qty > 0 && row.remaining_qty > 0).length,
    remaining_item_count: remaining.length,
    loaded_item_count: loaded.length,
    certificate_remaining_item_count: certificateRemaining.length,
    remaining_after_loaded_count: certificateRemaining.length - loaded.length,
    total_unit_count: rows.filter(row => !row.cancelled).reduce((n,row) => n+row.ordered_qty,0),
    shipped_unit_count: rows.reduce((n,row) => n+row.shipped_qty,0),
    remaining_unit_count: remaining.reduce((n,row) => n+row.remaining_qty,0),
    loaded_unit_count: loaded.reduce((n,row) => n+row.certificate_remaining_qty,0),
    history_needs_review: historyNeedsReview,
    loaded_item_ids: loaded.map(row => row.id),
    items: rows,
  };
}

function remainingDeliveryItems(items, progress, loadedOnly = false) {
  const rows = new Map(progress.items.map(row => [row.id,row]));
  return items.flatMap(item => {
    const row = rows.get(Number(item.id));
    const remaining = row?.certificate_remaining_qty ?? row?.remaining_qty;
    if (!row || remaining <= 0 || (loadedOnly && !row.loaded)) return [];
    const ratio = remaining / row.ordered_qty;
    return [{ ...item, quantity: remaining,
      total_weight: effectiveItemWeight(item).weightKg * ratio,
      actual_weight_kg: Number(item.actual_weight_kg || 0) * ratio,
      weight: Number(item.weight || 0) * ratio,
      original_quantity: row.ordered_qty, shipment_quantity: remaining }];
  });
}

function deliverySelectionFingerprint(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
module.exports = { buildDeliveryCertificateProgress, remainingDeliveryItems, deliverySelectionFingerprint };
