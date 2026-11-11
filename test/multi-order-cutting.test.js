'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {planInventoryCutting}=require('../public/straight-stock-cutting');
const batch=require('../public/order-batch-actions');
const {cuttingStock}=require('../services/cuttingStock');
const source=(id,length,count,extra={})=>({id,diameter:12,material:'ribbed',stockLengthMm:length,count,...extra});
const piece=(id,length,quantity=1,extra={})=>({itemId:id,diameter:12,material:'ribbed',lengthMm:length,quantity,orderId:id,...extra});

test('delivery action uses customer identity, preserves exact requested message and handles missing identities',()=>{
  assert.equal(batch.deliveryEligibility([{customer_id:1},{customer_id:'1'}]).ok,true);
  assert.deepEqual(batch.deliveryEligibility([{customer_id:1,customer_name:'זהה'},{customer_id:2,customer_name:'זהה'}]),{ok:false,message:'לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים'});
  assert.match(batch.deliveryEligibility([{customer_name:'לקוח'}]).message,/חסר לקוח/);
  batch.sync([{id:1,customer_id:1},{id:2,customer_id:2}],[{id:1}],'orders|active');batch.toggleVisible(true);assert.deepEqual(batch.selectedIds(),[1]);
  batch.sync([{id:1,customer_id:1},{id:2,customer_id:2}],[{id:2}],'orders|active');batch.toggleVisible(true);assert.deepEqual(batch.selectedIds(),[1,2]);
  batch.sync([{id:2,customer_id:2}],[{id:2}],'orders|active');assert.deepEqual(batch.selectedIds(),[2]);
  batch.sync([],[],'quotes|active');assert.deepEqual(batch.selectedIds(),[]);
});
test('finite stock combines compatible orders on one bar and preserves both source identities',()=>{
  const plan=planInventoryCutting({sources:[source(1,12000,1)],pieces:[piece('11:1',7000),piece('22:1',5000)]});
  assert.equal(plan.bars.length,1);assert.equal(plan.complete,true);assert.equal(plan.totalWasteMm,0);
  assert.deepEqual(plan.bars[0].pieces.map(p=>p.itemId),['11:1','22:1']);assert.equal(plan.sourceUsage[0].barsUsed,1);
  const separated=planInventoryCutting({sources:[source(1,12000,2)],pieces:[piece(11,7000),piece(22,5000)],separateOrders:true});
  assert.equal(separated.bars.length,2);assert.ok(separated.bars.every(bar=>new Set(bar.pieces.map(p=>p.orderId)).size===1));
});
test('does not invent 12m stock or exceed the registered finite count',()=>{
  const plan=planInventoryCutting({sources:[source(6,6000,1),source(12,12000,0)],pieces:[piece(1,8000),piece(2,4000),piece(3,2000),piece(4,1000,3)]});
  assert.equal(plan.complete,false);assert.equal(plan.bars.length,1);assert.equal(plan.bars[0].stockLengthMm,6000);assert.equal(plan.pieceCount,2);
  assert.deepEqual(plan.rejected.map(p=>[p.itemId,p.quantity]),[[1,1],[4,3]]);
  assert.ok(plan.sourceUsage.every(row=>row.barsUsed<=row.count));
});
test('keeps ribbed/smooth, diameters and declared grades and standards separate',()=>{
  const sources=[source(1,6000,1),source(2,6000,1,{material:'smooth'}),source(3,6000,1,{diameter:10})];
  const plan=planInventoryCutting({sources,pieces:[piece(1,2000),piece(2,2000,1,{material:'smooth'}),piece(3,2000,1,{diameter:10})]});
  assert.equal(plan.bars.length,3);assert.ok(plan.bars.every(bar=>new Set(bar.pieces.map(p=>p.material+'|'+p.diameter)).size===1));
  const incompatible=planInventoryCutting({sources:[source(4,6000,1,{grade:'A',standard:'X'})],pieces:[piece(4,2000,1,{grade:'B',standard:'X'})]});assert.equal(incompatible.pieceCount,0);
});
test('single-length preference remains bounded by inventory and chooses the best covered alternative',()=>{
  const plan=planInventoryCutting({sources:[source(1,6000,5),source(2,12000,2)],pieces:[piece(1,8000),piece(2,4000,2)],groupPolicies:{12:{allowMixedStockLengths:false}}});
  assert.equal(plan.complete,true);assert.deepEqual([...new Set(plan.bars.map(bar=>bar.stockLengthMm))],[12000]);
  const only6=planInventoryCutting({sources:[source(1,6000,1),source(2,12000,2)],pieces:[piece(1,8000)],groupPolicies:{12:{stockLengthsMm:[6000]}}});assert.equal(only6.complete,false);
});

