'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const completion=require('../services/inventoryItemCompletion');
const reservation=require('../services/inventoryReservation');
function setup({created='2026-11-04 10:00:00',excluded=[]}={}){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureCoreSchema(db);
 db.prepare("INSERT INTO orders(id,order_num,created_at) VALUES(1,'ITEM',?)").run(created);
 db.exec("INSERT INTO items(id,order_id,diameter,total_weight,quantity,status,completed_at) VALUES(1,1,12,100,10,'הושלם','2026-11-09 10:00:00'),(2,1,12,200,20,'ממתין',NULL);INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(1,12,'coil',1000);INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(1,'physical','x','2026-11-08T20:56:41.574Z','count',1)");
 reservation.reserveMaterialForOrder(db,{order_id:1,items:[{id:1,diameter:12,total_weight:100},{id:2,diameter:12,total_weight:200}]});
 completion.activatePolicy(db,{stocktake_id:1,completed_item_ids:excluded});return db;
}
const used=db=>db.prepare('SELECT SUM(weight_used) kg FROM raw_material').get().kg;
const consume=(db,amount)=>reservation.consumeReservationsForProduction(db,{order_id:1,item_ids:[1],actual_weight_kg:amount});
test('completed item consumes without waiting for the order and repeated reports do not debit twice',()=>{
 const db=setup();assert.equal(consume(db,90).consumed,1);assert.equal(used(db),90);assert.equal(consume(db,90).consumed,0);assert.equal(used(db),90);db.close();
});
test('actual weight correction returns the exact difference to the original lot and keeps both movements',()=>{
 const db=setup();consume(db,100);consume(db,80);assert.equal(used(db),80);assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_item_completion_events').get().n,3);consume(db,80);assert.equal(used(db),80);
 assert.equal(db.prepare('SELECT SUM(weight_used) kg FROM raw_material_usage').get().kg,80);db.close();
});
test('creation lookback is inclusive and completion must be strictly later than count',()=>{
 for(const [created,weight] of [['2026-11-01T20:56:41.574Z',100],['2026-11-01T20:56:41.573Z',0],['2026-11-09 00:00:00',100]]){
  const db=setup({created});consume(db);assert.equal(used(db),weight);db.close();
 }
 const db=setup();db.exec("UPDATE items SET completed_at='2026-11-08T20:56:41.574Z' WHERE id=1");consume(db);assert.equal(used(db),0);db.close();
});
test('baseline completed items stay excluded after a later rescan; a status rollback alone does not return physical steel',()=>{
 const excluded=setup({excluded:[1]});consume(excluded);assert.equal(used(excluded),0);excluded.close();
 const db=setup();consume(db);db.exec("UPDATE items SET status='ממתין',completed_at=NULL WHERE id=1");consume(db);assert.equal(used(db),100);db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-10 10:00:00' WHERE id=1");consume(db);assert.equal(used(db),100);db.close();
});
test('an unavailable corrected debit rolls back the refund and retries after stock arrival',()=>{
 const db=setup();consume(db,100);const result=consume(db,1100);assert.equal(result.pending[0].missing_kg,100);assert.equal(used(db),100);
 assert.equal(require('../services/inventoryPlanning').planInventory(db).groups.find(g=>g.diameter===12).backlog_kg,1200);
 db.exec("INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(2,12,'coil',200)");consume(db);assert.equal(used(db),1100);db.close();
});
test('pending consumption of a previously closed legacy reservation stays in procurement demand',()=>{
 const db=setup({created:'2026-10-14 10:00:00'});completion.authorizeConsumptionOverrides(db,{item_ids:[1],reason:'הבעלים אישר'});
 db.exec("UPDATE inventory_reservations SET status='consumed',consumption_mode='legacy' WHERE item_id=1;UPDATE raw_material SET weight_received=25");
 assert.equal(consume(db).pending[0].missing_kg,75);
 assert.equal(require('../services/inventoryPlanning').planInventory(db).groups.find(g=>g.diameter===12).backlog_kg,100);db.close();
});
test('erroneous production returns a proportional amount, once, to its source lots',()=>{
 const db=setup();consume(db,100);const input={itemId:1,ratio:0.4,eventKey:'correction:1',reason:'דיווח שגוי',actorId:1};
 assert.equal(completion.returnErroneousProduction(db,input).returned_kg,40);assert.equal(used(db),60);assert.equal(completion.returnErroneousProduction(db,input).returned_kg,0);assert.equal(used(db),60);db.close();
});
test('legacy pre-count usage is preserved and is not refunded from the new physical balance',()=>{
 const db=setup();db.exec("UPDATE inventory_reservations SET consumption_mode='legacy',status='consumed';UPDATE raw_material SET weight_used=100,stock_adjustment_kg=100;INSERT INTO raw_material_usage(raw_material_id,order_id,item_id,weight_used,used_at) VALUES(1,1,1,100,'2026-11-04 10:00:00')");consume(db);assert.equal(used(db),200);assert.equal(db.prepare('SELECT stock_adjustment_kg n FROM raw_material').get().n,100);db.close();
});
test('revised consumed items can reserve again and reconcile diameter inside the same transaction',()=>{
 const db=setup();consume(db);db.exec("INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(2,16,'coil',200)");
 db.transaction(()=>{reservation.releaseReservationsForItems(db,{item_ids:[1],correction_reason:'תיקון קוטר'});db.exec('UPDATE items SET diameter=16,total_weight=120 WHERE id=1');reservation.reserveMaterialForOrder(db,{order_id:1,items:[{id:1,diameter:16,total_weight:120}]});completion.consumeItem(db,{item_id:1,strict:true,reason:'תיקון קוטר'});})();
 assert.equal(db.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used,0);assert.equal(db.prepare('SELECT weight_used FROM raw_material WHERE id=2').get().weight_used,120);db.close();
});
test('straight lengths remain distinct and cannot consume coils',()=>{
 const db=setup();db.prepare('UPDATE items SET total_length_mm=12000,shape_snapshot_json=? WHERE id=1').run(JSON.stringify({family:'lifts'}));db.exec("UPDATE inventory_reservations SET material_type='straight' WHERE item_id=1;INSERT INTO raw_material(id,diameter,material_type,nominal_length_mm,weight_received) VALUES(2,12,'straight',6000,1000)");assert.equal(consume(db).pending[0].missing_kg,100);assert.equal(used(db),0);db.close();
});
test('a weight correction stocktake cannot move the physical count boundary',()=>{
 const db=setup();db.exec("INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(2,'correction','x','2026-11-10T07:29:42Z','correction',1)");consume(db);const metrics=require('../services/inventoryMetrics').inventoryMetrics(db);assert.equal(metrics.baseline.id,1);assert.equal(metrics.recorded_net_kg,100);db.close();
});
test('planning excludes historical completed and supplied demand but keeps current production demand',()=>{
 const db=setup({excluded:[1]}),plan=require('../services/inventoryPlanning').planInventory;
 assert.equal(plan(db).groups.find(g=>g.diameter===12).backlog_kg,200);
 db.exec("UPDATE inventory_reservations SET consumption_mode='legacy' WHERE item_id=2;INSERT INTO raw_material_usage(raw_material_id,order_id,item_id,weight_used,used_at) VALUES(1,1,2,200,'2026-11-04 10:00:00')");
 assert.equal(plan(db).groups.find(g=>g.diameter===12).backlog_kg,200);
 db.exec("UPDATE orders SET status='סופק – אושר' WHERE id=1");assert.equal(plan(db).groups.find(g=>g.diameter===12).backlog_kg,0);
 db.exec("UPDATE orders SET status='בייצור',created_at='2026-10-08 10:00:00' WHERE id=1");assert.equal(plan(db).groups.find(g=>g.diameter===12).backlog_kg,0);db.close();
});
test('an explicit diameter-specific item exception admits an older order without admitting its other items',()=>{
 const db=setup({created:'2026-10-14 10:00:00'});assert.equal(consume(db).consumed,0);
 assert.equal(completion.authorizeConsumptionOverrides(db,{item_ids:[1],reason:'הבעלים אישר קוטר 12 מהמלאי החדש'}).authorized,1);
 assert.equal(consume(db).consumed,1);assert.equal(used(db),100);
 assert.equal(completion.authorizeConsumptionOverrides(db,{item_ids:[1],reason:'הבעלים אישר קוטר 12 מהמלאי החדש'}).authorized,0);assert.equal(consume(db).consumed,0);
 db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-10 10:00:00' WHERE id=2");assert.equal(completion.consumeItem(db,{item_id:2}).consumed,0);
 db.exec('UPDATE items SET diameter=16 WHERE id=1');assert.equal(completion.eligibility(db,completion.itemRecord(db,1)),'created_before_lookback');db.close();
});
test('override keeps unfinished material in demand, but never debits it before completion or before count',()=>{
 const db=setup({created:'2026-10-14 10:00:00'}),plan=require('../services/inventoryPlanning').planInventory;
 completion.authorizeConsumptionOverrides(db,{item_ids:[2],reason:'הבעלים אישר קוטר 12 מהמלאי החדש'});
 db.exec("UPDATE orders SET status='סופק – אושר' WHERE id=1");assert.equal(plan(db).groups.find(g=>g.diameter===12).backlog_kg,200);assert.equal(completion.consumeItem(db,{item_id:2}).consumed,0);
 db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-07 10:00:00' WHERE id=2");assert.equal(completion.consumeItem(db,{item_id:2}).consumed,0);assert.equal(used(db),0);db.close();
});
