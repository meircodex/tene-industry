'use strict';

const { ITEM_STATUS, ORDER_STATUS, normalizeOrderStatus, isValidItemStatus } = require('../status-contracts');
const { deliverySelectionFingerprint, buildDeliveryCertificateProgress } = require('./deliveryCertificateProgress');
const { cancellationPreview, cancelCertificate } = require('./deliveryCertificateCancellation');

const STAGES = [ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION, ITEM_STATUS.DONE, ITEM_STATUS.LOADED, ITEM_STATUS.SENT, ITEM_STATUS.DELIVERED];
const CORRECTION_ROLES = ['office', 'manager', 'admin'];
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function isBackwardItemStatus(from, to) {
  const before = STAGES.indexOf(from), after = STAGES.indexOf(to);
  return (after >= 0 && after < before) || (before >= 2 && to === ITEM_STATUS.ON_HOLD);
}

function itemStatusCorrectionPreview(db, itemId, targetStatus) {
  const item = db.prepare(`SELECT i.*, p.order_id, o.order_num, o.status AS order_status
    FROM items i JOIN pallets p ON p.id=i.pallet_id JOIN orders o ON o.id=p.order_id WHERE i.id=?`).get(itemId);
  if (!item) fail('הפריט לא נמצא', 404);
  if (!isValidItemStatus(targetStatus) || targetStatus === ITEM_STATUS.CANCELLED) fail('סטטוס התיקון אינו תקין', 400);
  if (item.cancelled_at || item.production_stopped_at || item.status === ITEM_STATUS.CANCELLED || normalizeOrderStatus(item.order_status) === ORDER_STATUS.CANCELLED) fail('הפריט או ההזמנה בוטלו; נדרש טיפול בביטול לפני חזרה לעבודה');
  const items = db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(item.order_id);
  const progress = buildDeliveryCertificateProgress(db, item.order_id, items);
  const notes = db.prepare(`SELECT dn.*, dno.items_json AS scoped_items FROM delivery_notes dn
    LEFT JOIN delivery_note_orders dno ON dno.delivery_note_id=dn.id AND dno.order_id=?
    LEFT JOIN delivery_note_cancellations dc ON dc.note_id=dn.id
    WHERE (dn.order_id=? OR dno.order_id=?) AND dc.note_id IS NULL ORDER BY dn.id`).all(item.order_id, item.order_id, item.order_id);
  const certificates = [];
  let historyUnclear = progress.history_needs_review;
  for (const note of notes) {
    let rows, packages;
    try {
      rows = JSON.parse(note.scoped_items || note.items_json || '[]');
      packages = JSON.parse(note.packages_json || '[]');
      if (!Array.isArray(rows) || !Array.isArray(packages)) throw new Error('invalid history');
      const linked = rows.some(row => Number(row.parent_item_id || row.id) === Number(item.id)) || packages.some(pack => {
        const ids = pack.item_ids || JSON.parse(pack.item_ids_json || '[]');
        return Array.isArray(ids) && ids.some(id => Number(id) === Number(item.id));
      });
      if (!linked) continue;
    } catch (_) { historyUnclear = true; continue; }
    let preview = null, blockedReason = null;
    try { preview = cancellationPreview(db, item.order_id, note.id); }
    catch (error) { blockedReason = error.message; }
    certificates.push({ id: note.id, note_num: note.note_num, can_cancel: Boolean(preview), blocked_reason: blockedReason,
      affected_items: preview?.items.map(row => ({ id: row.id, quantity: row.quantity })) || [] });
  }
  const result = {
    item_id: item.id, order_id: item.order_id, current_status: item.status, target_status: targetStatus,
    backwards: isBackwardItemStatus(item.status, targetStatus), produced_qty: Number(item.produced_qty || 0),
    documented_qty: progress.items.find(row => row.id === Number(item.id))?.documented_qty || 0,
    certificates, can_cancel_certificates: !historyUnclear && certificates.length > 0 && certificates.every(note => note.can_cancel),
    history_needs_review: historyUnclear,
  };
  return { ...result, fingerprint: deliverySelectionFingerprint({ result, item, items, notes }) };
}

