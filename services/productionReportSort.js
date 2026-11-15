'use strict';
const fields={
 card:r=>r.item_id,order:r=>r.order_num,customer:r=>r.customer_name,shape:r=>r.shape_name,
 diameter:r=>r.diameter_mm,material:r=>r.material_type,machine:r=>r.machine,status:r=>r.status,
 planned:r=>r.planned_quantity,quantity:r=>r.reported_quantity,weight:r=>r.reported_weight_kg,weight_source:r=>r.weight_source,
 unit_length:r=>r.card?.unitCutLengthMm,length:r=>r.produced_length_mm,
 start:r=>(r.ended||r.started)?.started_at?Date.parse((r.ended||r.started).started_at):null,
 end:r=>r.ended?.completed_at?Date.parse(r.ended.completed_at):null,
 workers:r=>r.worker_names,start_worker:r=>r.start_worker,end_worker:r=>r.end_worker,
 gross:r=>r.card?.gross_minutes,outside:r=>r.card?.outside_work_minutes,lunch:r=>r.card?.lunch_minutes,stops:r=>r.card?.documented_stop_minutes,
 net:r=>r.card?.net_minutes_exact??r.card?.net_minutes,pace:r=>r.card?.meters_per_min,kg_pace:r=>r.card?.kg_per_min,
 reliability:r=>r.reliability_status,included:r=>Number(Boolean(r.card?.included_in_statistics)),reason:r=>(r.card?.reliability_reasons||[]).join(' '),
 kind:r=>r.same_day_scanned?'same':r.ended_from_prior_day?'prior':r.ended_unmatched?'unmatched':r.started?'open':'',dates:r=>r.date
};
function sortedCards(rows,key,direction){
 if(!key)return rows;
 const get=fields[key],sign=direction==='desc'?-1:1;
 return [...rows].sort((a,b)=>{
  const av=get(a),bv=get(b),empty=v=>v==null||v===''||(typeof v==='number'&&!Number.isFinite(v));
  if(empty(av)!==empty(bv))return empty(av)?1:-1;
  if(empty(av))return b.item_id-a.item_id;
  const delta=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'he',{numeric:true});
  return sign*delta||b.item_id-a.item_id;
 });
}
module.exports={fields,sortedCards};
