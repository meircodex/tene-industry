(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendOrderSorting=api;})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const collator=new Intl.Collator('he',{numeric:true,sensitivity:'base'});
  const columns=['order_num','customer_name','delivery_date','priority','total_weight','status','notes'];
  function value(order,key,workspace){
    if(key==='notes')return workspace?.notes(order).join(' ')||order.general_notes||null;
    if(key==='status')return workspace?.primaryStatus(order)||order.status||null;
    if(key==='priority')return ['דחוף','urgent','high'].includes(order.priority)?1:0;
    if(key==='total_weight')return order.total_weight==null?null:Number(order.total_weight);
    if(key==='delivery_date'){const date=String(order.delivery_date||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(date)?date:null;}
    return order[key]||null;
  }
  function sort(orders,state,workspace){
    if(!columns.includes(state?.key))return [...orders];
    const direction=state.direction==='desc'?-1:1;
    return orders.map((order,index)=>({order,index})).sort((a,b)=>{
      const av=value(a.order,state.key,workspace),bv=value(b.order,state.key,workspace);
      const missing=v=>v==null||v===''||(typeof v==='number'&&!Number.isFinite(v));
      if(missing(av)||missing(bv))return missing(av)===missing(bv)?a.index-b.index:missing(av)?1:-1;
      return direction*(typeof av==='number'&&typeof bv==='number'?av-bv:collator.compare(String(av),String(bv)))||a.index-b.index;
    }).map(row=>row.order);
  }
  function toggle(state,key){return columns.includes(key)?{key,direction:state?.key===key&&state.direction==='asc'?'desc':'asc'}:state;}
  return {columns,sort,toggle};
});
