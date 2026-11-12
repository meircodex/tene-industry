'use strict';
const {kg} = require('./materialBalance');
const {itemShapeMetrics} = require('./shapeSnapshot');
const {nominalLength,itemLength} = require('./inventoryPlanningLength');
const completion = require('./inventoryItemCompletion');
const {normalizeOrderStatus,ORDER_STATUS} = require('../status-contracts');

// One read-only contributor list drives inventory totals, recommendations and
// drill-down. Reservation weights are a cache, not an alternative calculator.
function inventoryDemand(db) {
  const policy = completion.policy(db);
  const excluded = new Set(policy ? db.prepare('SELECT item_id FROM inventory_count_completed_items').all().map(r=>r.item_id) : []);
  const reviews = new Set(db.prepare('SELECT item_id FROM inventory_weight_review_items').all().map(r=>r.item_id));
  const rows = db.prepare(`SELECT r.*,o.delivery_date,o.created_at AS order_created_at,o.status AS order_status,o.order_num,c.name AS customer_name
    FROM inventory_reservations r JOIN orders o ON o.id=r.order_id LEFT JOIN customers c ON c.id=o.customer_id
    WHERE (r.status='active' OR r.pending_actual_kg IS NOT NULL OR r.item_id IN (SELECT item_id FROM inventory_weight_review_items))
    AND o.inventory_lifecycle_version=1 AND o.status NOT IN ('בוטל','cancelled','canceled') ORDER BY r.id`).all();
  const usage = db.prepare(`SELECT COALESCE(SUM(u.weight_used),0) AS kg FROM raw_material_usage u JOIN raw_material m ON m.id=u.raw_material_id
    WHERE u.order_id=? AND u.item_id=? AND m.diameter=? AND COALESCE(m.material_type,'coil')=?
    AND (? != 'straight' OR m.nominal_length_mm IS ?) ${policy?'AND julianday(u.used_at)>julianday(?)':''}`);
  const output=[], seen=new Set();
  for (const row of rows) {
    if(seen.has(row.item_id))continue;
    const item = completion.itemRecord(db,row.item_id);
    if(!item || item.status==='בוטל')continue;
    if(policy) {
      const override = completion.consumptionOverride(db,item);
      if(normalizeOrderStatus(row.order_status)===ORDER_STATUS.DELIVERED_CONFIRMED&&!override || excluded.has(item.id))continue;
      const stamp=String(row.order_created_at||'');
      const created=Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(stamp)?stamp:stamp.replace(' ','T')+'Z');
      if((!Number.isFinite(created)||created<Date.parse(policy.eligible_from))&&!override)continue;
    }
    seen.add(item.id);
    const metrics=itemShapeMetrics(item), length=itemLength(item), review=reviews.has(item.id);
    const measuredPending=row.pending_weight_source==='actual';
    // Untagged pending values belong to the pre-rollout protocol; protected
    // historical rows use the item weight, never their stale cached unit.
    const pending=measuredPending||(!review&&row.pending_weight_source==null)?row.pending_actual_kg:null;
    const target=Number(pending??(policy?metrics.totalWeightKg:null)??row.reserved_kg);
    const charged=policy?completion.state(db,item.id):null;
    const identity=charged?JSON.parse(charged.identity_json):null;
    const prepaid=charged?(identity.diameter===Number(row.diameter)&&identity.material_type===row.material_type&&nominalLength(row.material_type,identity.length_mm)===nominalLength(row.material_type,length)?Math.min(target,charged.consumed_kg):0):(row.consumption_mode==='on_completion'?0:Math.min(target,Number(usage.get(row.order_id,item.id,row.diameter,row.material_type,row.material_type,nominalLength(row.material_type,length),...(policy?[policy.counted_at]:[])).kg)));
    const remaining=kg(Math.max(0,target-prepaid));
    if(remaining<=0&&prepaid<=0)continue;
    output.push({item,order_id:row.order_id,order_num:row.order_num,customer_name:row.customer_name||'',delivery_date:row.delivery_date,
      diameter:Number(row.diameter),material_type:row.material_type,nominal_length_mm:nominalLength(row.material_type,length),
      target_kg:kg(target),preallocated_kg:kg(prepaid),remaining_kg:remaining,quantity:metrics.quantity,
      weight_source:measuredPending?'actual_pending':metrics.weightSource,
      requires_review:review||metrics.requiresWeightReview,review_kg:review?remaining:0});
  }
  return output;
}

function demandDetails(db,rows,{limit=25,offset=0}={}) {
  rows=rows.filter(row=>row.remaining_kg>0);
  const numbers=new Map();
  for(const orderId of new Set(rows.map(row=>row.order_id))) {
    const items=db.prepare(`SELECT i.id,i.source_item_number FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id
      WHERE COALESCE(i.order_id,p.order_id)=? ORDER BY COALESCE(p.pallet_num,0),COALESCE(i.sort_order,i.id),i.id`).all(orderId);
    items.forEach((item,index)=>numbers.set(item.id,item.source_item_number||String(index+1)));
  }
  const {itemShapeSvg}=require('./productionCards');
  const order=db.prepare('SELECT o.order_num,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?');
  return {total:rows.length,limit,offset,items:rows.slice(offset,offset+limit).map(row=>({
    order_id:row.order_id,order_num:row.order_num||order.get(row.order_id)?.order_num,customer_name:row.customer_name||order.get(row.order_id)?.customer_name||'',item_id:row.item.id,
    item_number:numbers.get(row.item.id),shape_name:row.item.shape_name||row.item.struct_element||'',
    shape_svg:itemShapeSvg(row.item),length_mm:itemShapeMetrics(row.item).totalLengthMm,quantity:row.quantity,
    total_weight_kg:row.target_kg,recorded_consumption_kg:row.preallocated_kg,remaining_kg:row.remaining_kg,
    requires_review:row.requires_review,status:row.review_kg>0?'צריכת עבר לבדיקה':row.requires_review?'נדרשת בדיקת משקל':row.item.status,
  }))};
}
module.exports={inventoryDemand,demandDetails};
