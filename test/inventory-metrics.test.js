'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {inventoryMetrics}=require('../services/inventoryMetrics');
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE raw_material(id INTEGER PRIMARY KEY,active INTEGER,verification_status TEXT,diameter REAL,weight_received REAL,weight_used REAL,weight_scrapped REAL,stock_adjustment_kg REAL,created_at TEXT);
 CREATE TABLE inventory_stocktakes(id INTEGER PRIMARY KEY,counted_at TEXT,created_at TEXT);
 CREATE TABLE inventory_stocktake_lines(stocktake_id INTEGER,raw_material_id INTEGER,before_snapshot_json TEXT);
 CREATE TABLE raw_material_usage(raw_material_id INTEGER,order_id INTEGER,item_id INTEGER,weight_used REAL,allocation_policy TEXT,used_at TEXT);
 CREATE TABLE material_consumption_events_v2(id INTEGER PRIMARY KEY,event_type TEXT,approved_at TEXT);
 CREATE TABLE material_consumption_event_lines_v2(consumption_event_id INTEGER,raw_material_id INTEGER,consumed_kg REAL);
 CREATE TABLE orders(id INTEGER,status TEXT);
 CREATE TABLE inventory_reservations(order_id INTEGER,item_id INTEGER,status TEXT,consumption_mode TEXT);
 INSERT INTO raw_material VALUES(1,1,'approved',12,10000,9363.715,0,134663.715,'2026-10-01 00:00:00');`);
 return db;
}
function count(db){db.exec("INSERT INTO inventory_stocktakes VALUES(1,'2026-11-08T18:00:00Z','2026-11-08 20:56:41')");db.prepare('INSERT INTO inventory_stocktake_lines VALUES(1,1,?)').run(JSON.stringify({lot:{weight_used:9363.715}}));}
test('historic FIFO and reservation counters never become consumption since a count',t=>{
 const db=fixture(t);count(db);
 db.exec("INSERT INTO raw_material_usage VALUES(1,10,20,9363.722,'auto_fifo','2026-10-07 15:23:41');INSERT INTO orders VALUES(10,'בייצור');INSERT INTO inventory_reservations VALUES(10,20,'active','legacy')");
 const before=db.serialize();const m=inventoryMetrics(db);
 assert.equal(m.historical_used_counter_kg,9363.715);assert.equal(m.recorded_net_kg,0);assert.equal(m.verified_consumption_kg,null);assert.equal(m.status,'needs_reconciliation');assert.ok(m.issues.includes('legacy_orders_not_covered'));assert.deepEqual(db.serialize(),before);
});
test('net recorded consumption includes approved reversals and deactivated lots, not stock adjustments',t=>{
 const db=fixture(t);count(db);
 db.exec(`UPDATE raw_material SET active=0,weight_used=9368.715,stock_adjustment_kg=150000;
 INSERT INTO raw_material_usage VALUES(1,1,1,3,'production_completion','2026-11-08 22:00:00');
 INSERT INTO material_consumption_events_v2 VALUES(1,'consumption','2026-11-09T00:00:00Z'),(2,'reversal','2026-11-09 01:00:00');
 INSERT INTO material_consumption_event_lines_v2 VALUES(1,1,4),(2,1,2);`);
 const m=inventoryMetrics(db);assert.equal(m.recorded_net_kg,5);assert.equal(m.status,'recorded_only');assert.equal(m.stocked_lots,0);
});
test('missing baseline, unknown counters, partial counts and unverified FIFO remain explicitly uncertain',t=>{
 const db=fixture(t);assert.equal(inventoryMetrics(db).status,'no_baseline');assert.equal(inventoryMetrics(db).recorded_net_kg,null);count(db);
 db.exec("UPDATE raw_material SET weight_used=9364.715;INSERT INTO raw_material_usage VALUES(1,1,1,1,'auto_fifo','2026-11-09 00:00:00')");
 assert.ok(inventoryMetrics(db).issues.includes('unverified_legacy_movements'));
 db.exec('UPDATE raw_material SET weight_used=9370');assert.ok(inventoryMetrics(db).issues.includes('counter_ledger_mismatch'));
 db.exec("INSERT INTO raw_material VALUES(2,1,'approved',16,10,0,0,0,'2026-01-01T00:00:00Z')");assert.ok(inventoryMetrics(db).issues.includes('partial_count_baseline'));
});
test('stocked lots exclude exhausted, inactive and unapproved records; later receipts do not break a baseline',t=>{
 const db=fixture(t);count(db);
 db.exec(`INSERT INTO raw_material VALUES(2,1,'approved',16,0,0,0,0,'2026-11-09T00:00:00Z'),(3,0,'approved',20,100,0,0,0,'2026-11-09 00:00:00'),(4,1,'pending_verification',22,100,0,0,0,'2026-11-09 00:00:00'),(5,1,'approved',12,50,0,0,0,'2026-11-09T00:00:00Z');`);
 const m=inventoryMetrics(db);assert.equal(m.stocked_lots,2);assert.equal(m.stocked_diameters,1);assert.equal(m.status,'recorded_only');
});
