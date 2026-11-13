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
  return {filter,customerKey};
});
