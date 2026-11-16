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
 return {range,bucket,valid,setup,selected:()=>active};
});
