'use strict';
window.IronBendOrderCutting=(()=>{
  let host=null,loadVersion=0,orderIds=[],busy=false;
  const byId=id=>document.getElementById(id);
  function configure(adapter){host=adapter;}
  function invalidate(){byId('straightStockResults').innerHTML='<div class="straight-stock-empty">הבחירה או המלאי השתנו. לחץ על ״חשב תוכנית״ לעדכון.</div>';}
  async function open(ids){
    const chosen=[...new Set(ids.map(Number))];if(!chosen.length||chosen.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('יש לבחור הזמנות תקינות');
    const token=++loadVersion;orderIds=chosen;host.setEntries([]);host.renderItems();byId('straightStockOverlay').classList.add('show');byId('straightStockMeta').textContent='טוען את ההזמנות שנבחרו…';invalidate();
    const results=new Array(chosen.length);let next=0;
    try{await Promise.all(Array.from({length:Math.min(6,chosen.length)},async()=>{
      while(next<chosen.length){const index=next++,id=chosen[index];const response=await fetch('/api/orders/'+id);
        if(!response.ok)throw new Error('לא ניתן לטעון את הזמנה '+id+'. יש לרענן את הרשימה ולנסות שוב.');results[index]=await response.json();}
    }));}catch(error){if(token!==loadVersion)return;throw error;}
    if(token!==loadVersion)return;
    const entries=results.flatMap(order=>host.buildEntries(order).map(entry=>({...entry,
      fullLabel:'הזמנה '+(order.order_num||order.id)+' · '+entry.label,
      label:results.length>1?(order.order_num||order.id)+' / '+entry.itemNumber:entry.label})));host.setEntries(entries);host.resetPolicies();
    byId('straightStockMeta').textContent=results.map(order=>(order.order_num||order.id)+' · '+(order.customer_name||'')).join(' | ');
    byId('straightStockKerf').value='0';byId('straightStockSeparateOrders').checked=false;host.renderItems();host.renderPolicies();
    await window.IronBendCuttingInventory.open(orderIds,invalidate);
  }
  async function calculate(){
    if(busy)return;host.syncEntries();const entries=host.getEntries().filter(entry=>entry.selected&&entry.selectedQuantity>0);
    if(!entries.length){byId('straightStockResults').textContent='לא נבחרו פריטים לחיתוך.';return;}
    busy=true;byId('straightStockCalculate').disabled=true;
    try{
      const policies=host.getPolicies(entries);
      // Auto uses actual Inventory lengths, not an invented unlimited 6/12 pool.
      for(const diameter of new Set(entries.map(entry=>entry.diameter))){const choice=host.getPolicyChoice(diameter);if(choice==='auto')policies[diameter]={allowMixedStockLengths:true};if(choice==='single')policies[diameter]={allowMixedStockLengths:false};}
      const plan=await window.IronBendCuttingInventory.calculate({pieces:entries.map(entry=>({...entry,quantity:entry.selectedQuantity})),groupPolicies:policies,
        kerfMm:Math.max(0,Number(byId('straightStockKerf').value)||0),separateOrders:byId('straightStockSeparateOrders').checked});
      if(!byId('straightStockOverlay').classList.contains('show'))return;
      host.renderPlan(plan);
    }catch(error){if(!error.cancelled&&byId('straightStockOverlay').classList.contains('show')){const p=document.createElement('p');p.className='cut-warning';p.textContent=error.message;byId('straightStockResults').replaceChildren(p);}}
    finally{busy=false;byId('straightStockCalculate').disabled=false;}
  }
  function close(){loadVersion++;window.IronBendCuttingInventory.close();}
  function changed(){window.IronBendCuttingInventory.cancel();invalidate();}
  return {configure,open,calculate,close,changed};
})();
