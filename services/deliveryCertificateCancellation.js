'use strict';
const {deliverySelectionFingerprint,buildDeliveryCertificateProgress} = require('./deliveryCertificateProgress');
function fail(message,status=409) { throw Object.assign(new Error(message),{status}); }
function cancellationPreview(db,orderId,noteId,{ignoreActiveLoading=false}={}) {
  const note=db.prepare('SELECT * FROM delivery_notes WHERE id=? AND order_id=?').get(noteId,orderId);
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!note || !order) fail('תעודה לא נמצאה בהזמנה',404);
  if(db.prepare('SELECT 1 FROM delivery_note_cancellations WHERE note_id=?').get(noteId)) fail('התעודה כבר מבוטלת');
  // Truck departures have package/stock/signature dependencies. Do not pretend
  // that cancelling their PDF reverses a physical warehouse movement.
  if(!String(note.note_num||'').startsWith('CERT-') || note.delivery_id || note.signed_by || note.signature_data || note.delivered_at || note.driver_id) fail('תעודה זו קשורה למשלוח מחסן או לאישור מסירה; נדרש תיקון המשלוח המקושר לפני ביטול');
  if(db.prepare('SELECT 1 FROM delivery_note_orders WHERE delivery_note_id=?').get(noteId)) fail('תעודה משותפת דורשת תיקון המשלוח המקושר');
  if(!ignoreActiveLoading && db.prepare("SELECT 1 FROM order_loading_sessions WHERE order_id=? AND status='active'").get(orderId)) fail('יש העמסה פעילה במחסן; יש לסיים או לבטל אותה לפני תיקון תעודה');
  if(db.prepare('SELECT 1 FROM invoices WHERE order_id=?').get(orderId)) fail('קיימת חשבונית מקושרת להזמנה; נדרש טיפול בחיוב לפני ביטול התעודה');
  if(db.prepare("SELECT 1 FROM export_log WHERE entity_type IN ('delivery_note','delivery-notes') AND entity_id=?").get(noteId)) fail('התעודה יוצאה למערכת אחרת; נדרש טיפול במסמך המקושר לפני ביטול');
  let snapshot,packages;
  try { snapshot=JSON.parse(note.items_json||'[]');packages=JSON.parse(note.packages_json||'[]'); } catch { fail('היסטוריית התעודה אינה תקינה; נדרש אימות'); }
  if(!Array.isArray(snapshot) || !snapshot.length || !Array.isArray(packages) || packages.length) fail('נדרש תיקון משלוח מחסן או אימות היסטוריה');
  const ids=[...new Set(snapshot.map(row=>Number(row.id)))];
  if(ids.some(id=>!Number.isSafeInteger(id)||id<=0) || ids.length!==snapshot.length) fail('נדרש אימות פריטי התעודה');
  const items=db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=? ORDER BY i.id').all(orderId);
  const byId=new Map(items.map(row=>[row.id,row]));
  const other=db.prepare(`SELECT dn.items_json,dno.items_json AS scoped_items FROM delivery_notes dn LEFT JOIN delivery_note_cancellations dc ON dc.note_id=dn.id
    LEFT JOIN delivery_note_orders dno ON dno.delivery_note_id=dn.id AND dno.order_id=?
    WHERE (dn.order_id=? OR dno.order_id=?) AND dn.id<>? AND dc.note_id IS NULL`).all(orderId,orderId,orderId,noteId);
  for(const row of other) {
    let otherItems;try {otherItems=JSON.parse(row.scoped_items||row.items_json||'[]');} catch {fail('נדרש אימות היסטוריית משלוחים');}
    if(!Array.isArray(otherItems)) fail('נדרש אימות היסטוריית משלוחים');
    if(otherItems.some(it=>ids.includes(Number(it.parent_item_id||it.id)))) fail('פריט בתעודה כבר מקושר לתעודה תקפה נוספת; נדרש תיקון התעודות המקושרות יחד');
  }
  const restore=snapshot.map(row=>{
    const item=byId.get(Number(row.id));
    if(!item || item.cancelled_at || ['בוטל','בוטלה'].includes(item.status)) fail('פריט בתעודה חסר או בוטל; נדרש אימות לפני ביטול המסמך');
    const prior=['הועמס','נשלח','סופק'].includes(row.status)?row.status:'הועמס';
    return {id:item.id,quantity:Number(row.shipment_quantity??row.quantity),old_status:item.status,
      status:item.status==='נשלח'?prior:item.status};
  });
  if(restore.some(row=>!Number.isFinite(row.quantity)||row.quantity<=0)) fail('כמות בתעודה אינה תקינה');
  return {note_id:note.id,order_id:order.id,items:restore,
    fingerprint:deliverySelectionFingerprint({note,order,items}),snapshot};
}
function cancelCertificate(db,{orderId,noteId,reason,expectedFingerprint,userId,userName}) {
  const explanation=String(reason||'').trim();
  if(explanation.length<3 || explanation.length>2000) fail('יש להזין סיבת ביטול בין 3 ל־2000 תווים',400);
  return db.transaction(()=>{
    const preview=cancellationPreview(db,orderId,noteId);
    if(!expectedFingerprint || expectedFingerprint!==preview.fingerprint) fail('ההזמנה או התעודה השתנו; יש לפתוח מחדש את הביטול');
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    db.prepare('INSERT INTO delivery_note_cancellations(note_id,reason,created_by,restored_items_json,order_status_before) VALUES(?,?,?,?,?)').run(noteId,explanation,userId||null,JSON.stringify(preview.items),order.status);
    for(const row of preview.items) {
      // Keep production quantities, times, dimensions and inventory untouched.
      if(row.old_status!==row.status) db.prepare('UPDATE items SET status=? WHERE id=?').run(row.status,row.id);
      db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?)').run('item',row.id,order.order_num,'delivery_certificate_cancel','status',row.old_status,row.status,explanation,userId||null,userName||null);
    }
    const items=db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=?').all(orderId);
    const progress=buildDeliveryCertificateProgress(db,orderId,items);
    let next=order.status;
    if(['נשלחה','אספקה חלקית'].includes(order.status)) {
      const previous=preview.snapshot[0]?.certificate_order?.status;
      next=progress.certificates.some(note=>!note.cancelled_at)?'אספקה חלקית':(['בוטלה','נשלחה','סופק – אושר'].includes(previous)||!previous?progress.production_status:previous);
      db.prepare('UPDATE orders SET status=?,workspace_version=workspace_version+1 WHERE id=?').run(next,orderId);
    }
    db.prepare('UPDATE delivery_note_cancellations SET order_status_after=? WHERE note_id=?').run(next,noteId);
    db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?)').run('delivery_note',noteId,order.order_num,'cancel_for_correction','document_status','valid','cancelled',explanation,userId||null,userName||null);
    return {ok:true,note_id:noteId,order_status:next,restored_items:preview.items};
  })();
}
module.exports={cancellationPreview,cancelCertificate};
