'use strict';
const assert=require('node:assert/strict'); const test=require('node:test'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const {hashPin}=require('../auth-core');
test('office guarantee review lifecycle is role protected and expiry aware',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tene-guarantees-')); Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'guarantee-tests',BCRYPT_ROUNDS:'4',DB_PATH:path.join(dir,'db.sqlite'),BACKUP_DIR:path.join(dir,'backups')}); const {server,db,closeServer}=require('../server');
 t.after(async()=>{await new Promise(r=>closeServer(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(const [name,role] of [['office','office'],['finance','finance'],['production','production']]) db.prepare('INSERT INTO users(username,display_name,role,pin,pin_hash,active) VALUES (?,?,?,?,?,1)').run(name,name,role,'1234',hashPin('1234',4));
 const cid=db.prepare("INSERT INTO customers(name) VALUES ('Guarantee')").run().lastInsertRowid; const data='data:application/pdf;base64,'+Buffer.from([1,2,250,255]).toString('base64'); const gid=db.prepare("INSERT INTO customer_guarantee_documents(customer_id,original_name,file_name,mime_type,data_url,status,size_bytes) VALUES (?,?,?,?,?,'uploaded_pending_review',4)").run(cid,'g.pdf','g.pdf','application/pdf',data).lastInsertRowid;
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`; async function token(user){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,pin:'1234'})}); return (await r.json()).access_token;} async function req(path,opts={}){return fetch(base+path,{...opts,headers:{...(opts.headers||{}),Authorization:'Bearer '+(opts.token||'')}})}
 const office=await token('office'),finance=await token('finance'),production=await token('production'); let r=await req('/api/portal/guarantees',{token:office}); assert.equal(r.status,200); const body=await r.json(); assert.equal(body.documents[0].data_url,undefined); assert.equal((await req(`/api/portal/guarantees/${gid}/download`,{token:production})).status,403); assert.equal((await req(`/api/portal/guarantees/${gid}`,{token:office,method:'PATCH',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const review=body=>req(`/api/portal/guarantees/${gid}`,{token:finance,method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await review({status:'approved',valid_until:'2000-01-01'})).status,400);
 assert.equal((await review({status:'approved',valid_until:'2099-02-30'})).status,400);
 assert.equal((await review({status:'approved',valid_until:'2099-01-01'})).status,200);
 assert.equal((await review({status:'revoked'})).status,400);
 assert.equal((await review({status:'revoked',notes:'test revoke'})).status,200);
 assert.equal((await review({status:'rejected',notes:'test rejected'})).status,200);
 db.prepare("UPDATE customer_guarantee_documents SET status='approved',valid_until='2000-01-01' WHERE id=?").run(gid);
 assert.equal((await (await req('/api/portal/guarantees',{token:office})).json()).documents[0].computed_status,'expired');
 assert.equal((await (await req('/api/portal/guarantees',{token:office})).json()).canReview,false);
 assert.equal((await (await req('/api/portal/guarantees',{token:finance})).json()).canReview,true);
 assert.deepEqual(Buffer.from(await (await req(`/api/portal/guarantees/${gid}/download`,{token:finance})).arrayBuffer()),Buffer.from([1,2,250,255]));
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND action='guarantee_review'").get(gid).n,3);
});
