'use strict';
// Orders owns this explicit maintenance operation. It records the owner's
// declaration of past delivery; it does not manufacture production/stock events.
const crypto=require('node:crypto');
const {ORDER_STATUS,ITEM_STATUS,normalizeOrderStatus}=require('../status-contracts');
const {releaseAllReservationsForOrder}=require('./inventoryReservation');
const inventory=require('./inventoryItemCompletion');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshot(db,orderIds){
  return orderIds.map(id=>({order:db.prepare('SELECT * FROM orders WHERE id=?').get(id),items:db.prepare('SELECT i.* FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id WHERE COALESCE(i.order_id,p.order_id)=? ORDER BY i.id').all(id),reservations:db.prepare('SELECT * FROM inventory_reservations WHERE order_id=? ORDER BY id').all(id)}));
}
function physicalFingerprint(db){
  return hash(['raw_material','raw_material_usage','inventory_mesh_stock','inventory_mesh_movements','material_consumption_events_v2','material_consumption_event_lines_v2','inventory_item_completion_state','inventory_item_completion_events'].map(table=>({table,rows:db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()})));
}
function preview(db,{order_ids}={}){
  if(!Array.isArray(order_ids)||!order_ids.length||order_ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('explicit_order_ids_required');
  const ids=[...new Set(order_ids)].sort((a,b)=>a-b),rows=snapshot(db,ids);
  if(rows.some(r=>!r.order||r.order.deleted_at||normalizeOrderStatus(r.order.status)===ORDER_STATUS.CANCELLED))throw Error('historical_order_scope_invalid');
  if(rows.some(r=>Number(r.order.inventory_lifecycle_version)===2))throw Error('historical_v2_requires_reconciliation');
  if(rows.some(r=>r.items.some(i=>(inventory.state(db,i.id)?.consumed_kg||0)>0)))throw Error('historical_item_already_consumed');
  return {order_ids:ids,preview_token:hash(rows),orders:rows.map(r=>({id:r.order.id,order_num:r.order.order_num,from_status:r.order.status,to_status:ORDER_STATUS.DELIVERED_CONFIRMED,created_at:r.order.created_at,item_count:r.items.length})),physical_fingerprint:physicalFingerprint(db)};
}
function closeHistoricalOrders(db,input={}){
  const key=String(input.idempotency_key||'').trim(),reason=String(input.reason||'').trim();
  if(!key||reason.length<3||input.owner_confirmed!==true)throw Error('historical_owner_declaration_required');
  return db.transaction(()=>{
    const replay=db.prepare("SELECT new_value FROM audit_log WHERE entity_type='historical_order_closure' AND entity_ref=? AND action='close_supplied_without_consumption'").get(key);
    if(replay){const result=JSON.parse(replay.new_value);if(hash(result.order_ids)!==hash([...new Set(input.order_ids)].sort((a,b)=>a-b)))throw Error('idempotency_key_conflict');return {...result,replay:true};}
    const current=preview(db,input);
    if(current.preview_token!==input.preview_token)throw Error('historical_preview_stale');
    const before=snapshot(db,current.order_ids),exempt=[];let updatedItems=0;
    for(const row of before){
      db.prepare('UPDATE orders SET status=?,workspace_version=workspace_version+1 WHERE id=?').run(ORDER_STATUS.DELIVERED_CONFIRMED,row.order.id);
      for(const item of row.items){
        if(item.status===ITEM_STATUS.CANCELLED||item.cancelled_at)continue;
        // Completion/measurement timestamps and produced quantities stay intact.
        updatedItems+=db.prepare('UPDATE items SET status=? WHERE id=? AND status<>?').run(ITEM_STATUS.DELIVERED,item.id,ITEM_STATUS.DELIVERED).changes;
        exempt.push(item.id);
      }
      releaseAllReservationsForOrder(db,{order_id:row.order.id});
      db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?)').run('order',row.order.id,row.order.order_num,'historical_delivery_status_reconciled','status',JSON.stringify({status:row.order.status,items:row.items}),ORDER_STATUS.DELIVERED_CONFIRMED,reason,input.actor_id??null,input.actor_name??null);
    }
    inventory.exemptHistoricalItems(db,{item_ids:exempt,reason});
    if(physicalFingerprint(db)!==current.physical_fingerprint)throw Error('historical_closure_changed_physical_inventory');
    const result={order_ids:current.order_ids,orders_updated:before.length,items_updated:updatedItems,status:ORDER_STATUS.DELIVERED_CONFIRMED,inventory_delta_kg:0,physical_fingerprint:current.physical_fingerprint,replay:false};
    db.prepare('INSERT INTO audit_log(entity_type,entity_ref,action,old_value,new_value,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?,?)').run('historical_order_closure',key,'close_supplied_without_consumption',JSON.stringify(current),JSON.stringify(result),reason,input.actor_id??null,input.actor_name??null);
    return result;
  }).immediate();
}
module.exports={preview,closeHistoricalOrders,physicalFingerprint};
