'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(),'tene-shape-catalog-http-'));
Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'shape-catalog-test-secret',BCRYPT_ROUNDS:'4',DB_PATH:path.join(tmpDir,'test.db'),BACKUP_DIR:path.join(tmpDir,'backups')});
const { server,db,closeServer } = require('../server');
const { hashPin } = require('../auth-core');
const commercial = require('../modules/steel-rebar/shape-commercial');
test('authorized catalogue editing and order/delivery consumers share immutable per-shape policies', async t => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => closeServer(resolve)); db.close(); fs.rmSync(tmpDir,{recursive:true,force:true}); });
  const request = (url,options={}) => fetch(base+url,options);
  async function login(role) {
    db.prepare('INSERT INTO users(username,display_name,role,pin,pin_hash,active,password_changed_at) VALUES(?,?,?,?,?,1,?)').run('catalog-'+role,role,role,'1234',hashPin('1234',4),new Date().toISOString());
    const result = await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'catalog-'+role,pin:'1234'})});
    assert.equal(result.status,200); const token = (await result.json()).access_token;
    return {'Content-Type':'application/json',Authorization:'Bearer '+token};
  }
  const manager = await login('manager'),office = await login('office');
  const admin = await login('admin');
  for(const [headers,canManage] of [[manager,true],[admin,true],[office,false]]) {
    const response = await request('/api/shape-definitions',{headers});
    assert.equal((await response.json()).permissions.canManage,canManage);
  }
  const input = {itemCode:'001',name:'חישוק',definition:{family:'bars',sides:[400,200,400,200],angles:[90,90,90,90]},billingPolicy:commercial.defaultPolicy({presetId:'s8'})};
  assert.equal((await request('/api/shape-definitions')).status,401);
  assert.equal((await request('/api/shape-definitions',{method:'POST',headers:office,body:JSON.stringify(input)})).status,403);
  const created = await request('/api/shape-definitions',{method:'POST',headers:manager,body:JSON.stringify(input)}); assert.equal(created.status,201);
  const entry = (await created.json()).entry;
  const builtin = {...input,itemCode:'8',expectedVersion:1};
  assert.equal((await request('/api/shape-definitions/builtin/s8',{method:'PUT',headers:office,body:JSON.stringify(builtin)})).status,403);
  const override = await request('/api/shape-definitions/builtin/s8',{method:'PUT',headers:manager,body:JSON.stringify(builtin)});
  assert.equal(override.status,200); assert.equal((await override.json()).entry.version,2);
  assert.equal((await request('/api/shape-definitions/builtin/s8',{method:'PUT',headers:admin,body:JSON.stringify({...builtin,expectedVersion:2})})).status,200);
  assert.equal((await request('/api/shape-definitions/builtin/s8',{method:'PUT',headers:manager,body:JSON.stringify(builtin)})).status,409);
  const listed = await request('/api/shape-definitions',{headers:office}); assert.equal(listed.status,200); assert.equal((await listed.json()).entries[0].itemCode,'001');
  const customerId = db.prepare("INSERT INTO customers(name,phone) VALUES('Catalog customer','0500000000')").run().lastInsertRowid;
  const orderId = db.prepare("INSERT INTO orders(order_num,customer_id,channel,status,total_weight) VALUES('CATALOG-1',?,'משרד','ממתין',150)").run(customerId).lastInsertRowid;
  const palletId = db.prepare('INSERT INTO pallets(order_id,pallet_num,total_weight) VALUES(?,1,150)').run(orderId).lastInsertRowid;
  function insert(policy,qty,weight,smooth) {
    const snapshot = {family:'bars',shapeType:'custom_bar',data:{sides:[400,200,400,200],angles:[90,90,90,90],diameter:8,steelFinish:smooth?'smooth':'ribbed'},billingPolicy:policy,catalogIdentity:{source:'shared',id:entry.id,itemCode:'001',version:1}};
    db.prepare("INSERT INTO items(pallet_id,order_id,shape_name,diameter,segments,total_length_mm,quantity,total_weight,shape_snapshot_json,status) VALUES(?,?,'שם חופשי',8,?,1200,?,?,?,'ממתין')").run(palletId,orderId,JSON.stringify([{length_mm:400,angle_deg:90},{length_mm:200,angle_deg:90},{length_mm:400,angle_deg:90},{length_mm:200,angle_deg:90}]),qty,weight,JSON.stringify(snapshot));
  }
  insert(entry.billingPolicy,20,100,false);
  insert(commercial.defaultPolicy({shapeType:'bench_bar'}),10,50,true);
  const update = await request('/api/shape-definitions/'+entry.id,{method:'PUT',headers:manager,body:JSON.stringify({...input,name:'שונה לספסל',billingPolicy:commercial.defaultPolicy({shapeType:'bench_bar'}),expectedVersion:1})});
  assert.equal(update.status,200);
  assert.equal((await request('/api/shape-definitions/'+entry.id,{method:'PUT',headers:manager,body:JSON.stringify({...input,expectedVersion:1})})).status,409);
  assert.equal((await request('/api/shapes',{method:'POST',headers:manager,body:JSON.stringify({id:entry.id,name:'legacy overwrite'})})).status,409);
  const orderResponse = await request('/api/orders/'+orderId,{headers:office}); assert.equal(orderResponse.status,200);
  const summary = (await orderResponse.json()).commercial_summary;
  for(const [key,value] of [['hoops_units',20],['chairs_units',10],['smooth_rebar_kg',50],['bending_kg',150],['cutting_kg',150]]) assert.equal(summary.lines.find(line=>line.key===key).value,value,key);
  assert.equal(summary.material_weight_kg,150);
  assert.equal(summary.lines.find(line=>line.key==='hoops_units').contributors[0].catalog_identity.version,1);
  for(const suffix of ['/print-a4','/delivery-certificate?waste3=0']) {
    const response = await request('/api/orders/'+orderId+suffix,{headers:office}); assert.equal(response.status,200);
    const html = await response.text();
    for(const key of ['hoops_units','chairs_units','smooth_rebar_kg','cutting_kg','bending_kg']) assert.ok(html.includes(`data-commercial-summary-line="${key}"`),suffix+' '+key);
    assert.doesNotMatch(html,/₪/);
  }
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
});
