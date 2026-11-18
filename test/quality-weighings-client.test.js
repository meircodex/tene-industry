'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {createQualityWeighingsService}=require('../services/qualityWeighings');
const source=fs.readFileSync(path.join(__dirname,'../public/quality-weighings.js'),'utf8');
function fixture(t,options={}){
 const db=new Database(options.databasePath||':memory:');ensureCoreSchema(db);t.after(()=>{if(db.open)db.close();});
 db.exec("INSERT INTO users(id,username,display_name,role)VALUES(1,'qc-test','בודק בדיקה','admin');INSERT INTO customers(id,name)VALUES(1,'לקוח בדיקה');INSERT INTO orders(id,order_num,customer_id,status)VALUES(1,'TEST-133',1,'בייצור'),(2,'TEST-132',1,'בייצור');INSERT INTO pallets(id,order_id,pallet_num)VALUES(1,1,1),(2,2,1);INSERT INTO items(id,pallet_id,order_id,shape_name,diameter,quantity,weight_per_unit,total_weight,status)VALUES(1,1,1,'מוט ישר',10,17,100,1700,'הושלם'),(2,2,2,'מוט ישר',12,19,100,1900,'ממתין');");
 const service=createQualityWeighingsService(db),nodes=new Map(),docEvents=new Map(),windowEvents=new Map(),timers=new Map(),requests=[];let nextTimer=0,failSave=options.failSave||null,serverRole=options.serverRole||'admin';
 function node(id){return {id,value:'',hidden:true,disabled:false,textContent:'',innerHTML:'',dataset:{},style:{},classList:{toggle(){}},events:new Map(),setAttribute(key,value){this[key]=value;},addEventListener(key,fn){this.events.set(key,fn);},querySelectorAll(){return[];},append(){},focus(){},scrollIntoView(){},showModal(){this.open=true;},close(){this.open=false;},get valueAsNumber(){return this.value===''?NaN:Number(this.value);}};}
 const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);},querySelectorAll:()=>[],addEventListener:(key,fn)=>docEvents.set(key,fn),createElement:()=>node('new')};
 const crypto=options.crypto===undefined?{randomUUID:()=> 'test-uuid-00000000000000000001'}:options.crypto;
 const win={IronBendSafe:{escapeHtml:value=>String(value)},IronBendAuth:{currentUser:()=>({role:options.cachedRole||'admin'})},switchTab(){},crypto,addEventListener:(key,fn)=>windowEvents.set(key,fn)};
 const fetch=async(url,init={})=>{
  const method=init.method||'GET',body=init.body?JSON.parse(init.body):null;requests.push({url,method,body});
  try{
   if(url==='/api/access/me')return {ok:true,status:200,json:async()=>({role:serverRole,screens:[{id:'quality',access:['admin','quality','manager'].includes(serverRole)?'edit':'read'}]})};
   let result;
   if(url.startsWith('/api/quality/weighing-orders/'))result=service.context(url.split('/').at(-1));
   else if(url.startsWith('/api/quality/weighing-orders?'))result=service.orders(Object.fromEntries(new URL(url,'https://test.invalid').searchParams));
   else if(url==='/api/quality/weighings/preview')result=service.preview(body);
   else if(url==='/api/quality/weighings'&&method==='POST'){
    if(options.beforeSave)await options.beforeSave();
    if(failSave){const mode=failSave;failSave=null;if(mode==='after-commit'){service.save(body,{id:1});throw Error('network response lost');}throw Error('network unavailable');}
    if(!['admin','quality','manager'].includes(serverRole))throw Object.assign(Error('forbidden'),{statusCode:403});
    result=service.save(body,{id:1});
   }else if(url.startsWith('/api/quality/weighings?'))result=service.history(Object.fromEntries(new URL(url,'https://test.invalid').searchParams));
   else if(url.startsWith('/api/quality/weighings/'))result=service.detail(url.split('/').at(-1));
   else throw Error('Unexpected URL '+url);
   return {ok:true,status:200,json:async()=>result};
  }catch(error){if(!error.statusCode)throw error;return {ok:false,status:error.statusCode,json:async()=>({error:error.message})};}
 };
 const context=vm.createContext({window:win,document,fetch,crypto,URLSearchParams,URL,Uint8Array,Date,console,location:{search:''},setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source,context);
 const event=target=>({target,preventDefault(){},stopPropagation(){}});
 const tick=async()=>{while(timers.size){const all=[...timers.values()];timers.clear();for(const fn of all)await fn();}};
 const choose=async id=>{const target={dataset:{qwChoose:String(id)},closest:()=>target};await docEvents.get('click')(event(target));await tick();};
 const weight=async value=>{const input=document.getElementById('qwWeight');input.value=String(value);await input.events.get('input')(event(input));await tick();};
 return {db,service,requests,nodes,win,async init(){await docEvents.get('DOMContentLoaded')();await tick();},choose,weight,tick,async save(){await document.getElementById('qwSave').events.get('click')();},async history(){await document.getElementById('qwHistoryView').events.get('click')();await new Promise(setImmediate);},async record(){await document.getElementById('qwLastSaved').events.get('click')();await new Promise(setImmediate);},get saveButton(){return document.getElementById('qwSave');},setCrypto(value){context.crypto=value;win.crypto=value;}};
}
test('original client saves two selected orders to SQLite and reads identical snapshots through history/detail',async t=>{
 const f=fixture(t);await f.init();await f.choose(1);await f.choose(2);await f.weight(3608);
 assert.equal(f.saveButton.disabled,false);await f.save();
 const row=f.db.prepare('SELECT * FROM quality_weighings').get();assert.equal(row.expected_weight_kg,3600);assert.equal(row.actual_weight_kg,3608);assert.equal(row.delta_kg,8);assert.equal(row.inspector_id,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM quality_weighing_orders').get().n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM quality_weighing_lines').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM quality_weighing_events').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE entity_type='quality_weighing'").get().n,1);
 assert.equal(f.db.prepare('SELECT sum(total_weight) w FROM items').get().w,3600);
 assert.equal(f.saveButton.disabled,true);await f.save();assert.equal(f.service.history().total,1);
 await f.history();assert.match(f.nodes.get('qwHistoryBody').innerHTML,/3,608/);await f.record();assert.equal(f.nodes.get('qwDetail').open,true);assert.match(f.nodes.get('qwDetailBody').innerHTML,/3,608/);
});
test('a lost response retries the same idempotency key and does not add a second database record',async t=>{
 const f=fixture(t,{failSave:'after-commit'});await f.init();await f.choose(1);await f.weight(1708);await f.save();
 assert.equal(f.service.history().total,1);assert.equal(f.saveButton.disabled,false);await f.save();
 const posts=f.requests.filter(r=>r.url==='/api/quality/weighings'&&r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.idempotency_key,posts[1].body.idempotency_key);assert.equal(f.service.history().total,1);assert.equal(f.saveButton.disabled,true);
});
test('missing randomUUID uses secure random bytes rather than leaving the form locked',async t=>{
 const f=fixture(t,{crypto:{getRandomValues:array=>{array.fill(7);return array;}}});await f.init();await f.choose(1);await f.weight(1708);await f.save();
 assert.equal(f.service.history().total,1);assert.equal(f.nodes.get('qwWeight').disabled,false);assert.match(f.saveButton.textContent,/נשמר/);
});
test('preparation failures remain visible and retryable, and permissions use the server rather than a stale cached role',async t=>{
 const f=fixture(t,{cachedRole:'office',serverRole:'admin',crypto:{}});await f.init();await f.choose(1);await f.weight(1708);
 assert.equal(f.saveButton.disabled,false);await f.save();assert.equal(f.service.history().total,0);assert.equal(f.nodes.get('qwWeight').disabled,false);assert.equal(f.saveButton.disabled,false);assert.ok(f.nodes.get('qwMessage').textContent.length>0);
 f.setCrypto({randomUUID:()=> 'test-uuid-00000000000000000002'});await f.save();assert.equal(f.service.history().total,1);
});
test('read-only server roles cannot save despite an admin role cached in the browser',async t=>{
 const f=fixture(t,{cachedRole:'admin',serverRole:'office'});await f.init();await f.choose(1);await f.weight(1708);await f.save();
 assert.equal(f.saveButton.disabled,true);assert.equal(f.service.history().total,0);assert.equal(f.requests.filter(r=>r.url==='/api/quality/weighings'&&r.method==='POST').length,0);
});

