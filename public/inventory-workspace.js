(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => Number(value || 0).toLocaleString('he-IL', {maximumFractionDigits:0});
  const labels = {coil:'גליל',straight:'ליפט / מוטות ישרים',bent:'מכופף',mesh:'רשת'};
  const purchaseUnits=window.IronBendPurchaseUnits;
  let loadRevision=0;
  const state = {rows:[],sort:'label',direction:1,loaded:false,draft:[]};
  const errors = {
    Forbidden:'אין לך הרשאה לפעולה זו. אישור מלאי דורש מנהל.',
    stocktake_preview_stale:'המלאי השתנה מאז הבדיקה. יש לבדוק שוב את ההפרשים.',
    historical_count_requires_reconciliation:'יש להזין ולאשר את התנועות שבוצעו מאז הספירה בכל שורה.',
    lot_created_after_count_cutoff:'אצווה זו נקלטה אחרי מועד הספירה. יש לבדוק את מועד הספירה.',
    duplicate_confirmation_required:'נמצאה תעודה דומה. יש לבדוק כפילות לפני אישור.',
    diameter_required:'יש להזין קוטר בכל שורת ברזל.',
    invalid_purchase_quantity:'יש להזין כמות חיובית: גלילים ורשתות בשלמים, חבילות בשלמים או בחצאים.',
    minimum_purchase_30_tonnes:'מינימום הזמנה הוא 30 טון לסוג חומר אחד. יש להשלים בקטרים נוספים מאותו סוג.',
    mixed_purchase_material_types:'אין לערבב גלילים וליפטים באותה הזמנה.',
    purchase_length_required:'יש לבחור אורך נפרד לכל שורת ליפטים.',
    invalid_unit_weight:'יש להזין משקל חיובי לגליל או לחבילה.',
    invalid_purchase_length:'יש להזין אורך תקין במטרים.',
    mesh_specification_required:'יש להשלים את מפרט הרשת.',
    mesh_uniform_diameter_required:'יש להזין קוטר אחיד לכל הרשת.',
    mesh_bar_count_confirmation_required:'יש לבדוק ולאשר את מספר המוטות לפני שמירה.',
  };
  async function api(path, options) {
    const response = await fetch(path, options && {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options)});
    const data = await response.json().catch(() => ({}));
    if(data.offline)throw new Error('אין חיבור לשרת. אי אפשר לעדכן מלאי במצב לא מקוון.');
    if (!response.ok) {const error=new Error(errors[data.error] || (response.status===403 ? errors.Forbidden : data.user_message || data.error || 'טעינת הנתונים נכשלה'));error.code=data.error;throw error;}
    return data;
  }
  function meshDescription(s) {
    return `${s.length_mm/1000} × ${s.width_mm/1000} מ׳ · Ø${s.longitudinal_diameter_mm} · מרווח ${s.longitudinal_spacing_mm/10} × ${s.transverse_spacing_mm/10} ס״מ${s.grade?' · '+s.grade:''}${s.standard_code?' · '+s.standard_code:''}`;
  }
  function visibleRows() {
    const type=$('inventoryType').value,diameter=$('inventoryDiameter').value;
    return state.rows.filter(row => (!type||row.type===type)&&(!diameter||row.diameter===Number(diameter))&&(!$('inventoryShortages').checked||row.buy>0))
      .sort((a,b) => {
        const numeric=['stock','demand','available','incoming','buy','lengthMm','barCount'].includes(state.sort);
        const first=a[state.sort],second=b[state.sort];
        const compared=numeric?(first==null?1:second==null?-1:first-second):String(first).localeCompare(String(second),'he',{numeric:true});
        return state.direction*((first==null&&second==null?0:compared)||a.diameter-b.diameter||(a.lengthMm??Infinity)-(b.lengthMm??Infinity));
      });
  }
  function render() {
    const rows=visibleRows();
    $('inventoryDailyRows').innerHTML=rows.map(row=>`<tr ${row.type!=='mesh'?`data-demand-row="${state.rows.indexOf(row)}" style="cursor:pointer"`:""}>
      <td><button class="inventory-link" ${row.type==='mesh'?`data-filter-type="${row.type}" data-filter-diameter="${row.diameter}"`:`data-demand-open="${state.rows.indexOf(row)}" aria-expanded="false"`}>${escape(row.label)}</button><div class="material-shape">${escape(row.specification)}</div>${row.type==='mesh'?`<div class="material-shape">${row.theoreticalWeight!=null?`תיאורטי לרשת: ${row.theoreticalWeight.toFixed(2)} ק״ג · במלאי: ${(row.theoreticalWeight*row.stock).toFixed(2)} ק״ג`:'משקל היסטורי — נדרשת בדיקת מפרט'}</div>`:''}</td>
      <td>${row.type==='straight'?(row.lengthMm?escape(row.lengthMm/1000):'אורך לא צוין'):'—'}</td>
      <td>${number(row.stock)} ${row.unitLabel}</td><td title="מספר מוטות משוער לפי משקל המלאי, אורך המוט ומשקל למטר לפי הקוטר; מעוגל מטה">${row.barCount==null?'—':`≈ ${number(row.barCount)}`}</td><td>${number(row.demand)} ${row.unitLabel}${row.reviewKg>0?`<div class="inventory-review">מתוכם ${number(row.reviewKg)} ק״ג צריכת עבר לבדיקה</div>`:""}</td>
      <td><span class="badge ${row.available<0?'badge-danger':'badge-ok'}">${row.available<0?'חוסר':'פנוי'} ${number(Math.abs(row.available))} ${row.unitLabel}</span></td>
      <td>${number(row.incoming)} ${row.unitLabel}</td><td>${row.buy>0?`<strong class="inventory-shortage">${number(row.buy)} ${row.unitLabel}</strong>`:'אין צורך'}</td></tr>`).join('') || '<tr><td colspan="8" class="inventory-message">אין פריטים בתצוגה זו.</td></tr>';
    document.querySelectorAll('[data-inventory-sort]').forEach(button=>{
      const active=button.dataset.inventorySort===state.sort;
      button.textContent=button.dataset.label+(active?(state.direction===1?' ↑':' ↓'):' ↕');
      button.closest('th').setAttribute('aria-sort',active?(state.direction===1?'ascending':'descending'):'none');
    });
    $('inventoryPurchase').disabled=!state.loaded;
  }
  async function showDemand(index,offset=0) {
    const row=state.rows[index],tr=$('inventoryDailyRows').querySelector(`[data-demand-row="${index}"]`);
    if(!row||!tr)return;
    const next=tr.nextElementSibling;if(next?.classList.contains('inventory-demand-detail'))next.remove();
    const detail=document.createElement('tr');detail.className='inventory-demand-detail';
    detail.innerHTML='<td colspan="8">טוען את ההזמנות והפריטים...</td>';tr.after(detail);
    tr.querySelector('button')?.setAttribute('aria-expanded','true');
    try {
      const params=new URLSearchParams(state.planParams||'');
      params.set('include_details','true');params.set('diameter',row.diameter);params.set('material_type',row.type);
      params.set('nominal_length_mm',row.lengthMm??'');params.set('detail_limit','25');params.set('detail_offset',offset);
      const plan=await api('/api/procurement/plan?'+params),group=plan.groups[0],data=group?.demand_details;
      if(!detail.isConnected)return;
      if(!data)throw new Error('לא ניתן לטעון פירוט לפריט זה');
      detail.innerHTML=`<td colspan="8"><div class="inventory-demand-box"><strong>${escape(row.label)}${row.lengthMm?` · ${row.lengthMm/1000} מטר`:''} — פירוט דרישה: ${number(group.backlog_kg)} ק״ג</strong>
        <p>מלאי פיזי: ${number(group.physical_stock_kg)} ק״ג. צריכות עבר המסומנות לבדיקה טרם שינו את היתרה הרשומה.</p>
        <div class="table-wrap"><table><thead><tr><th>הזמנה / לקוח</th><th>פריט</th><th>צורה ומידות</th><th>כמות</th><th>דרישה שנותרה</th><th>מצב</th><th></th></tr></thead><tbody>${data.items.map(item=>`<tr>
          <td><strong>${escape(item.order_num)}</strong><div>${escape(item.customer_name)}</div></td><td>${escape(item.item_number)}</td>
          <td><div class="inventory-demand-shape">${item.shape_svg}</div><div>${escape(item.shape_name)}${item.length_mm?` · אורך פריסה ${number(item.length_mm/10)} ס״מ`:''}</div></td>
          <td>${number(item.quantity)} יח׳</td><td><strong>${number(item.remaining_kg)} ק״ג</strong>${item.recorded_consumption_kg>0?`<div>נרשם שנצרך: ${number(item.recorded_consumption_kg)} ק״ג</div>`:''}</td>
          <td class="${item.requires_review?'inventory-review':''}">${escape(item.status)}</td><td><a class="btn btn-outline btn-sm" href="/orders.html?id=${Number(item.order_id)}#item-row-${Number(item.item_id)}">פתח הזמנה</a></td></tr>`).join('')||'<tr><td colspan="7">אין דרישה פתוחה בשורה זו.</td></tr>'}</tbody></table></div>
        <div class="inventory-demand-pages">${offset>0?`<button class="btn btn-outline btn-sm" data-row="${index}" data-demand-page="${Math.max(0,offset-25)}">הקודם</button>`:''}<span>${data.total?`${offset+1}–${Math.min(offset+25,data.total)} מתוך ${data.total}`:'0 פריטים'}</span>${offset+25<data.total?`<button class="btn btn-outline btn-sm" data-row="${index}" data-demand-page="${offset+25}">הבא</button>`:''}</div></div></td>`;
    }catch(error){if(detail.isConnected)detail.innerHTML=`<td colspan="8">${escape(error.message)} <button class="btn btn-outline btn-sm" data-row="${index}" data-demand-page="${offset}">נסה שוב</button></td>`;}
  }
  async function reload() {
    const revision=++loadRevision;
    state.loaded=false;$('inventoryPurchase').disabled=true;$('inventoryDailyRows').innerHTML='<tr><td colspan="8" class="inventory-message">טוען מלאי וחוסרים...</td></tr>';
    try {
      const params=new URLSearchParams({waste_percent:$('inventoryWaste').value||'0',safety_stock_kg:$('inventorySafety').value||'0'});
      if($('inventoryThrough').value)params.set('through_date',$('inventoryThrough').value);
      params.set('stock_basis',$('inventoryStockBasisSelect').value);
      const plan=await api('/api/procurement/plan?'+params);
      state.planParams=params.toString();
      state.policy=plan.purchase_policy;
      if(revision!==loadRevision)return;
      state.rows=plan.groups.map(row=>({type:row.material_type,diameter:row.diameter,lengthMm:row.nominal_length_mm??null,barCount:row.estimated_bar_count??null,label:`${labels[row.material_type]||row.material_type} Ø${row.diameter}`,stock:row.physical_stock_kg,reviewKg:row.completed_review_kg||0,demand:row.backlog_kg,available:row.available_stock_kg??(row.physical_stock_kg-row.backlog_kg),incoming:row.incoming_kg,buy:row.recommended_purchase_kg,unitLabel:'ק״ג',specification:row.requires_length_review?'יש להשלים אורך ולבדוק דרגה ותקן לפני הזמנה':'יש לבדוק דרגה ותקן לפני הזמנה'}));
      state.rows.push(...(plan.mesh_groups||[]).map(row=>({type:'mesh',diameter:row.specification.longitudinal_diameter_mm,label:`רשת Ø${row.specification.longitudinal_diameter_mm}`,specification:meshDescription(row.specification),stock:row.physical_units,demand:row.required_units,available:row.available_units,incoming:row.incoming_units,buy:row.recommended_purchase_units,unitLabel:'יחידות',meshSpecification:row.specification,theoreticalWeight:row.specification.calculation?.weightKg})));
      const previous=$('inventoryDiameter').value;
      $('inventoryDiameter').innerHTML='<option value="">כל הקטרים</option>'+[...new Set(state.rows.map(row=>row.diameter))].sort((a,b)=>a-b).map(d=>`<option value="${d}">Ø${d}</option>`).join('');
      $('inventoryDiameter').value=previous;state.loaded=true;render();
    } catch(error) {
      if(revision!==loadRevision)return;
      state.rows=[];$('inventoryDailyRows').innerHTML=`<tr><td colspan="8" class="inventory-message">${escape(window.IronBendMessages?.text(error.message) ?? error.message)} <button class="btn btn-outline btn-sm" id="inventoryRetry">נסה שוב</button></td></tr>`;
      $('inventoryRetry')?.addEventListener('click',reload);
    }
  }
  function openModal(id) {$(id).classList.add('open');$(id).querySelector('input,select,button')?.focus();}
  function closeModal(id) {$(id).classList.remove('open');}
  function purchaseType(){return $('purchaseMaterialType').value;}
  function draftLine(type,row={}){
    const weight=purchaseUnits.defaultUnitWeight(type);
    return {material_type:type,diameter:row.diameter||'',specification:row.specification||'',length_m:type==='straight'&&row.lengthMm?row.lengthMm/1000:'',purchase_unit:purchaseUnits.purchaseUnit(type).unit,unit_weight_kg:weight,shortage_kg:row.unitLabel==='ק״ג'?row.buy:null,quantity:row.buy?purchaseUnits.suggestedQuantity(type,row.buy,weight):1,notes:''};
  }
  function buildPurchase(){
    const type=purchaseType(),diameter=$('inventoryDiameter').value;
    state.draft=state.rows.filter(row=>row.type===type&&row.buy>0&&(!diameter||row.diameter===Number(diameter))).map(row=>draftLine(type,row));
    if(['coil','straight'].includes(type)){
      const policy=state.policy?.types.find(row=>row.material_type===type),target=Math.max(30000,policy?.recommended_order_kg||0);
      const current=state.draft.reduce((sum,row)=>sum+purchaseUnits.estimatedWeight(row.quantity,row.unit_weight_kg),0);
      if(current<target){const extra=draftLine(type);extra.quantity=purchaseUnits.suggestedQuantity(type,target-current,extra.unit_weight_kg);extra.notes='השלמה למינימום הזמנה — יש לבחור קוטר';state.draft.push(extra);}
    }
    if(!state.draft.length)state.draft.push(draftLine(type));
    $('purchaseMessage').textContent='';renderDraft();
  }
  async function openPurchase() {
    if(!state.loaded)return;
    $('purchaseMaterialType').value=$('inventoryType').value||'coil';
    buildPurchase();openModal('inventoryPurchaseModal');
    try {const suppliers=await api('/api/suppliers');$('purchaseSupplier').innerHTML='<option value="">ללא בחירת ספק</option>'+suppliers.map(s=>`<option value="${s.id}">${escape(s.name)}</option>`).join('');}
    catch(error){$('purchaseMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  }
  function updatePurchaseTotals(){
    let total=0;
    state.draft.forEach((row,i)=>{
      const mass=['coil','bundle'].includes(row.purchase_unit)?purchaseUnits.estimatedWeight(row.quantity,row.unit_weight_kg):row.purchase_unit==='kg'?Number(row.quantity):null;
      if(Number.isFinite(mass))total+=mass;
      const box=$(`draftMass-${i}`);if(box)box.textContent=mass===null?'':`≈ ${number(mass)} ק״ג להזמנה`;
    });
    const packages=['coil','straight'].includes(purchaseType());
    $('purchaseTotals').textContent=packages?`סה״כ משקל משוער להזמנה: ${number(total)} ק״ג. מינימום הזמנה: 30,000 ק״ג.${total<30000?` להשלמה: ${number(30000-total)} ק״ג — אפשר בקטרים אחרים מאותו סוג.`:''}`:purchaseType()==='mesh'?'רשתות מוזמנות ביחידות; אין ערבוב עם גלילים או ליפטים.':'ברזל מכופף מוצג בק״ג.';
    $('purchaseDownload').disabled=packages&&total<30000;
  }
  function renderDraft() {
    $('purchaseDraftRows').innerHTML=state.draft.map((row,i)=>`<tr data-draft-index="${i}">
      <td>${escape(labels[row.material_type])}</td>
      <td><input aria-label="קוטר במ״מ" data-field="diameter" type="number" min="0.1" step="0.1" value="${escape(row.diameter)}"></td>
      <td><input aria-label="מפרט" data-field="specification" value="${escape(row.specification)}"></td>
      <td><input aria-label="אורך במטרים" data-field="length_m" type="number" min="0.1" step="0.1" list="purchaseLengths" value="${escape(row.length_m)}" ${['straight','bent'].includes(row.material_type)?'':'disabled'}></td>
      <td><input aria-label="כמות להזמנה" data-field="quantity" type="number" min="${row.purchase_unit==='bundle'?'0.5':'1'}" step="${row.purchase_unit==='bundle'?'0.5':'1'}" value="${escape(row.quantity)}">${row.shortage_kg!==null?`<div class="material-shape">חוסר: ${number(row.shortage_kg)} ק״ג</div>`:''}</td>
      <td>${escape(purchaseUnits.purchaseUnit(row.material_type).label)}</td>
      <td>${['coil','bundle'].includes(row.purchase_unit)?`<input aria-label="ק״ג ליחידה" data-field="unit_weight_kg" type="number" min="1" step="1" value="${escape(row.unit_weight_kg)}">`:''}<div class="material-shape" id="draftMass-${i}"></div></td>
      <td><input aria-label="הערות שורה" data-field="notes" value="${escape(row.notes)}"></td>
      <td><button class="btn btn-outline btn-sm" data-remove="${i}" aria-label="הסרת שורה ${i+1}">הסר</button></td></tr>`).join('');
    updatePurchaseTotals();
  }
  async function downloadPurchase() {
    const button=$('purchaseDownload');button.disabled=true;$('purchaseMessage').textContent='';
    try {
      const payload={supplier_id:$('purchaseSupplier').value||null,expected_date:$('purchaseDate').value,reference:$('purchaseReference').value,notes:$('purchaseNotes').value,enforce_supplier_policy:true,lines:state.draft};
      const response=await fetch('/api/procurement/purchase-draft/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){const result=await response.json();throw new Error(errors[result.error]||result.user_message || result.error||'הפקת הקובץ נכשלה');}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='טיוטת-הזמנת-רכש.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      $('purchaseMessage').textContent='הקובץ הוכן להורדה. המלאי לא השתנה.';
    } catch(error){$('purchaseMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}finally{updatePurchaseTotals();}
  }
  document.querySelectorAll('[data-inventory-sort]').forEach(button=>{button.dataset.label=button.textContent;button.addEventListener('click',()=>{const field=button.dataset.inventorySort;state.direction=state.sort===field?-state.direction:1;state.sort=field;render();});});
  ['inventoryType','inventoryDiameter','inventoryShortages'].forEach(id=>$(id).addEventListener('change',render));
  ['inventoryThrough','inventoryWaste','inventorySafety','inventoryStockBasisSelect'].forEach(id=>$(id).addEventListener('change',reload));
  $('inventoryDailyRows').addEventListener('click',event=>{
    const page=event.target.closest('[data-demand-page]');
    if(page){showDemand(Number(page.dataset.row),Number(page.dataset.demandPage));return;}
    if(event.target.closest('.inventory-demand-detail'))return;
    const tr=event.target.closest('[data-demand-row]');
    if(tr){const id=Number(tr.dataset.demandRow),detail=tr.nextElementSibling;if(detail?.classList.contains('inventory-demand-detail')){detail.remove();tr.querySelector('button')?.setAttribute('aria-expanded','false');}else showDemand(id,0);return;}
    const button=event.target.closest('[data-filter-type]');if(button){$('inventoryType').value=button.dataset.filterType;$('inventoryDiameter').value=button.dataset.filterDiameter;render();}
  });
  $('inventoryPurchase').addEventListener('click',openPurchase);
  $('purchaseMaterialType').addEventListener('change',buildPurchase);
  $('purchaseAddRow').addEventListener('click',()=>{state.draft.push(draftLine(purchaseType()));renderDraft();});
  $('purchaseDraftRows').addEventListener('input',event=>{const row=event.target.closest('[data-draft-index]');if(!row||!event.target.dataset.field)return;state.draft[Number(row.dataset.draftIndex)][event.target.dataset.field]=event.target.value;updatePurchaseTotals();});
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
  $('inventoryDailyRows').title='מלאי וחוסרים לפי סוג וקוטר, וליפטים גם לפי אורך; מספר המוטות משוער לפי משקל. רשתות ביחידות וברזל בק״ג.';
  $('kpiTotal').title='יתרת ברזל מאושרת בק״ג, כולל התאמות ספירה ולפני שריונים. רשתות מוצגות בנפרד ביחידות.';
  reload();
})();
