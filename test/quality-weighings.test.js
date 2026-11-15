'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {createQualityWeighingsService}=require('../services/qualityWeighings');
function fixture(t){const db=new Database(':memory:');ensureCoreSchema(db);t.after(()=>db.close());
 db.exec("INSERT INTO customers(id,name)VALUES(1,'לקוח בדיקה');INSERT INTO users(id,username,display_name,role)VALUES(1,'qc-owner','בודק מאומת','quality');INSERT INTO orders(id,order_num,customer_id,status)VALUES(1,'QC-1',1,'בייצור'),(2,'QC-2',1,'הושלם – ממתין לאיסוף');INSERT INTO pallets(id,order_id,pallet_num)VALUES(1,1,1),(2,2,1);INSERT INTO items(id,pallet_id,order_id,shape_name,diameter,quantity,weight_per_unit,total_weight,actual_weight_kg,status)VALUES(1,1,1,'מוט ישר',12,10,100,1000,2000,'הושלם'),(2,2,2,'צורה 3',8,20,25,500,NULL,'הושלם');");
 return {db,s:createQualityWeighingsService(db)};
}
const selection=()=>({orders:[{order_id:1,mode:'full'},{order_id:2,mode:'partial',items:[{item_id:2,quantity:4}]}]});
function request(s,extra={}){const body=selection(),p=s.preview(body);return {...body,expected_fingerprint:p.fingerprint,actual_weight_kg:1078,idempotency_key:'quality-test-key-0001',...extra};}
test('whole and partial orders use the same canonical basis, ignore prior actual weight and never allocate a group weighing',t=>{
 const {db,s}=fixture(t),before=db.prepare('SELECT * FROM items').all(),p=s.preview({...selection(),actual_weight_kg:1078});
 assert.equal(p.expected_weight_kg,1100);assert.equal(p.delta_kg,-22);assert.equal(p.delta_pct,-2);assert.equal(p.lines.length,2);
 const saved=s.save(request(s),{id:1});assert.equal(saved.inspector_name,'בודק מאומת');assert.equal(saved.orders.length,2);assert.equal(saved.lines[1].quantity,4);assert.equal(saved.lines[0].expected_weight_kg,1000);assert.equal(saved.actual_weight_kg,1078);
 assert.ok(saved.lines.every(l=>!('actual_weight_kg' in l)));assert.equal(db.prepare('SELECT count(*) n FROM quality_weighing_events').get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE entity_type='quality_weighing'").get().n,1);
 assert.deepEqual(db.prepare('SELECT * FROM items').all(),before);assert.equal(s.history({customer_id:'1'}).total,1,'EXISTS avoids counting a shared weighing once per order');
});
test('history is immutable after order edits, safe retries are idempotent even after source changes',t=>{
 const {db,s}=fixture(t),body=request(s),record=s.save(body,{id:1});db.exec("UPDATE items SET total_weight=3000,weight_per_unit=300,shape_name='שונה' WHERE id=1;UPDATE customers SET name='שם חדש' WHERE id=1");
 const after=s.detail(record.id);assert.equal(after.expected_weight_kg,1100);assert.equal(after.lines[0].shape_name,'מוט ישר');assert.equal(after.orders[0].customer_name,'לקוח בדיקה');assert.equal(s.save(body,{id:1}).replay,true);assert.equal(s.history().total,1);
 assert.throws(()=>s.save({...body,actual_weight_kg:999},{id:1}),e=>e.statusCode===409);
 const next=s.save(request(s,{idempotency_key:'quality-test-key-0002'}),{id:1});assert.equal(next.id,2);assert.equal(s.history({order_id:'1'}).total,2);
});
test('invalid quantities, cross-order items, duplicate selections and unavailable baseline cannot be saved',t=>{
 const {db,s}=fixture(t);
 for(const body of [{orders:[]},{orders:[null]},{orders:[{order_id:1,mode:'full'},{order_id:1,mode:'full'}]},{orders:[{order_id:1,mode:'partial',items:[{item_id:2,quantity:1}]}]}, {orders:[{order_id:2,mode:'partial',items:[{item_id:2,quantity:21}]}]}, {orders:[{order_id:2,mode:'partial',items:[{item_id:2,quantity:0}]}]}, {orders:[{order_id:2,mode:'partial',items:[{item_id:2,quantity:1},{item_id:2,quantity:1}]}]}])assert.throws(()=>s.preview(body));
 db.exec('UPDATE items SET total_weight=0,weight_per_unit=0 WHERE id=1');assert.throws(()=>s.preview(selection()),e=>e.statusCode===422);assert.equal(s.history().total,0);
});
test('source changes block stale saves and an audit failure rolls back the complete group atomically',t=>{
 const {db,s}=fixture(t),body=request(s);db.exec('UPDATE items SET quantity=11 WHERE id=1');assert.throws(()=>s.save(body,{id:1}),e=>e.statusCode===409);assert.equal(s.history().total,0);
 db.exec("CREATE TRIGGER fail_qw_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='quality_weighing' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");assert.throws(()=>s.save(request(s),{id:1}));
 for(const table of ['quality_weighings','quality_weighing_orders','quality_weighing_lines','quality_weighing_events'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('chooser filters and history validation use real lifecycle and bounded pages',t=>{
 const {db,s}=fixture(t);assert.equal(s.orders({status:'production'}).total,1);assert.equal(s.orders({status:'completed'}).total,1);assert.equal(s.orders({limit:1,page:2}).rows[0].id,1);
 for(const q of [{limit:101},{page:0},{customer_id:['1']},{from:'2026-02-30'},{from:'2026-11-15',to:'2026-11-14'}])assert.throws(()=>s.history(q));
 for(const weight of [0,-1,Infinity,'2',null])assert.throws(()=>s.save(request(s,{actual_weight_kg:weight}),{id:1}));
 db.exec("UPDATE orders SET deleted_at='2026-11-15' WHERE id=1");assert.equal(s.orders().total,1);assert.throws(()=>s.context(1),e=>e.statusCode===409);
});
