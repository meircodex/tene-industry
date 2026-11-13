'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {reconcileQueuedProduction}=require('../services/orderProductionStatus');

test('existing queued work reconciles once while approval, untouched work and closed orders stay protected',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY,order_num TEXT,status TEXT,payment_status TEXT DEFAULT 'unpaid',deleted_at TEXT,workspace_version INTEGER DEFAULT 1);
    CREATE TABLE pallets(id INTEGER PRIMARY KEY,order_id INTEGER);
    CREATE TABLE items(id INTEGER PRIMARY KEY,pallet_id INTEGER,status TEXT,produced_qty INTEGER DEFAULT 0,cancelled_at TEXT);
    CREATE TABLE audit_log(entity_type TEXT,entity_id INTEGER,entity_ref TEXT,action TEXT,field_name TEXT,old_value TEXT,new_value TEXT,notes TEXT,user_id INTEGER,user_name TEXT);`);
  const add=(id,status,itemStatus,extra={})=>{
    db.prepare('INSERT INTO orders(id,order_num,status,payment_status,deleted_at)VALUES(?,?,?,?,?)').run(id,'TEST-'+id,status,extra.paid?'paid':'unpaid',extra.deleted?'2026-11-13':null);
    db.prepare('INSERT INTO pallets VALUES(?,?)').run(id,id);db.prepare('INSERT INTO items(id,pallet_id,status,produced_qty,cancelled_at)VALUES(?,?,?,?,?)').run(id,id,itemStatus,extra.produced||0,extra.cancelled?'2026-11-13':null);
  };
  add(1,'בתור ייצור','הושלם');add(2,'בתור ייצור','בייצור');add(3,'בתור ייצור','ממתין');
  add(4,'ממתינה לאישור','הושלם');add(5,'אספקה חלקית','בייצור');add(6,'בתור ייצור','הושלם',{paid:true});
  add(7,'בתור ייצור','הושלם',{deleted:true});add(8,'בתור ייצור','הושלם',{cancelled:true});add(9,'בתור ייצור','ממתין',{produced:2});
  const before=db.prepare('SELECT * FROM items').all();
  assert.deepEqual(reconcileQueuedProduction(db).map(row=>row.id),[1,2,9]);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=3').get().status,'בתור ייצור');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=4').get().status,'ממתינה לאישור');
  assert.deepEqual(db.prepare('SELECT * FROM items').all(),before);
  assert.deepEqual(reconcileQueuedProduction(db),[]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,3);
});
