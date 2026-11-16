'use strict';
// Same filtered, deduplicated cards as the table, before pagination.
const {FACTORY_TIME_ZONE,asDate,validDay}=require('./productionTiming');
const hourFormat=new Intl.DateTimeFormat('en-GB',{timeZone:FACTORY_TIME_ZONE,hour:'2-digit',hourCycle:'h23'});
function reportCharts(rows,{bucket='day',from='',to=''}={}){
 const timeline=new Map(),days=new Map(),diameters=new Map(),machines=new Map(),reliability=new Map();
 if(validDay(from)&&validDay(to)&&from<=to){
  const span=(Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000;
  if(bucket==='hour'&&from===to)for(let h=0;h<24;h++)timeline.set(String(h).padStart(2,'0'),0);
  else if(span<=370)for(let n=0;n<=span;n++){
   const day=new Date(Date.parse(from+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
   timeline.set(bucket==='month'?day.slice(0,7):day,0);
  }
 }
 for(const r of rows){
  const status=r.reliability_status||'unknown';reliability.set(status,(reliability.get(status)||0)+1);
  if(r.reported_complete){
   const weight=Number(r.reported_weight_kg)||0;
   days.set(r.date,(days.get(r.date)||0)+weight);
   let key=bucket==='month'?r.date.slice(0,7):r.date;
   if(bucket==='hour'){
    const at=asDate(r.card?.completed_at)||asDate(r.ended?.completed_at);
    key=at?hourFormat.format(at):'unknown';
   }
   timeline.set(key,(timeline.get(key)||0)+weight);
   const diameter=r.diameter_mm==null?'unknown':String(r.diameter_mm);diameters.set(diameter,(diameters.get(diameter)||0)+weight);
  }
  const c=r.card;
  if(r.reported_complete&&c?.included_in_statistics){
   const key=r.machine||'לא משויך';if(!machines.has(key))machines.set(key,{minutes:0,length:0,cards:0});
   const m=machines.get(key);m.minutes+=Number(c.net_minutes_exact??c.net_minutes)||0;m.length+=Number(c.cut_length_mm)||0;m.cards++;
  }
 }
 const series=(map,sort)=>[...map].sort(sort).map(([key,value])=>({key,value}));
 return {bucket,period:{from,to},timeline:series(timeline,(a,b)=>a[0].localeCompare(b[0])),daily:series(days,(a,b)=>a[0].localeCompare(b[0])),diameters:series(diameters,(a,b)=>Number(a[0])-Number(b[0])),
  machines:[...machines].sort((a,b)=>a[0].localeCompare(b[0],'he',{numeric:true})).filter(([,m])=>m.minutes>0).map(([key,m])=>({key,value:m.length/1000/m.minutes,cards:m.cards})),
  reliability:series(reliability,(a,b)=>a[0].localeCompare(b[0]))};
}
module.exports={reportCharts};
