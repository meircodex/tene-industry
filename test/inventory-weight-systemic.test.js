'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const completion=require('../services/inventoryItemCompletion');
const reservation=require('../services/inventoryReservation');
const {planInventory}=require('../services/inventoryPlanning');
const {effectiveItemWeight}=require('../services/orderCommercialSummary');
const {itemShapeMetrics}=require('../services/shapeSnapshot');
const shape=JSON.stringify({contractVersion:2,shapeVersion:1,shapeId:'bar',shapeType:'straight_bar',family:'bars',data:{diameter:20,sides:[5350]},
  calculated:{totalLengthMm:5350,weightKg:13.215,unitWeightKg:13.215,totalWeightKg:13.215},machineOutput:{},validation:{valid:true}});
function setup(){
  const db=new Database(':memory:');ensureCoreSchema(db);
  db.exec(`INSERT INTO orders(id,order_num,created_at) VALUES(1,'HZ-TEST','2026-11-09 10:00:00');
    INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(1,20,'coil',10000);
    INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(1,'count','x','2026-11-08T20:56:41.574Z','count',1)`);
  completion.activatePolicy(db,{stocktake_id:1});
  db.prepare(`INSERT INTO items(id,order_id,diameter,quantity,weight_per_unit,total_weight,shape_snapshot_json,status,source_item_number) VALUES(1,1,20,45,13.2145,594.6525,?,'ממתין','22')`).run(shape);
  const item=db.prepare('SELECT * FROM items WHERE id=1').get();reservation.reserveMaterialForOrder(db,{order_id:1,items:[item]});
  return db;
}
const item=db=>db.prepare('SELECT * FROM items WHERE id=1').get();
const used=db=>db.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used;
test('one weight drives card, stale reservation projection, paged details, stock position and physical completion',()=>{
  const db=setup();
  db.exec('UPDATE inventory_reservations SET reserved_kg=13.215');
  assert.equal(itemShapeMetrics(item(db)).totalWeightKg,594.6525);
  assert.equal(effectiveItemWeight(item(db)).weightKg,594.653);
  const before=db.prepare('SELECT * FROM inventory_reservations').get();
  const plan=planInventory(db,{include_details:true,detail_limit:1});
  const group=plan.groups.find(g=>g.diameter===20);
  assert.equal(group.backlog_kg,594.653);
  assert.equal(group.demand_details.items[0].item_number,'22');
  assert.equal(group.demand_details.items[0].remaining_kg,group.backlog_kg);
  assert.equal(reservation.calculateMaterialStockPosition(db,{diameter:20}).reservedKg,group.backlog_kg);
  assert.equal(used(db),0);assert.deepEqual(db.prepare('SELECT * FROM inventory_reservations').get(),before);
  db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-12 10:00:00' WHERE id=1");
  assert.equal(completion.consumeItem(db,{item_id:1}).consumed_kg,594.653);
  assert.equal(used(db),594.653);assert.equal(completion.consumeItem(db,{item_id:1}).consumed,0);
  assert.equal(planInventory(db).groups[0].backlog_kg,0);db.close();
});
test('rollout detects historical undercharges, blocks silent rescan repairs and leaves physical history intact',()=>{
  const db=setup();db.exec("UPDATE items SET status='הושלם',completed_at='2026-11-09 12:00:00' WHERE id=1");
  completion.consumeItem(db,{item_id:1,actual_weight_kg:13.215});
  const before={lot:db.prepare('SELECT * FROM raw_material').all(),usage:db.prepare('SELECT * FROM raw_material_usage').all(),events:db.prepare('SELECT * FROM inventory_item_completion_events').all()};
  db.exec('DELETE FROM inventory_weight_rollout');require('../db/inventoryWeightSchema').ensureInventoryWeightSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_weight_review_items').get().n,1);
  assert.equal(completion.consumeItem(db,{item_id:1}).pending.reason,'historical_weight_review_required');
  const group=planInventory(db,{include_details:true}).groups[0];
  assert.equal(group.completed_review_kg,581.438);assert.equal(group.backlog_kg,581.438);
  assert.equal(group.demand_details.items[0].requires_review,true);
  assert.deepEqual(db.prepare('SELECT * FROM raw_material').all(),before.lot);
  assert.deepEqual(db.prepare('SELECT * FROM raw_material_usage').all(),before.usage);
  assert.deepEqual(db.prepare('SELECT * FROM inventory_item_completion_events').all(),before.events);
  require('../db/inventoryWeightSchema').ensureInventoryWeightSchema(db);assert.equal(used(db),13.215);db.close();
});
test('current quantity updates demand without stale cached totals; cancellation removes future demand',()=>{
  const db=setup();db.exec('UPDATE items SET quantity=46 WHERE id=1');
  assert.equal(planInventory(db).groups[0].backlog_kg,607.867);
  db.exec("UPDATE items SET status='בוטל' WHERE id=1");assert.equal(planInventory(db).groups[0].backlog_kg,0);db.close();
});
test('details validate pagination, keep count lookback exclusions and are read-only',()=>{
  const db=setup();
  assert.throws(()=>planInventory(db,{include_details:true,detail_limit:101}),/pagination/);
  assert.throws(()=>planInventory(db,{include_details:true,detail_offset:-1}),/pagination/);
  assert.equal(planInventory(db,{include_details:true,detail_offset:1}).groups[0].demand_details.items.length,0);
  db.exec("UPDATE orders SET created_at='2026-10-01 10:00:00'");assert.equal(planInventory(db).groups[0].backlog_kg,0);db.close();
});

test('approved receipt retries current measured pending consumption once, but never protected historical items',()=>{
  const db=setup(),receipts=require('../services/pendingRawMaterialReceiptV2');
  db.exec("UPDATE raw_material SET weight_received=10;UPDATE items SET status='הושלם',completed_at='2026-11-12 10:00:00' WHERE id=1");
  assert.equal(completion.consumeItem(db,{item_id:1,actual_weight_kg:600}).pending.reason,'insufficient_stock');
  assert.equal(db.prepare('SELECT pending_weight_source FROM inventory_reservations').get().pending_weight_source,'actual');
  const draft=receipts.createDraft(db,{source_type:'manual',idempotency_key:'arrived',lines:[{material_type:'coil',diameter:20,weight_received:1000}]});
  const approval={receipt_id:draft.id,idempotency_key:'approved-arrived'};receipts.approveReceipt(db,approval);receipts.approveReceipt(db,approval);
  assert.equal(db.prepare('SELECT SUM(weight_used) n FROM raw_material').get().n,600);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_item_completion_events').get().n,1);
  db.exec("INSERT INTO inventory_weight_review_items(item_id,reason) VALUES(1,'historical_weight_difference');UPDATE inventory_reservations SET pending_actual_kg=700,pending_weight_source='actual'");
  completion.retryCurrentPending(db);assert.equal(db.prepare('SELECT SUM(weight_used) n FROM raw_material').get().n,600);db.close();
});