function cancelUnshippedCertificatesForCorrection(db, { itemId, status, fingerprint, reason, role, userId, userName }) {
  if (!CORRECTION_ROLES.includes(role)) fail('ביטול תעודה לצורך תיקון זמין למשרד או למנהל בלבד', 403);
  const preview = itemStatusCorrectionPreview(db, itemId, status);
  if (!preview.backwards) fail('ביטול תעודה זמין רק בהחזרה לשלב קודם');
  if (!fingerprint || preview.fingerprint !== fingerprint) fail('הפריט או התעודה השתנו; יש לפתוח מחדש את התיקון');
  if (!preview.can_cancel_certificates) fail(preview.certificates.find(note => note.blocked_reason)?.blocked_reason || 'לא ניתן לבטל את התעודה במסלול זה; אפשר להחזיר לעבודה ולשמור את התעודה');
  const cancelled = [];
  for (const note of preview.certificates) {
    const fresh = cancellationPreview(db, preview.order_id, note.id);
    cancelled.push(cancelCertificate(db, { orderId: preview.order_id, noteId: note.id, reason, expectedFingerprint: fresh.fingerprint, userId, userName }));
  }
  return cancelled;
}

// Reopening work changes the operational queue, not historical delivery quantities.
function reopenOrderAfterItemCorrection(db, item, targetStatus, { reason, userId, userName } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(item.order_id);
  if (!order) return null;
  const from = normalizeOrderStatus(order.status);
  if ([ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.CUSTOMER_PENDING_APPROVAL, ORDER_STATUS.CANCELLED].includes(from)) return null;
  // An active warehouse session owns the order's loading stage. Rework may
  // resume, but changing that stage here would strand its scan/finish actions.
  if (db.prepare("SELECT 1 FROM order_loading_sessions WHERE order_id=? AND status='active'").get(order.id)) return null;
  const items = db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(item.order_id);
  const active = items.filter(row => !row.cancelled_at && row.status !== ITEM_STATUS.CANCELLED);
  const progress = buildDeliveryCertificateProgress(db, item.order_id, items);
  const workOpen = active.some(row => [ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION, ITEM_STATUS.ON_HOLD].includes(row.status));
  let next;
  const shipmentOrder = [ORDER_STATUS.PARTIAL_DELIVERY, ORDER_STATUS.SENT, ORDER_STATUS.ON_THE_WAY, ORDER_STATUS.DELIVERED_CONFIRMED, ORDER_STATUS.DELIVERY_PROBLEM].includes(from);
  if (progress.items.some(row => row.documented_qty > 0) || (shipmentOrder && progress.shipped_unit_count > 0) || progress.history_needs_review) next = ORDER_STATUS.PARTIAL_DELIVERY;
  else if (workOpen) next = active.some(row => row.status === ITEM_STATUS.IN_PRODUCTION) ? ORDER_STATUS.IN_PRODUCTION : ORDER_STATUS.PRODUCTION_QUEUE;
  else if (targetStatus === ITEM_STATUS.LOADED) next = ORDER_STATUS.LOADING;
  else next = ORDER_STATUS.DONE_WAITING_PICKUP;
  if (from === next) return null;
  db.prepare('UPDATE orders SET status=?,workspace_version=workspace_version+1 WHERE id=?').run(next, order.id);
  db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('order', order.id, order.order_num, 'item_status_correction', 'status', order.status, next, reason || 'פתיחה מחדש בעקבות תיקון סטטוס פריט', userId || null, userName || null);
  return next;
}

function isPreviouslyReopenedItem(db, item) {
  if (![ITEM_STATUS.WAITING, ITEM_STATUS.ON_HOLD].includes(item.status)) return false;
  if (![ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.SENT, ORDER_STATUS.ON_THE_WAY, ORDER_STATUS.DELIVERED_CONFIRMED, ORDER_STATUS.DELIVERY_PROBLEM].includes(normalizeOrderStatus(item.order_status))) return false;
  const latest = db.prepare("SELECT new_value FROM audit_log WHERE entity_type='item' AND entity_id=? AND field_name='status' ORDER BY id DESC LIMIT 1").get(item.id);
  return latest?.new_value === item.status && Boolean(db.prepare("SELECT 1 FROM audit_log WHERE entity_type='item' AND entity_id=? AND action='item_status_correction' LIMIT 1").get(item.id));
}

module.exports = { itemStatusCorrectionPreview, cancelUnshippedCertificatesForCorrection, reopenOrderAfterItemCorrection, isBackwardItemStatus, isPreviouslyReopenedItem };
