'use strict';

const { ORDER_STATUS: O, ITEM_STATUS: I, normalizeOrderStatus, isValidOrderStatus } = require('../status-contracts');
const { deliverySelectionFingerprint, buildDeliveryCertificateProgress } = require('./deliveryCertificateProgress');
const { cancellationPreview, cancelCertificate } = require('./deliveryCertificateCancellation');
const { cancelActiveLoadingForCorrection } = require('./loadingStatusCorrection');

const ITEM_STAGES = [I.WAITING, I.IN_PRODUCTION, I.DONE, I.LOADED, I.SENT, I.DELIVERED];
const TARGETS = { [O.PENDING_APPROVAL]: I.WAITING, [O.CUSTOMER_PENDING_APPROVAL]: I.WAITING,
  [O.PRODUCTION_QUEUE]: I.WAITING, [O.IN_PRODUCTION]: I.IN_PRODUCTION,
  [O.DONE_WAITING_PICKUP]: I.DONE, [O.LOADING]: I.LOADED,
  [O.ON_THE_WAY]: I.SENT, [O.SENT]: I.SENT };
const RANK = { [O.PENDING_APPROVAL]: -1, [O.CUSTOMER_PENDING_APPROVAL]: -1,
  [O.PRODUCTION_QUEUE]: 0, [O.IN_PRODUCTION]: 1, [O.DONE_WAITING_PICKUP]: 2,
  [O.LOADING]: 3, [O.PARTIAL_DELIVERY]: 4, [O.ON_THE_WAY]: 4,
  [O.SENT]: 4, [O.DELIVERY_PROBLEM]: 4, [O.DELIVERED_CONFIRMED]: 5 };
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }

function scanHistory(db,orderId) {
  return db.prepare(`SELECT COUNT(DISTINCT item_id) AS scanned_item_count,COUNT(*) AS scan_count,MAX(scanned_at) AS last_scan_at FROM (
    SELECT item_id,datetime(occurred_at) scanned_at FROM worker_card_activity WHERE order_id=? AND action='opened'
    UNION ALL SELECT sl.item_id,datetime(sl.scanned_at) FROM scan_log sl JOIN items i ON i.id=sl.item_id JOIN pallets p ON p.id=i.pallet_id
      WHERE p.order_id=? AND sl.action='start')`).get(orderId,orderId);
}

function orderStatusCorrectionPreview(db, orderId, status) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) fail('הזמנה לא נמצאה', 404);
  const target = normalizeOrderStatus(status), from = normalizeOrderStatus(order.status);
  if (!isValidOrderStatus(target) || target === O.CANCELLED) fail('סטטוס תיקון לא תקין', 400);
  if (from === O.CANCELLED || order.deleted_at) fail('יש לטפל בביטול או לשחזר את ההזמנה לפני שינוי');
  const items = db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(order.id);
  const targetItem = TARGETS[target];
  const affected = targetItem ? items.filter(item => !item.cancelled_at && !item.production_stopped_at && item.status !== I.CANCELLED &&
    (ITEM_STAGES.indexOf(item.status) > ITEM_STAGES.indexOf(targetItem) || (item.status === I.ON_HOLD && targetItem === I.WAITING)))
    .map(item => ({ id: item.id, from: item.status, status: targetItem })) : [];
  const sessions = db.prepare("SELECT * FROM order_loading_sessions WHERE order_id=? AND status='active' ORDER BY id").all(order.id);
  const loadingCards = db.prepare(`SELECT c.* FROM order_loading_session_cards c JOIN order_loading_sessions s ON s.id=c.session_id
    WHERE s.order_id=? AND s.status='active' ORDER BY c.id`).all(order.id);
  const loadingPackages = db.prepare(`SELECT p.* FROM order_loading_session_packages p JOIN order_loading_sessions s ON s.id=p.session_id
    WHERE s.order_id=? AND s.status='active' ORDER BY p.id`).all(order.id);
  const cancelLoading = RANK[target] < RANK[O.LOADING] ? sessions : [];
  const progress = buildDeliveryCertificateProgress(db, order.id, items);
  const notes = db.prepare(`SELECT dn.*,dno.items_json AS scoped_items FROM delivery_notes dn
    LEFT JOIN delivery_note_orders dno ON dno.delivery_note_id=dn.id AND dno.order_id=?
    LEFT JOIN delivery_note_cancellations dc ON dc.note_id=dn.id
    WHERE (dn.order_id=? OR dno.order_id=?) AND dc.note_id IS NULL ORDER BY dn.id`).all(order.id, order.id, order.id);
  const certificates = notes.map(note => {
    try {
      const preview = cancellationPreview(db, order.id, note.id, { ignoreActiveLoading: cancelLoading.length > 0 });
      return { id: note.id, note_num: note.note_num, can_cancel: true, affected_items: preview.items };
    } catch (error) { return { id: note.id, note_num: note.note_num, can_cancel: false, blocked_reason: error.message, affected_items: [] }; }
  });
  const returningToQueue = from === O.IN_PRODUCTION && target === O.PRODUCTION_QUEUE;
  const queueTransfer = returningToQueue && sessions.length === 0 && items.every(item=>item.cancelled_at || item.status===I.CANCELLED || [I.WAITING,I.IN_PRODUCTION].includes(item.status));
  const scan = returningToQueue ? scanHistory(db,order.id) : null;
  const result = { order_id: order.id, current_status: from, target_status: target,
    queue_transfer: queueTransfer, scan_warning: scan && scan.scanned_item_count>0 ? scan : null,
    requires_correction: !queueTransfer && (RANK[target] < RANK[from] || affected.length > 0 || cancelLoading.length > 0),
    affected_items: queueTransfer ? [] : affected, target_item_status: queueTransfer ? null : targetItem || null,
    cancelled_loading_session_ids: cancelLoading.map(session => session.id),
    documented_qty: progress.shipped_unit_count, certificates,
    can_cancel_certificates: RANK[target] <= RANK[O.LOADING] && !progress.history_needs_review && certificates.length > 0 && certificates.every(note => note.can_cancel),
    history_needs_review: progress.history_needs_review };
  return { ...result, fingerprint: deliverySelectionFingerprint({ order, items, sessions, loadingCards, loadingPackages, notes, result }) };
}