test('a weighing saved through the client survives closing and reopening the database file',async t=>{
 const folder=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'tene-qw-durable-')),databasePath=path.join(folder,'quality.db');
 const f=fixture(t,{databasePath});await f.init();await f.choose(1);await f.choose(2);await f.weight(3608);await f.save();
 const saved=f.service.detail(1);f.db.close();const reopened=new Database(databasePath);t.after(()=>reopened.close());
 const service=createQualityWeighingsService(reopened);assert.deepEqual(service.detail(1),saved);assert.equal(service.history().total,1);assert.equal(reopened.pragma('integrity_check',{simple:true}),'ok');
 assert.equal(reopened.prepare('SELECT sum(total_weight) w FROM items').get().w,3600);
});

test('changed order data blocks a stale save and requires a refreshed preview before retry',async t=>{
 const f=fixture(t);await f.init();await f.choose(1);await f.weight(1708);
 f.db.exec('UPDATE items SET quantity=18, total_weight=1800 WHERE id=1');await f.save();
 assert.equal(f.service.history().total,0);assert.equal(f.saveButton.disabled,true);assert.match(f.nodes.get('qwMessage').textContent,/השתנו/);
 await f.tick();assert.equal(f.saveButton.disabled,false);await f.save();assert.equal(f.service.detail(1).expected_weight_kg,1800);
});

test('invalid or empty measured weights cannot reach the save API',async t=>{
 const f=fixture(t);await f.init();await f.choose(1);
 for(const value of ['',0,-1,'invalid',10000001]){await f.weight(value);await f.save();assert.equal(f.saveButton.disabled,true);}
 assert.equal(f.requests.filter(r=>r.url==='/api/quality/weighings'&&r.method==='POST').length,0);assert.equal(f.service.history().total,0);
});

test('pending saves freeze selection and ignore repeated submissions until the database responds',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});const f=fixture(t,{beforeSave:()=>gate});await f.init();await f.choose(1);await f.weight(1708);
 const saving=f.save();assert.equal(f.nodes.get('qwOrders').inert,true);assert.equal(f.nodes.get('qwClear').disabled,true);await f.save();
 f.nodes.get('qwClear').events.get('click')();await f.nodes.get('qwOrders').events.get('change')({target:{dataset:{qwFull:'1'},checked:false}});
 release();await saving;assert.equal(f.service.history().total,1);assert.equal(f.service.detail(1).orders[0].order_id,1);assert.match(f.saveButton.textContent,/נשמר/);assert.equal(f.nodes.get('qwOrders').inert,false);
 assert.equal(f.requests.filter(r=>r.url==='/api/quality/weighings'&&r.method==='POST').length,1);
});
