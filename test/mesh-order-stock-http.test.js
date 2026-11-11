'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),bcrypt=require('bcryptjs');
const {buildFullShapeSnapshot}=require('../services/shapeSnapshot');
const makeShape=(data={})=>buildFullShapeSnapshot({family:'mesh',shapeId:'mesh1',shapeType:'mesh_rectangular',displayName:'רשת',data:{length:6000,width:2500,longitudinalDiameter:8,longitudinalSpacing:200,transverseDiameter:8,transverseSpacing:200,edgeLeft:0,edgeRight:0,edgeTop:0,edgeBottom:0,countingConfirmed:true,...data},calculated:{weightKg:9999},validation:{valid:true}});
test('mesh HTTP create, preview, add, edit, delete and issued-stock protection preserve sheet stock and canonical weights',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ironbend-mesh-http-'));
 Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(dir,'test.db'),BACKUP_DIR:path.join(dir,'backups'),JWT_SECRET:'mesh-http-fixture-secret',BCRYPT_ROUNDS:'4',AI_ENABLED:'false',PRIORITY_ENABLED:'false'});
 const runtime=require('../server'),db=runtime.db;t.after(async()=>{await new Promise(r=>runtime.closeServer(r));if(db.open)db.close();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+runtime.server.address().port;
 const tokens={};for(const role of ['office','production']){
  db.prepare('INSERT INTO users(username,display_name,role,pin_hash,active) VALUES(?,?,?,?,1)').run('mesh-'+role,'Mesh '+role,role,bcrypt.hashSync('1234',4));
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'mesh-'+role,pin:'1234'})});tokens[role]=(await response.json()).access_token;
 }
 async function call(url,body,method='POST',role='office'){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:'Bearer '+tokens[role]}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 const snapshot=makeShape(),payload={customer:{name:'Mesh HTTP'},order:{totalWeight:0},pallets:[{items:[{shapeSnapshot:snapshot,shapeName:'רשת',diameter:12,length:0,sides:[],angles:[],qty:3}]}]};
 const mesh=require('../services/meshInventory'),spec=require('../services/meshOrder').metrics({shapeSnapshot:snapshot}).specification;
 const receipt=mesh.receiptDraft(db,{specification:spec,quantity_units:10,idempotency_key:'http-stock'});mesh.approveReceipt(db,{receipt_id:receipt.id});
 assert.equal((await call('/api/orders/reservation-preview',{items:[]},'POST',null)).status,401);
 assert.equal((await call('/api/orders/reservation-preview',{items:[]},'POST','production')).status,403);
 const created=await call('/api/orders',payload);assert.equal(created.status,200,JSON.stringify(created.data));const id=created.data.orderId;
 const item=db.prepare('SELECT * FROM items WHERE order_id=?').get(id);assert.equal(item.total_weight,181.333);assert.equal(item.diameter,8);
 assert.equal(db.prepare('SELECT total_weight FROM orders WHERE id=?').get(id).total_weight,181.333);
 let preview=await call('/api/orders/reservation-preview',{items:[{shape_snapshot_json:JSON.stringify(snapshot),quantity:4,material_type:'mesh'}]});assert.equal(preview.status,200);assert.equal(preview.data.mesh_groups[0].available_units,7);assert.equal(preview.data.total.required_kg,0);assert.equal(preview.data.mesh_groups[0].reserved_units,3);
 const updated=await call(`/api/orders/${id}/items/${item.id}`,{quantity:2},'PATCH');assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.total_weight,120.889);
 assert.equal(db.prepare("SELECT SUM(quantity_units) n FROM inventory_mesh_demands WHERE status='active'").get().n,2);
 const added=await call(`/api/orders/${id}/items`,{shapeSnapshot:snapshot,shape_name:'רשת',diameter:12,total_length_mm:0,quantity:3,segments:[]});assert.equal(added.status,200,JSON.stringify(added.data));assert.equal(added.data.total_weight,181.333);
 assert.equal(db.prepare("SELECT SUM(quantity_units) n FROM inventory_mesh_demands WHERE status='active'").get().n,5);
 const removed=await call(`/api/orders/${id}/items/${added.data.itemId}`,undefined,'DELETE');assert.equal(removed.status,409,JSON.stringify(removed.data));
 const review=await call(`/api/orders/${id}/items/${added.data.itemId}/cancellation-review`,undefined,'GET');assert.equal(review.status,200);
 const cancelled=await call(`/api/orders/${id}/items/${added.data.itemId}/cancel`,{idempotency_key:'mesh-cancel-http',reason:'fixture cancellation',items:[{item_id:added.data.itemId,stock_disposition_qty:0,scrap_disposition_qty:0}]});assert.equal(cancelled.status,201,JSON.stringify(cancelled.data));assert.equal(mesh.planMesh(db)[0].required_units,2);
 const use=require('../services/inventoryReservation').consumeReservationsForProduction(db,{order_id:id,item_ids:[item.id]});assert.equal(use.consumed,1);assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,8);
 assert.equal((await call(`/api/orders/${id}/items/${item.id}`,{quantity:3},'PATCH')).status,409);
 assert.equal(db.prepare('SELECT quantity FROM items WHERE id=?').get(item.id).quantity,2);assert.equal(db.prepare('SELECT quantity_units FROM inventory_mesh_stock').get().quantity_units,8);
 const count=db.prepare('SELECT COUNT(*) n FROM orders').get().n;
 assert.equal((await call('/api/orders',{...payload,pallets:[{items:[{...payload.pallets[0].items[0],shapeSnapshot:makeShape({longitudinalSpacing:0})}]}]})).status,400);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,count);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_reservations').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_material_usage').get().n,0);
 assert.equal(db.pragma('integrity_check')[0].integrity_check,'ok');
});
