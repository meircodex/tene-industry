'use strict';
const {readProductionQueueItems}=require('../productionQueue');
const cards=require('../productionCards');
const {hashEvent}=require('../../contracts/machine-station/v1');
const {assertCardMachine}=require('./automaticConnection');
const {ITEM_STATUS}=require('../../status-contracts');
const fail=(message,status=422)=>{throw Object.assign(Error(message),{status});};
function definitionRevision(item){
 return hashEvent({id:item.id,order:item.order_id,orderNumber:item.order_num,machineId:item.machine_id,machine:item.machine,quantity:item.quantity,
  diameter:item.diameter,shapeId:item.shape_id,shapeName:item.shape_name,shape:item.shape_snapshot_json,segments:item.segments,
  spiralDiameter:item.spiral_diameter_mm,spiralTurns:item.spiral_turns,length:item.total_length_mm});
}
class StationProductionQueue{
 constructor({db}){if(!db)throw Error('STATION_QUEUE_DB_REQUIRED');this.db=db;}
 rows(binding){
  const machine=this.db.prepare('SELECT * FROM machines WHERE id=?').get(binding.central_machine_id);
  if(!machine||machine.retired_at)fail('STATION_MACHINE_UNAVAILABLE',409);
  // Use Production's canonical eligibility, assignment and order. The station
  // never interprets a printed machine number as a database ID.
  const items=readProductionQueueItems(this.db,{machine:machine.name,visual:false});
  return {machine,items};
 }
 readiness(binding,item){
  if(!Number.isSafeInteger(Number(item.quantity))||Number(item.quantity)<1)return{canOpen:false,problemCode:'CARD_QUANTITY_UNRESOLVED',problemHe:'כמות הפריט אינה תקינה'};
  const raw=this.db.prepare('SELECT machine_id,machine FROM items WHERE id=?').get(item.id);
  try{assertCardMachine(this.db,binding,raw);}catch{return {canOpen:false,problemCode:'STATION_CARD_MACHINE_MISMATCH',problemHe:'שיוך המכונה בכרטיס אינו עקבי'};}
  let shape;try{shape=typeof item.shape_snapshot_json==='string'?JSON.parse(item.shape_snapshot_json):item.shape_snapshot_json;}catch{}
  if(!shape?.shapeId||!shape?.shapeVersion||shape.family!=='bars'||!Array.isArray(shape.data?.sides)||!Array.isArray(shape.data?.angles))return{canOpen:false,problemCode:'CARD_SNAPSHOT_UNAVAILABLE',problemHe:'הצורה טרם זמינה לניתוח בתחנה'};
  return {canOpen:true,problemCode:null,problemHe:null};
 }
 entry(binding,item,{svg=true}={}){
  const quantity=Number(item.quantity),produced=Number(item.produced_qty||0);
  return {itemId:Number(item.id),orderId:Number(item.order_id),orderNumber:item.order_num,customerName:item.customer_name||'',shapeName:item.shape_name||'',
   scanToken:cards.itemScanCode(item,item.order_num),quantityScope:'whole_item',quantityPieces:quantity,producedPieces:produced,
   remainingPieces:Number.isFinite(quantity)&&Number.isFinite(produced)?Math.max(0,quantity-produced):null,diameterMm:Number(item.diameter)||null,
   status:item.status,priority:item.priority||null,deliveryDate:item.delivery_date||null,
   revision:definitionRevision(item),...(svg?{shapeSvg:cards.itemShapeSvg(item)}:{}),...this.readiness(binding,item)};
 }
 page(binding,{limit=20,offset=0,q='',diameter='',status=''}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||typeof q!=='string'||q.length>120||/[\x00-\x1f]/.test(q)||
   !['','pending','running'].includes(status)||diameter!==''&&(!Number.isFinite(Number(diameter))||Number(diameter)<=0))fail('INVALID_STATION_QUEUE_FILTER');
  const {machine,items}=this.rows(binding),needle=q.trim().toLocaleLowerCase('he-IL');
  const filtered=items.filter(item=>(!diameter||Number(item.diameter)===Number(diameter))&&(!status||item.status===(status==='running'?ITEM_STATUS.IN_PRODUCTION:ITEM_STATUS.WAITING))&&
   (!needle||[item.id,item.order_num,item.customer_name,item.shape_name,cards.itemScanCode(item,item.order_num)].some(v=>String(v??'').toLocaleLowerCase('he-IL').includes(needle))));
  return {schemaVersion:1,authority:'production_queue',sourceId:binding.source_id,logicalMachineId:binding.logical_machine_id,
   machine:{id:machine.id,name:machine.name,label:machine.label||machine.name},observedAtUtc:new Date().toISOString(),
   revision:hashEvent({machineId:machine.id,items:items.map(i=>({revision:definitionRevision(i),status:i.status,produced:i.produced_qty,priority:i.priority,deliveryDate:i.delivery_date}))}),
   query:{limit,offset,q,diameter:String(diameter),status},total:filtered.length,machineTotal:items.length,
   remainingPieces:filtered.reduce((n,i)=>n+Math.max(0,Number(i.quantity||0)-Number(i.produced_qty||0)),0),
   diameters:[...new Set(items.map(i=>Number(i.diameter)).filter(n=>n>0))].sort((a,b)=>a-b),
   items:filtered.slice(offset,offset+limit).map(i=>this.entry(binding,i))};
 }
 assertEligible(binding,itemId,{scanToken=null,revision=null}={}){
  if(!Number.isSafeInteger(Number(itemId))||Number(itemId)<1)fail('INVALID_STATION_QUEUE_ITEM');
  const {items}=this.rows(binding),item=items.find(i=>Number(i.id)===Number(itemId));
  if(!item)fail('STATION_QUEUE_ITEM_NO_LONGER_AVAILABLE',409);
  const entry=this.entry(binding,item,{svg:false});if(!entry.canOpen)fail(entry.problemCode,409);
  if(scanToken!=null&&scanToken!==entry.scanToken)fail('STATION_QUEUE_CARD_SCOPE_MISMATCH',409);
  if(revision!=null&&revision!==entry.revision)fail('STATION_QUEUE_ITEM_CHANGED',409);
  return entry;
 }
}
module.exports={StationProductionQueue,definitionRevision};
