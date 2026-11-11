'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {buildFullShapeSnapshot,itemShapeMetrics}=require('../services/shapeSnapshot');
const {createOrderFactory}=require('../services/orders');
const mesh=require('../services/meshInventory');
const {metrics}=require('../services/meshOrder');
const reservations=require('../services/inventoryReservation');
function shape(data={}){return buildFullShapeSnapshot({family:'mesh',shapeId:'mesh1',shapeType:'mesh_rectangular',displayName:'רשת',data:{length:6000,width:2500,longitudinalDiameter:8,longitudinalSpacing:100,transverseDiameter:8,transverseSpacing:100,edgeLeft:0,edgeRight:0,edgeTop:0,edgeBottom:0,...data},calculated:{weightKg:999,totalWeightKg:999},validation:{valid:true}});}
function setup(t){const db=new Database(':memory:');ensureCoreSchema(db);require('../db/startup').runCoreMigrations(db);t.after(()=>db.close());let seq=0;const orders=createOrderFactory(db,{generateOrderNum:()=>`MESH-${++seq}`,industry:require('../modules/steel-rebar')});return {db,orders};}
function create(orders,quantity=3,snapshot=shape()){return orders.createOrderTransaction({customer:{name:'Mesh fixture'},order:{totalWeight:0},pallets:[{items:[{shapeSnapshot:snapshot,shapeName:'רשת',diameter:8,qty:quantity,length:0,sides:[],angles:[],material_type:'coil'}]}]});}
test('mesh creation recalculates the uniform diameter, counts quantities once and creates only sheet demand',t=>{
 const {db,orders}=setup(t),result=create(orders),item=db.prepare('SELECT * FROM items').get(),snapshot=JSON.parse(item.shape_snapshot_json);
 assert.ok(Math.abs(item.weight_per_unit-118.5185185185185)<1e-9);assert.equal(item.total_weight,355.556);assert.equal(item.diameter,8);assert.equal(item.segments,'[]');assert.equal(snapshot.data.transverseDiameter,8);assert.ok(Math.abs(snapshot.calculated.weightKg-118.5185185185185)<1e-9);assert.equal(snapshot.calculated.totalWeightKg,undefined);
 assert.equal(db.prepare('SELECT total_weight FROM orders').get().total_weight,355.556);assert.equal(db.prepare('SELECT total_weight FROM pallets').get().total_weight,355.556);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_reservations').get().n,0);
 assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_demands').get().quantity_units,3);
 assert.equal(itemShapeMetrics(item).totalWeightKg,355.556);assert.ok(result.success);
});
test('invalid mesh and fractional sheet quantities roll back the whole order',t=>{
 const {db,orders}=setup(t);
 for(const [qty,snapshot] of [[1,shape({longitudinalSpacing:0})],[1,shape({width:-1})],[1.5,shape()],[1,shape({edgeLeft:6000})]])assert.throws(()=>create(orders,qty,snapshot));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,0);
});
test('stock preview separates exact mesh specs and reserves sheets without debiting physical stock',t=>{
 const {db,orders}=setup(t),spec=metrics({shapeSnapshot:shape()}).specification;
 const receipt=mesh.receiptDraft(db,{specification:spec,quantity_units:10,idempotency_key:'sheets'});mesh.approveReceipt(db,{receipt_id:receipt.id});create(orders,3);
 const previews=mesh.previewMesh(db,[{shapeSnapshot:shape(),quantity:4},{shapeSnapshot:shape({transverseSpacing:200}),quantity:2}]);
 assert.deepEqual(previews.map(p=>[p.physical_units,p.reserved_units,p.available_units,p.required_units,p.shortage_units]),[[10,3,7,4,0],[0,0,0,2,2]]);
 assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,10);
 assert.equal(mesh.meshSpecification({...spec,grade:'B500A'}).specification_key===mesh.meshSpecification(spec).specification_key,false);
 assert.equal(mesh.meshSpecification({...spec,edge_left_mm:50}).specification_key===mesh.meshSpecification(spec).specification_key,false);
});
test('completion consumes sheets once, cancellation of unissued demand releases units, never coil mass',t=>{
 const {db,orders}=setup(t),spec=metrics({shapeSnapshot:shape()}).specification;
 const receipt=mesh.receiptDraft(db,{specification:spec,quantity_units:10,idempotency_key:'stock'});mesh.approveReceipt(db,{receipt_id:receipt.id});const first=create(orders,3),second=create(orders,4);
 const item=db.prepare('SELECT id FROM items WHERE order_id=?').get(first.orderId);
 const result=reservations.consumeReservationsForProduction(db,{order_id:first.orderId,item_ids:[item.id]});assert.equal(result.consumed,1);assert.equal(mesh.consumeMesh(db,{orderId:first.orderId,itemIds:[item.id]}).consumed,0);
 assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,7);assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_material_usage').get().n,0);
 reservations.releaseAllReservationsForOrder(db,{order_id:second.orderId});assert.equal(mesh.planMesh(db)[0].available_units,7);
 assert.throws(()=>mesh.reserveMesh(db,{order_id:first.orderId,item_id:item.id,specification:spec,quantity_units:4}),/already_reserved_or_consumed/);
});
test('insufficient stock never creates negative sheets and consumption can retry after receipt',t=>{
 const {db,orders}=setup(t);const r=create(orders,3),item=db.prepare('SELECT id FROM items').get();
 assert.equal(mesh.consumeMesh(db,{orderId:r.orderId,itemIds:[item.id]}).pending[0].missing_units,3);
 const receipt=mesh.receiptDraft(db,{specification:metrics({shapeSnapshot:shape()}).specification,quantity_units:3,idempotency_key:'late'});mesh.approveReceipt(db,{receipt_id:receipt.id});
 assert.equal(mesh.consumeMesh(db,{orderId:r.orderId,itemIds:[item.id]}).consumed,1);assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,0);
});

