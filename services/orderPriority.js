'use strict';
const {ORDER_STATUS,normalizeOrderStatus}=require('../status-contracts');
function fail(statusCode,message){throw Object.assign(Error(message),{statusCode});}
function updatePriority(db,{order_id,priority,expected_priority,actor_id,actor_name}){
  if(!['רגיל','דחוף'].includes(priority)||!['רגיל','דחוף'].includes(expected_priority))fail(400,'יש לבחור דחיפות רגילה או דחופה');
  return db.transaction(()=>{
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);if(!order)fail(404,'הזמנה לא נמצאה');
    if(order.deleted_at||order.locked)fail(409,'לא ניתן לשנות דחיפות להזמנה נעולה או להזמנה שבסל המחזור');
    if([ORDER_STATUS.CANCELLED,ORDER_STATUS.SENT,ORDER_STATUS.ON_THE_WAY,ORDER_STATUS.DELIVERED_CONFIRMED].includes(normalizeOrderStatus(order.status)))fail(409,'ההזמנה כבר בוטלה או יצאה מהמפעל');
    const current=order.priority||'רגיל';if(current!==expected_priority)fail(409,'הדחיפות עודכנה בינתיים. יש לרענן את ההזמנות לפני שינוי');
    if(current===priority)return {success:true,changed:false,order};
    db.prepare('UPDATE orders SET priority=?,workspace_version=workspace_version+1 WHERE id=?').run(priority,order.id);
    db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?)').run('order',order.id,order.order_num,'priority_change','priority',current,priority,actor_id??null,actor_name??null);
    return {success:true,changed:true,order:db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)};
  }).immediate();
}
module.exports={updatePriority};
