'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {exportPurchaseDraft}=require('../services/purchaseDraftExport');

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
