(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.IronBendOrderBatch=api;
})(typeof window!=='undefined'?window:null,function(root){
  'use strict';
  const CROSS_CUSTOMER_MESSAGE='לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const selected=new Set();let rows=new Map(),visible=[],context='',busy=false;
  function deliveryEligibility(orders){
    if(!orders.length)return {ok:false,message:'יש לבחור הזמנות'};
    if(orders.some(o=>!Number.isSafeInteger(Number(o.customer_id))||Number(o.customer_id)<=0))return {ok:false,message:'באחת ההזמנות חסר לקוח. יש להשלים לקוח לפני הפקת תעודת משלוח.'};
    return new Set(orders.map(o=>Number(o.customer_id))).size===1?{ok:true}:{ok:false,message:CROSS_CUSTOMER_MESSAGE};
  }
  function selectedOrders(){return [...selected].map(id=>rows.get(id)).filter(Boolean);}
  function sync(orders,shown,scope){
    if(context!==scope){selected.clear();context=scope;}
    rows=new Map(orders.filter(o=>!o.deleted_at).map(o=>[Number(o.id),o]));
    for(const id of selected)if(!rows.has(id))selected.delete(id);
    visible=shown.filter(o=>!o.deleted_at).map(o=>Number(o.id));render();
  }
  function checkbox(order){return order.deleted_at?'':`<input class="order-batch-check" type="checkbox" data-batch-order="${Number(order.id)}" aria-label="בחר הזמנה ${esc(order.order_num)}" ${selected.has(Number(order.id))?'checked':''} onclick="event.stopPropagation()" onchange="IronBendOrderBatch.toggle(${Number(order.id)},this.checked,event)">`;}
  function master(){return '<input class="order-batch-check" id="orderBatchMaster" type="checkbox" aria-label="בחר את ההזמנות המוצגות" onchange="IronBendOrderBatch.toggleVisible(this.checked,event)">';}
  function toggle(id,checked,event){event?.stopPropagation?.();if(!rows.has(Number(id)))return;checked?selected.add(Number(id)):selected.delete(Number(id));render();}
  function toggleVisible(checked,event){event?.stopPropagation?.();for(const id of visible)checked?selected.add(id):selected.delete(id);render();}
  function clear(){selected.clear();render();}
  function render(){
    if(!root?.document)return;
    const doc=root.document,bar=doc.getElementById('orderBatchToolbar');if(!bar)return;
    bar.hidden=!selected.size||!context.startsWith('orders|');
    doc.getElementById('orderBatchCount').textContent=selected.size+' הזמנות נבחרו';
    for(const input of doc.querySelectorAll('[data-batch-order]'))input.checked=selected.has(Number(input.dataset.batchOrder));
    const masterInput=doc.getElementById('orderBatchMaster'),count=visible.filter(id=>selected.has(id)).length;
    if(masterInput){masterInput.checked=Boolean(visible.length)&&count===visible.length;masterInput.indeterminate=count>0&&count<visible.length;masterInput.disabled=!visible.length;}
    doc.getElementById('orderBatchDelivery').classList.toggle('is-unavailable',!deliveryEligibility(selectedOrders()).ok);
    doc.getElementById('orderBatchCutting').disabled=busy;
  }
  async function cutting(){
    if(busy||!selected.size)return;busy=true;render();
    try{await root.openSelectedStraightStockCutting([...selected]);}
    catch(error){if(!error.cancelled)root.alert(error.message||'לא ניתן לפתוח את תוכנית החיתוך.');}
    finally{busy=false;render();}
  }
  function delivery(){
    const eligibility=deliveryEligibility(selectedOrders());
    if(!eligibility.ok){root.alert(eligibility.message);return;}
    root.location.href='/order-operations.html?orders='+[...selected].join(',');
  }
  return {CROSS_CUSTOMER_MESSAGE,deliveryEligibility,sync,checkbox,master,toggle,toggleVisible,clear,render,cutting,delivery,selectedIds:()=>[...selected]};
});
