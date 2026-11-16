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
 const sort=text('sort'),direction=text('direction')||'asc';if((sort&&!Object.hasOwn(require('./productionReportSort').fields,sort))||!['asc','desc'].includes(direction))throw Error('invalid_report_filter');
 const sets={};
 for(const key of ['machine','diameter','material','customer','order','status','worker','kind','reliability']){
  const raw=text(key+'_in',8000);let values=[];
  if(raw){try{values=JSON.parse(raw);}catch{throw Error('invalid_report_filter');}
   if(!Array.isArray(values)||values.length>50||values.some(v=>typeof v!=='string'||!v.trim()||v.length>160))throw Error('invalid_report_filter');
   if(key==='diameter'&&values.some(v=>!Number.isFinite(Number(v))||Number(v)<=0))throw Error('invalid_report_filter');
   if(key==='material'&&values.some(v=>!['coil','straight','bent','mesh','unknown'].includes(v)))throw Error('invalid_report_filter');
   if(key==='kind'&&values.some(v=>!KINDS.includes(v)))throw Error('invalid_report_filter');
   if(key==='reliability'&&values.some(v=>!['reliable','review','unreliable','unknown'].includes(v)))throw Error('invalid_report_filter');
  }sets[key]=[...new Set(values.map(v=>v.trim()))];
 }
 const chart_bucket=text('chart_bucket')||'day';if(!['hour','day','month'].includes(chart_bucket))throw Error('invalid_report_filter');
 const from=text('from'),to=text('to');for(const day of [from,to])if(day&&!require('./productionTiming').validDay(day))throw Error('invalid_report_filter');
 const flat=text('flat');if(!['','1'].includes(flat))throw Error('invalid_report_filter');
 return {chart_bucket,from,to,sets,sort,direction,flat:flat==='1',worker:text('worker'),order:text('order'),status:text('status'),group,kind,reliability,material,diameter,drill_field,drill_value,machine:text('machine'),search:text('search'),customer:text('customer'),page:integer('page',1,100000),limit:integer('limit',25,200)};
}
function summary(rows){
 const result={cards:new Set(rows.map(r=>r.item_id)).size,rows:rows.length,reported_cards:0,units:0,weight_kg:0,theoretical_kg:0,measured_kg:0,net_minutes:0,timed_length_mm:0,timed_weight_kg:0,reliable_cards:0,started_cards:0,ended_cards:0,confirmed_units:0};
 for(const r of rows){
  result.started_cards+=Number(Boolean(r.started));result.ended_cards+=Number(Boolean(r.ended));
  if(r.reported_complete){result.reported_cards++;result.units+=Number(r.reported_quantity)||0;result.weight_kg+=Number(r.reported_weight_kg)||0;result[r.weight_source==='measured'?'measured_kg':'theoretical_kg']+=Number(r.reported_weight_kg)||0;}
  if(r.confirmed_same_day)result.confirmed_units+=Number(r.reported_quantity)||0;
  if(r.reported_complete&&r.card?.included_in_statistics){result.reliable_cards++;result.net_minutes+=Number(r.card.net_minutes_exact??r.card.net_minutes)||0;result.timed_length_mm+=Number(r.card.cut_length_mm)||0;result.timed_weight_kg+=Number(r.card.weight_kg)||0;}
 }
 result.meters_per_min=result.net_minutes>0?result.timed_length_mm/1000/result.net_minutes:null;
 result.kg_per_min=result.net_minutes>0?result.timed_weight_kg/result.net_minutes:null;
 return result;
}
function unifiedProductionReport({cards,activity,workers=[]},filters){
 const canonical=new Map(cards.map(c=>[c.item_id,c]));
 let all=activity.cards.map(r=>({...r,card:r.reported_complete?canonical.get(r.item_id)||null:null,
  customer_name:r.customer_name||canonical.get(r.item_id)?.customer_name||'',
  material_type:canonical.get(r.item_id)?.material_type||r.material_type||'unknown'}));
 if(filters.flat){
  const grouped=new Map(),byWorkerItem=new Map();
  for(const w of workers){const id=Number(w.item_id);if(!byWorkerItem.has(id))byWorkerItem.set(id,[]);byWorkerItem.get(id).push(w);}
  for(const row of all){if(!grouped.has(row.item_id))grouped.set(row.item_id,[]);grouped.get(row.item_id).push(row);}
  all=[...grouped.values()].map(list=>{
   list.sort((a,b)=>b.date.localeCompare(a.date));
   const base=list.find(r=>r.reported_complete)||list[0],c=canonical.get(base.item_id)||null;
   const people=byWorkerItem.get(base.item_id)||[];
   return {...base,card:base.reported_complete?c:null,
    produced_length_mm:base.reported_complete&&c?.unitCutLengthMm>0?c.unitCutLengthMm*c.quantity:null,
    started:list.find(r=>r.started)?.started||base.started,
    activity_dates:list.map(r=>r.date),activity_kinds:{started:list.some(r=>r.started),same:list.some(r=>r.same_day_scanned),prior:list.some(r=>r.ended_from_prior_day),unmatched:list.some(r=>r.ended_unmatched),open:list.some(r=>r.not_finished_same_day),ended:list.some(r=>r.ended),confirmed:list.some(r=>r.confirmed_same_day)},
    workers:people,worker_names:[...new Set(people.map(w=>w.actor_name))].join(' · ')||'לא מזוהה',
    start_worker:people.filter(w=>w.to_status==='בייצור').at(-1)?.actor_name||null,
    end_worker:people.filter(w=>w.to_status==='הושלם').at(-1)?.actor_name||null};
  }).sort((a,b)=>b.date.localeCompare(a.date)||b.item_id-a.item_id);
 }
 const values=key=>[...new Set(all.map(r=>r[key]).filter(v=>v!==null&&v!==undefined&&v!==''))].sort((a,b)=>String(a).localeCompare(String(b),'he',{numeric:true}));
 const facets={machines:values('machine'),diameters:values('diameter_mm'),customers:values('customer_name'),orders:values('order_num'),statuses:values('status'),workers:[...new Map(workers.map(w=>[w.worker_key,{key:w.worker_key,name:w.actor_name}])).values()]};
 const kindMatches=(r,kind)=>kind==='all'?true:filters.flat?Boolean(r.activity_kinds[kind]):kind==='started'?Boolean(r.started):kind==='same'?r.same_day_scanned:kind==='prior'?r.ended_from_prior_day:kind==='unmatched'?r.ended_unmatched:kind==='open'?r.not_finished_same_day:kind==='ended'?Boolean(r.ended):kind==='confirmed'?r.confirmed_same_day:false;
 const selected=all.filter(r=>{
  for(const [key,values] of Object.entries(filters.sets||{})){
   if(!values.length)continue;
   if(key==='worker'){if(!r.workers?.some(w=>values.includes(w.worker_key)))return false;continue;}
   if(key==='kind'){if(!values.some(k=>kindMatches(r,k)))return false;continue;}
   const field={diameter:'diameter_mm',material:'material_type',customer:'customer_name',order:'order_num',reliability:'reliability_status'}[key]||key;
   if(key==='diameter'?!values.some(v=>Number(v)===Number(r[field])):!values.includes(String(r[field]??(key==='reliability'?'unknown':''))))return false;
  }

  if(filters.worker&&!r.workers?.some(w=>w.worker_key===filters.worker))return false;
  if(filters.order&&r.order_num!==filters.order)return false;
  if(filters.status&&r.status!==filters.status)return false;
  if(filters.drill_field&&String(r[filters.drill_field]??'')!==filters.drill_value)return false;
  if(filters.machine&&r.machine!==filters.machine)return false;
  if(filters.diameter&&Number(r.diameter_mm)!==Number(filters.diameter))return false;
  if(filters.material&&r.material_type!==filters.material)return false;
  if(filters.customer&&r.customer_name!==filters.customer)return false;
  if(filters.reliability&&(r.reliability_status||'unknown')!==filters.reliability)return false;
  if(filters.search&&![r.order_num,r.item_id,r.shape_name,r.customer_name].join(' ').toLocaleLowerCase('he').includes(filters.search.toLocaleLowerCase('he')))return false;
  if(filters.flat)return filters.kind==='all'||Boolean(r.activity_kinds[filters.kind]);
  return filters.kind==='started'?Boolean(r.started):filters.kind==='same'?r.same_day_scanned:filters.kind==='prior'?r.ended_from_prior_day:filters.kind==='unmatched'?r.ended_unmatched:filters.kind==='open'?r.not_finished_same_day:filters.kind==='ended'?Boolean(r.ended):filters.kind==='confirmed'?r.confirmed_same_day:true;
 });
 const totals=summary(selected);let rows=selected;
 if(!filters.flat&&filters.group!=='card'){
  const field={day:'date',machine:'machine',diameter:'diameter_mm',order:'order_num',customer:'customer_name',shape:'shape_name'}[filters.group],groups=new Map();
  for(const r of selected){const key=String(r[field]??'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  rows=[...groups].map(([key,list])=>({key,label:key||'לא ידוע',...summary(list)})).sort((a,b)=>filters.group==='day'?b.key.localeCompare(a.key):a.key.localeCompare(b.key,'he',{numeric:true}));
 }
 if(filters.flat&&filters.sort)rows=require('./productionReportSort').sortedCards(rows,filters.sort,filters.direction);
 const total=rows.length,pages=Math.max(1,Math.ceil(total/filters.limit)),page=Math.min(filters.page,pages);
 return {charts:filters.flat?require('./productionReportCharts').reportCharts(selected,{bucket:filters.chart_bucket,from:filters.from,to:filters.to}):null,filters:{...filters,page},facets,summary:totals,total,pages,page,limit:filters.limit,rows:rows.slice((page-1)*filters.limit,page*filters.limit)};
}
module.exports={parseFilters,unifiedProductionReport,summary};
