'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Database=require('better-sqlite3'),bcrypt=require('bcryptjs');
const os=require('node:os');
const {ensureCoreSchema}=require('../db/coreSchema');
const {ensureOrderWorkspaceSchema}=require('../db/orderWorkspaceSchema');
const {ensureAuthSchema}=require('../auth-core');
const {createOrderWorkspaceService,bucketCondition}=require('../services/orderWorkspace');
const ui=require('../public/order-workspace');
const actor={id:1,name:'מנהל',role:'admin'};
function fixture(t){const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureCoreSchema(db);ensureAuthSchema(db);db.prepare('INSERT INTO users(id,username,display_name,role,pin_hash,active) VALUES(1,?,?,?,?,1)').run('test-admin','Test Admin','admin',bcrypt.hashSync('1234',4));t.after(()=>db.close());return{db,s:createOrderWorkspaceService({db})};}
function order(db,num,status='ממתינה לאישור'){return Number(db.prepare('INSERT INTO orders(order_num,status,total_weight,delivery_date) VALUES(?,?,123.4,?)').run(num,status,'2026-10-15').lastInsertRowid);}
const confirm=(version=1)=>({version,confirmed:true,reason:'בדיקה מקומית בלבד'});
test('workspace groups all work, delivered, paid, cancelled and trash without altering production',t=>{
 const {db,s}=fixture(t);const ids=[order(db,'ACTIVE','בייצור'),order(db,'DELIVERED','סופק – אושר'),order(db,'PAID','סופק – אושר'),order(db,'CANCELLED','בוטלה'),order(db,'TRASH')];
 s.payment(ids[2],actor,{...confirm(),payment_status:'paid'});s.trash(ids[4],actor,confirm());
 for(const [index,bucket]of ['active','delivered','closed','cancelled','trash'].entries()){const rows=db.prepare('SELECT o.* FROM orders o WHERE '+bucketCondition(bucket)).all();assert.equal(rows.length,1);assert.equal(rows[0].id,ids[index]);assert.equal(ui.bucket(rows[0]),bucket);}
 assert.equal(s.read(ids[2]).status,'סופק – אושר');assert.equal(s.read(ids[2]).total_weight,123.4);
 assert.throws(()=>bucketCondition('invalid'),{statusCode:400});
});
test('trash is reversible even after production, retains all items, statuses and payment',t=>{
 const {db,s}=fixture(t),id=order(db,'STARTED','בייצור');const pallet=Number(db.prepare('INSERT INTO pallets(order_id,pallet_num)VALUES(?,1)').run(id).lastInsertRowid);
 db.prepare('INSERT INTO items(pallet_id,order_id,shape_name,diameter,quantity,status,produced_qty,segments,total_length_mm,total_weight)VALUES(?,?,?,12,64,?,12,?,4700,475.3)').run(pallet,id,'custom','בייצור','[]');
 const before=db.prepare('SELECT * FROM items').all();assert.throws(()=>s.trash(id,actor,{...confirm(),confirmed:false}),{statusCode:400});
 let row=s.trash(id,actor,confirm());assert.ok(row.deleted_at);assert.equal(row.status,'בייצור');assert.deepEqual(db.prepare('SELECT * FROM items').all(),before);
 assert.throws(()=>s.restore(id,actor,confirm()),{statusCode:409});row=s.restore(id,actor,confirm(2));assert.equal(row.deleted_at,null);assert.equal(row.status,'בייצור');assert.deepEqual(db.prepare('SELECT * FROM items').all(),before);
 assert.deepEqual(db.prepare('SELECT action FROM order_workspace_events WHERE order_id=? ORDER BY id').all(id).map(e=>e.action),['trash','restore']);
});
test('payment marker can be corrected without rewriting supply, price, weight or finance',t=>{
 const {db,s}=fixture(t),id=order(db,'PAYMENT','סופק – אושר');const baseline=s.read(id);s.payment(id,actor,{...confirm(),payment_status:'paid'});
 assert.equal(ui.bucket(s.read(id)),'closed');assert.throws(()=>s.payment(id,actor,{...confirm(),payment_status:'unpaid'}),{statusCode:409});
 s.payment(id,actor,{...confirm(2),payment_status:'unpaid'});assert.equal(ui.bucket(s.read(id)),'delivered');for(const key of ['status','total_weight','sale_price','billing_weight'])assert.equal(s.read(id)[key],baseline[key]);
 assert.equal(db.prepare('SELECT count(*)n FROM invoices').get().n,0);
});
test('permanent purge requires active admin password, trash and explicit confirmation',t=>{
 const {db,s}=fixture(t),id=order(db,'PURGE');assert.throws(()=>s.purge(id,actor,{...confirm(),password:'1234'}),{statusCode:409});s.trash(id,actor,confirm());
 assert.throws(()=>s.purge(id,actor,{...confirm(2),password:'wrong'}),{statusCode:403});assert.ok(s.read(id));
 assert.throws(()=>s.purge(id,actor,{...confirm(2),confirmed:false,password:'1234'}),{statusCode:400});
 const result=s.purge(id,actor,{...confirm(2),password:'1234'});assert.equal(result.orderNum,'PURGE');assert.equal(db.prepare('SELECT id FROM orders WHERE id=?').get(id),undefined);
 const events=db.prepare('SELECT * FROM order_workspace_events WHERE order_id=?').all(id);assert.equal(events.length,2);assert.ok(events.some(e=>e.action==='purge'));assert.doesNotMatch(JSON.stringify(events),/1234|wrong/);
});
test('purge protects production, delivery, invoice, inventory and source records',t=>{
 const {db,s}=fixture(t);for(const name of ['production','delivery','invoice','inventory','source']){
  const id=order(db,'PROTECT-'+name),pallet=Number(db.prepare('INSERT INTO pallets(order_id,pallet_num)VALUES(?,1)').run(id).lastInsertRowid);const item=Number(db.prepare('INSERT INTO items(pallet_id,order_id,status,quantity,produced_qty)VALUES(?,?,?,1,?)').run(pallet,id,name==='production'?'בייצור':'ממתין',name==='production'?1:0).lastInsertRowid);
  if(name!=='production'){db.exec(`CREATE TABLE IF NOT EXISTS test_history_${name}(order_id INTEGER,item_id INTEGER)`);db.prepare(`INSERT INTO test_history_${name}(order_id,item_id)VALUES(?,?)`).run(id,item);}
  s.trash(id,actor,confirm());assert.throws(()=>s.purge(id,actor,{...confirm(2),password:'1234'}),{statusCode:409});assert.ok(s.read(id));assert.ok(db.prepare('SELECT id FROM items WHERE id=?').get(item));
 }
});
test('migration is repeatable; helpers and table headings have matching seven columns',t=>{
 const {db}=fixture(t),id=order(db,'KEEP');ensureOrderWorkspaceSchema(db);ensureOrderWorkspaceSchema(db);assert.equal(db.prepare('SELECT total_weight FROM orders WHERE id=?').get(id).total_weight,123.4);
 assert.equal(ui.deliveryDate('2026-10-15'),'15.10.2026');assert.equal(ui.rowTone({status:'בייצור'}),'production');assert.match(ui.notes({delivery_progress:{shipped_unit_count:646,total_unit_count:917,remaining_unit_count:271,shipped_item_count:16,total_item_count:31}})[0],/16 מתוך 31/);
 const html=fs.readFileSync(path.join(__dirname,'../public/orders.html'),'utf8');const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);for(const script of scripts)new vm.Script(script);
 const rendering=html.slice(html.indexOf('function renderTable('),html.indexOf('// ── Mobile cards'));assert.equal((rendering.match(/<td(?:\s|>)/g)||[]).length,8); // seven row cells plus the empty state cell
 assert.match(rendering,/תאריך אספקה/);assert.match(rendering,/הערות/);assert.doesNotMatch(rendering,/channelLabel|urgentLabel/);assert.doesNotMatch(html,/id="quotesViewBtn"/);
 const actions=html.slice(html.indexOf('function actionBtns('),html.indexOf('function orderStatusSelect('));assert.match(actions,/kind=print-a4/);assert.doesNotMatch(actions,/openOrderEdit|setStatus\(|kind=print-cards/);
});

