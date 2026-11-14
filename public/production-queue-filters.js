(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IronBendQueueFilters=api;})(typeof window==='undefined'?this:window,function(){
  const customerKey=item=>item.customer_id!=null?'id:'+item.customer_id:'name:'+(item.customer_name||'');
  function filter(items,selection={}){
    return items.filter(item=>(!selection.diameter||Number(item.diameter)===Number(selection.diameter))
      &&(!selection.customer||customerKey(item)===selection.customer)
      &&(!selection.order||String(item.order_id)===selection.order)
      &&(!selection.machine||(item.machine||'__unassigned')===selection.machine)
      &&(!selection.status||item.status===selection.status)
      &&(!selection.stock||(item.stock_state?.code||'unknown')===selection.stock));
  }
  function groups(items,{mode='diameter',machines=[],allItems=items,diameter='',machine=''}={}){
    if(mode==='diameter'){
      const values=diameter?[Number(diameter)]:[...new Set(allItems.map(i=>Number(i.diameter)).filter(d=>d>0))].sort((a,b)=>a-b);
      const result=values.map(d=>({key:'diameter-'+d,label:'Ø'+d,kind:'diameter',items:items.filter(i=>Number(i.diameter)===d)}));
      const unknown=items.filter(i=>!(Number(i.diameter)>0));if(unknown.length)result.push({key:'unknown-diameter',label:'קוטר לא ידוע',kind:'diameter',items:unknown});
      return result;
    }
    const result=machines.filter(m=>!machine||machine===m.name).map(m=>({key:m.name,label:m.label||m.name,kind:'machine',machine:m,items:items.filter(i=>i.machine===m.name)}));
    const other=items.filter(i=>!machines.some(m=>m.name===i.machine));
    if(other.length||machine==='__unassigned')result.push({key:'__unassigned',label:'לא שויך',kind:'unassigned',items:other});
    return result;
  }
  return {filter,customerKey,groups};
});
