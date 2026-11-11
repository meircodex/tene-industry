'use strict';

const crypto=require('node:crypto');
const {calculateMesh}=require('../modules/steel-rebar/shapes');
function meshCalculation(spec) {
 return calculateMesh({length:spec.length_mm,width:spec.width_mm,longitudinalDiameter:spec.longitudinal_diameter_mm,transverseDiameter:spec.transverse_diameter_mm,longitudinalSpacing:spec.longitudinal_spacing_mm,transverseSpacing:spec.transverse_spacing_mm,edgeLeft:spec.edge_left_mm||0,edgeRight:spec.edge_right_mm||0,edgeTop:spec.edge_top_mm||0,edgeBottom:spec.edge_bottom_mm||0,longitudinalBarCount:spec.longitudinal_bar_count,transverseBarCount:spec.transverse_bar_count,countingConfirmed:spec.counting_confirmed===true});
}
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:409});};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function meshSpecification(input={}) {
  const spec={};
  for(const name of ['length_mm','width_mm','longitudinal_diameter_mm','transverse_diameter_mm','longitudinal_spacing_mm','transverse_spacing_mm']) {
    if(input[name]===null||input[name]===''||typeof input[name]==='boolean')fail(`invalid_mesh_${name}`);
    const n=Number(input[name]);if(!Number.isFinite(n)||n<=0)fail(`invalid_mesh_${name}`);spec[name]=n;
  }
  spec.grade=String(input.grade||'').trim();spec.standard_code=String(input.standard_code||'').trim();
  const edges={};for(const key of ['edge_left_mm','edge_right_mm','edge_top_mm','edge_bottom_mm']){
    const value=Number(input[key]??0);if(!Number.isFinite(value)||value<0)fail('invalid_mesh_'+key);edges[key]=value;
  }
  if(edges.edge_left_mm+edges.edge_right_mm>=spec.length_mm||edges.edge_top_mm+edges.edge_bottom_mm>=spec.width_mm)fail('invalid_mesh_edges');
  if(Object.values(edges).some(v=>v!==0))Object.assign(spec,edges);
  for(const key of ['longitudinal_bar_count','transverse_bar_count'])if(input[key]!=null)spec[key]=units(input[key]);
  const specification_key=hash(spec);
  if(input.counting_confirmed===true)spec.counting_confirmed=true;
  if(input.calculation?.calculationVersion==='mesh-count-v2')spec.calculation=input.calculation;
  return {specification:spec,specification_key};
}
function units(value,{zero=false}={}) {if(value===null||value===''||typeof value==='boolean')fail('invalid_mesh_quantity');const n=Number(value);if(!Number.isSafeInteger(n)||n<(zero?0:1)||n>1e7)fail('invalid_mesh_quantity');return n;}
function receiptDraft(db,input) {
  const spec=meshSpecification(input.specification),quantity=units(input.quantity_units),key=String(input.idempotency_key||'').trim();
  if(!key)fail('idempotency_key_required');
  const calculation=meshCalculation(spec.specification).calculated;
  if(!calculation.countingVerified)fail('mesh_bar_count_confirmation_required');
  spec.specification.calculation=calculation;
  const payload={...spec,quantity_units:quantity,supplier_id:input.supplier_id||null,delivery_note_num:input.delivery_note_num||null};
  return db.transaction(()=>{
    const replay=db.prepare('SELECT * FROM inventory_mesh_receipts WHERE idempotency_key=?').get(key);
    if(replay){if(replay.payload_fingerprint!==hash(payload))fail('idempotency_key_conflict');return replay;}
    const id=db.prepare('INSERT INTO inventory_mesh_receipts(idempotency_key,payload_fingerprint,specification_key,specification_json,quantity_units,supplier_id,delivery_note_num,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(key,hash(payload),spec.specification_key,JSON.stringify(spec.specification),quantity,payload.supplier_id,payload.delivery_note_num,input.actor_id||null).lastInsertRowid;
    return db.prepare('SELECT * FROM inventory_mesh_receipts WHERE id=?').get(id);
  }).immediate();
}
function stock(db,spec) {
  db.prepare('INSERT OR IGNORE INTO inventory_mesh_stock(specification_key,specification_json) VALUES(?,?)').run(spec.specification_key,JSON.stringify(spec.specification));
  return db.prepare('SELECT * FROM inventory_mesh_stock WHERE specification_key=?').get(spec.specification_key);
}
function approveReceipt(db,input) {
  return db.transaction(()=>{
    const receipt=db.prepare('SELECT * FROM inventory_mesh_receipts WHERE id=?').get(Number(input.receipt_id));if(!receipt)fail('mesh_receipt_not_found');
    if(receipt.status==='approved')return receipt;
    if(receipt.status!=='draft')fail('draft_mesh_receipt_required');
    const same=db.prepare("SELECT id FROM inventory_mesh_receipts WHERE status='approved' AND supplier_id IS ? AND delivery_note_num=? AND specification_key=? AND id<>?").get(receipt.supplier_id,receipt.delivery_note_num,receipt.specification_key,receipt.id);
    if(same&&input.confirm_duplicate!==true)fail('duplicate_confirmation_required');
    stock(db,{specification_key:receipt.specification_key,specification:JSON.parse(receipt.specification_json)});
    movement(db,{key:`receipt:${receipt.id}`,type:'receipt',specKey:receipt.specification_key,delta:receipt.quantity_units,actor:input.actor_id,reason:`תעודת ספק ${receipt.delivery_note_num||receipt.id}`});
    db.prepare("UPDATE inventory_mesh_receipts SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP WHERE id=?").run(input.actor_id,receipt.id);
    return db.prepare('SELECT * FROM inventory_mesh_receipts WHERE id=?').get(receipt.id);
  }).immediate();
}
function movement(db,{key,type,specKey,delta,actor,reason,sourceItemId=null}) {
  const current=db.prepare('SELECT * FROM inventory_mesh_stock WHERE specification_key=?').get(specKey);
  if(!current||current.quantity_units+delta<0)fail('insufficient_mesh_stock');
  db.prepare('INSERT INTO inventory_mesh_movements(event_key,event_type,specification_key,delta_units,before_units,actor_id,reason,source_item_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(key,type,specKey,delta,current.quantity_units,actor||null,reason,sourceItemId);
  db.prepare('UPDATE inventory_mesh_stock SET quantity_units=quantity_units+?,revision=revision+1 WHERE specification_key=?').run(delta,specKey);
}
function previewCount(db,input) {
  const spec=meshSpecification(input.specification),quantity=units(input.counted_units,{zero:true});
  const row=db.prepare('SELECT * FROM inventory_mesh_stock WHERE specification_key=?').get(spec.specification_key);
  if(!row)fail('mesh_stock_not_found');
  return {...spec,counted_units:quantity,expected_units:row.quantity_units,adjustment_units:quantity-row.quantity_units,preview_token:hash({row,quantity})};
}
function approveCount(db,input) {
  const key=String(input.idempotency_key||'').trim(),reason=String(input.reason||'').trim();if(!key||!reason)fail('count_reason_and_key_required');
  return db.transaction(()=>{
    const replay=db.prepare('SELECT * FROM inventory_mesh_movements WHERE event_key=?').get(`count:${key}`);
    const preview=previewCount(db,input);
    if(replay){if(replay.reason!==reason||replay.specification_key!==preview.specification_key||replay.before_units+replay.delta_units!==preview.counted_units)fail('idempotency_key_conflict');return replay;}
    if(preview.preview_token!==input.preview_token)fail('stocktake_preview_stale');
    movement(db,{key:`count:${key}`,type:'stocktake',specKey:preview.specification_key,delta:preview.adjustment_units,actor:input.actor_id,reason});
    return db.prepare('SELECT * FROM inventory_mesh_movements WHERE event_key=?').get(`count:${key}`);
  }).immediate();
}
function reserveMesh(db,{order_id,item_id,specification,quantity_units}) {
  const spec=meshSpecification(specification),quantity=units(quantity_units);
  const order=db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(order_id);
  if(!order||Number(order.inventory_lifecycle_version)!==1)fail('mesh_order_workflow_required');
  const prior=db.prepare("SELECT * FROM inventory_mesh_demands WHERE order_id=? AND item_id=? AND status IN ('active','consumed')").get(order_id,item_id);
  if(prior){if(prior.status==='consumed'&&prior.specification_key===spec.specification_key&&prior.quantity_units===quantity)return spec;fail('mesh_item_already_reserved_or_consumed');}
  db.prepare('INSERT INTO inventory_mesh_demands(order_id,item_id,specification_key,specification_json,quantity_units) VALUES(?,?,?,?,?)').run(order_id,item_id,spec.specification_key,JSON.stringify(spec.specification),quantity);
  return spec;
}
function consumeMesh(db,input) {return db.transaction(()=>consumeMeshRows(db,input)).immediate();}
function consumeMeshRows(db,{orderId,itemIds=[]}) {
  const rows=db.prepare("SELECT * FROM inventory_mesh_demands WHERE status='active'").all().filter(row=>(!orderId||row.order_id===orderId)&&(!itemIds.length||itemIds.includes(row.item_id)));
  let consumed=0;const pending=[];
  for(const row of rows) {
    const lot=db.prepare('SELECT * FROM inventory_mesh_stock WHERE specification_key=?').get(row.specification_key);
    if(!lot||lot.quantity_units<row.quantity_units) {
      const message=`צריכת רשתות ממתינה: פריט ${row.item_id}, חסרות ${row.quantity_units-(lot?.quantity_units||0)} רשתות`;
      if(!db.prepare("SELECT id FROM alerts WHERE type='inventory_consumption_pending' AND message=? AND resolved=0").get(message))db.prepare("INSERT INTO alerts(type,level,message,order_id) VALUES('inventory_consumption_pending','warning',?,?)").run(message,row.order_id);
      pending.push({item_id:row.item_id,missing_units:row.quantity_units-(lot?.quantity_units||0)});continue;
    }
    db.prepare("UPDATE alerts SET resolved=1 WHERE type='inventory_consumption_pending' AND order_id=? AND message LIKE ?").run(row.order_id,`צריכת רשתות ממתינה: פריט ${row.item_id},%`);
    movement(db,{key:`completion:${row.id}`,type:'consumption',specKey:row.specification_key,delta:-row.quantity_units,sourceItemId:row.item_id,reason:'דיווח השלמת פריט'});
    db.prepare("UPDATE inventory_mesh_demands SET status='consumed' WHERE id=?").run(row.id);consumed++;
  }
  return {consumed,pending};
}
function planMesh(db,{through_date}={}) {
  const groups=new Map();const get=row=>{
    if(!groups.has(row.specification_key))groups.set(row.specification_key,{specification_key:row.specification_key,specification:JSON.parse(row.specification_json),material_type:'mesh',stock_unit:'units',physical_units:0,required_units:0,incoming_units:0});return groups.get(row.specification_key);
  };
  for(const row of db.prepare('SELECT * FROM inventory_mesh_stock ORDER BY specification_key').all())get(row).physical_units=row.quantity_units;
  for(const row of db.prepare("SELECT d.*,o.delivery_date FROM inventory_mesh_demands d JOIN orders o ON o.id=d.order_id WHERE d.status='active' AND o.deleted_at IS NULL AND o.status NOT IN ('בוטל','בוטלה','cancelled','canceled')").all())if(!through_date||!row.delivery_date||row.delivery_date<=through_date)get(row).required_units+=row.quantity_units;
  const {CONFIRMED_INCOMING}=require('./inventoryPlanning');
  for(const row of db.prepare("SELECT * FROM purchase_orders WHERE material_type='mesh' AND specification_key IS NOT NULL").all()) {
    if(!CONFIRMED_INCOMING.has(String(row.status||'').toLowerCase())||row.received_at)continue;
    if(through_date&&(!row.expected_date||row.expected_date>through_date))continue;
    get(row).incoming_units+=Math.max(0,Number(row.quantity_units||0)-Number(row.received_units||0));
  }
  return [...groups.values()].map(row=>({...row,available_units:row.physical_units-row.required_units,recommended_purchase_units:Math.max(0,row.required_units-row.physical_units-row.incoming_units)}));
}
function previewMesh(db,items){
  const requested=new Map();
  for(const item of items){
    const metrics=require('./meshOrder').metrics(item);if(!metrics)continue;
    const spec=meshSpecification(metrics.specification),quantity=units(item.quantity??item.qty??1);
    if(!requested.has(spec.specification_key))requested.set(spec.specification_key,{...spec,required_units:0});
    requested.get(spec.specification_key).required_units+=quantity;
  }
  return [...requested.values()].map(row=>{
    const physical=db.prepare('SELECT quantity_units FROM inventory_mesh_stock WHERE specification_key=?').get(row.specification_key)?.quantity_units||0;
    const reserved=db.prepare("SELECT COALESCE(SUM(d.quantity_units),0) n FROM inventory_mesh_demands d JOIN orders o ON o.id=d.order_id WHERE d.specification_key=? AND d.status='active' AND o.deleted_at IS NULL AND o.status NOT IN ('בוטל','בוטלה','cancelled','canceled')").get(row.specification_key).n;
    return {...row,physical_units:physical,reserved_units:reserved,available_units:physical-reserved,shortage_units:Math.max(0,row.required_units-Math.max(0,physical-reserved))};
  });
}
// Only an explicit erroneous-production correction may return issued sheets.
function returnErroneousMesh(db,{itemId,quantity,eventKey,reason,actorId}) {
 return db.transaction(()=>{
  const row=db.prepare("SELECT * FROM inventory_mesh_demands WHERE item_id=? AND status='consumed' ORDER BY id DESC LIMIT 1").get(itemId);
  if(!row)return {returned_units:0};
  if(!eventKey||!String(reason||'').trim())fail('invalid_mesh_correction');
  const amount=units(quantity);
  if(db.prepare('SELECT 1 FROM inventory_mesh_movements WHERE event_key=?').get(eventKey))return {returned_units:0};
  const remaining=-db.prepare("SELECT COALESCE(SUM(delta_units),0) n FROM inventory_mesh_movements WHERE source_item_id=? AND specification_key=? AND event_type IN ('consumption','production_record_correction')").get(itemId,row.specification_key).n;
  if(amount>remaining)fail('mesh_correction_exceeds_issued');
  movement(db,{key:eventKey,type:'production_record_correction',specKey:row.specification_key,delta:amount,sourceItemId:itemId,actor:actorId,reason});
  return {returned_units:amount};
 }).immediate();
}
function releaseMeshDemand(db,itemId){return db.prepare("UPDATE inventory_mesh_demands SET status='released' WHERE item_id=? AND status='active'").run(itemId).changes;}
module.exports={returnErroneousMesh,releaseMeshDemand,meshCalculation,meshSpecification,receiptDraft,approveReceipt,previewCount,approveCount,reserveMesh,consumeMesh,planMesh,previewMesh};
