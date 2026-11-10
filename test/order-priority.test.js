'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema'),{updatePriority}=require('../services/orderPriority');
function setup(){const db=new Database(':memory:');ensureCoreSchema(db);db.exec("ALTER TABLE orders ADD COLUMN locked INTEGER DEFAULT 0;INSERT INTO orders(id,order_num,status,priority) VALUES(1,'PRIORITY','בייצור','רגיל');INSERT INTO items(id,order_id,status) VALUES(1,1,'בייצור');INSERT INTO raw_material(diameter,weight_received) VALUES(12,1000)");return db;}
test('urgency is an audited scheduling change during production, without material or item changes',()=>{
 const db=setup(),before=JSON.stringify(db.prepare('SELECT * FROM raw_material').all()),item=JSON.stringify(db.prepare('SELECT * FROM items').all());
 const r=updatePriority(db,{order_id:1,priority:'דחוף',expected_priority:'רגיל',actor_id:1});assert.equal(r.order.priority,'דחוף');assert.equal(r.changed,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='priority_change'").get().n,1);
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM raw_material').all()),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM items').all()),item);
 assert.throws(()=>updatePriority(db,{order_id:1,priority:'רגיל',expected_priority:'רגיל'}),/עודכנה בינתיים/);
 assert.equal(updatePriority(db,{order_id:1,priority:'דחוף',expected_priority:'דחוף'}).changed,false);db.close();
});
test('closed, cancelled, locked and deleted orders cannot change priority',()=>{
 for(const change of ["status='סופק – אושר'","status='בוטלה'","locked=1","deleted_at=CURRENT_TIMESTAMP"]){const db=setup();db.exec('UPDATE orders SET '+change+' WHERE id=1');assert.throws(()=>updatePriority(db,{order_id:1,priority:'דחוף',expected_priority:'רגיל'}));assert.equal(db.prepare('SELECT priority FROM orders').get().priority,'רגיל');db.close();}
});