test('real HTTP endpoints scope payment and recycle operations and block old passwordless deletion',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ironbend-order-workspace-http-'));
 process.env.NODE_ENV='test';process.env.JWT_SECRET='order-workspace-test-secret';process.env.BCRYPT_ROUNDS='4';process.env.DB_PATH=path.join(directory,'test.db');process.env.BACKUP_DIR=path.join(directory,'backups');
 const runtime=require('../server');t.after(async()=>{await new Promise(resolve=>runtime.closeServer(resolve));if(runtime.db.open)runtime.db.close();fs.rmSync(directory,{recursive:true,force:true});});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+runtime.server.address().port;
 const tokens={};for(const role of ['admin','office','production']){const username='workspace-http-'+role;runtime.db.prepare('INSERT INTO users(username,display_name,role,pin_hash,active)VALUES(?,?,?,?,1)').run(username,username,role,bcrypt.hashSync('1234',4));const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,pin:'1234'})});assert.equal(response.status,200);tokens[role]=(await response.json()).access_token;}
 const headers=role=>({'Content-Type':'application/json',Authorization:'Bearer '+tokens[role]});
 const call=(url,role,method='GET',body)=>fetch(base+url,{method,headers:role?headers(role):undefined,body:body===undefined?undefined:JSON.stringify(body)});
 const active=order(runtime.db,'HTTP-ACTIVE','בייצור'),supplied=order(runtime.db,'HTTP-SUPPLIED','סופק – אושר'),pending=order(runtime.db,'HTTP-PURGE');
 assert.equal((await call(`/api/orders/${active}/trash`,null,'POST',confirm())).status,401);
 assert.equal((await call(`/api/orders/${active}/trash`,'production','POST',confirm())).status,403);
 assert.equal((await call(`/api/orders/${pending}`,'office','DELETE')).status,409);
 assert.equal((await call(`/api/orders/${supplied}/payment`,'production','PATCH',{...confirm(),payment_status:'paid'})).status,403);
 assert.equal((await call(`/api/orders/${supplied}/payment`,'office','PATCH',{...confirm(),payment_status:'paid'})).status,200);
 let rows=await(await call('/api/orders?bucket=active','office')).json();assert.ok(rows.some(r=>r.id===active));assert.ok(!rows.some(r=>r.id===supplied));
 rows=await(await call('/api/orders?bucket=closed','office')).json();assert.equal(rows.find(r=>r.id===supplied).status,'סופק – אושר');
 assert.equal((await call(`/api/orders/${active}/trash`,'office','POST',confirm())).status,200);
 rows=await(await call('/api/orders?bucket=trash','office')).json();assert.ok(rows.some(r=>r.id===active));assert.ok(!(await(await call('/api/orders','office')).json()).some(r=>r.id===active));
 assert.equal((await call(`/api/orders/${active}/status`,'office','PATCH',{status:'הושלם – ממתין לאיסוף'})).status,409);
 assert.equal((await call(`/api/orders/${active}/restore`,'office','POST',confirm(2))).status,200);
 assert.equal(runtime.db.prepare('SELECT status FROM orders WHERE id=?').get(active).status,'בייצור');
 assert.equal((await call(`/api/orders/${pending}/trash`,'office','POST',confirm())).status,200);
 assert.equal((await call(`/api/orders/${pending}/purge`,'office','POST',{...confirm(2),password:'1234'})).status,403);
 assert.equal((await call(`/api/orders/${pending}/purge`,'admin','POST',{...confirm(2),password:'wrong'})).status,403);
 assert.equal((await call(`/api/orders/${pending}/purge`,'admin','POST',{...confirm(2),password:'1234'})).status,200);
 assert.equal(runtime.db.prepare('SELECT id FROM orders WHERE id=?').get(pending),undefined);
 assert.ok(runtime.db.prepare("SELECT 1 FROM order_workspace_events WHERE order_id=? AND action='purge'").get(pending));
});
