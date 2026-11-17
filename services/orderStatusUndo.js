'use strict';

const { orderStatusCorrectionPreview } = require('./orderStatusCorrection');
const { deliverySelectionFingerprint } = require('./deliveryCertificateProgress');
const { restoreProductionStatusSnapshot } = require('./productionStatusPreservation');
const { normalizeOrderStatus } = require('../status-contracts');
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

function capture(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw Object.assign(new Error('הזמנה לא נמצאה'), { status: 404 });
  const items = db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(orderId);
  return { order, items };
}
function fingerprint(db, orderId) {
  const state = capture(db, orderId);
  const preview = orderStatusCorrectionPreview(db, orderId, state.order.status);
  const activity = db.prepare('SELECT * FROM worker_card_activity WHERE order_id=? ORDER BY id').all(orderId);
  const scans = db.prepare('SELECT s.* FROM scan_log s JOIN items i ON i.id=s.item_id JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY s.id').all(orderId);
  return deliverySelectionFingerprint({ state, preview, activity, scans });
}
function record(db, before, { userId, userName, reversible = true } = {}) {
  const id = before.order.id;
  return Number(db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,user_id,user_name)
    VALUES('order',?,?,'status_restore_point','production_state',?,?,?,?)`).run(id,before.order.order_num,
      JSON.stringify(before),JSON.stringify({ fingerprint:fingerprint(db,id),reversible }),userId||null,userName||null).lastInsertRowid);
}
function preview(db, orderId) {
  const state = capture(db,orderId);
  const row = db.prepare("SELECT * FROM audit_log WHERE entity_type='order' AND entity_id=? AND action='status_restore_point' ORDER BY id DESC LIMIT 1").get(orderId);
  if (!row) return { available:false, reason:'אין שינוי קודם עם נקודת חזרה שמורה' };
  const before = JSON.parse(row.old_value), after = JSON.parse(row.new_value);
  const blocked = state.order.deleted_at || state.order.locked || normalizeOrderStatus(state.order.status)==='בוטלה';
  const unchanged = !blocked && after.fingerprint === fingerprint(db,orderId);
  return { available:!!after.reversible && unchanged, restore_point_id:row.id,
    target_status:before.order.status, current_status:state.order.status, changed_by:row.user_name,
    changed_at:row.created_at, fingerprint:unchanged?after.fingerprint:null,
    reason:blocked?'ההזמנה נעולה, בוטלה או נמצאת בסל המחזור':!after.reversible?'התיקון כלל שינוי מסמכי משלוח או העמסה; נדרש תיקון דרך המסלול המתאים':!unchanged?'נוספו דיווחים או עדכונים מאז השינוי; יש לבצע תיקון לפי המצב הנוכחי':null };
}
// Must run in the Orders transaction. Never restore geometry, documents, stock or quantities.
function restore(db, orderId, body, actor) {
  const p = preview(db,orderId);
  if (!p.available) fail(p.reason);
  if (Number(body.restore_point_id)!==p.restore_point_id || body.fingerprint!==p.fingerprint) fail('המצב השתנה; יש לפתוח שוב את אפשרות החזרה');
  const reason = String(body.reason||'').trim();
  if (reason.length<3 || reason.length>2000) throw Object.assign(new Error('יש להזין סיבת תיקון'),{status:400});
  const row = db.prepare('SELECT * FROM audit_log WHERE id=?').get(p.restore_point_id);
  const before = JSON.parse(row.old_value), current = capture(db,orderId);
  for (const item of before.items) restoreProductionStatusSnapshot(db,item);
  db.prepare('UPDATE orders SET status=?,approved_by=?,approved_at=?,workspace_version=workspace_version+1 WHERE id=?')
    .run(before.order.status,before.order.approved_by,before.order.approved_at,orderId);
  db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
    VALUES('order',?,?,'status_restored','status',?,?,?,?,?)`).run(orderId,before.order.order_num,current.order.status,before.order.status,reason,actor.userId||null,actor.userName||null);
  record(db,current,actor);
  return { status:before.order.status, items:before.items.map(i=>({id:i.id,status:i.status})) };
}
module.exports={ capture,record,preview,restore };
