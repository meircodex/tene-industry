'use strict';
// Calendar dates only: browser timezone must not move a factory reporting day.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendReportPeriods=api;})(typeof window==='object'?window:globalThis,()=>{
 const modes=['day','week','quarter','year','custom'];
 function valid(day){if(!/^\d{4}-\d{2}-\d{2}$/.test(day||''))return false;const d=new Date(day+'T12:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===day;}
 const iso=d=>d.toISOString().slice(0,10);
 function range(mode,anchor){
  if(!modes.includes(mode)||mode==='custom'||!valid(anchor))throw Error('invalid_report_period');
  const start=new Date(anchor+'T12:00:00Z'),end=new Date(start),y=start.getUTCFullYear(),m=start.getUTCMonth();
  if(mode==='week'){start.setUTCDate(start.getUTCDate()-start.getUTCDay());end.setTime(start.getTime());end.setUTCDate(start.getUTCDate()+6);}
  if(mode==='quarter'){start.setUTCMonth(Math.floor(m/3)*3,1);end.setUTCFullYear(y,Math.floor(m/3)*3+3,0);}
  if(mode==='year'){start.setUTCMonth(0,1);end.setUTCFullYear(y,11,31);}
  return {from:iso(start),to:iso(end)};
 }
 const bucket=mode=>mode==='day'?'hour':['quarter','year'].includes(mode)?'month':'day';

 // Re-bin supplied report totals only; never calculate source production weights.
 function groupDays(series,{from,to},granularity){
  const days=new Map();
  if(valid(from)&&valid(to)&&from<=to){
   const span=(Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000;
   for(let n=0;n<=span;n++)days.set(iso(new Date(Date.parse(from+'T12:00:00Z')+n*86400000)),0);
  }
  for(const point of series||[]){if(!valid(point.key)||from&&point.key<from||to&&point.key>to)continue;days.set(point.key,(days.get(point.key)||0)+(Number(point.value)||0));}
  const groups=new Map();
  for(const [day,value] of days){
   const key=granularity==='month'?day.slice(0,7):granularity==='week'?range('week',day).from:day;
   groups.set(key,(groups.get(key)||0)+value);
  }
  return [...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([key,value])=>({key,value}));
 }
 function zoomLevels({from,to}={}){
  if(from&&from===to)return ['hour','day'];
  const span=(Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000;
  return span<7?['day','week']:['day','week','month'];
 }
 const display=day=>day.split('-').reverse().join('.');
 let active='week';
 function setup({load}){
  const $=id=>document.getElementById(id),anchor=$('periodAnchor');anchor.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const apply=(reload=true)=>{
   for(const b of $('reportPeriods').querySelectorAll('[data-period]'))b.setAttribute('aria-pressed',String(b.dataset.period===active));
   $('periodAnchorLabel').hidden=active==='custom';for(const label of document.querySelectorAll('.custom-period'))label.hidden=active!=='custom';
   if(active!=='custom'){
    if(!valid(anchor.value)){$('reportState').textContent='יש לבחור תאריך תקין';return;}
    const dates=range(active,anchor.value);$('fromDate').value=dates.from;$('toDate').value=dates.to;
   }
   const from=$('fromDate').value,to=$('toDate').value;
   $('periodTitle').textContent=valid(from)&&valid(to)?(from===to?display(from):display(from)+'–'+display(to)):'';
   if(reload)load();
  };
  $('reportPeriods').addEventListener('click',event=>{const mode=event.target.closest('[data-period]')?.dataset.period;if(!modes.includes(mode))return;active=mode;apply();});
  anchor.addEventListener('change',()=>apply());
  for(const id of ['fromDate','toDate'])$(id).addEventListener('change',()=>apply());
  apply(false);
 }
 return {range,bucket,valid,groupDays,zoomLevels,setup,selected:()=>active};
});
