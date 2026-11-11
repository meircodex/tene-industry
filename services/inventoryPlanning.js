'use strict';

const { kg, materialOnHand } = require('./materialBalance');
const {nominalLength,itemLength,purchaseLength,barEstimate}=require('./inventoryPlanningLength');
const CONFIRMED_INCOMING = new Set(['approved','transit','ordered','מאושר','מאושרת','הוזמן','בדרך']);
function planInventory(db,input={}) {
  const mode=input.mode || 'backlog';
  if (!['backlog','reorder'].includes(mode)) throw new Error('invalid_planning_mode');
  const percent=Number(input.waste_percent ?? 0), safety=Number(input.safety_stock_kg ?? 0);
  if (!Number.isFinite(percent)||percent<0||percent>100||!Number.isFinite(safety)||safety<0) throw new Error('invalid_planning_allowance');
  const through=input.through_date || null;
  if (through && (!/^\d{4}-\d{2}-\d{2}$/.test(through)||new Date(through).toISOString().slice(0,10)!==through)) throw new Error('invalid_through_date');
  const groups=new Map();
  const group=(diameter,type,length)=>{
    const lengthMm=nominalLength(type,length),key=`${Number(diameter)}|${type||'coil'}|${lengthMm??''}`;
    if (!groups.has(key)) groups.set(key,{diameter:Number(diameter),material_type:type||'coil',nominal_length_mm:lengthMm,physical_stock_kg:0,backlog_kg:0,incoming_kg:0,legacy_preallocated_kg:0,undated_demand_kg:0,undated_incoming_kg:0,requires_specification_review:true,requires_length_review:type==='straight'&&!lengthMm});
    return groups.get(key);
  };
  if (input.diameter&&(!Number.isFinite(Number(input.diameter))||Number(input.diameter)<=0))throw new Error('invalid_diameter');
  for (const lot of db.prepare("SELECT * FROM raw_material WHERE active=1 AND COALESCE(verification_status,'approved')='approved'").all()) group(lot.diameter,lot.material_type,lot.nominal_length_mm).physical_stock_kg+=materialOnHand(lot);
  const itemById=db.prepare('SELECT * FROM items WHERE id=?');
  const completionPolicy=require('./inventoryItemCompletion').policy(db);
  const countCompleted=new Set(completionPolicy?db.prepare('SELECT item_id FROM inventory_count_completed_items').all().map(r=>r.item_id):[]);
  const reservations=db.prepare(`SELECT r.*,o.delivery_date,o.created_at AS order_created_at,o.status AS order_status FROM inventory_reservations r JOIN orders o ON o.id=r.order_id
    WHERE ${completionPolicy?"(r.status='active' OR r.pending_actual_kg IS NOT NULL)":"r.status='active'"} AND o.inventory_lifecycle_version=1 AND o.status NOT IN ('בוטל','cancelled','canceled') ORDER BY r.id`).all();
  const legacyUsage=db.prepare(`SELECT COALESCE(SUM(u.weight_used),0) AS kg FROM raw_material_usage u JOIN raw_material m ON m.id=u.raw_material_id
    WHERE u.order_id=? AND u.item_id=? AND m.diameter=? AND COALESCE(m.material_type,'coil')=?
    AND (? != 'straight' OR m.nominal_length_mm IS ?)
    ${completionPolicy?'AND julianday(u.used_at)>julianday(?)':''}`);
  for (const row of reservations) {
    if(completionPolicy){
      const exceptional=require('./inventoryItemCompletion').consumptionOverride(db,require('./inventoryItemCompletion').itemRecord(db,row.item_id));
      const status=require('../status-contracts').normalizeOrderStatus(row.order_status);
      const {ORDER_STATUS}=require('../status-contracts');
      if(status===ORDER_STATUS.CANCELLED||(status===ORDER_STATUS.DELIVERED_CONFIRMED&&!exceptional)||countCompleted.has(row.item_id))continue;
      const stamp=String(row.order_created_at||'');
      const created=Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(stamp)?stamp:stamp.replace(' ','T')+'Z');
      if((!Number.isFinite(created)||created<Date.parse(completionPolicy.eligible_from))&&!exceptional)continue;
    }
    const length=itemLength(itemById.get(row.item_id)),g=group(row.diameter,row.material_type,length);
    const target=Number(row.pending_actual_kg??row.reserved_kg);
    const charged=completionPolicy?require('./inventoryItemCompletion').state(db,row.item_id):null;
    const identity=charged?JSON.parse(charged.identity_json):null;
    const prepaid=charged?(identity.diameter===Number(row.diameter)&&identity.material_type===row.material_type&&nominalLength(row.material_type,identity.length_mm)===nominalLength(row.material_type,length)?Math.min(target,charged.consumed_kg):0):(row.consumption_mode==='on_completion'?0:Math.min(target,Number(legacyUsage.get(row.order_id,row.item_id,row.diameter,row.material_type,row.material_type,nominalLength(row.material_type,length),...(completionPolicy?[completionPolicy.counted_at]:[])).kg)));
    g.legacy_preallocated_kg+=prepaid;
    const remaining=Math.max(0,target-prepaid);
    if (!row.delivery_date) g.undated_demand_kg+=remaining;
    if (!through||!row.delivery_date||row.delivery_date<=through) g.backlog_kg+=remaining;
  }
  const net=db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) AS kg
    FROM material_consumption_events_v2 e JOIN material_consumption_event_lines_v2 l ON l.consumption_event_id=e.id WHERE e.material_requirement_id=?`);
  for (const row of db.prepare(`SELECT r.* FROM material_requirements_v2 r JOIN orders o ON o.id=r.order_id
    WHERE r.status='open' AND r.lifecycle_version=2 AND o.inventory_lifecycle_version=2 AND o.status NOT IN ('בוטל','cancelled','canceled')`).all()) {
    const g=group(row.diameter,row.material_type,itemLength(itemById.get(row.item_id))), remaining=Math.max(0,Number(row.required_kg)-Number(net.get(row.id).kg));
    if (!row.need_by_date) g.undated_demand_kg+=remaining;
    if (!through||!row.need_by_date||row.need_by_date<=through) g.backlog_kg+=remaining;
  }
  for (const po of db.prepare("SELECT * FROM purchase_orders WHERE material_type IN ('coil','straight','bent') AND diameter>0").all()) {
    if (!CONFIRMED_INCOMING.has(String(po.status||'').trim().toLowerCase())||po.received_at) continue;
    const g=group(po.diameter,po.material_type,purchaseLength(po)), amount=Math.max(0,Number(po.quantity_ton||0)*1000-Number(po.received_weight||0));
    if (!po.expected_date) g.undated_incoming_kg+=amount;
    if (!through||(po.expected_date&&po.expected_date<=through)) g.incoming_kg+=amount;
  }
  if(input.diameter&&![...groups.values()].some(g=>g.diameter===Number(input.diameter)&&(!input.material_type||g.material_type===input.material_type)))group(input.diameter,input.material_type||'coil');
  for(const diameter of new Set([...groups.values()].filter(g=>g.material_type==='straight').map(g=>g.diameter))){group(diameter,'straight',6000);group(diameter,'straight',12000);}
  const rows=[...groups.values()].filter(g=>(!input.diameter||g.diameter===Number(input.diameter))&&(!input.material_type||g.material_type===input.material_type))
    .filter(g=>!g.requires_length_review||g.physical_stock_kg!==0||g.backlog_kg!==0||g.incoming_kg!==0||g.undated_demand_kg!==0||g.undated_incoming_kg!==0).map(g=>{
    const demand=mode==='backlog'?g.backlog_kg:0, waste=kg(demand*percent/100);
    const coverage=g.requires_length_review?0:g.physical_stock_kg,incoming=g.requires_length_review?0:g.incoming_kg;
    return {...Object.fromEntries(Object.entries(g).map(([k,v])=>[k,k.endsWith('_kg')?kg(v):v])),...barEstimate(g.diameter,g.nominal_length_mm,g.physical_stock_kg),available_stock_kg:kg(coverage-g.backlog_kg),waste_kg:waste,safety_stock_kg:kg(safety),recommended_purchase_kg:kg(Math.max(0,demand+waste+safety-coverage-incoming))};
  }).sort((a,b)=>a.diameter-b.diameter||a.material_type.localeCompare(b.material_type)||(a.nominal_length_mm??Infinity)-(b.nominal_length_mm??Infinity));
  return {mode,through_date:through,read_only:true,identity_scope:'diameter_material_type_nominal_length',specification_warning:'ליפטים מופרדים לפי אורך; אורך לא ידוע דורש בירור ואינו מכסה חוסר. יש לבדוק דרגה ותקן לפני פתיחת רכש.',groups:rows,purchase_policy:require('./purchasePolicy').purchasePolicy(rows,input.stock_basis||'available')};
}
module.exports={planInventory,CONFIRMED_INCOMING};