const {calculateMesh}=require('../modules/steel-rebar/shapes');
test('verified mesh example has 25 and 60 bars, 300 metres and 118.52 theoretical kg',()=>{
 const {calculated:c}=calculateMesh(shape().data);
 assert.equal(c.longitudinalBarCount,25);assert.equal(c.transverseBarCount,60);assert.equal(c.totalLengthMm,300000);assert.equal(c.weightKg.toFixed(2),'118.52');assert.equal(c.countingVerified,true);
});
test('different pitches use the cross dimension and unknown rounding needs explicit confirmation',()=>{
 const base=shape().data;
 let c=calculateMesh({...base,longitudinalSpacing:150,transverseSpacing:200}).calculated;
 assert.equal(c.longitudinalBarCount,17);assert.equal(c.transverseBarCount,30);assert.equal(c.countingVerified,true);
 c=calculateMesh({...base,width:2600,longitudinalSpacing:150}).calculated;assert.equal(c.longitudinalBarCount,18);assert.equal(c.countingVerified,false);
 assert.throws(()=>metrics({shapeSnapshot:shape({width:2600,longitudinalSpacing:150})}),/confirmation_required/);
 c=calculateMesh({...base,width:2600,longitudinalSpacing:150,longitudinalBarCount:17,countingConfirmed:true}).calculated;assert.equal(c.longitudinalBarCount,17);assert.equal(c.countingVerified,true);
 assert.throws(()=>calculateMesh({...base,transverseDiameter:10}),/uniform_diameter/);
});
test('receipt stores a versioned theoretical calculation and reports quantities without trusting client weights',t=>{
 const {db}=setup(t),spec=metrics({shapeSnapshot:shape()}).specification;
 const receipt=mesh.receiptDraft(db,{specification:{...spec,weightKg:1},quantity_units:5,idempotency_key:'weight-snapshot'}),saved=JSON.parse(receipt.specification_json);
 assert.equal(saved.calculation.weightKg.toFixed(2),'118.52');assert.equal(saved.calculation.weightBasis,'theoretical');
 mesh.approveReceipt(db,{receipt_id:receipt.id});assert.equal(JSON.parse(db.prepare('SELECT specification_json FROM inventory_mesh_stock').get().specification_json).calculation.weightKg.toFixed(2),'118.52');
});

test('physical-count policy waits for completion, issues once, and explicit false-production correction returns only corrected whole sheets',t=>{
 const {db,orders}=setup(t),completion=require('../services/inventoryItemCompletion');
 db.prepare("INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(1,'mesh-policy','fixture',?,'count',1)").run(new Date(Date.now()-86400000).toISOString());
 completion.activatePolicy(db,{stocktake_id:1});
 const spec=metrics({shapeSnapshot:shape()}).specification,receipt=mesh.receiptDraft(db,{specification:spec,quantity_units:10,idempotency_key:'policy-stock'});mesh.approveReceipt(db,{receipt_id:receipt.id});
 const r=create(orders,3),item=db.prepare('SELECT id FROM items WHERE order_id=?').get(r.orderId);
 assert.equal(reservations.consumeReservationsForProduction(db,{order_id:r.orderId,item_ids:[item.id]}).consumed,0);
 db.prepare("UPDATE items SET status='הושלם',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(item.id);
 assert.equal(reservations.consumeReservationsForProduction(db,{order_id:r.orderId,item_ids:[item.id]}).consumed,1);
 assert.equal(reservations.consumeReservationsForProduction(db,{order_id:r.orderId,item_ids:[item.id]}).consumed,0);
 const correction={itemId:item.id,quantity:1,eventKey:'mesh-false-production-1',reason:'דווח בטעות'};
 assert.equal(mesh.returnErroneousMesh(db,correction).returned_units,1);assert.equal(mesh.returnErroneousMesh(db,correction).returned_units,0);
 assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,8);
 assert.throws(()=>mesh.returnErroneousMesh(db,{...correction,eventKey:'too-many',quantity:3}),/exceeds_issued/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_material_usage').get().n,0);
});
