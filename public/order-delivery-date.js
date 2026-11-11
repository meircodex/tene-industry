(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendOrderDeliveryDate=api;})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const FACTORY_TIME_ZONE='Asia/Jerusalem';
  function defaultDate(now=new Date()){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:FACTORY_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const date=Object.fromEntries(parts.map(part=>[part.type,part.value]));
    return new Date(Date.UTC(Number(date.year),Number(date.month)-1,Number(date.day)+2)).toISOString().slice(0,10);
  }
  function resolve(value,now=new Date()){return String(value??'').trim()||defaultDate(now);}
  return {FACTORY_TIME_ZONE,defaultDate,resolve};
});
