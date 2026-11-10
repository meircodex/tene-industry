'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const closure=require('../services/historicalOrderClosure'),inventory=require('../services/inventoryItemCompletion');
function setup(){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureCoreSchema(db);
 db.exec("INSERT INTO orders(id,order_num,status,created_at) VALUES(1,'OLD','בייצור','2026-11-04 10:00:00'),(2,'READY','הושלם – ממתין לאיסוף','2026-11-05 10:00:00'),(3,'NEW','בייצור','2026-11-08 12:00:00'); INSERT INTO items(id,order_id,diameter,total_weight,quantity,status) VALUES(1,1,12,100,10,'ממתין'),(2,2,12,100,10,'הושלם'),(3,3,12,100,10,'בייצור');INSERT INTO inventory_reservations(order_id,item_id,diameter,material_type,reserved_kg,consumption_mode) VALUES(1,1,12,'coil',100,'on_completion'),(2,2,12,'coil',100,'on_completion'),(3,3,12,'coil',100,'on_completion'); INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(1,12,'coil',1000); INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(1,'physical','x','2026-11-08T20:56:41.574Z','count',1)");
 inventory.activatePolicy(db,{stocktake_id:1});return db;
}
function input(db){return {order_ids:[1],preview_token:closure.preview(db,{order_ids:[1]}).preview_token,idempotency_key:'historical-1',owner_confirmed:true,reason:'הבעלים אישר שסופק לפני ספירת המלאי'};}
test('historical delivery closes only explicit orders, preserves all physical inventory and does not invent production',()=>{
 const db=setup(),before=closure.physicalFingerprint(db),action=input(db),result=closure.closeHistoricalOrders(db,action);
 assert.equal(result.inventory_delta_kg,0);assert.equal(closure.physicalFingerprint(db),before);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=1').get().status,'סופק – אושר');
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=2').get().status,'הושלם – ממתין לאיסוף');
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=3').get().status,'בייצור');
 const item=db.prepare('SELECT * FROM items WHERE id=1').get();assert.equal(item.status,'סופק');assert.equal(item.completed_at,null);assert.equal(item.produced_qty,0);
 assert.equal(db.prepare('SELECT status FROM inventory_reservations WHERE item_id=1').get().status,'released');
 db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-10 10:00:00' WHERE id=1");assert.equal(inventory.consumeItem(db,{item_id:1}).consumed,0);
 assert.equal(closure.closeHistoricalOrders(db,action).replay,true);assert.equal(closure.physicalFingerprint(db),before);db.close();
});
test('stale preview or missing owner declaration cannot modify statuses',()=>{
 const db=setup(),action=input(db);assert.throws(()=>closure.closeHistoricalOrders(db,{...action,owner_confirmed:false}),/declaration_required/);
 db.exec("UPDATE orders SET priority='דחוף' WHERE id=1");assert.throws(()=>closure.closeHistoricalOrders(db,action),/preview_stale/);assert.equal(db.prepare('SELECT status FROM orders WHERE id=1').get().status,'בייצור');db.close();
});
test('cancelled/deleted orders and already consumed material require separate reconciliation',()=>{
 const db=setup();db.exec("UPDATE orders SET status='בוטלה' WHERE id=1");assert.throws(()=>closure.preview(db,{order_ids:[1]}),/scope_invalid/);
 db.exec("UPDATE orders SET status='בייצור' WHERE id=1;UPDATE items SET status='הושלם',completed_at='2026-11-09 10:00:00' WHERE id=1");inventory.consumeItem(db,{item_id:1});assert.throws(()=>closure.preview(db,{order_ids:[1]}),/already_consumed/);db.close();
});
