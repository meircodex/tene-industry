'use strict';
window.IronBendCuttingInventory=(()=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let ids=[],snapshot=null,settings=new Map(),changed=()=>{},worker=null,rejectWork=null,requestVersion=0,session=0,closed=true;
  const weight=(kg)=>Number(kg||0).toLocaleString('he-IL',{maximumFractionDigits:3});
  const cancelled=()=>Object.assign(new Error('החישוב בוטל'),{cancelled:true});
  function cancel(){requestVersion++;if(worker)worker.terminate();worker=null;if(rejectWork)rejectWork(cancelled());rejectWork=null;}
  function sources(){
    if(!snapshot)throw new Error('המלאי טרם נטען. יש לרענן את המלאי לפני חישוב התוכנית.');
    return snapshot.sources.filter(row=>settings.get(row.id)?.selected).map(row=>{
      const config=settings.get(row.id),length=Number(row.nominal_length_mm);
      if(!Number.isFinite(length)||length<=0)throw new Error('באצווה '+(row.lot_number||row.id)+' חסר אורך במלאי. יש להשלים את ההפרדה לאורכי המוטות במודול המלאי ולרענן.');
      const unitWeight=Number(row.unit_weight_kg);
      if(!Number.isFinite(unitWeight)||unitWeight<=0||!Number.isSafeInteger(row.calculated_bar_count))throw new Error('לא ניתן לחשב מספר מוטות באצווה '+(row.lot_number||row.id));
      return {id:row.id,lot_number:row.lot_number,diameter:row.diameter,material:config.material,grade:row.grade,standard:row.standard_code,
        stockLengthMm:length,availableKg:row.available_kg,unitWeightKg:unitWeight,count:row.calculated_bar_count};
    });
  }
  function render(){
    const container=document.getElementById('straightStockInventory');if(!container)return;
    if(!snapshot){container.innerHTML='<p>טוען מלאי מוטות מאושר…</p>';return;}
    container.innerHTML=`<div class="straight-stock-policy"><b>מלאי לחיתוך</b><button type="button" class="straight-stock-action" id="cutStockRefresh">רענן מלאי</button><small>נתוני מלאי: ${esc(new Date(snapshot.captured_at).toLocaleString('he-IL'))}</small></div>
      <p class="straight-stock-hint">מספר המוטות מחושב במודול המלאי לפי המשקל הרשום והאורך של כל אצווה; נכללים רק מוטות שלמים. ההפרדה בין 6 ל־12 מטר נקראת מהמלאי. החישוב אינו צורך או משריין מלאי.</p>
      <div class="straight-stock-table-wrap"><table class="straight-stock-table"><thead><tr><th>כלול</th><th>אצווה / מיקום</th><th>קוטר / מפרט</th><th>סוג לתכנון</th><th>אורך מוט בס״מ</th><th>פיזי רשום ק״ג</th><th>מוקצה לאחרים ק״ג</th><th>לתכנון ק״ג</th><th>מוטות מחושבים</th></tr></thead><tbody>${snapshot.sources.map(row=>{
        const config=settings.get(row.id),count=row.calculated_bar_count;
        return `<tr data-cut-stock="${row.id}"><td><input type="checkbox" data-stock-use ${config.selected?'checked':''}></td><td>${esc(row.lot_number||'אצווה '+row.id)}<small>${esc(row.warehouse_loc||'')}</small></td><td>⌀${esc(row.diameter)}<small>${esc([row.grade,row.standard_code].filter(Boolean).join(' · '))}</small></td><td><select data-stock-material aria-label="סוג ברזל לתכנון באצווה ${row.id}"><option value="ribbed" ${config.material==='ribbed'?'selected':''}>מצולע</option><option value="smooth" ${config.material==='smooth'?'selected':''}>חלק</option></select></td><td>${row.nominal_length_mm?esc(row.nominal_length_mm/10):'טרם הוגדר במלאי'}</td><td>${weight(row.physical_kg)}</td><td>${weight(row.allocated_to_other_orders_kg)}</td><td>${weight(row.available_kg)}</td><td data-stock-count>${count===null?'חסר אורך':count}</td></tr>`;
      }).join('')||'<tr><td colspan="9">לא נמצא מלאי מאושר של מוטות ישרים. סלילים אינם נכללים בתוכנית חיתוך ממוטות.</td></tr>'}</tbody></table></div>`;
    container.querySelector('#cutStockRefresh').onclick=()=>refresh().catch(showError);
    for(const row of container.querySelectorAll('[data-cut-stock]'))for(const control of row.querySelectorAll('input,select'))control.onchange=()=>{
      const config=settings.get(Number(row.dataset.cutStock));config.selected=row.querySelector('[data-stock-use]').checked;config.material=row.querySelector('[data-stock-material]').value;cancel();changed();
    };
  }
  function showError(error){if(error.cancelled)return;const el=document.getElementById('straightStockInventory');if(el){el.replaceChildren();const p=document.createElement('p');p.className='cut-warning';p.textContent=error.message;const retry=document.createElement('button');retry.type='button';retry.className='straight-stock-action';retry.textContent='רענן מלאי';retry.onclick=()=>refresh().catch(showError);el.append(p,retry);}}
  async function refresh(){
    const token=session;cancel();const request=requestVersion;snapshot=null;changed();
    let response;
    try{response=await fetch('/api/inventory/cutting-stock?order_ids='+ids.join(','));}catch(error){if(token!==session||request!==requestVersion||closed)throw cancelled();throw error;}
    if(token!==session||request!==requestVersion||closed)throw cancelled();
    if(!response.ok)throw await window.IronBendMessages.responseError(response,'טעינת מלאי המוטות נכשלה');
    const data=await response.json();
    if(token!==session||request!==requestVersion||closed)throw cancelled();
    if(!Array.isArray(data.sources))throw new Error('לא התקבלה רשימת מלאי תקינה');
    snapshot=data;
    for(const row of data.sources)if(!settings.has(row.id))settings.set(row.id,{selected:row.available_kg>0&&row.nominal_length_mm>0,material:'ribbed'});
    render();return data;
  }
  async function open(orderIds,onChanged){session++;closed=false;ids=[...orderIds];changed=onChanged;settings=new Map();snapshot=null;render();try{await refresh();}catch(error){if(!closed)showError(error);throw error;}}
  async function calculate(input){
    await refresh();if(closed)throw new Error('חלון החיתוך נסגר');const stocks=sources();if(!stocks.length)throw new Error('לא נבחר מלאי מוטות עם אורך מוגדר. יש לבדוק את יתרות 6 ו־12 מטר במודול המלאי ולרענן.');
    const token=++requestVersion;
    return new Promise((resolve,reject)=>{
      worker=new Worker('/straight-stock-worker.js?v=1');rejectWork=reject;
      const finish=()=>{worker?.terminate();worker=null;rejectWork=null;};
      worker.onmessage=event=>{if(token!==requestVersion)return;const result=event.data;finish();result.error?reject(new Error(result.error)):resolve({...result.plan,inventoryCapturedAt:snapshot.captured_at});};
      worker.onerror=()=>{finish();reject(new Error('חישוב תוכנית החיתוך לא הסתיים. יש לנסות שוב או לצמצם את הבחירה.'));};
      worker.postMessage({...input,sources:stocks});
    });
  }
  function close(){closed=true;session++;cancel();}
  return {open,calculate,cancel,close,sources};
})();