test('mixed stock compares short-first and long-first alternatives to avoid needless tails',()=>{
  const plan=planInventoryCutting({sources:[source(1,6000,1),source(2,12000,1)],pieces:[piece(1,5000,2),piece(2,2000)]});
  assert.equal(plan.complete,true);assert.equal(plan.bars.length,1);assert.equal(plan.totalWasteMm,0);
  const unknownSpec=planInventoryCutting({sources:[source(1,6000,1)],pieces:[piece(1,2000,1,{grade:'B500B',standard:'SI4466'})]});
  assert.equal(unknownSpec.pieceCount,0,'missing stock specifications cannot establish compatibility');
});
test('cutting loss includes separation from a reusable tail and conserves all stock length',()=>{
  for(const pieces of [[piece(1,2000,2)],[piece(1,3000),piece(2,2996)],[piece(1,6000)]]){
    const plan=planInventoryCutting({sources:[source(1,6000,1)],pieces,kerfMm:4});
    assert.equal(plan.complete,true);assert.equal(plan.totalStockLengthMm,plan.totalCutLengthMm+plan.totalKerfLossMm+plan.totalWasteMm);
    assert.equal(plan.totalKerfLossMm,pieces.length===1?(pieces[0].quantity===2?8:0):4);
  }
});
test('invalid supply, duplicate lots and excessively large requests fail without inventing a plan',()=>{
  assert.throws(()=>planInventoryCutting({sources:[source(1,6000,1),source(1,6000,1)]}),/מלאי/);
  assert.throws(()=>planInventoryCutting({sources:[source(1,6000,1.5)]}),/מלאי/);
  assert.throws(()=>planInventoryCutting({sources:[source(1,6000,1)],pieces:[piece(1,2000,100001)]}),/100,000/);
});
test('Inventory projects theoretical whole bars separately for 6 and 12m and leaves stored rows intact',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE raw_material(id INTEGER PRIMARY KEY,material_type,active,verification_status,diameter,nominal_length_mm,weight_received,stock_adjustment_kg,weight_used,weight_scrapped,lot_number,grade,standard_code,warehouse_loc,received_date,catalog_item_id);
    CREATE TABLE catalog_items(id INTEGER PRIMARY KEY,name);CREATE TABLE allocation_plan_lines_v2(id,raw_material_id,allocated_kg,allocation_plan_id,status);
    CREATE TABLE allocation_plans_v2(id,material_requirement_id,status);CREATE TABLE material_requirements_v2(id,order_id);
    CREATE TABLE material_consumption_event_lines_v2(consumed_kg,consumption_event_id,allocation_plan_line_id);CREATE TABLE material_consumption_events_v2(id,event_type);`);
  const insert=db.prepare("INSERT INTO raw_material(id,material_type,active,verification_status,diameter,nominal_length_mm,weight_received,stock_adjustment_kg,weight_used,weight_scrapped) VALUES(?,'straight',1,'approved',12,?,?,0,0,0)");
  insert.run(1,6000,53.28);insert.run(2,12000,21.312);insert.run(3,null,50);
  db.exec("INSERT INTO material_requirements_v2 VALUES(1,99);INSERT INTO allocation_plans_v2 VALUES(1,1,'active');INSERT INTO allocation_plan_lines_v2 VALUES(1,1,10.656,1,'active')");
  const before=db.prepare('SELECT * FROM raw_material').all(),result=cuttingStock(db,[1]);
  assert.deepEqual(result.sources.map(s=>s.calculated_bar_count),[8,2,null]);assert.equal(result.sources[0].allocated_to_other_orders_kg,10.656);
  assert.equal(cuttingStock(db,[99]).sources[0].calculated_bar_count,10,'a selected order may use its own allocated stock');
  assert.deepEqual(db.prepare('SELECT * FROM raw_material').all(),before);
});
