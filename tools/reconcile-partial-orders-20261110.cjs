'use strict';
// Reviewed owner-specific maintenance. No receipt, completion date, measured
// weight, production output or delivery certificate is invented by this script.
const Database=require('better-sqlite3'),fs=require('node:fs');
const inventory=require('../services/inventoryItemCompletion');
const {ORDER_STATUS,ITEM_STATUS}=require('../status-contracts');
const {kg}=require('../services/materialBalance');
const KEY='owner-partial-orders105-107-diameter12-20261110-v1';
const REASON='הבעלים אישר אספקה חלקית בהזמנות 105–107, למעט קוטר 12; קוטר 12 יופחת מהמלאי החדש בסיום הייצור';
function apply(db){return db.transaction(()=>{
 const replay=db.prepare("SELECT new_value FROM audit_log WHERE entity_type='partial_stock_reconciliation' AND entity_ref=?").get(KEY);
 if(replay)return {...JSON.parse(replay.new_value),replay:true};
 const orders=[105,106,107].map(id=>db.prepare('SELECT * FROM orders WHERE id=?').get(id));
 if(orders.some((o,i)=>!o||o.order_num!==`HZ-2026-${105+i}`||o.deleted_at||['בוטלה','בוטל'].includes(o.status)))throw Error('reviewed_order_scope_changed');
 if(db.prepare('SELECT 1 FROM delivery_notes WHERE order_id IN (105,106,107) LIMIT 1').get()||db.prepare('SELECT 1 FROM delivery_note_orders WHERE order_id IN (105,106,107) LIMIT 1').get())throw Error('delivery_document_evidence_requires_review');
 const items=db.prepare('SELECT i.*,COALESCE(i.order_id,p.order_id) owner_order_id FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id WHERE COALESCE(i.order_id,p.order_id) IN (105,106,107) ORDER BY COALESCE(i.completed_at,\'9999\'),i.id').all();
 const selected=items.filter(i=>Number(i.diameter)===12&&!i.cancelled_at&&i.status!==ITEM_STATUS.CANCELLED);
 if(selected.length!==37)throw Error('reviewed_diameter12_scope_changed');
 const otherLotsBefore=JSON.stringify(db.prepare("SELECT * FROM raw_material WHERE diameter<>12 OR COALESCE(material_type,'coil')<>'coil' ORDER BY id").all());
 const beforeTotal=db.prepare('SELECT SUM(weight_received+stock_adjustment_kg-weight_used-weight_scrapped) kg FROM raw_material WHERE active=1').get().kg;
 const authorization=inventory.authorizeConsumptionOverrides(db,{item_ids:selected.map(i=>i.id),reason:REASON});
 for(const order of orders){
   const supplied=items.filter(i=>i.owner_order_id===order.id&&Number(i.diameter)!==12&&!i.cancelled_at&&i.status!==ITEM_STATUS.CANCELLED);
   const previous=supplied.map(i=>({id:i.id,status:i.status}));
   // Partial delivery was declared without item-level delivered quantities.
   // Preserve child delivery states and documents rather than inventing them.
   db.prepare('UPDATE orders SET status=?,workspace_version=workspace_version+1 WHERE id=?').run(ORDER_STATUS.PARTIAL_DELIVERY,order.id);
   db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,old_value,new_value,notes) VALUES(?,?,?,?,?,?,?)').run('order',order.id,order.order_num,'correct_false_full_delivery_to_partial',JSON.stringify({order_status:order.status,supplied_items:previous}),JSON.stringify({order_status:ORDER_STATUS.PARTIAL_DELIVERY,unsupplied_diameter:12}),REASON);
 }
 const results=selected.map(item=>({item_id:item.id,order_id:item.owner_order_id,...inventory.consumeItem(db,{item_id:item.id,reason:REASON})}));
 const pending=results.filter(r=>r.pending).map(r=>{
   const reservation=db.prepare("SELECT pending_actual_kg FROM inventory_reservations WHERE item_id=? AND pending_actual_kg IS NOT NULL ORDER BY id DESC LIMIT 1").get(r.item_id);
   const prior=inventory.state(db,r.item_id);
   return {...r,unrecorded_kg:kg((reservation?.pending_actual_kg||0)-(prior?.consumed_kg||0))};
 });
 const totalUnrecorded=kg(pending.reduce((n,r)=>n+r.unrecorded_kg,0));
 const available=db.prepare("SELECT ROUND(SUM(weight_received+stock_adjustment_kg-weight_used-weight_scrapped),3) kg FROM raw_material WHERE active=1 AND diameter=12 AND COALESCE(material_type,'coil')='coil'").get().kg;
 const afterTotal=db.prepare('SELECT SUM(weight_received+stock_adjustment_kg-weight_used-weight_scrapped) kg FROM raw_material WHERE active=1').get().kg;
 if(otherLotsBefore!==JSON.stringify(db.prepare("SELECT * FROM raw_material WHERE diameter<>12 OR COALESCE(material_type,'coil')<>'coil' ORDER BY id").all()))throw Error('unrelated_material_changed');
 const result={order_ids:[105,106,107],status:ORDER_STATUS.PARTIAL_DELIVERY,authorized_items:authorization.authorized,consumed_items:results.filter(r=>r.consumed).length,consumed_kg:kg(results.reduce((n,r)=>n+(r.consumed_kg||0),0)),waiting_items:results.filter(r=>r.reason==='production_incomplete').length,pending_items:pending,pending_kg:totalUnrecorded,remaining_coil12_kg:available,additional_coil12_needed_kg:kg(Math.max(0,totalUnrecorded-available)),inventory_delta_kg:kg(afterTotal-beforeTotal),total_stock_kg:kg(afterTotal),replay:false};
 db.prepare('INSERT INTO audit_log(entity_type,entity_ref,action,new_value,notes) VALUES(?,?,?,?,?)').run('partial_stock_reconciliation',KEY,'owner_declared_partial_delivery_and_count_consumption',JSON.stringify(result),REASON);
 return result;
}).immediate();}
module.exports={apply};
if(require.main===module){
 const [dbPath,reportPath]=process.argv.slice(2);if(!dbPath||!reportPath)throw Error('Usage: DB REPORT_JSON');
 const db=new Database(dbPath,{fileMustExist:true});if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('integrity_failed');
 const report=apply(db);report.integrity=db.pragma('integrity_check',{simple:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));db.close();
}
