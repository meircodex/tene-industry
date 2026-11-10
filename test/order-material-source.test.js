'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {runCoreMigrations}=require('../db/startup');
const {createOrderFactory}=require('../services/orders');
const industry=require('../modules/steel-rebar');
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');ensureCoreSchema(db);runCoreMigrations(db);db.exec("INSERT INTO raw_material(id,diameter,material_type,weight_received,stock_adjustment_kg) VALUES(1,12,'coil',0,5000)");let seq=0;return {db,service:createOrderFactory(db,{generateOrderNum:()=>`SOURCE-${++seq}`,industry})};}
function payload(source){return {customer:{name:'Material source regression'},order:{},pallets:[{items:[{shapeName:'straight',diameter:12,length:1000,qty:2,raw_material_id:source}]}]};}
test('actual new-order auto material source saves after stocktake without deducting stock',t=>{
 const {db,service}=setup(t);
 const r=service.createOrderTransaction(payload('auto'));
 assert.equal(r.success,true);const row=db.prepare('SELECT * FROM inventory_reservations WHERE order_id=?').get(r.orderId);
 assert.equal(row.preferred_raw_material_id,null);assert.equal(row.consumption_mode,'on_completion');
 assert.equal(db.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used,0);assert.equal(db.pragma('foreign_key_check').length,0);
 const {consumeReservationsForProduction}=require('../services/inventoryReservation');
 consumeReservationsForProduction(db,{order_id:r.orderId});consumeReservationsForProduction(db,{order_id:r.orderId});
 assert.equal(db.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used,row.reserved_kg);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_material_usage').get().n,1);
});
test('explicit material source is preserved and missing sources fail clearly with full rollback',t=>{
 const {db,service}=setup(t);const r=service.createOrderTransaction(payload('1'));
 assert.equal(db.prepare('SELECT preferred_raw_material_id id FROM inventory_reservations WHERE order_id=?').get(r.orderId).id,1);
 const before=Object.fromEntries(['orders','customers','pallets','items','inventory_reservations'].map(t=>[t,db.prepare('SELECT COUNT(*) n FROM '+t).get().n]));
 for(const value of ['auto-bad',999,-1,1.5])assert.throws(()=>service.createOrderTransaction(payload(value)),e=>e.statusCode===400 && !e.message.includes('FOREIGN KEY'));
 assert.deepEqual(Object.fromEntries(Object.keys(before).map(t=>[t,db.prepare('SELECT COUNT(*) n FROM '+t).get().n])),before);
});
