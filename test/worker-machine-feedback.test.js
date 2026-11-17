'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), Database = require('better-sqlite3');
const {StationInbox} = require('../services/machineIntegration/stationInbox');
const {WorkerFeedback} = require('../services/machineIntegration/workerFeedback');
const {hashEvent} = require('../contracts/machine-station/v1');
const {ITEM_STATUS} = require('../status-contracts');
const CARD = 'SYNTHETIC-000009';
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE machines(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO machines VALUES(1,'מכונה 6'),(2,'תלת מימד');
    CREATE TABLE items(id INTEGER PRIMARY KEY,status TEXT,produced_qty INTEGER);INSERT INTO items VALUES(9,'בייצור',4);
    CREATE TABLE worker_card_activity(id INTEGER PRIMARY KEY,item_id INTEGER,action TEXT,card_token TEXT,details_json TEXT);`);
  let at = '2026-11-15T10:00:00.000Z'; const now = () => at;
  const inbox = new StationInbox({db, now}), binding = inbox.register({id: 1}, {sourceId:'station-6',logicalMachineId:'machine6',machineId:1});
  const other = inbox.register({id: 1}, {sourceId:'station-3d',logicalMachineId:'machine3d',machineId:2});
  return {db,inbox,binding,other,service:new WorkerFeedback({db,inbox,now}),advance:ms=>{at=new Date(Date.parse(at)+ms).toISOString();}};
}
const input = (overrides={}) => ({requestId:'SYNTHETIC-request',sourceId:'station-6',itemId:9,card:CARD,action:'card.open',payload:{receiptId:1},...overrides});

test('the real factory QR policy keeps open scanning open and still denies unapproved devices in secure mode',async t=>{
 const f=fixture(t),express=require('express'),app=express();app.use(express.json());let accessMode='open';
 const qr=require('../services/qrAccess').createQrAccessService({db:f.db,settingsService:{get:()=>accessMode},deviceEnrollment:{statusForRequest:()=>null}});
 app.use('/api/machine-feedback',require('../routes/workerMachineFeedback')({db:f.db,requireQrPermission:qr.requirePermission,
  authorizeCard:(req,res,id)=>{if(Number(id)!==9||(req.body?.card||req.query.card)!==CARD){res.status(403).json({error:'invalid_worker_card_token'});return null;}return{id:9};},parseCard:()=>({itemId:9}),wsBroadcast:()=>{}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/api/machine-feedback';
 assert.equal((await fetch(url+'/stations')).status,200);
 assert.equal((await fetch(url+'/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input({card:'wrong'}))})).status,403);
 assert.equal((await fetch(url+'/snapshot?sourceId=station-6&card='+CARD)).status,403);
 accessMode='secure';assert.equal((await fetch(url+'/stations')).status,403);
 assert.equal((await fetch(url+'/stations',{headers:{'X-User-Role':'admin'}})).status,403);
});

test('worker request is durable and idempotent, never writes production counts/status, and cannot change payload under one id', t => {
  const f = fixture(t), before = f.db.prepare('SELECT * FROM items').all(), request = input();
  const first = f.service.create('user:1',{id:9},request), retry=f.service.create('user:1',{id:9},request);
  assert.equal(first.id,retry.id);assert.equal(first.state,'pending');
  assert.equal(f.db.prepare('SELECT count(*) n FROM mi_worker_requests').get().n,1);
  assert.throws(()=>f.service.create('user:1',{id:9},input({card:'OTHER-000009'})),/REQUEST_CONFLICT/);
  assert.deepEqual(f.db.prepare('SELECT * FROM items').all(),before);
});

test('station credentials, source, command whitelist and hashes prevent cross-machine or device-control requests',t=>{
  const f=fixture(t);f.service.create('user:1',{id:9},input());
  assert.throws(()=>f.service.pending('station-6',f.other.credential),/STATION_SCOPE_FORBIDDEN/);
  assert.throws(()=>f.service.create('user:1',{id:9},input({requestId:'bad',action:'PLC_START'})),/INVALID_WORKER_MACHINE_REQUEST/);
  assert.throws(()=>f.service.create('user:1',{id:9},input({requestId:'bad-params',payload:{address:'Y11',value:1}})),/INVALID_WORKER_MACHINE_PAYLOAD/);
  const pending=f.service.pending('station-6',f.binding.credential);assert.equal(pending.items.length,1);assert.equal(pending.items[0].logicalMachineId,'machine6');
  const {id,requestHash,createdAtUtc,expiresAtUtc,...content}=pending.items[0];assert.equal(hashEvent(content),requestHash);
  assert.equal(f.service.stations().items.find(s=>s.sourceId==='station-6').online,true);
  assert.equal(f.service.pending('station-3d',f.other.credential).items.length,0);
});

test('results are actor/card scoped, content-bound and duplicate acknowledgements cannot overwrite evidence',t=>{
  const f=fixture(t);f.service.create('user:1',{id:9},input());const p=f.service.pending('station-6',f.binding.credential).items[0];
  const result={ok:true,data:{runId:'run-1',card:CARD,sourceId:'station-6'}};
  const packet={requestId:p.id,requestHash:p.requestHash,result};
  const ack=f.service.respond('station-6',f.binding.credential,packet);assert.equal(ack.status,'accepted');assert.equal(ack.resultHash,hashEvent(result));
  assert.equal(f.service.respond('station-6',f.binding.credential,packet).status,'duplicate');
  assert.throws(()=>f.service.get('user:2',p.id),/NOT_FOUND/);
  assert.throws(()=>f.service.respond('station-6',f.binding.credential,{...packet,result:{ok:false,error:'changed'}}),/STATION_RESULT_CONFLICT/);
  assert.deepEqual(f.service.get('user:1',p.id).result,result);
});

test('parameter approval recording requires the original business DONE receipt for exactly the same card',t=>{
  const f=fixture(t),request=input({action:'completion.record',payload:{runId:'run-1',proposalId:'proposal-1',saveRecipe:true,receiptId:5}});
  assert.throws(()=>f.service.create('user:1',{id:9},request),/BUSINESS_COMPLETION_RECEIPT_REQUIRED/);
  const insert=f.db.prepare('INSERT INTO worker_card_activity VALUES(?,?,?,?,?)');
  insert.run(5,9,'status_changed',CARD,JSON.stringify({to_status:ITEM_STATUS.IN_PRODUCTION}));
  assert.throws(()=>f.service.create('user:1',{id:9},request),/BUSINESS_COMPLETION_RECEIPT_REQUIRED/);
  f.db.prepare('UPDATE worker_card_activity SET details_json=? WHERE id=5').run(JSON.stringify({to_status:ITEM_STATUS.DONE}));
  assert.equal(f.service.create('user:1',{id:9},request).state,'pending');
  assert.throws(()=>f.service.create('user:1',{id:9},{...request,requestId:'wrong-card',card:'OTHER-000009'}),/BUSINESS_COMPLETION_RECEIPT_REQUIRED/);
  assert.equal(f.db.prepare('SELECT status FROM items WHERE id=9').get().status,ITEM_STATUS.IN_PRODUCTION);
});

test('expired reads are reported, never executed later as fresh, while completion receipts survive an offline shift',t=>{
  const f=fixture(t);f.service.create('user:1',{id:9},input());f.advance(31000);
  assert.equal(f.service.get('user:1','SYNTHETIC-request').state,'expired');
  assert.equal(f.service.pending('station-6',f.binding.credential).items.length,0);
  assert.throws(()=>f.service.respond('station-6',f.binding.credential,{requestId:'SYNTHETIC-request',requestHash:f.db.prepare('SELECT input_hash FROM mi_worker_requests').get().input_hash,result:{ok:true}}),/EXPIRED/);
  f.db.prepare('INSERT INTO worker_card_activity VALUES(?,?,?,?,?)').run(8,9,'status_changed',CARD,JSON.stringify({to_status:ITEM_STATUS.DONE}));
  f.service.create('user:1',{id:9},input({requestId:'offline-done',action:'completion.record',payload:{runId:'run1',saveRecipe:false,receiptId:8}}));f.advance(3600000);
  assert.equal(f.service.pending('station-6',f.binding.credential).items[0].id,'offline-done');
});

test('routine mirroring uses a bounded current-value cache instead of accumulating a database row for every screen refresh',t=>{
 const f=fixture(t),data={sourceId:'station-6',machineId:'machine6',runId:'run1',card:CARD,live:true,observedAtUtc:'2026-11-15T10:00:00.000Z',rows:[{slot:1,length:300}]};
 f.service.publish('station-6',f.binding.credential,data);
 for(let i=0;i<100;i++){
  const result=f.service.create('user:1',{id:9},input({requestId:'mirror-'+i,action:'mirror.read',payload:{runId:'run1'}}));
  assert.equal(result.state,'done');assert.equal(result.result.data.rows[0].length,300);
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM mi_worker_requests').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM mi_station_current').get().n,1);
 assert.throws(()=>f.service.publish('station-6',f.binding.credential,{...data,sourceId:'station-3d'}),/INVALID_STATION_MIRROR/);
 f.advance(6000);const stale=f.service.create('user:1',{id:9},input({requestId:'stale-mirror',action:'mirror.read',payload:{runId:'run1'}}));
 assert.equal(stale.result.data.live,false);
 const other=f.service.create('user:1',{id:9},input({requestId:'other-card',card:'OTHER-000009',action:'mirror.read',payload:{runId:'run2'}}));
 assert.equal(other.state,'pending');
});

test('worker routes retain QR authorization and item ownership, with no public role-header shortcut',async t=>{
  const f=fixture(t),express=require('express'),app=express();app.use(express.json());
  const guard=()=> (req,res,next)=>{if(req.headers.authorization!=='Bearer SYNTHETIC')return res.status(403).json({error:'permission'});req.auth={sub:1};next();};
  app.use('/api/machine-feedback',require('../routes/workerMachineFeedback')({db:f.db,requireQrPermission:guard,
    authorizeCard:(req,res,id)=>{if(Number(id)!==9||(req.body?.card||req.query.card)!==CARD){res.status(403).json({error:'card'});return null;}return{id:9};},parseCard:()=>({itemId:9}),snapshotBuilder:()=>({read_only:true,card_quantity:10,html:'not-needed'}),wsBroadcast:()=>{}}));
  const server=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port,headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC'};
  assert.equal((await fetch(url+'/api/machine-feedback/stations')).status,403);
  assert.equal((await fetch(url+'/api/machine-feedback/stations',{headers:{'X-User-Role':'admin'}})).status,403);
  const response=await fetch(url+'/api/machine-feedback/requests',{method:'POST',headers,body:JSON.stringify(input())});assert.equal(response.status,202);
  assert.equal((await fetch(url+'/api/machine-feedback/requests/SYNTHETIC-request?card=OTHER',{headers})).status,403);
  const read=await fetch(url+'/api/machine-feedback/requests/SYNTHETIC-request?card='+CARD,{headers});assert.equal(read.status,200);
  const snapshots=f.db.prepare('SELECT count(*) n FROM worker_card_activity').get().n;
  const snap=await fetch(url+'/api/machine-feedback/snapshot?sourceId=station-6&card='+CARD,{headers:{...headers,'X-Station-Credential':f.binding.credential}});
  assert.equal(snap.status,200);assert.equal((await snap.json()).activityFree,true);assert.equal(f.db.prepare('SELECT count(*) n FROM worker_card_activity').get().n,snapshots);
});
