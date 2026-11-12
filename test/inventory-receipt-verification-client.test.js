'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness({role='admin',confirmed=true,fail=false}={}){
  const nodes=new Map(),calls=[],confirmations=[],edits=[];let refreshes=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,handlers:{},style:{},insertAdjacentHTML(){},addEventListener(event,handler){this.handlers[event]=handler;}});return nodes.get(id);};
  let pending=[{id:25,material_type:'coil',diameter:12,weight_received:60606,catalog_item_id:null,grade:'B500B'}];
  const window={IronBendAuth:{currentUser:()=>({role})},InventoryWorkspace:{escape:value=>String(value??'').replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;'),api:async(url,body)=>{
    calls.push({url,body});if(url==='/api/inventory/pending-verification')return pending;
    if(url==='/api/inventory/25/approve-verification'){if(fail)throw new Error('בדיקת שגיאה');pending=[];return {success:true};}return [];
  }}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/inventory-counts.js'),'utf8'),{receiptReviews:[],window,document:{getElementById:node,body:{insertAdjacentHTML(){}}},location:{hash:''},crypto:{randomUUID:()=> 'test-key'},confirm:message=>{confirmations.push(message);return confirmed;},editBatch:(id,row)=>edits.push({id,row}),validateBatchFields(){},alert(){},renderReceiptReview(){},showReceiptSource(){},showTab(){},loadSummary:async()=>{refreshes++;}});
  return {node,window,calls,confirmations,edits,refreshes:()=>refreshes};
}
test('held receipt remains visible and opens its original lot for correction without stock writes or popups',async()=>{
 const h=harness();await h.window.InventoryCounts.loadReceipts();assert.equal(h.node('inventoryVerificationNotice').hidden,false);
 assert.match(h.node('receiptReviewList').innerHTML,/קוטר 12/);assert.match(h.node('receiptReviewList').innerHTML,/60,606/);
 await h.node('receiptReviewList').handlers.click({target:{closest:()=>({dataset:{verifyLot:'25'}})}});
 assert.equal(h.edits[0].id,25);assert.equal(h.calls.some(call=>call.body!==undefined),false);assert.equal(h.confirmations.length,0);
});
test('warehouse staff do not call the manager-only verification endpoint',async()=>{
 const h=harness({role:'warehouse'});await h.window.InventoryCounts.loadReceipts();assert.equal(h.calls.some(call=>call.url==='/api/inventory/pending-verification'),false);
});
