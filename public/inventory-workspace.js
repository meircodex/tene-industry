(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => Number(value || 0).toLocaleString('he-IL', {maximumFractionDigits:0});
  const labels = {coil:'גליל',straight:'ליפט / מוטות ישרים',bent:'מכופף',mesh:'רשת'};
  let loadRevision=0;
  const state = {rows:[],sort:'label',direction:1,loaded:false,draft:[]};
  const errors = {
    Forbidden:'אין לך הרשאה לפעולה זו. אישור מלאי דורש מנהל.',
    stocktake_preview_stale:'המלאי השתנה מאז הבדיקה. יש לבדוק שוב את ההפרשים.',
    historical_count_requires_reconciliation:'יש להזין ולאשר את התנועות שבוצעו מאז הספירה בכל שורה.',
    lot_created_after_count_cutoff:'אצווה זו נקלטה אחרי מועד הספירה. יש לבדוק את מועד הספירה.',
    duplicate_confirmation_required:'נמצאה תעודה דומה. יש לבדוק כפילות לפני אישור.',
    diameter_required:'יש להזין קוטר בכל שורת ברזל.',
    invalid_purchase_quantity:'יש להזין כמות חיובית; רשתות נרשמות ביחידות שלמות.',
    mesh_specification_required:'יש להשלים את מפרט הרשת.',
  };
  async function api(path, options) {
    const response = await fetch(path, options && {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options)});
    const data = await response.json().catch(() => ({}));
    if(data.offline)throw new Error('אין חיבור לשרת. אי אפשר לעדכן מלאי במצב לא מקוון.');
    if (!response.ok) {const error=new Error(errors[data.error] || (response.status===403 ? errors.Forbidden : data.error || 'טעינת הנתונים נכשלה'));error.code=data.error;throw error;}
    return data;
  }
  function meshDescription(s) {
    return `${s.length_mm/1000} × ${s.width_mm/1000} מ׳ · Ø${s.longitudinal_diameter_mm}/Ø${s.transverse_diameter_mm} · מרווח ${s.longitudinal_spacing_mm/10} × ${s.transverse_spacing_mm/10} ס״מ${s.grade?' · '+s.grade:''}${s.standard_code?' · '+s.standard_code:''}`;
  }
  function visibleRows() {
    const type=$('inventoryType').value,diameter=$('inventoryDiameter').value;
    return state.rows.filter(row => (!type||row.type===type)&&(!diameter||row.diameter===Number(diameter))&&(!$('inventoryShortages').checked||row.buy>0))
      .sort((a,b) => state.direction*(typeof a[state.sort]==='number' ? a[state.sort]-b[state.sort] : String(a[state.sort]).localeCompare(String(b[state.sort]),'he')));
  }
  function render() {
    const rows=visibleRows();
    $('inventoryDailyRows').innerHTML=rows.map(row=>`<tr>
      <td><button class="inventory-link" data-filter-type="${row.type}" data-filter-diameter="${row.diameter}">${escape(row.label)}</button><div class="material-shape">${escape(row.specification)}</div></td>
      <td>${number(row.stock)} ${row.unitLabel}</td><td>${number(row.demand)} ${row.unitLabel}</td>
      <td><span class="badge ${row.available<0?'badge-danger':'badge-ok'}">${row.available<0?'חוסר':'פנוי'} ${number(Math.abs(row.available))} ${row.unitLabel}</span></td>
      <td>${number(row.incoming)} ${row.unitLabel}</td><td>${row.buy>0?`<strong class="inventory-shortage">${number(row.buy)} ${row.unitLabel}</strong>`:'אין צורך'}</td></tr>`).join('') || '<tr><td colspan="6" class="inventory-message">אין פריטים בתצוגה זו.</td></tr>';
    document.querySelectorAll('[data-inventory-sort]').forEach(button=>{
      const active=button.dataset.inventorySort===state.sort;
      button.textContent=button.dataset.label+(active?(state.direction===1?' ↑':' ↓'):' ↕');
      button.closest('th').setAttribute('aria-sort',active?(state.direction===1?'ascending':'descending'):'none');
    });
    $('inventoryPurchase').disabled=!state.loaded||!rows.some(row=>row.buy>0);
  }
  async function reload() {
    const revision=++loadRevision;
    state.loaded=false;$('inventoryPurchase').disabled=true;$('inventoryDailyRows').innerHTML='<tr><td colspan="6" class="inventory-message">טוען מלאי וחוסרים...</td></tr>';
    try {
      const params=new URLSearchParams({waste_percent:$('inventoryWaste').value||'0',safety_stock_kg:$('inventorySafety').value||'0'});
      if($('inventoryThrough').value)params.set('through_date',$('inventoryThrough').value);
      const plan=await api('/api/procurement/plan?'+params);
      if(revision!==loadRevision)return;
      state.rows=plan.groups.map(row=>({type:row.material_type,diameter:row.diameter,label:`${labels[row.material_type]||row.material_type} Ø${row.diameter}`,stock:row.physical_stock_kg,demand:row.backlog_kg,available:row.physical_stock_kg-row.backlog_kg,incoming:row.incoming_kg,buy:row.recommended_purchase_kg,unitLabel:'ק״ג',specification:row.material_type==='straight'?'יש לבדוק אורך, דרגה ותקן לפני הזמנה':'יש לבדוק דרגה ותקן לפני הזמנה'}));
      state.rows.push(...(plan.mesh_groups||[]).map(row=>({type:'mesh',diameter:row.specification.longitudinal_diameter_mm,label:`רשת Ø${row.specification.longitudinal_diameter_mm}/Ø${row.specification.transverse_diameter_mm}`,specification:meshDescription(row.specification),stock:row.physical_units,demand:row.required_units,available:row.available_units,incoming:row.incoming_units,buy:row.recommended_purchase_units,unitLabel:'יחידות',meshSpecification:row.specification})));
      const previous=$('inventoryDiameter').value;
      $('inventoryDiameter').innerHTML='<option value="">כל הקטרים</option>'+[...new Set(state.rows.map(row=>row.diameter))].sort((a,b)=>a-b).map(d=>`<option value="${d}">Ø${d}</option>`).join('');
      $('inventoryDiameter').value=previous;state.loaded=true;render();
    } catch(error) {
      if(revision!==loadRevision)return;
      state.rows=[];$('inventoryDailyRows').innerHTML=`<tr><td colspan="6" class="inventory-message">${escape(error.message)} <button class="btn btn-outline btn-sm" id="inventoryRetry">נסה שוב</button></td></tr>`;
      $('inventoryRetry')?.addEventListener('click',reload);
    }
  }
  function openModal(id) {$(id).classList.add('open');$(id).querySelector('input,select,button')?.focus();}
  function closeModal(id) {$(id).classList.remove('open');}
  async function openPurchase() {
    if(!state.loaded)return;
    state.draft=visibleRows().filter(row=>row.buy>0).map(row=>({material_type:row.type,diameter:row.diameter,specification:row.specification,quantity:row.buy,notes:''}));
    if(!state.draft.length)return;
    renderDraft();openModal('inventoryPurchaseModal');
    try {const suppliers=await api('/api/suppliers');$('purchaseSupplier').innerHTML='<option value="">ללא בחירת ספק</option>'+suppliers.map(s=>`<option value="${s.id}">${escape(s.name)}</option>`).join('');}
    catch(error){$('purchaseMessage').textContent=error.message;}
  }
  function renderDraft() {
    $('purchaseDraftRows').innerHTML=state.draft.map((row,i)=>`<tr data-draft-index="${i}">
      <td><select aria-label="סוג חומר" data-field="material_type">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${row.material_type===key?'selected':''}>${label}</option>`).join('')}</select></td>
      <td><input aria-label="קוטר במ״מ" data-field="diameter" type="number" min="0.1" step="0.1" value="${escape(row.diameter)}"></td>
      <td><input aria-label="מפרט ואורך" data-field="specification" value="${escape(row.specification)}"></td>
      <td><input aria-label="כמות להזמנה" data-field="quantity" type="number" min="${row.material_type==='mesh'?'1':'0.001'}" step="${row.material_type==='mesh'?'1':'0.001'}" value="${escape(row.quantity)}"></td>
      <td>${row.material_type==='mesh'?'יחידות':'ק״ג'}</td><td><input aria-label="הערות שורה" data-field="notes" value="${escape(row.notes)}"></td>
      <td><button class="btn btn-outline btn-sm" data-remove="${i}" aria-label="הסרת שורה ${i+1}">הסר</button></td></tr>`).join('');
  }
  async function downloadPurchase() {
    const button=$('purchaseDownload');button.disabled=true;$('purchaseMessage').textContent='';
    try {
      const payload={supplier_id:$('purchaseSupplier').value||null,expected_date:$('purchaseDate').value,reference:$('purchaseReference').value,notes:$('purchaseNotes').value,lines:state.draft};
      const response=await fetch('/api/procurement/purchase-draft/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){const result=await response.json();throw new Error(errors[result.error]||result.error||'הפקת הקובץ נכשלה');}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='טיוטת-הזמנת-רכש.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      $('purchaseMessage').textContent='הקובץ הוכן להורדה. המלאי לא השתנה.';
    } catch(error){$('purchaseMessage').textContent=error.message;}finally{button.disabled=false;}
  }
  document.querySelectorAll('[data-inventory-sort]').forEach(button=>{button.dataset.label=button.textContent;button.addEventListener('click',()=>{const field=button.dataset.inventorySort;state.direction=state.sort===field?-state.direction:1;state.sort=field;render();});});
  ['inventoryType','inventoryDiameter','inventoryShortages'].forEach(id=>$(id).addEventListener('change',render));
  ['inventoryThrough','inventoryWaste','inventorySafety'].forEach(id=>$(id).addEventListener('change',reload));
  $('inventoryDailyRows').addEventListener('click',event=>{const button=event.target.closest('[data-filter-type]');if(button){$('inventoryType').value=button.dataset.filterType;$('inventoryDiameter').value=button.dataset.filterDiameter;render();}});
  $('inventoryPurchase').addEventListener('click',openPurchase);
  $('purchaseAddRow').addEventListener('click',()=>{state.draft.push({material_type:'coil',diameter:'',specification:'',quantity:1,notes:''});renderDraft();});
  $('purchaseDraftRows').addEventListener('input',event=>{const row=event.target.closest('[data-draft-index]');if(!row||!event.target.dataset.field)return;state.draft[Number(row.dataset.draftIndex)][event.target.dataset.field]=event.target.value;});
  $('purchaseDraftRows').addEventListener('change',event=>{if(event.target.dataset.field==='material_type')renderDraft();});
  $('purchaseDraftRows').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(button){state.draft.splice(Number(button.dataset.remove),1);renderDraft();}});
  $('purchaseDownload').addEventListener('click',downloadPurchase);
  document.querySelectorAll('[data-inventory-close]').forEach(button=>button.addEventListener('click',()=>closeModal(button.dataset.inventoryClose)));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.inventory-overlay.open').forEach(modal=>closeModal(modal.id));});
  // Refresh on return to the page, without discarding an in-progress purchase draft.
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadSummary();});
  let socket,reconnectTimer,refreshTimer,leaving=false;
  function connect(){
    if(leaving||!window.IronBendAuth?.accessToken())return;
    socket=new WebSocket(window.IronBendAuth.webSocketUrl('/'));
    socket.onmessage=event=>{try{if(['inventory_changed','new_order','order_status','order_item_added','order_item_updated','order_item_deleted','order_deleted'].includes(JSON.parse(event.data).type)){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>loadSummary(),150);}}catch{}};
    socket.onclose=()=>{if(!leaving)reconnectTimer=setTimeout(connect,5000);};
  }
  window.addEventListener('pagehide',()=>{leaving=true;clearTimeout(reconnectTimer);clearTimeout(refreshTimer);socket?.close();});
  window.addEventListener('pageshow',()=>{if(leaving){leaving=false;connect();loadSummary();}});
  connect();
  window.InventoryWorkspace={reload,visibleRows,openModal,closeModal,api,escape,meshDescription};
  window.IronBendDataContracts?.applyDataContracts();
  $('inventoryDailyRows').title='מלאי וחוסרים לפי סוג וקוטר; רשתות ביחידות וברזל בק״ג.';
  $('kpiTotal').title='יתרת ברזל מאושרת בק״ג, כולל התאמות ספירה ולפני שריונים. רשתות מוצגות בנפרד ביחידות.';
  reload();
})();
