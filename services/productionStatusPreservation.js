'use strict';
// Immutable before-image for explicit Production corrections, in the existing audit ledger.
function preserveProductionState(db,itemId,{targetStatus,reason,userId,userName,orderNum}={}){
 const item=db.prepare('SELECT * FROM items WHERE id=?').get(Number(itemId));
 if(!item)throw Object.assign(Error('פריט לא נמצא לשמירת מצב הייצור'),{status:404});
 const snapshot=JSON.stringify({version:1,item});
 const result=db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
 VALUES('item',?,?,'production_state_snapshot','production_state',?,?,?,?,?)`).run(Number(itemId),orderNum||null,snapshot,String(targetStatus||item.status),String(reason||'תיקון סטטוס'),userId||null,userName||null);
 return Number(result.lastInsertRowid);
}
// Production owns restoration of its status facts; quantities, geometry and stock are never rewritten.
function restoreProductionStatusSnapshot(db,item){
 db.prepare('UPDATE items SET status=?,started_at=?,completed_at=? WHERE id=?').run(item.status,item.started_at,item.completed_at,item.id);
}
module.exports={preserveProductionState,restoreProductionStatusSnapshot};
