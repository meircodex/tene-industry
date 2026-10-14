'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const express=require('express');
const {ensureBugReportSchema}=require('../db/bugReportSchema');
const {createBugReportsService,safePagePath,validateFiles}=require('../services/bugReports');
const router=require('../routes/bugReports');
const {requireRole}=require('../permissions');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
const image=(kind='before')=>({fieldname:kind,originalname:'בדיקה.png',mimetype:'image/png',buffer:png});
const worker={id:'2',name:'עובד',role:'production'},admin={id:'1',name:'מנהל',role:'admin'},other={id:'3',name:'אחר',role:'production'};
const body=()=>({request_uid:crypto.randomUUID(),title:'מידה לא מובנת',actual:'המספר מכסה את הקו',expected:'המספר מחוץ לצורה',page_path:'/orders.html?id=97&token=secret',order_reference:'097',item_reference:'4',priority:'urgent'});
function setup(t){const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureBugReportSchema(db);t.after(()=>db.close());return{db,s:createBugReportsService({db})};}

test('bug reports are persistent, additive and creation retries are idempotent',t=>{
  const {db,s}=setup(t);db.exec('CREATE TABLE orders(id INTEGER, total_weight REAL); INSERT INTO orders VALUES(97,475.3)');
  const b=body(),first=s.create(worker,b,[image()]),retry=s.create(worker,b,[image()]);
  assert.equal(first.report.id,retry.report.id);assert.equal(first.report.page_path,'/orders.html?id=97');
  assert.equal(s.list(worker).reports.length,1);assert.equal(first.events.length,1);assert.equal(first.attachments.length,1);
  assert.equal(first.attachments[0].data,undefined);assert.equal(first.report.fingerprint,undefined);
  assert.deepEqual(db.prepare('SELECT * FROM orders').all(),[{id:97,total_weight:475.3}]);
  assert.throws(()=>s.create(worker,{...b,title:'אחר'},[image()]),{status:409});
  assert.throws(()=>s.create(other,b,[image()]),{status:409});
  ensureBugReportSchema(db);assert.equal(s.list(worker).reports.length,1);
});
test('worker can only read own reports, images and conversations; manager sees all',t=>{
  const {s}=setup(t);const d=s.create(worker,body(),[image()]);
  assert.equal(s.list(other).reports.length,0);assert.equal(s.list(admin).reports.length,1);
  assert.throws(()=>s.detail(d.report.id,other),{status:404});
  assert.throws(()=>s.update(d.report.id,other,{version:1,message:'x'},[]),{status:404});
  assert.throws(()=>s.attachment(d.report.id,d.attachments[0].id,other),{status:404});
  assert.deepEqual(s.attachment(d.report.id,d.attachments[0].id,admin).data,png);
  const another=s.create(admin,body(),[]);assert.throws(()=>s.attachment(another.report.id,d.attachments[0].id,admin),{status:404});
});
test('repair requires explanation and new after image; confirmation and reopen retain history',t=>{
  const {s}=setup(t);let d=s.create(worker,body(),[image()]);const id=d.report.id;
  assert.throws(()=>s.update(id,worker,{version:1,status:'in_progress',message:'x'},[]),{status:403});
  assert.throws(()=>s.update(id,admin,{version:1,status:'closed',message:'x'},[]),{status:400});
  assert.throws(()=>s.update(id,admin,{version:1,status:'awaiting_confirmation',handler_name:'Codex',resolution:'fixed'},[]),{status:400});
  assert.equal(s.detail(id,worker).report.version,1);
  d=s.update(id,admin,{version:1,status:'in_progress',message:'בודקים תצוגת מידות'},[]);
  assert.throws(()=>s.update(id,worker,{version:1,message:'stale'},[]),{status:409});
  d=s.update(id,admin,{version:2,status:'awaiting_confirmation',handler_name:'Codex',resolution:'המספר הוצב מחוץ לצורה; נבדק מול המקור',resolution_reference:'091f7f5'},[image('after')]);
  assert.equal(d.report.status,'awaiting_confirmation');assert.equal(d.attachments.length,2);
  assert.throws(()=>s.update(id,worker,{version:3,status:'closed'},[]),{status:400});
  d=s.update(id,worker,{version:3,status:'closed',message:'בדקתי מול המקור והתיקון תקין'},[]);
  assert.equal(d.report.status,'closed');
  assert.throws(()=>s.update(id,worker,{version:4,status:'in_progress'},[]),{status:400});
  d=s.update(id,worker,{version:4,status:'in_progress',message:'בפריט אחר הבעיה עדיין קיימת'},[]);
  assert.equal(d.report.status,'in_progress');assert.equal(d.attachments.length,2);assert.equal(d.events.length,5);
  assert.throws(()=>s.update(id,admin,{version:5,status:'awaiting_confirmation',handler_name:'Codex',resolution:'fixed again'},[]),{status:400});
  d=s.update(id,admin,{version:5,status:'awaiting_confirmation',handler_name:'Codex',resolution:'תיקון נוסף'},[image('after')]);
  assert.equal(d.attachments.length,3);assert.equal(d.events.filter(e=>e.resolution).length,2);
});
test('images reject spoofed MIME, active content, oversize uploads; no partial writes',t=>{
  const {db,s}=setup(t);
  for(const file of [{...image(),buffer:Buffer.from('<svg><script>bad()</script></svg>')},{...image(),mimetype:'text/html'},{...image(),buffer:Buffer.alloc(4*1024*1024+1)}]) assert.throws(()=>s.create(worker,body(),[file]));
  assert.equal(db.prepare('SELECT count(*) n FROM bug_reports').get().n,0);
  assert.throws(()=>validateFiles(Array(7).fill(image())),{status:413});
  assert.throws(()=>s.create(worker,body(),[image('after')]),{status:400});
  assert.throws(()=>s.create(worker,{...body(),title:''},[]),{status:400});
  assert.throws(()=>safePagePath('javascript:alert(1)'),{status:400});
  assert.throws(()=>safePagePath('https://attacker.test/orders.html'),{status:400});
  assert.equal(safePagePath('/orders.html?id=97&access_token=secret&x=y#token'),'/orders.html?id=97');
});
test('reports, proof images and event ledger survive database reopen',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ironbend-bugs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'test.db');let db=new Database(filename);ensureBugReportSchema(db);const s=createBugReportsService({db});const id=s.create(worker,body(),[image()]).report.id;db.close();
  db=new Database(filename);const reopened=createBugReportsService({db});assert.equal(reopened.detail(id,worker).events.length,1);assert.deepEqual(reopened.attachment(id,1,worker).data,png);db.close();
});
test('HTTP authorization, multipart creation, image privacy and API proof requirements',async t=>{
  const {db}=setup(t);const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.headers['x-user'])req.auth={sub:req.headers['x-user'],role:req.headers['x-role']||'production',display_name:'משתמש בדיקה'};next();});app.use('/api',router({db,requireRole}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port+'/api/bug-reports';
  const request=(url='',options={})=>fetch(base+url,options);const headers={'x-user':'2','x-role':'production'};
  assert.equal((await request()).status,401);assert.equal((await request('',{headers:{'x-user':'2','x-role':'unknown'}})).status,403);
  const form=new FormData();Object.entries(body()).forEach(([k,v])=>form.set(k,v));form.append('before',new Blob([png],{type:'image/png'}),'before.png');
  const created=await request('',{method:'POST',headers,body:form});assert.equal(created.status,201);const d=await created.json();assert.equal(d.report.created_by_name,'משתמש בדיקה');
  const endpoint=`/${d.report.id}/images/${d.attachments[0].id}`;const imageResponse=await request(endpoint,{headers});assert.equal(imageResponse.status,200);assert.equal(imageResponse.headers.get('cache-control'),'no-store');assert.equal(imageResponse.headers.get('content-type'),'image/png');
  assert.equal((await request(endpoint)).status,401);assert.equal((await request(endpoint,{headers:{'x-user':'3'}})).status,404);
  const update=new FormData();update.set('version','1');update.set('status','awaiting_confirmation');update.set('handler_name','Codex');update.set('resolution','fix');
  assert.equal((await request(`/${d.report.id}/events`,{method:'POST',headers:{'x-user':'1','x-role':'admin'},body:update})).status,400);
});
