'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const directory=require('../services/productionReportWorkers'),identity=require('../services/workerIdentity');
const {createWorkerCardActivityService}=require('../services/workerCardActivity');
const {unifiedProductionReport,parseFilters}=require('../services/unifiedProductionReport');
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,active INTEGER);
 CREATE TABLE items(id INTEGER PRIMARY KEY);INSERT INTO items VALUES(101),(102),(103);
 CREATE TABLE worker_qr_profiles(id INTEGER PRIMARY KEY,worker_name TEXT,active INTEGER);
 CREATE TABLE worker_portal_accounts(profile_id INTEGER,user_id INTEGER);
 CREATE TABLE worker_invitations(id INTEGER PRIMARY KEY,worker_profile_id INTEGER);
 CREATE TABLE device_enrollment_requests(id INTEGER PRIMARY KEY,invitation_id INTEGER,requester_name TEXT,status TEXT);
 CREATE TABLE workers(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);
 CREATE TABLE scan_log(id INTEGER PRIMARY KEY,item_id INTEGER,worker_id INTEGER,action TEXT,scanned_at TEXT);
 INSERT INTO users VALUES(1,'manager','Manager','manager',1),(2,'santi','Portal account','production',1),(3,'new','New user','production',1),(4,'terminal','Shared terminal','kiosk',1);
 INSERT INTO worker_qr_profiles VALUES(1,'Santi current',0),(2,'Never reported',1);
 INSERT INTO worker_portal_accounts VALUES(1,2);INSERT INTO worker_invitations VALUES(100,1);INSERT INTO device_enrollment_requests VALUES(10,100,'Santi phone','approved'),(11,NULL,'Older phone worker','approved');
 INSERT INTO workers VALUES(1,'Station worker',1),(2,'No shifts',0);
 INSERT INTO scan_log VALUES(1,101,1,'start','2026-11-14T07:00:00Z'),(2,101,1,'complete','2026-11-15T11:00:00Z'),(3,102,NULL,'end_of_day','2026-11-15T12:00:00Z');
 `);
 const activity=createWorkerCardActivityService({db});
 const record=(req,item,action,details,at)=>{const r=activity.record(req,{id:item},action,details);db.prepare('UPDATE worker_card_activity SET occurred_at=? WHERE id=?').run(at,r.id);return r.id};
 const req={userId:2,auth:{sub:'2',display_name:'Santi receipt'},portalWorker:{profile_id:1},approvedDevice:{id:10}};
 record(req,101,'status_changed',{from_status:'ממתין',to_status:'בייצור'},'2026-11-14T08:00:00Z');
 record(req,101,'status_changed',{from_status:'בייצור',to_status:'הושלם'},'2026-11-15T10:00:00Z');
 record({userId:3,auth:{display_name:'New user'}},101,'opened',{},'2026-11-15T10:30:00Z');
 record({userId:3,auth:{display_name:'New user'}},101,'status_changed',{unchanged:true,from_status:'הושלם',to_status:'הושלם'},'2026-11-15T10:31:00Z');
 record({qrAccess:{actor_name:'סריקה פתוחה'}},102,'updated',{actual_weight_kg:50},'2026-11-15T09:00:00Z');
 record({userId:3,auth:{display_name:'New user'}},101,'updated',{produced_qty:1},'2026-11-15T22:30:00Z'); // Israel next day.
 return {db,record,req};
}
const report=(db,q={})=>unifiedProductionReport({cards:[{item_id:101,included_in_statistics:true,net_minutes_exact:10,cut_length_mm:100000,weight_kg:100}],activity:{cards:[{item_id:101,date:'2026-11-15',reported_complete:true,reported_quantity:10,reported_weight_kg:100},{item_id:102,date:'2026-11-15',reported_complete:true,reported_quantity:5,reported_weight_kg:50},{item_id:103,date:'2026-11-15',reported_complete:false}]},...directory.readWorkerData(db,[101,102,103],{to:'2026-11-15'})},parseFilters({flat:'1',...q}));
test('directory contains configured inactive, station and never-reporting people, independently of the date range',t=>{
 const {db}=fixture(t);const data=directory.readWorkerData(db,[],{to:'2000-01-01'});assert.equal(data.workers.length,0);assert.ok(data.workerDirectory.some(w=>w.key==='profile:2'));assert.ok(data.workerDirectory.some(w=>w.key==='legacy:2'&&!w.active));assert.ok(data.workerDirectory.some(w=>w.key==='user:3'));assert.ok(!data.workerDirectory.some(w=>w.key==='user:2'));assert.ok(!data.workerDirectory.some(w=>w.key==='user:4'));
 const empty=report(db,{worker:'profile:2'});assert.equal(empty.total,0);assert.ok(empty.facets.workers.some(w=>w.key==='profile:2'));assert.ok(empty.facets.workers.some(w=>w.key==='profile:1'&&!w.active));
});
test('card worker filtering joins real portal and station actions without mixing numeric namespaces or counting views',t=>{
 const {db}=fixture(t),all=report(db);assert.equal(all.summary.weight_kg,150);assert.equal(all.summary.meters_per_min,10);
 const profile=report(db,{worker:'profile:1',limit:'1'});assert.equal(profile.total,1);assert.equal(profile.summary.weight_kg,100);assert.equal(profile.rows[0].start_worker,'Santi receipt');assert.equal(profile.rows[0].end_worker,'Station worker');
 assert.equal(report(db,{worker:'legacy:1'}).total,1);assert.equal(report(db,{worker:'user:1'}).total,0);assert.equal(report(db,{worker:'user:3'}).total,0,'view/no-op/future save must not be work');assert.equal(report(db,{worker:'user:2'}).total,1,'explicit portal account alias shares the profile key');
 const selected=report(db,{worker_in:'["profile:1","legacy:1"]'});assert.equal(selected.total,1);assert.equal(selected.summary.weight_kg,100,'multiple contributors do not multiply output');
 assert.equal(report(db,{worker:'anonymous'}).total,2,'unknown saves and cards without identified receipts remain selectable');
});
test('renames keep one directory identity and historical snapshots; readers never rewrite source records',t=>{
 const {db}=fixture(t);const before=JSON.stringify(db.prepare('SELECT * FROM worker_card_activity').all());db.prepare("UPDATE worker_qr_profiles SET worker_name='Renamed Santi' WHERE id=1").run();const r=report(db);assert.equal(r.facets.workers.filter(w=>w.key==='profile:1').length,1);assert.equal(r.facets.workers.find(w=>w.key==='profile:1').name,'Renamed Santi');assert.match(r.rows.find(r=>r.item_id===101).worker_names,/Santi receipt/);assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_card_activity').all()),before);
});
test('receipt identity is snapshotted by the server and anonymous snapshots never inherit a later account/device link',t=>{
 const {db,record,req}=fixture(t);const id=record(req,101,'updated',{_actor_identity:{kind:'profile',id:2}},'2026-11-15T10:01:00Z');assert.deepEqual(JSON.parse(db.prepare('SELECT details_json FROM worker_card_activity WHERE id=?').get(id).details_json)._actor_identity,{kind:'profile',id:1});
 assert.equal(identity.eventKey({worker_profile_id:1,actor_user_id:2,device_enrollment_id:10},{_actor_identity:{kind:'anonymous'}}),'anonymous');
 assert.equal(identity.eventKey({worker_profile_id:2},{_actor_identity:{kind:'profile',id:1}}),'profile:1');
 assert.equal(identity.eventKey({worker_profile_id:1,actor_name:'Old name'}),'profile:1','old receipts use explicit links, not matching names');
 const workers=directory.readWorkers(db,Array.from({length:1005},(_,i)=>i+1),{to:'2026-11-15'});assert.ok(workers.some(w=>w.worker_key==='profile:1'));assert.ok(!workers.some(w=>w.worker_key==='user:3'));
});
test('approved worker device identity outranks an unrelated manager session, while device-free staff use their own account',()=>{
 const req={auth:{sub:'99'},approvedDevice:{id:10},qrAccess:{device:{id:10},actor_name:'Worker'}};
 assert.deepEqual(identity.snapshot(req),{kind:'device',id:10});
 assert.deepEqual(identity.snapshot({...req,portalWorker:{profile_id:1}}),{kind:'profile',id:1});
 assert.deepEqual(identity.snapshot({auth:{sub:'99'}}),{kind:'user',id:99});
 assert.equal(identity.eventKey({actor_name:'Worker',actor_user_id:99,device_enrollment_id:10}),'device:10');
});
