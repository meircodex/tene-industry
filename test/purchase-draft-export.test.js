'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {exportPurchaseDraft}=require('../services/purchaseDraftExport');
const {suggestedQuantity,defaultUnitWeight,displayKg}=require('../public/purchase-units');

test('editable draft exports exactly the edited quantities and mixed stock units without creating purchases',()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);db.exec("INSERT INTO suppliers(id,name) VALUES(1,'ספק בדיקה')");
  const input={supplier_id:1,expected_date:'2026-11-30',reference:'ברזל לחודש',lines:[{material_type:'coil',diameter:12,quantity:5250,notes:'הכמות שונתה לאחר המלצה'},{material_type:'mesh',quantity:25,specification:'6×2.5 מ׳, Ø8/8, מרווח 200/200'}]};
  const result=exportPurchaseDraft(db,input);
  assert.ok(result.content.startsWith('\uFEFF'));assert.match(result.content,/5250/);assert.match(result.content,/יחידות/);assert.match(result.content,/ספק בדיקה/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_material').get().n,0);db.close();
});
test('export quotes commas/newlines and prevents spreadsheet formula execution',()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);
  const result=exportPurchaseDraft(db,{supplier_name:'=HYPERLINK("https://example.com")',lines:[{material_type:'straight',diameter:12,quantity:100,notes:' \t=1+1',specification:'12m, "A"\nפרט'}]});
  assert.match(result.content,/'=HYPERLINK/);assert.match(result.content,/'=1\+1/);assert.match(result.content,/""A""/);db.close();
});
test('invalid or ambiguous units and missing mesh specification cannot be exported',()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);
  for(const line of [{material_type:'coil',quantity:-1},{material_type:'mesh',quantity:1.5,specification:'mesh'},{material_type:'mesh',quantity:2},{material_type:'unknown',quantity:2}])assert.throws(()=>exportPurchaseDraft(db,{lines:[line]}));
  assert.throws(()=>exportPurchaseDraft(db,{supplier_id:999,lines:[{material_type:'coil',quantity:1}]}),/supplier_not_found/);db.close();
});

test('shortage kg rounds up to supplier rolls and bundles; sheets stay separate',()=>{
  assert.equal(defaultUnitWeight('coil'),1586);
  assert.equal(defaultUnitWeight('straight'),2050);
  assert.equal(suggestedQuantity('coil',7013.52),5);
  assert.equal(suggestedQuantity('coil',1481.564),1);
  assert.equal(suggestedQuantity('straight',4100),2);
  assert.equal(suggestedQuantity('straight',4100.001),3);
  assert.equal(suggestedQuantity('coil',3172.00000000001),2);
  assert.equal(suggestedQuantity('coil',7013.52,2000),4);
  assert.equal(suggestedQuantity('mesh',30),30);
  assert.equal(suggestedQuantity('coil',0),0);
  assert.throws(()=>suggestedQuantity('coil',100,0),/invalid_unit_weight/);
});

test('supplier export preserves edited package quantity and recalculates estimated kg on server',()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);
  const result=exportPurchaseDraft(db,{lines:[
    {material_type:'coil',diameter:12,quantity:5,purchase_unit:'coil',unit_weight_kg:2100,estimated_weight_kg:123,shortage_kg:7013.52},
    {material_type:'straight',diameter:16,specification:'B500B',length_m:12,quantity:1.5,purchase_unit:'bundle',unit_weight_kg:2000},
    {material_type:'mesh',quantity:25,specification:'6x2.5',purchase_unit:'sheet'}
  ]});
  assert.equal(result.draft.lines[0].quantity,5);
  assert.equal(result.draft.lines[0].unit_label,'גלילים');
  assert.equal(result.draft.lines[0].estimated_weight_kg,10500);
  assert.equal(result.draft.lines[0].shortage_kg,7013.52);
  assert.equal(result.draft.lines[1].unit_label,'חבילות');
  assert.equal(result.draft.lines[1].estimated_weight_kg,3000);
  assert.equal(result.draft.lines[1].specification,'B500B');
  assert.equal(result.draft.lines[1].length_m,12);
  assert.match(result.content,/"מפרט","אורך \(מטר\)"/);
  assert.match(result.content,/"B500B","12","1.5","חבילות"/);
  assert.equal(result.draft.lines[2].estimated_weight_kg,null);
  assert.match(result.content,/"5","גלילים","2100","10500","7014"/);
  assert.match(result.content,/"1.5","חבילות","2000","3000"/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_material').get().n,0);
  db.close();
});

test('whole-kg display/export retain precision for calculations and half-bundle quantities',()=>{
  assert.equal(displayKg(8405.52),'8,406');
  assert.equal(displayKg(1481.564),'1,482');
  const db=new Database(':memory:');ensureCoreSchema(db);
  const out=exportPurchaseDraft(db,{lines:[{material_type:'straight',diameter:12,length_m:6,specification:'B500B',quantity:1.5,purchase_unit:'bundle',unit_weight_kg:2050.25,shortage_kg:3000.7}]});
  assert.equal(out.draft.lines[0].estimated_weight_kg,3075.375);
  assert.equal(out.draft.lines[0].shortage_kg,3000.7);
  assert.match(out.content,/"1.5","חבילות","2050","3075","3001"/);
  db.close();
});

test('supplier units reject incompatible material, fractional rolls and invalid or overflowing weight',()=>{
  const db=new Database(':memory:');ensureCoreSchema(db);
  const base={material_type:'coil',diameter:12,quantity:2,purchase_unit:'coil',unit_weight_kg:2050};
  for(const change of [{purchase_unit:'bundle'},{purchase_unit:false},{purchase_unit:''},{quantity:1.5},{unit_weight_kg:0},{unit_weight_kg:false},{unit_weight_kg:Infinity},{unit_weight_kg:1e-6},{quantity:1e9}])assert.throws(()=>exportPurchaseDraft(db,{lines:[{...base,...change}]}));
  assert.throws(()=>exportPurchaseDraft(db,{lines:[{...base,material_type:'straight',purchase_unit:'bundle',quantity:1.3}]}),/invalid_purchase_quantity/);
  assert.throws(()=>exportPurchaseDraft(db,{lines:[{material_type:'mesh',quantity:2,purchase_unit:'kg',specification:'mesh'}]}),/invalid_purchase_unit/);
  db.close();
});
