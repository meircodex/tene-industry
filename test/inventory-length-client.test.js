'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const purchaseUnits=require('../public/purchase-units');
test('inventory displays both length rows and estimated counts, and draft carries each length independently',async()=>{
 const nodes=new Map();
 const node=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',checked:false,dataset:{},handlers:{},classList:{add(){},remove(){}},querySelector(){return null;},addEventListener(name,fn){this.handlers[name]=fn;}});
  return nodes.get(id);
 };
 const plan={groups:[
  {material_type:'straight',diameter:12,nominal_length_mm:6000,physical_stock_kg:2050,estimated_bar_count:384,backlog_kg:3000,available_stock_kg:-950,incoming_kg:0,recommended_purchase_kg:950},
  {material_type:'straight',diameter:12,nominal_length_mm:12000,physical_stock_kg:0,estimated_bar_count:0,backlog_kg:4000,available_stock_kg:-4000,incoming_kg:0,recommended_purchase_kg:4000},
 ],purchase_policy:{types:[]}};
 const window={IronBendPurchaseUnits:purchaseUnits,addEventListener(){}};
 const document={getElementById:node,querySelectorAll:()=>[],addEventListener(){}};
 const fetch=async url=>({ok:true,json:async()=>url.startsWith('/api/procurement/plan')?plan:[]});
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/inventory-workspace.js'),'utf8'),{window,document,fetch,URLSearchParams});
 node('inventoryType').value='straight';node('inventoryStockBasisSelect').value='available';
 await window.InventoryWorkspace.reload();
 const table=node('inventoryDailyRows').innerHTML;
 assert.match(table,/<td>6<\/td>/);assert.match(table,/<td>12<\/td>/);assert.match(table,/≈ 384/);assert.match(table,/≈ 0/);
 assert.equal((table.match(/<tr(?:\s|>)/g)||[]).length,2);assert.equal((table.match(/<td(?:\s|>)/g)||[]).length,16);
 await node('inventoryPurchase').handlers.click();
 const draft=node('purchaseDraftRows').innerHTML;
 const lines=[...draft.matchAll(/<tr data-draft-index="\d+">([\s\S]*?)<\/tr>/g)].map(m=>m[1]);
 assert.match(lines[0],/data-field="length_m"[^>]*value="6"/);
 assert.match(lines[1],/data-field="length_m"[^>]*value="12"/);
 assert.match(lines[0],/data-field="diameter"[^>]*value="12"/);
 assert.match(lines[1],/data-field="diameter"[^>]*value="12"/);
});
