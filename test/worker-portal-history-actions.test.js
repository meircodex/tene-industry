'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const projection=require('../services/workerPortalProjection');
const {createWorkerCardActivityService}=require('../services/workerCardActivity');
function fixture(){
 const db=new Database(':memory:');db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY,display_name TEXT);
  CREATE TABLE device_enrollment_requests(id INTEGER PRIMARY KEY);
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT);
  CREATE TABLE orders(id INTEGER PRIMARY KEY,order_num TEXT,customer_id INTEGER);
  CREATE TABLE pallets(id INTEGER PRIMARY KEY,order_id INTEGER);
  CREATE TABLE items(id INTEGER PRIMARY KEY,order_id INTEGER,pallet_id INTEGER,status TEXT,shape_name TEXT,diameter INTEGER,quantity INTEGER,zone TEXT,total_weight REAL);
  INSERT INTO users VALUES(7,'Viewer'),(8,'Producer');
  INSERT INTO customers VALUES(1,'Customer');INSERT INTO orders VALUES(1,'HZ-TEST',1);
 `);
 const activity=createWorkerCardActivityService({db});
 for(let id=1;id<=6;id++)db.prepare("INSERT INTO items VALUES(?,1,NULL,'הושלם','Straight',8,10,NULL,175)").run(id);
 const record=(actor,id,action,details={},token='CARD-'+id)=>activity.record({userId:actor,auth:{display_name:actor===7?'Viewer':'Producer'},query:{card:token}},{id,order_id:1,order_num:'HZ-TEST'},action,details);
 return {db,record};
}
test('viewing an already completed card leaves no personal work row and preserves the scan ledger and daily totals',t=>{
 const {db,record}=fixture();t.after(()=>db.close());
 record(8,1,'status_changed',{to_status:'הושלם',completed_weight_kg:175});record(7,1,'opened');
 const before=JSON.stringify(db.prepare('SELECT * FROM worker_card_activity ORDER BY id').all());
 const result=projection.history(db,7);assert.equal(result.total,0);assert.deepEqual(result.rows,[]);assert.equal(projection.daily(db,7).completed_cards,0);
 assert.equal(projection.history(db,8).total,1,'the actual updater keeps their card');
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_card_activity ORDER BY id').all()),before);
 assert.equal(db.prepare('SELECT status,total_weight FROM items WHERE id=1').get().total_weight,175);
});
test('history pages use the latest actual actor update, excluding later views and no-op receipts',t=>{
 const {db,record}=fixture();t.after(()=>db.close());
 record(7,1,'opened');record(7,2,'status_changed',{to_status:'הושלם',unchanged:true});
 record(7,3,'status_changed',{to_status:'הושלם',unchanged:true,zone:'B'});
 record(7,4,'status_changed',{to_status:'הושלם',unchanged:true,actual_weight_kg:180});
 record(7,5,'status_changed',{to_status:'בייצור'});record(7,6,'updated',{quantity:10});
 record(7,3,'opened',{},'3');record(7,5,'status_changed',{to_status:'בייצור',unchanged:true},'5');record(8,2,'status_changed',{to_status:'הושלם'});
 const page1=projection.history(db,7,1,2),page2=projection.history(db,7,2,2),empty=projection.history(db,7,3,2);
 assert.equal(page1.total,4);assert.equal(page2.total,4);assert.equal(empty.total,4);
 assert.deepEqual(page1.rows.map(r=>r.item_id),[6,5]);assert.deepEqual(page2.rows.map(r=>r.item_id),[4,3]);assert.deepEqual(empty.rows,[]);
 assert.equal(page1.rows[1].action,'status_changed');assert.equal(page2.rows[1].action,'status_changed');assert.equal(page2.rows[1].card_token,'CARD-3');
 assert.equal(page1.rows[1].card_token,'CARD-5');
 assert.equal(projection.history(db,8).total,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM worker_card_activity WHERE action='opened'").get().n,2);
});
