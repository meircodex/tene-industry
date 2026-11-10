'use strict';
const {kg,materialOnHand}=require('./materialBalance');
const {itemShapeMetrics,parseJsonObject}=require('./shapeSnapshot');
const DONE=new Set(['הושלם','הועמס','נשלח','סופק']);
const utc=value=>Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(String(value))?value:String(value).replace(' ','T')+'Z');
function policy(db) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='inventory_item_completion_policy'").get())return null;
  return db.prepare('SELECT * FROM inventory_item_completion_policy WHERE id=1').get()||null;
}
function itemRecord(db,id){return db.prepare(`SELECT i.*,COALESCE(i.order_id,p.order_id) owner_order_id,o.created_at order_created_at,o.status order_status,o.inventory_lifecycle_version
  FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id JOIN orders o ON o.id=COALESCE(i.order_id,p.order_id) WHERE i.id=?`).get(id);}
function eligibility(db,item){
  const rule=policy(db);
  if(!rule)return 'policy_not_configured';
  if(!item || ['בוטל','cancelled','canceled'].includes(item.order_status)||item.status==='בוטל')return 'cancelled_or_missing';
  if(db.prepare('SELECT 1 FROM inventory_count_completed_items WHERE item_id=?').get(item.id))return 'completed_before_count';
  if(!Number.isFinite(utc(item.order_created_at))||utc(item.order_created_at)<utc(rule.eligible_from))return 'created_before_lookback';
  if(!DONE.has(item.status))return 'production_incomplete';
  if(!Number.isFinite(utc(item.completed_at)))return 'completion_time_missing';
  if(utc(item.completed_at)<=utc(rule.counted_at))return 'completed_before_count';
  return null;
}
function activatePolicy(db,{stocktake_id,completed_item_ids=[]}){
  return db.transaction(()=>{
    const prior=policy(db);if(prior){if(prior.stocktake_id!==stocktake_id)throw Error('policy_already_configured');return prior;}
    const count=db.prepare('SELECT * FROM inventory_stocktakes WHERE id=?').get(stocktake_id);
    if(!count||!Number.isFinite(utc(count.counted_at)))throw Error('physical_count_required');
    db.prepare('INSERT INTO inventory_item_completion_policy(id,stocktake_id,counted_at,eligible_from) VALUES(1,?,?,?)').run(count.id,count.counted_at,new Date(utc(count.counted_at)-7*86400000).toISOString());
    const insert=db.prepare('INSERT INTO inventory_count_completed_items(item_id,stocktake_id) VALUES(?,?)');
    for(const id of new Set(completed_item_ids))insert.run(id,count.id);
    return policy(db);
  }).immediate();
}
function state(db,itemId){return db.prepare('SELECT * FROM inventory_item_completion_state WHERE item_id=?').get(itemId);}
function movement(db,item,lines,{key,reason,actorId}){
  if(db.prepare('SELECT 1 FROM inventory_item_completion_events WHERE event_key=?').get(key))return false;
  for(const line of lines){
    const changed=db.prepare('UPDATE raw_material SET weight_used=ROUND(weight_used+?,3) WHERE id=? AND ROUND(weight_used+?,3)>=0').run(line.weight_used,line.raw_material_id,line.weight_used);
    if(!changed.changes)throw Error('inventory_reversal_exceeds_recorded_usage');
    db.prepare("INSERT INTO raw_material_usage(raw_material_id,order_id,item_id,weight_used,allocation_policy) VALUES(?,?,?,?,'item_completion_reconciliation')").run(line.raw_material_id,item.owner_order_id,item.id,line.weight_used);
  }
  db.prepare('INSERT INTO inventory_item_completion_events(event_key,item_id,order_id,delta_kg,allocations_json,reason,actor_id) VALUES(?,?,?,?,?,?,?)').run(key,item.id,item.owner_order_id,kg(lines.reduce((n,l)=>n+l.weight_used,0)),JSON.stringify(lines),reason,actorId??null);
  return true;
}
function pending(db,item,reason,details={}){
  const label={insufficient_stock:'אין מספיק חומר מתאים',missing_reservation:'חסר שיוך חומר לפריט',length_requires_review:'יש לבדוק את אורך הליפט',unreconciled_usage:'יש לבדוק צריכת חומר שכבר נרשמה',completion_time_missing:'חסר מועד השלמת ייצור'}[reason]||'נתוני הפריט דורשים בדיקה';
  const message=`צריכת מלאי ממתינה: הזמנה ${item.owner_order_id}, פריט ${item.id}: ${label}`;
  if(!db.prepare("SELECT 1 FROM alerts WHERE type='inventory_consumption_pending' AND order_id=? AND message=? AND resolved=0").get(item.owner_order_id,message))db.prepare("INSERT INTO alerts(type,level,message,order_id) VALUES('inventory_consumption_pending','warning',?,?)").run(message,item.owner_order_id);
  return {consumed:0,pending:{item_id:item.id,reason,...details}};
}
function consumeItem(db,{item_id,actual_weight_kg,reason='השלמת ייצור פריט',actor_id,strict=false}={}){
  return db.transaction(()=>{
    const item=itemRecord(db,item_id),blocked=eligibility(db,item);
    if(blocked)return blocked==='completion_time_missing'?pending(db,item,blocked):{consumed:0,reason:blocked};
    if(Number(item.inventory_lifecycle_version)===2)return {consumed:0,reason:'v2_requires_approved_consumption_report'};
    const reservation=db.prepare("SELECT * FROM inventory_reservations WHERE item_id=? AND order_id=? AND status IN ('active','consumed') ORDER BY id DESC LIMIT 1").get(item.id,item.owner_order_id);
    if(!reservation)return pending(db,item,'missing_reservation');
    const amount=kg(actual_weight_kg??reservation.pending_actual_kg??item.actual_weight_kg??itemShapeMetrics(item).totalWeightKg??reservation.reserved_kg);
    if(!Number.isFinite(amount)||amount<0)throw Error('invalid_actual_weight');
    const metrics=itemShapeMetrics(item),shape=parseJsonObject(item.shape_snapshot_json);
    const identity={diameter:Number(reservation.diameter),material_type:reservation.material_type,length_mm:reservation.material_type==='straight'?Number(metrics.totalLengthMm):null,preferred_raw_material_id:reservation.preferred_raw_material_id||null};
    if(identity.material_type==='straight'&&(!identity.length_mm||shape?.family!=='lifts'))return pending(db,item,'length_requires_review');
    const prior=state(db,item.id),identityJson=JSON.stringify(identity);
    if(prior&&prior.consumed_kg===amount&&prior.identity_json===identityJson){db.prepare("UPDATE inventory_reservations SET status='consumed' WHERE id=?").run(reservation.id);return {consumed:0,reason:'already_consumed'};}
    const save=db.transaction(()=>{
      let previous=prior;
      // Adopt a verified post-count completion from the previous software once.
      // Unknown usage is never silently credited or returned as raw material.
      if(!previous){
        const usage=db.prepare(`SELECT u.* FROM raw_material_usage u WHERE u.item_id=? AND u.order_id=? AND julianday(u.used_at)>julianday(?)`).all(item.id,item.owner_order_id,policy(db).counted_at);
        if(usage.length){
          if(usage.some(u=>u.allocation_policy!=='production_completion'))throw Object.assign(Error('unreconciled_usage'),{pendingReason:'unreconciled_usage'});
          previous={consumed_kg:kg(usage.reduce((n,u)=>n+u.weight_used,0)),identity_json:identityJson,allocations_json:JSON.stringify(usage.map(u=>({raw_material_id:u.raw_material_id,weight_used:u.weight_used}))),revision:0};
        }
      }
      const revision=(previous?.revision||0)+1,key=`item:${item.id}:revision:${revision}`;
      if(previous){
        const returns=JSON.parse(previous.allocations_json).map(l=>({...l,weight_used:-l.weight_used}));
        movement(db,item,returns,{key:key+':return',reason,actorId:actor_id});
      }
      const allocations=[];let remaining=amount;
      const lots=db.prepare(`SELECT * FROM raw_material WHERE active=1 AND COALESCE(verification_status,'approved')='approved' AND diameter=? AND COALESCE(material_type,'coil')=? ORDER BY COALESCE(received_date,created_at),id`).all(identity.diameter,identity.material_type);
      for(const lot of lots){
        if(remaining<=0)break;
        if(identity.preferred_raw_material_id&&Number(identity.preferred_raw_material_id)!==lot.id)continue;
        if(identity.length_mm&&Number(lot.nominal_length_mm)!==identity.length_mm)continue;
        const {activeAllocatedForLot}=require('./materialAllocationPlanningV2');
        const free=Math.max(0,kg(materialOnHand(lot)-activeAllocatedForLot(db,lot.id))),take=kg(Math.min(remaining,free));
        if(take>0){allocations.push({raw_material_id:lot.id,weight_used:take});remaining=kg(remaining-take);}
      }
      if(remaining>0)throw Object.assign(Error('insufficient_stock'),{pendingReason:'insufficient_stock',missing_kg:remaining});
      movement(db,item,allocations,{key,reason,actorId:actor_id});
      db.prepare(`INSERT INTO inventory_item_completion_state(item_id,order_id,consumed_kg,identity_json,allocations_json,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET consumed_kg=excluded.consumed_kg,identity_json=excluded.identity_json,allocations_json=excluded.allocations_json,revision=excluded.revision`).run(item.id,item.owner_order_id,amount,identityJson,JSON.stringify(allocations),revision);
      db.prepare("UPDATE inventory_reservations SET status='consumed',reserved_kg=?,pending_actual_kg=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(amount,reservation.id);
      db.prepare("UPDATE alerts SET resolved=1 WHERE type='inventory_consumption_pending' AND order_id=? AND message LIKE ?").run(item.owner_order_id,`צריכת מלאי ממתינה: הזמנה ${item.owner_order_id}, פריט ${item.id}:%`);
      return {consumed:1,consumed_kg:kg(amount-(previous?.consumed_kg||0)),allocations};
    });
    try{return save();}catch(error){
      if(!error.pendingReason||strict)throw error;
      db.prepare('UPDATE inventory_reservations SET pending_actual_kg=? WHERE id=?').run(amount,reservation.id);
      return pending(db,item,error.pendingReason,error.missing_kg?{missing_kg:error.missing_kg}:{});
    }
  }).immediate();
}
// Called only by the authorized, reasoned erroneous-production correction flow.
// A real cancellation leaves this raw-material consumption intact.
function returnErroneousProduction(db,{itemId,ratio,eventKey,reason,actorId}){
  if(!policy(db))return {returned_kg:0};
  return db.transaction(()=>{
    const previous=state(db,itemId);if(!previous)return {returned_kg:0};
    if(!reason||!eventKey||!Number.isFinite(ratio)||ratio<0||ratio>1)throw Error('invalid_inventory_correction');
    if(db.prepare('SELECT 1 FROM inventory_item_completion_events WHERE event_key=?').get(eventKey))return {returned_kg:0};
    const item=itemRecord(db,itemId),old=JSON.parse(previous.allocations_json),returned=old.map(l=>({...l,weight_used:-kg(l.weight_used*ratio)}));
    movement(db,item,returned,{key:eventKey,reason,actorId});
    const remaining=old.map((l,i)=>({...l,weight_used:kg(l.weight_used+returned[i].weight_used)}));
    const weight=kg(remaining.reduce((n,l)=>n+l.weight_used,0));
    db.prepare('UPDATE inventory_item_completion_state SET consumed_kg=?,allocations_json=?,revision=revision+1 WHERE item_id=?').run(weight,JSON.stringify(remaining),itemId);
    return {returned_kg:kg(previous.consumed_kg-weight)};
  }).immediate();
}
function exemptHistoricalItems(db,{item_ids,reason}){
  if(!reason||!Array.isArray(item_ids))throw Error('historical_inventory_exemption_reason_required');
  const rule=policy(db);if(!rule)return {exempted:0};
  const insert=db.prepare('INSERT OR IGNORE INTO inventory_count_completed_items(item_id,stocktake_id) VALUES(?,?)');
  let exempted=0;for(const id of new Set(item_ids))exempted+=insert.run(id,rule.stocktake_id).changes;
  return {exempted};
}
module.exports={policy,activatePolicy,eligibility,itemRecord,consumeItem,state,returnErroneousProduction,exemptHistoricalItems};
