'use strict';
// Activity is a read-only projection of scan events. Production amounts are
// supplied by the canonical timing projection, never reconstructed from scans.
function dailyScanActivity({records,scans,completedCards,fromDate,toDate,dayOf,parseDate,machineOf}){
 const dayCache=new Map();
 const localDay=value=>{const key=value instanceof Date?value.toISOString():value;if(!dayCache.has(key))dayCache.set(key,dayOf(value));return dayCache.get(key);};
 const inside=day=>day&&day>=fromDate&&day<=toDate;
 const completed=new Map(completedCards.map(c=>[c.item_id,c]));
 const entries=[],machines=new Map(),dates=new Set();
 const safe=value=>Number.isFinite(Number(value))?Number(value):0;
 for(const item of records){
  const id=Number(item.id),card=completed.get(id),events=scans.byItem.get(id)||[],cycles=[];
  let current=null;
  for(const event of events){
   if(event.kind==='reset'){if(current)current.corrected=true;current=null;continue;}
   if(event.kind==='start'&&(!current||current.completed_at)){
    current={started_at:event.at.toISOString(),completed_at:null,corrected:false,scanned:true};cycles.push(current);
   }
   if(event.kind==='end'){
    if(!current){current={started_at:null,completed_at:event.at.toISOString(),corrected:false,scanned:true};cycles.push(current);}
    else if(!current.completed_at)current.completed_at=event.at.toISOString();
   }
  }
  const byDay=new Map();
  const bucket=day=>{if(!inside(day))return null;if(!byDay.has(day))byDay.set(day,{date:day,started:null,ended:null});return byDay.get(day);};
  for(const cycle of cycles){
   const start=cycle.started_at&&bucket(localDay(cycle.started_at));if(start)start.started={...cycle};
   const end=cycle.completed_at&&bucket(localDay(cycle.completed_at));if(end)end.ended={...cycle};
  }
  if(card&&inside(card.production_day)){
   const row=bucket(card.production_day);
   if(!row.ended)row.ended={started_at:card.started_at,completed_at:card.completed_at,corrected:false,scanned:card.timing_end_source==='scan'};
   row.reported=card;
  }
  if(!byDay.size)continue;
  const machine=machineOf(item),machineKey=machine.id?'id:'+machine.id:'name:'+(machine.name||'unassigned');
  machines.set(machineKey,{key:machineKey,label:machine.name||'לא משויך'});
  for(const row of byDay.values()){
   const endStartDay=row.ended?.started_at?localDay(row.ended.started_at):null;
   const paired=Boolean(row.ended?.scanned&&!row.ended.corrected&&endStartDay);
   const sameDay=paired&&endStartDay===row.date;
   const previousDay=paired&&endStartDay<row.date;
   const near=(a,b)=>a&&b&&Math.abs(parseDate(a)-parseDate(b))<=1000;
   const confirmed=Boolean(sameDay&&row.reported?.included_in_statistics&&near(row.ended.started_at,row.reported.started_at)&&near(row.ended.completed_at,row.reported.completed_at));
   dates.add(row.date);
   entries.push({date:row.date,item_id:id,order_id:Number(item.report_order_id)||null,order_num:item.report_order_num||null,
    shape_name:card?.shapeName||item.shape_name||'ללא צורה',diameter_mm:safe(item.diameter)||null,machine_key:machineKey,machine:machine.name||'לא משויך',
    status:item.status,planned_quantity:Math.max(0,safe(item.quantity)),started:row.started,ended:row.ended,
    same_day_scanned:sameDay,ended_from_prior_day:previousDay,ended_unmatched:Boolean(row.ended&&!sameDay&&!previousDay),
    not_finished_same_day:Boolean(row.started&&(!row.started.completed_at||localDay(row.started.completed_at)!==row.date||row.started.corrected)),
    confirmed_same_day:confirmed,reported_complete:Boolean(row.reported),
    reported_quantity:row.reported?row.reported.quantity:null,reported_weight_kg:row.reported?row.reported.weight_kg:null,
    weight_source:row.reported?.weight_source||null,reliability_status:row.reported?.reliability_status||null,
    included_in_statistics:Boolean(row.reported?.included_in_statistics)});
  }
 }
 const span=Math.round((Date.parse(toDate+'T12:00:00Z')-Date.parse(fromDate+'T12:00:00Z'))/86400000);
 if(span<=370)for(let n=0;n<=span;n++)dates.add(new Date(Date.parse(fromDate+'T12:00:00Z')+n*86400000).toISOString().slice(0,10));
 const groups=new Map();
 const group=(date,key)=>{
  const code=date+'|'+key;if(!groups.has(code))groups.set(code,{date,machine_key:key,started_cards:0,same_day_cards:0,prior_day_cards:0,unmatched_end_cards:0,not_finished_same_day_cards:0,
   ended_cards:0,reported_completed_cards:0,reported_units:0,reported_weight_kg:0,confirmed_cards:0,confirmed_units:0,confirmed_weight_kg:0,confirmed_theoretical_kg:0,confirmed_measured_kg:0,historical_end_without_quantity_cards:0});return groups.get(code);
 };
 for(const date of dates){group(date,'all');for(const key of machines.keys())group(date,key);}
 for(const entry of entries)for(const key of ['all',entry.machine_key]){
  const g=group(entry.date,key);
  g.started_cards+=Number(Boolean(entry.started));g.same_day_cards+=Number(entry.same_day_scanned);g.prior_day_cards+=Number(entry.ended_from_prior_day);
  g.unmatched_end_cards+=Number(entry.ended_unmatched);g.not_finished_same_day_cards+=Number(entry.not_finished_same_day);g.ended_cards+=Number(Boolean(entry.ended));
  if(entry.reported_complete){g.reported_completed_cards++;g.reported_units+=safe(entry.reported_quantity);g.reported_weight_kg+=safe(entry.reported_weight_kg);}
  if(entry.ended&&!entry.reported_complete)g.historical_end_without_quantity_cards++;
  if(entry.confirmed_same_day){g.confirmed_cards++;g.confirmed_units+=safe(entry.reported_quantity);g.confirmed_weight_kg+=safe(entry.reported_weight_kg);g[entry.weight_source==='measured'?'confirmed_measured_kg':'confirmed_theoretical_kg']+=safe(entry.reported_weight_kg);}
 }
 for(const g of groups.values())for(const key of ['reported_weight_kg','confirmed_weight_kg','confirmed_measured_kg','confirmed_theoretical_kg'])g[key]=Math.round(g[key]*1000)/1000;
 return {time_zone:'Asia/Jerusalem',includes_empty_days:span<=370,
  days:[...groups.values()].filter(g=>g.machine_key==='all').sort((a,b)=>b.date.localeCompare(a.date)),
  machine_days:[...groups.values()].filter(g=>g.machine_key!=='all'),machines:[...machines.values()].sort((a,b)=>a.label.localeCompare(b.label,'he')),
  cards:entries.sort((a,b)=>b.date.localeCompare(a.date)||b.item_id-a.item_id)};
}
module.exports={dailyScanActivity};
