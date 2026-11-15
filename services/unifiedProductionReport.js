'use strict';
// Aggregates canonical report values only; never derives geometry or raw weights.
const GROUPS=['card','day','machine','diameter','order','customer','shape'];
const KINDS=['all','started','same','prior','unmatched','open','ended','confirmed'];
function parseFilters(query={}){
 const text=(key,max=160)=>{const value=query[key]??'';if(typeof value!=='string'||value.length>max)throw Error('invalid_report_filter');return value.trim();};
 const group=text('group')||'card',kind=text('kind')||'all',reliability=text('reliability'),material=text('material');
 if(!GROUPS.includes(group)||!KINDS.includes(kind)||!['','reliable','review','unreliable','unknown'].includes(reliability)||!['','coil','straight','bent','mesh','unknown'].includes(material))throw Error('invalid_report_filter');
 const integer=(key,def,max)=>{const raw=text(key);const n=raw?Number(raw):def;if(!Number.isInteger(n)||n<1||n>max)throw Error('invalid_report_filter');return n;};
 const drill_field=text('drill_field');if(!['','order_num','shape_name','machine','diameter_mm','customer_name'].includes(drill_field))throw Error('invalid_report_filter');
 const drill_value=text('drill_value');
 const diameter=text('diameter');if(diameter&&(!Number.isFinite(Number(diameter))||Number(diameter)<=0))throw Error('invalid_report_filter');
 return {group,kind,reliability,material,diameter,drill_field,drill_value,machine:text('machine'),search:text('search'),customer:text('customer'),page:integer('page',1,100000),limit:integer('limit',25,200)};
}
function summary(rows){
 const result={cards:new Set(rows.map(r=>r.item_id)).size,rows:rows.length,reported_cards:0,units:0,weight_kg:0,theoretical_kg:0,measured_kg:0,net_minutes:0,timed_length_mm:0,timed_weight_kg:0,reliable_cards:0,started_cards:0,ended_cards:0,confirmed_units:0};
 for(const r of rows){
  result.started_cards+=Number(Boolean(r.started));result.ended_cards+=Number(Boolean(r.ended));
  if(r.reported_complete){result.reported_cards++;result.units+=Number(r.reported_quantity)||0;result.weight_kg+=Number(r.reported_weight_kg)||0;result[r.weight_source==='measured'?'measured_kg':'theoretical_kg']+=Number(r.reported_weight_kg)||0;}
  if(r.confirmed_same_day)result.confirmed_units+=Number(r.reported_quantity)||0;
  if(r.reported_complete&&r.card?.included_in_statistics){result.reliable_cards++;result.net_minutes+=Number(r.card.net_minutes)||0;result.timed_length_mm+=Number(r.card.cut_length_mm)||0;result.timed_weight_kg+=Number(r.card.weight_kg)||0;}
 }
 result.meters_per_min=result.net_minutes>0?result.timed_length_mm/1000/result.net_minutes:null;
 result.kg_per_min=result.net_minutes>0?result.timed_weight_kg/result.net_minutes:null;
 return result;
}
function unifiedProductionReport({cards,activity},filters){
 const canonical=new Map(cards.map(c=>[c.item_id,c]));
 const all=activity.cards.map(r=>({...r,card:r.reported_complete?canonical.get(r.item_id)||null:null,
  customer_name:r.customer_name||canonical.get(r.item_id)?.customer_name||'',
  material_type:canonical.get(r.item_id)?.material_type||r.material_type||'unknown'}));
 const values=key=>[...new Set(all.map(r=>r[key]).filter(v=>v!==null&&v!==undefined&&v!==''))].sort((a,b)=>String(a).localeCompare(String(b),'he',{numeric:true}));
 const facets={machines:values('machine'),diameters:values('diameter_mm'),customers:values('customer_name')};
 const selected=all.filter(r=>{
  if(filters.drill_field&&String(r[filters.drill_field]??'')!==filters.drill_value)return false;
  if(filters.machine&&r.machine!==filters.machine)return false;
  if(filters.diameter&&Number(r.diameter_mm)!==Number(filters.diameter))return false;
  if(filters.material&&r.material_type!==filters.material)return false;
  if(filters.customer&&r.customer_name!==filters.customer)return false;
  if(filters.reliability&&(r.reliability_status||'unknown')!==filters.reliability)return false;
  if(filters.search&&![r.order_num,r.item_id,r.shape_name,r.customer_name].join(' ').toLocaleLowerCase('he').includes(filters.search.toLocaleLowerCase('he')))return false;
  return filters.kind==='started'?Boolean(r.started):filters.kind==='same'?r.same_day_scanned:filters.kind==='prior'?r.ended_from_prior_day:filters.kind==='unmatched'?r.ended_unmatched:filters.kind==='open'?r.not_finished_same_day:filters.kind==='ended'?Boolean(r.ended):filters.kind==='confirmed'?r.confirmed_same_day:true;
 });
 const totals=summary(selected);let rows=selected;
 if(filters.group!=='card'){
  const field={day:'date',machine:'machine',diameter:'diameter_mm',order:'order_num',customer:'customer_name',shape:'shape_name'}[filters.group],groups=new Map();
  for(const r of selected){const key=String(r[field]??'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  rows=[...groups].map(([key,list])=>({key,label:key||'לא ידוע',...summary(list)})).sort((a,b)=>filters.group==='day'?b.key.localeCompare(a.key):a.key.localeCompare(b.key,'he',{numeric:true}));
 }
 const total=rows.length,pages=Math.max(1,Math.ceil(total/filters.limit)),page=Math.min(filters.page,pages);
 return {filters:{...filters,page},facets,summary:totals,total,pages,page,limit:filters.limit,rows:rows.slice((page-1)*filters.limit,page*filters.limit)};
}
module.exports={parseFilters,unifiedProductionReport,summary};