// Called inside the Orders transaction, before its final status/audit write.
function applyOrderStatusCorrection(db, preview, { fingerprint, reason, mode = 'keep_documents', role, userId, userName }) {
  const fresh = orderStatusCorrectionPreview(db, preview.order_id, preview.target_status);
  if (!fingerprint || fingerprint !== fresh.fingerprint) fail('ההזמנה או הפריטים השתנו; יש לפתוח מחדש את התיקון');
  if (!fresh.requires_correction) fail('אין החזרה לשלב קודם');
  const explanation = String(reason || '').trim();
  if (explanation.length < 3 || explanation.length > 2000) fail('יש להזין סיבת תיקון בין 3 ל־2000 תווים', 400);
  if (!['keep_documents', 'cancel_unshipped_certificate'].includes(mode)) fail('אופן תיקון לא תקין', 400);
  if (mode === 'cancel_unshipped_certificate') {
    if (!['office', 'manager', 'admin'].includes(role)) fail('ביטול תעודה זמין למשרד או למנהל בלבד', 403);
    if (!fresh.can_cancel_certificates) fail('לא ניתן לבטל תעודות אלה במסלול זה; אפשר להחזיר לעבודה ולשמור אותן');
  }
  if (fresh.cancelled_loading_session_ids.length) cancelActiveLoadingForCorrection(db, { orderId: fresh.order_id, actorId: userId, reason: explanation });
  const cancelled = [];
  if (mode === 'cancel_unshipped_certificate') for (const note of fresh.certificates) {
    const certificate = cancellationPreview(db, fresh.order_id, note.id);
    cancelled.push(cancelCertificate(db, { orderId: fresh.order_id, noteId: note.id, reason: explanation,
      expectedFingerprint: certificate.fingerprint, userId, userName }));
  }
  const order = db.prepare('SELECT order_num FROM orders WHERE id=?').get(fresh.order_id);
  for (const item of fresh.affected_items) {
    db.prepare('UPDATE items SET status=?,completed_at=CASE WHEN ? IN (?,?) THEN NULL ELSE completed_at END WHERE id=?')
      .run(item.status, item.status, I.WAITING, I.IN_PRODUCTION, item.id);
    db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('item', item.id, order.order_num, 'item_status_correction', 'status', item.from,
        item.status, explanation, userId || null, userName || null);
  }
  return { corrected_items: fresh.affected_items, cancelled_certificate_ids: cancelled.map(note => note.note_id),
    cancelled_loading_session_ids: fresh.cancelled_loading_session_ids };
}

function assertQueueTransfer(preview,body) {
  if(!preview.queue_transfer&&!preview.scan_warning)return;
  if(body.correction_fingerprint!==preview.fingerprint)fail('ההזמנה או הסריקות השתנו; יש לבדוק מחדש את ההעברה לתור');
  if(preview.scan_warning&&body.queue_scan_acknowledged!==true)fail('כבר נסרקו כרטיסים בהזמנה. יש לאשר את ההתראה לפני החזרה לתור ייצור');
}

module.exports = { orderStatusCorrectionPreview, applyOrderStatusCorrection, assertQueueTransfer };
