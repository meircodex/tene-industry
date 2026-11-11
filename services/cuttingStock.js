'use strict';
const {materialOnHand,kg}=require('./materialBalance');
const {rebarKgPerMeter}=require('../constants');
const {nominalLength,barEstimate}=require('./inventoryPlanningLength');

// Read only. Physical weight remains owned by Inventory; planning never consumes,
// reserves or changes a lot, order, production report or delivery certificate.
function cuttingStock(db,orderIds=[]){
  const selected=new Set(orderIds.map(Number)),held=new Map();
  const consumed=db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) n
    FROM material_consumption_event_lines_v2 l JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id WHERE l.allocation_plan_line_id=?`);
  for(const row of db.prepare(`SELECT l.id,l.raw_material_id,l.allocated_kg,r.order_id FROM allocation_plan_lines_v2 l
    JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id JOIN material_requirements_v2 r ON r.id=p.material_requirement_id
    WHERE l.status='active' AND p.status='active'`).all()){
    if(selected.has(Number(row.order_id)))continue;
    const remaining=Math.max(0,Number(row.allocated_kg)-Number(consumed.get(row.id).n));held.set(Number(row.raw_material_id),kg((held.get(Number(row.raw_material_id))||0)+remaining));
  }
  const sources=db.prepare(`SELECT r.*,c.name catalog_name FROM raw_material r LEFT JOIN catalog_items c ON c.id=r.catalog_item_id
    WHERE r.active=1 AND r.material_type='straight' AND COALESCE(r.verification_status,'approved')='approved' ORDER BY r.received_date,r.id`).all().map(row=>{
      const physicalKg=Math.max(0,materialOnHand(row)),heldKg=held.get(Number(row.id))||0,availableKg=kg(Math.max(0,physicalKg-heldKg));
      const lengthMm=nominalLength('straight',row.nominal_length_mm),kgPerMeter=rebarKgPerMeter(Number(row.diameter));
      const estimate=barEstimate(row.diameter,lengthMm,availableKg);
      return {id:row.id,lot_number:row.lot_number,catalog_name:row.catalog_name,diameter:Number(row.diameter),grade:row.grade,standard_code:row.standard_code,
        nominal_length_mm:lengthMm,physical_kg:physicalKg,allocated_to_other_orders_kg:heldKg,available_kg:availableKg,kg_per_meter:kgPerMeter,
        calculated_bar_count:estimate.estimated_bar_count,unit_weight_kg:estimate.unit_weight_kg,warehouse_loc:row.warehouse_loc};
    }).filter(row=>row.physical_kg>0||row.allocated_to_other_orders_kg>0);
  return {read_only:true,captured_at:new Date().toISOString(),quantity_basis:'theoretical_whole_bars_from_recorded_kg',allocation_scope:'physical_less_other_confirmed_lot_allocations',sources};
}
module.exports={cuttingStock};
