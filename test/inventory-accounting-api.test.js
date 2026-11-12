'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {requireAnyRole}=require('../permissions');
const createInventory=require('../routes/inventory'),createProcurement=require('../routes/procurement');
test('count approval, stock immutability and purchase export enforce roles and persist correct balances',async()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);db.exec("INSERT INTO raw_material(id,diameter,material_type,weight_received) VALUES(1,12,'coil',1000)");
  const app=express();app.use(express.json());
  // This fixture injects server-side auth; production uses the existing JWT middleware.
  app.use((req,res,next)=>{if(req.headers['test-fixture-role'])req.auth={role:req.headers['test-fixture-role'],sub:1};next();});
  const events=[];app.use('/api',createInventory({db,requireAnyRole,wsBroadcast:(...v)=>events.push(v),auditLog:()=>{},listPage:()=>({limit:100,offset:0})}));app.use('/api',createProcurement({db,requireAnyRole}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  const request=async(path,method='GET',role,body)=>fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',...(role?{'test-fixture-role':role}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try{
    const input={counted_at:new Date().toISOString(),reason:'ספירה',lines:[{raw_material_id:1,counted_kg:800}]};
    assert.equal((await request('/inventory/stocktakes/preview','POST',null,input)).status,401);
    const previewResponse=await request('/inventory/stocktakes/preview','POST','warehouse',input);assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
    const approval={...input,preview_token:preview.preview_token,idempotency_key:'api-count'};
    assert.equal((await request('/inventory/stocktakes','POST','warehouse',approval)).status,403);
    assert.equal((await request('/inventory/stocktakes','POST','manager',approval)).status,200);
    const summary=await (await request('/inventory/summary','GET','warehouse')).json();assert.equal(summary[0].available,800);
    assert.equal((await request('/inventory/metrics','GET')).status,401);
    assert.equal((await request('/inventory/metrics','GET','production')).status,403);
    const metrics=await (await request('/inventory/metrics','GET','warehouse')).json();assert.equal(metrics.stocked_lots,1);assert.equal(metrics.recorded_net_kg,0);assert.equal(metrics.verified_consumption_kg,null);
    assert.equal((await request('/inventory/1','PATCH','manager',{weight_received:800})).status,409);
    const exportBody={lines:[{material_type:'coil',diameter:12,quantity:1234}]};
    assert.equal((await request('/procurement/purchase-draft/export','POST','production',exportBody)).status,403);
    const result=await request('/procurement/purchase-draft/export','POST','manager',exportBody);assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/text\/csv/);assert.match(await result.text(),/1234/);
    assert.equal((await request('/procurement/plan','GET','warehouse')).status,200);assert.ok(events.some(([name])=>name==='inventory_changed'));
    assert.equal((await request('/procurement/plan?include_details=true','GET')).status,401);
    assert.equal((await request('/procurement/plan?include_details=true','GET','production')).status,403);
    assert.equal((await request('/procurement/plan?include_details=true&detail_limit=101','GET','warehouse')).status,400);
    assert.equal((await request('/procurement/plan?include_details=true&detail_offset=-1','GET','warehouse')).status,400);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
