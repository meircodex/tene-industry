'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tene-factory-monitor-'));
process.env.NODE_ENV='test';process.env.DB_PATH=path.join(tmp,'test.db');process.env.BACKUP_DIR=path.join(tmp,'backups');process.env.JWT_SECRET='synthetic-factory-monitor-only';process.env.BCRYPT_ROUNDS='4';
const {server,db,closeServer}=require('../server'),{hashPin}=require('../auth-core');
const {StationInbox}=require('../services/machineIntegration/stationInbox'),{WorkerFeedback}=require('../services/machineIntegration/workerFeedback');
test('existing personal scanner reaches feedback with its own identity and permissions while production remains the sole writer',async t=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>closeServer(resolve));db.close();fs.rmSync(tmp,{recursive:true,force:true});});
 async function call(url,token,body,method=body?'POST':'GET'){
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};
 }
 db.prepare('INSERT INTO users(username,display_name,role,pin_hash,active)VALUES(?,?,?,?,1)').run('synthetic-admin','Synthetic','admin',hashPin('9911',4));
 const admin=(await call('/api/auth/login',null,{username:'synthetic-admin',pin:'9911'})).body.access_token;
 async function worker(name,permissions){
  const p=(await call('/api/worker-profiles',admin,{worker_name:name,phone:name==='one'?'0501112211':'0501112212',role:'production',permissions:['production']})).body;
  assert.equal((await call('/api/worker-profiles/'+p.id+'/portal-account',admin,{username:'synthetic-'+name,password:'synthetic-Test-123!',language:'he',permissions},'PUT')).status,200);
  return (await call('/api/auth/worker-login',null,{username:'synthetic-'+name,password:'synthetic-Test-123!'})).body.access_token;
 }
 const one=await worker('one',['start','complete']),two=await worker('two',['weigh']);
 const machine=db.prepare('INSERT INTO machines(name,label) VALUES(?,?)').run('Synthetic machine','SYN6').lastInsertRowid;
 const c=db.prepare('INSERT INTO customers(name) VALUES(?)').run('Synthetic customer').lastInsertRowid;
 const o=db.prepare('INSERT INTO orders(order_num,customer_id,status) VALUES(?,?,?)').run('SYNTHETIC-1',c,'בתור ייצור').lastInsertRowid;
 const p=db.prepare('INSERT INTO pallets(order_id,pallet_num) VALUES(?,1)').run(o).lastInsertRowid;
 const item=Number(db.prepare(`INSERT INTO items(pallet_id,order_id,shape_id,shape_name,diameter,quantity,production_qty,weight_per_unit,total_weight,status,machine,machine_id,total_length_mm,segments)VALUES(?,?,'straight','Synthetic',8,10,10,0.395,3.95,'בייצור','SYN6',?,1000,?)`).run(p,o,machine,JSON.stringify([{length_mm:1000,angle_deg:0}])).lastInsertRowid);
 const card='SYNTHETIC-1-'+String(item).padStart(6,'0'),inbox=new StationInbox({db}),binding=inbox.register({id:1},{sourceId:'synthetic-station',logicalMachineId:'machine6',machineId:Number(machine)}),feedback=new WorkerFeedback({db,inbox});
 feedback.pending(binding.sourceId,binding.credential);
 const before=db.prepare('SELECT status,produced_qty FROM items WHERE id=?').get(item),count=db.prepare('SELECT COUNT(*) n FROM worker_card_activity').get().n;
 assert.equal((await call('/api/machine-integration/station-state')).status,401);
 const state=await call('/api/machine-integration/station-state?machineId='+machine,admin);assert.equal(state.status,200);assert.equal(state.body.items[0].controller,'unknown');assert.equal(state.body.items[0].online,true);assert.ok(!JSON.stringify(state.body).includes(binding.credential));
 const prefix='/api/worker-portal/machine-feedback';
 assert.equal((await call(prefix+'/stations')).status,401);
 assert.equal((await call(prefix+'/stations',two)).status,403);
 assert.equal((await call(prefix+'/stations',one)).status,200);
 assert.equal((await call('/api/machine-feedback/stations',one)).status,403,'portal-only credentials stay inside their API boundary');
 assert.equal((await call('/api/machine-integration/station-state',one)).status,403);
 assert.equal((await call(prefix+'/requests',one,{requestId:'synthetic-open',sourceId:binding.sourceId,itemId:item,card,action:'card.open',payload:{receiptId:1}})).status,202);
 const command=feedback.pending(binding.sourceId,binding.credential).items.find(r=>r.id==='synthetic-open');
 feedback.respond(binding.sourceId,binding.credential,{requestId:command.id,requestHash:command.requestHash,result:{ok:true,data:{sourceId:binding.sourceId,card,runId:'synthetic-run'}}});
 assert.equal((await call(prefix+'/requests/synthetic-open?card='+card,one)).body.result.data.runId,'synthetic-run');
 assert.equal((await call(prefix+'/requests/synthetic-open?card=WRONG',one)).status,403);
 assert.equal((await call(prefix+'/requests',two,{requestId:'wrong-worker',sourceId:binding.sourceId,itemId:item,card,action:'completion.record',payload:{runId:'synthetic-run',saveRecipe:true,receiptId:999}})).status,403);
 assert.equal((await call(prefix+'/requests',one,{requestId:'no-receipt',sourceId:binding.sourceId,itemId:item,card,action:'completion.record',payload:{runId:'synthetic-run',saveRecipe:true,receiptId:999}})).status,409);
 assert.deepEqual(db.prepare('SELECT status,produced_qty FROM items WHERE id=?').get(item),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM worker_card_activity').get().n,count);
 const done=await call('/api/worker-portal/card/'+item+'/status',one,{card,status:'הושלם',expected_status:'בייצור',request_id:'synthetic-complete-0001'},'PATCH');assert.equal(done.status,200,JSON.stringify(done.body));
 assert.equal((await call(prefix+'/requests',one,{requestId:'valid-completion',sourceId:binding.sourceId,itemId:item,card,action:'completion.record',payload:{runId:'synthetic-run',saveRecipe:false,receiptId:done.body.receipt.id}})).status,202);
 assert.equal((await call('/api/worker-portal/card/'+item+'/status',one,{card,status:'הושלם',expected_status:'בייצור',request_id:'synthetic-complete-0001'},'PATCH')).body.receipt.id,done.body.receipt.id);
});
