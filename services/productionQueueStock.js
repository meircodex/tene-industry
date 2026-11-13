'use strict';
const {planInventory}=require('./inventoryPlanning');
const {materialOnHand}=require('./materialBalance');
const {activeAllocatedForLot,consumedForAllocationLine}=require('./materialAllocationPlanningV2');
const {nominalLength}=require('./inventoryPlanningLength');
const identity=r=>`${Number(r.diameter)}|${r.material_type||'coil'}|${nominalLength(r.material_type||'coil',r.nominal_length_mm)??''}`;
const UNKNOWN={code:'unknown',label:'לא אומת',reason:'נדרש אימות נתוני החומר'};

// Inventory owns this read-only presentation of its existing demand and lot accounting.
function classifyStock({need,physical,total,allocated=0,review=false,conflict=false}) {
  if(review||conflict||![need,physical,total,allocated].every(Number.isFinite))return {...UNKNOWN};
  if(need<=0||((physical>=need)&&(physical>=total||allocated>=need)))return {code:'available',label:'יש מלאי',reason:'הכמות מכוסה במלאי המאושר או בהקצאה קיימת'};
  if(physical<need)return {code:'shortage',label:'חסר מלאי',reason:'היתרה הפיזית אינה מכסה את יתרת הדרישה לכרטיס'};
  return {code:'allocation',label:'דורש הקצאה',reason:'קיימת כמות פיזית, אך היא משותפת לדרישות נוספות; נדרשת החלטת הקצאה'};
}
function productionQueueStock(db,items) {
  const plan=planInventory(db,{include_queue_demands:true}),groups=new Map(plan.groups.map(g=>[identity(g),g]));
  const demands=new Map(plan.queue_demands.map(d=>[Number(d.item_id),d])),held=new Map(),conflicts=new Set(),lotTotals=new Map();
  const allocations=db.prepare(`SELECT l.id allocation_line_id,l.allocated_kg,req.item_id requirement_item_id,r.* FROM allocation_plan_lines_v2 l
    JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id JOIN material_requirements_v2 req ON req.id=p.material_requirement_id
    JOIN raw_material r ON r.id=l.raw_material_id WHERE l.status='active' AND p.status='active' AND r.active=1
    AND COALESCE(r.verification_status,'approved')='approved'`).all();
  for(const a of allocations){
    const demand=demands.get(Number(a.requirement_item_id));if(!demand||identity(a)!==identity(demand))continue;
    // The lot id and allocation-line id remain distinct.
    const lotId=a.id;
    if(!lotTotals.has(lotId))lotTotals.set(lotId,activeAllocatedForLot(db,lotId));
    const physical=materialOnHand(a);
    if(lotTotals.get(lotId)>physical+0.001)conflicts.add(Number(a.requirement_item_id));
    held.set(Number(a.requirement_item_id),(held.get(Number(a.requirement_item_id))||0)+Math.max(0,Math.min(physical,Number(a.allocated_kg)-consumedForAllocationLine(db,a.allocation_line_id))));
  }
  const meshGroups=new Map(require('./meshInventory').planMesh(db).map(g=>[g.specification_key,g]));
  const meshDemands=new Map(db.prepare("SELECT * FROM inventory_mesh_demands WHERE status='active'").all().map(d=>[Number(d.item_id),d]));
  return new Map(items.map(item=>{
    const d=demands.get(Number(item.id)),g=d&&groups.get(identity(d)),mesh=meshDemands.get(Number(item.id)),mg=mesh&&meshGroups.get(mesh.specification_key);
    const state=mg?classifyStock({need:Number(mesh.quantity_units),physical:Number(mg.physical_units),total:Number(mg.required_units)}):g?classifyStock({need:Number(d.remaining_kg),physical:Number(g.physical_stock_kg),total:Number(g.backlog_kg),allocated:held.get(Number(item.id))||0,review:d.requires_review||g.requires_length_review,conflict:conflicts.has(Number(item.id))}):{...UNKNOWN};
    return [Number(item.id),state];
  }));
}
module.exports={productionQueueStock,classifyStock};
