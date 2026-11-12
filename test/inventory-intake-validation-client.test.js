'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/inventory.html'),'utf8');
const normalize=html.slice(html.indexOf('function normalizeDiameterText'),html.indexOf('async function loadMaterialCatalogChoices'));
const validation=html.slice(html.indexOf('function clearBatchValidation'),html.indexOf('// ── INIT ─'));
function harness(changes={}){
 const nodes=new Map(),requests=[],refreshes=[];let focus=null;
 function element(id){const classes=new Set(),attrs={};return {id,value:'',textContent:'',className:'',classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)},setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k],attrs,addEventListener(){},focus(){focus=id;},insertAdjacentElement(_position,node){nodes.set(node.id,node);}};}
 function node(id){if(!nodes.has(id)&&!id.endsWith('Error'))nodes.set(id,element(id));return nodes.get(id)||null;}
 const document={getElementById:node,createElement:()=>element(''),querySelectorAll:selector=>[...nodes.values()].filter(n=>selector.includes('invalid')?n.classList.contains('batch-field-invalid'):n.className==='batch-field-error')};
 for(const [id,value]of Object.entries({bDiameter:'12',bType:'coil',bWeight:'60606',...changes}))node(id).value=value;
 const ctx={document,window:{InventoryCounts:{loadReceipts:async()=>refreshes.push("receipts")}},editingBatchId:null,bendingShapeSource:'manual',diameterCatalogRows:[{diameter_key:'12',status:'active'}],parseBendingShapeSegments:()=>[],IronBendDisplayUnits:{centimetersToMillimeters:()=>null},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({status:'draft',verification_status:'pending_receipt'})};},confirm:()=>{throw Error('Unexpected popup');},alert:()=>{throw Error('Unexpected popup');},closeBatchModal(){},loadSummary(){},loadBatches(){}};
 vm.createContext(ctx);vm.runInContext(normalize+validation,ctx);return {ctx,node,requests,refreshes,focus:()=>focus};
}
test('only diameter type and positive weight block save, with inline red errors and no request or popup',async()=>{
 for(const [id,value]of [['bDiameter',''],['bDiameter','abc'],['bType',''],['bType','invalid'],['bWeight',''],['bWeight','-1'],['bWeight','0']]){
  const h=harness({[id]:value});await h.ctx.saveBatch();assert.equal(h.requests.length,0);assert.equal(h.node(id).attrs['aria-invalid'],'true');assert.equal(h.focus(),id);assert.ok(h.node(id+'Error').textContent.length>0);
 }
});
test('empty optional catalog supplier certificate and shape data do not block a valid receipt',async()=>{
 const h=harness();await h.ctx.saveBatch();assert.equal(h.requests.length,1);assert.deepEqual(h.refreshes,['receipts']);const body=JSON.parse(h.requests[0].options.body);assert.equal(body.catalog_item_id,null);assert.equal(body.material_type,'coil');assert.equal(body.weight_received,60606);
});
