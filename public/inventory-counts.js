(function () {
  'use strict';
  const workspace=window.InventoryWorkspace,$=id=>document.getElementById(id),esc=workspace.escape;
  let lots=[],sheets=[],pending=null,verificationLots=[];
  const fmt=value=>Number(value||0).toLocaleString('he-IL',{maximumFractionDigits:0});
  const uid=()=>crypto.randomUUID();
  const canVerify=['manager','admin'].includes(window.IronBendAuth?.currentUser()?.role);
  $('inventoryStockBasis').insertAdjacentHTML('afterend','<div id="inventoryVerificationNotice" class="card" role="status" hidden style="padding:14px;line-height:1.8"></div>');
  function renderVerificationNotice(){
    const box=$('inventoryVerificationNotice');box.hidden=!verificationLots.length;
    if(!verificationLots.length){box.innerHTML='';return;}
    box.innerHTML=`<strong>חומר שהתקבל וממתין לאימות: ${fmt(verificationLots.reduce((sum,row)=>sum+Number(row.weight_received),0))} ק״ג</strong><br>הקבלות אושרו, אך החומר עדיין אינו כלול במלאי הזמין. <button class="btn btn-outline btn-sm" id="inventoryReviewVerification">בדיקה בהכנסת מלאי</button>`;
    $('inventoryReviewVerification').addEventListener('click',()=>showTab('receipts'));
  }
  function verificationCard(row){
    const type={coil:'גלילים',straight:'ליפטים',bent:'מכופף',mesh:'רשתות'}[row.material_type]||row.material_type;
    const length=row.nominal_length_mm?` · אורך ${row.nominal_length_mm/1000} מטר`:'';
    return `<article class="receipt-card"><div class="receipt-body"><strong>${esc(type)} · קוטר ${esc(row.diameter)}${length} · ${fmt(row.weight_received)} ק״ג</strong><div><strong>הקבלה אושרה — החומר ממתין לאימות</strong></div><div class="muted">קבלה קודמת נשארה חסומה. יש לבדוק קוטר, סוג ומשקל ולעדכן את המנה הקיימת.</div><button class="btn btn-primary btn-sm" data-verify-lot="${row.id}">בדיקה ועדכון הקבלה</button></div></article>`;
  }
  $('tab-batches').insertAdjacentHTML('afterend',`<div id="tab-stocktake" class="tab-panel"><div class="card"><div class="card-header"><span class="card-title">ספירת מלאי — יתרה בפועל</span><button class="btn btn-outline btn-sm" id="countReload">רענן אצוות</button></div>
    <div class="inventory-toolbar"><div class="form-row"><label for="countTime">מועד הספירה</label><input id="countTime" type="datetime-local" step="1"></div><div class="form-row"><label for="countReason">סיבת ההתאמה</label><input id="countReason" value="ספירת מלאי"></div></div>
    <p class="inventory-caption">מזינים את הכמות שנספרה, ולא את הכמות שהתקבלה בעבר. שורות ריקות לא משתנות; אפשר להזין אפס. אם היו תנועות מאז הספירה, יש לרשום את השינוי נטו ואת פירוט הבדיקה.</p>
    <div class="inventory-table-wrap"><table><thead><tr><th>סוג / קוטר / אצווה</th><th>מיקום</th><th>יתרה במערכת</th><th>נספר (ק״ג)</th><th>תנועות מאז (+/− ק״ג)</th><th>פירוט הבדיקה</th></tr></thead><tbody id="countRows"></tbody></table></div><div class="inventory-caption"><button class="btn btn-primary" id="countPreview">בדיקת הפרשים לפני אישור</button></div>
    <h3 class="inventory-caption">רשתות — ספירה ביחידות לפי מפרט</h3><p class="inventory-caption">לרשתות יש להזין יתרה עדכנית לאחר התנועות שבוצעו מאז הספירה. כל מפרט מאושר בנפרד.</p><div class="inventory-table-wrap"><table><thead><tr><th>מפרט</th><th>יתרה</th><th>נספר כעת (יחידות)</th><th></th></tr></thead><tbody id="meshCountRows"></tbody></table></div><p id="countMessage" class="inventory-caption" role="status"></p></div></div>`);
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-overlay inventory-overlay" id="countConfirmModal" role="dialog" aria-modal="true" aria-labelledby="countConfirmTitle"><div class="modal"><h2 id="countConfirmTitle">בדיקת הפרשי ספירה</h2><div id="countConfirmRows"></div><p class="muted">אישור ירשום תנועת התאמה מתועדת. היסטוריית הקבלות והצריכה נשמרת.</p><p id="countConfirmMessage" role="status" class="muted"></p><div class="modal-footer"><button class="btn btn-outline" id="countCancel">חזרה לבדיקה</button><button class="btn btn-primary" id="countApprove">אישור התאמת מלאי</button></div></div></div>
  <div class="modal-overlay inventory-overlay" id="meshReceiptModal" role="dialog" aria-modal="true" aria-labelledby="meshReceiptTitle"><div class="modal"><h2 id="meshReceiptTitle" style="padding-inline-start:90px;line-height:1.5">הכנסת רשתות — תוספת למלאי</h2><p class="muted">הכמות תתווסף לאחר אישור הקבלה. רשתות נרשמות ביחידות ומופרדות לפי מפרט.</p><div class="form-grid" id="meshReceiptFields"></div><p id="meshReceiptMessage" class="muted" role="status"></p><div class="modal-footer"><button class="btn btn-outline" id="meshReceiptClose">סגירה</button><button class="btn btn-primary" id="meshReceiptSave">שמירה לאישור</button></div></div></div>`);
  const fields=[['longitudinal_diameter_mm','קוטר ברזל (מ״מ)',1],['length_mm','אורך רשת (מטר)',1000],['width_mm','רוחב רשת (מטר)',1000],['longitudinal_spacing_mm','מרווח בין מוטות האורך (ס״מ)',10],['transverse_spacing_mm','מרווח בין מוטות הרוחב (ס״מ)',10]];
  $('meshReceiptFields').style.gridTemplateColumns='repeat(2,minmax(0,1fr))';
  const field=([key,label])=>`<div class="form-row"><label for="mesh-${key}">${label}</label><input id="mesh-${key}" type="number" min="0.001" step="any" style="font-size:22px;height:46px"></div>`;
  $('meshReceiptFields').innerHTML=field(fields[0])+`<div class="form-row"><label for="meshUnits">כמות רשתות</label><input id="meshUnits" type="number" min="1" step="1" style="font-size:22px;height:46px"></div>`+fields.slice(1).map(field).join('')+`<div id="meshReceiptCalculated" style="grid-column:1/-1;line-height:1.8"></div><div class="form-row" style="grid-column:1/-1"><label for="meshKnownSpec">מפרט שכבר קיים במלאי</label><select id="meshKnownSpec"><option value="">הגדרת מפרט חדש</option></select></div><details style="grid-column:1/-1"><summary>תיקון מספר המוטות לפי ספירה בפועל</summary><div class="form-grid"><label>מוטות באורך הרשת<input id="meshLongCount" type="number" min="1" step="1"></label><label>מוטות ברוחב הרשת<input id="meshTransCount" type="number" min="1" step="1"></label></div></details><label style="grid-column:1/-1;display:flex;gap:8px;align-items:center"><input id="meshCountConfirmed" type="checkbox" style="width:18px;min-height:18px">בדקתי את מספר המוטות המוצע ומאשר אותו</label><div class="form-row"><label for="meshGrade">דרגת פלדה</label><input id="meshGrade"></div><div class="form-row"><label for="meshStandard">תקן</label><input id="meshStandard"></div><div class="form-row"><label for="meshNote">מספר תעודת ספק</label><input id="meshNote"></div><div class="form-row"><label for="meshSupplier">ספק</label><select id="meshSupplier"><option value="">ללא ספק</option></select></div>`;
  function receiptSpecification(){const spec={grade:$('meshGrade').value,standard_code:$('meshStandard').value};for(const[key,,factor]of fields)spec[key]=Number($(`mesh-${key}`).value)*factor;spec.transverse_diameter_mm=spec.longitudinal_diameter_mm;spec.counting_confirmed=$('meshCountConfirmed').checked;for(const[id,key]of [['meshLongCount','longitudinal_bar_count'],['meshTransCount','transverse_bar_count']])if($(id).value!=='')spec[key]=Number($(id).value);const known=sheets[Number($('meshKnownSpec').value)]?.specification;if($('meshKnownSpec').value!==''&&known){for(const key of ['longitudinal_bar_count','transverse_bar_count','edge_left_mm','edge_right_mm','edge_top_mm','edge_bottom_mm'])if(known[key]!=null)spec[key]=known[key];}return spec;}
  function updateMeshWeight(){
    try{
      const spec=receiptSpecification(),c=window.IronBendSteelRebarShapes.calculateMesh({length:spec.length_mm,width:spec.width_mm,longitudinalDiameter:spec.longitudinal_diameter_mm,transverseDiameter:spec.transverse_diameter_mm,longitudinalSpacing:spec.longitudinal_spacing_mm,transverseSpacing:spec.transverse_spacing_mm,longitudinalBarCount:spec.longitudinal_bar_count,transverseBarCount:spec.transverse_bar_count,countingConfirmed:spec.counting_confirmed,edgeLeft:spec.edge_left_mm,edgeRight:spec.edge_right_mm,edgeTop:spec.edge_top_mm,edgeBottom:spec.edge_bottom_mm}).calculated;
      const cell=(label,value)=>`<div style="display:grid;gap:7px"><span style="font-size:13px;color:#647083">${label}</span><strong style="font-size:25px;color:#243047">${value}</strong></div>`;
      $('meshReceiptCalculated').innerHTML=`<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 12px;border-top:1px solid #d8dde5;padding-top:18px">${cell('מוטות באורך '+spec.length_mm/1000+' מ׳',c.longitudinalBarCount)}${cell('מוטות באורך '+spec.width_mm/1000+' מ׳',c.transverseBarCount)}${cell('משקל תיאורטי לרשת',c.weightKg.toFixed(2)+' ק״ג')}${cell('משקל כולל',(c.weightKg*Number($('meshUnits').value||0)).toFixed(2)+' ק״ג')}</div><p style="font-size:13px;margin:12px 0 0;color:#647083">${c.totalLengthMm/1000} מטר רץ · ${c.countingVerified?'ספירת מוטות מאומתת':'ספירה מוצעת — יש לבדוק ולאשר לפני שמירה'}</p>`;
    }catch{$('meshReceiptCalculated').textContent='הזינו מידות, קוטר ומרווחים לחישוב המשקל התיאורטי.';}
  }
  $('meshReceiptFields').addEventListener('input',event=>{if(event.target.id!=='meshCountConfirmed'&&event.target.id!=='meshUnits'){$('meshCountConfirmed').checked=false;if(fields.some(([key])=>event.target.id==='mesh-'+key)){$('meshKnownSpec').value='';$('meshLongCount').value='';$('meshTransCount').value='';}}updateMeshWeight();});
  $('meshKnownSpec').addEventListener('change',()=>{const spec=sheets[Number($('meshKnownSpec').value)]?.specification;if(!spec||$('meshKnownSpec').value==='')return;for(const[key,,factor]of fields)$(`mesh-${key}`).value=spec[key]/factor;$('meshGrade').value=spec.grade||'';$('meshStandard').value=spec.standard_code||'';$('meshCountConfirmed').checked=spec.counting_confirmed===true;$('meshLongCount').value=spec.longitudinal_bar_count||'';$('meshTransCount').value=spec.transverse_bar_count||'';updateMeshWeight();});
  function localTime(){return new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);}
  async function load() {
    $('countMessage').textContent='טוען אצוות...';
    try {
      lots=[];for(let offset=0;;offset+=1000){const rows=await workspace.api(`/api/inventory?limit=1000&offset=${offset}`);lots.push(...rows);if(rows.length<1000)break;}
      sheets=[];for(let offset=0;;offset+=500){const rows=await workspace.api(`/api/inventory/mesh?limit=500&offset=${offset}`);sheets.push(...rows);if(rows.length<500)break;}
      $('meshKnownSpec').innerHTML='<option value="">הגדרת מפרט חדש</option>'+sheets.map((row,i)=>`<option value="${i}">${esc(workspace.meshDescription(row.specification))}</option>`).join('');
      if(!$('countTime').value)$('countTime').value=localTime();
      $('countRows').innerHTML=lots.map(row=>`<tr data-count-lot="${row.id}"><td>${esc(row.material_type==='coil'?'גליל':row.material_type==='straight'?'ליפט / ישר':'מכופף')} Ø${esc(row.diameter)} · ${esc(row.lot_number||row.id)}</td><td>${esc(row.warehouse_loc||'')}</td><td>${fmt(row.weight_available)} ק״ג</td><td><input class="inventory-count-input" type="number" min="0" step="1" data-count-value aria-label="נספר באצווה ${row.id}"></td><td><input class="inventory-count-input" type="number" step="1" data-count-net aria-label="תנועות מאז הספירה באצווה ${row.id}"></td><td><input class="inventory-count-input" data-count-note aria-label="פירוט תנועות באצווה ${row.id}"></td></tr>`).join('')||'<tr><td colspan="6" class="inventory-message">אין אצוות פעילות לספירה.</td></tr>';
      $('meshCountRows').innerHTML=sheets.map((row,i)=>`<tr><td>${esc(workspace.meshDescription(row.specification))}</td><td>${fmt(row.physical_units)} יחידות</td><td><input class="inventory-count-input" type="number" min="0" step="1" id="meshCount-${i}" aria-label="נספר במפרט רשת ${i+1}"></td><td><button class="btn btn-outline btn-sm" data-mesh-count="${i}">בדיקת הפרש</button></td></tr>`).join('')||'<tr><td colspan="4" class="inventory-message">אין מפרטי רשת במלאי.</td></tr>';
      $('countMessage').textContent='';
    }catch(error){$('countMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  }
  async function preview() {
    try {
      const lines=[...document.querySelectorAll('[data-count-lot]')].filter(row=>row.querySelector('[data-count-value]').value!=='').map(row=>{
        const line={raw_material_id:Number(row.dataset.countLot),counted_kg:Number(row.querySelector('[data-count-value]').value)},net=row.querySelector('[data-count-net]').value;
        if(net!==''){line.post_count_net_kg=Number(net);line.post_count_reconciled=true;line.reconciliation_note=row.querySelector('[data-count-note]').value;}
        return line;
      });
      if(!lines.length)throw new Error('יש להזין לפחות כמות אחת שנספרה.');
      if(!$('countTime').value)throw new Error('יש לבחור את מועד הספירה.');
      const payload={counted_at:new Date($('countTime').value).toISOString(),reason:$('countReason').value,lines};
      const result=await workspace.api('/api/inventory/stocktakes/preview',payload);
      pending={path:'/api/inventory/stocktakes',payload:{...payload,preview_token:result.preview_token,idempotency_key:uid()}};
      showPreview(result.lines.map(row=>`אצווה ${row.raw_material_id}: יתרה ${fmt(row.expected_kg)}, נספר ${fmt(row.counted_kg)}, התאמה ${fmt(row.adjustment_kg)} ק״ג`));
    }catch(error){$('countMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  }
  function showPreview(lines){$('countConfirmRows').innerHTML=lines.map(text=>`<p style="margin-bottom:12px">${esc(text)}</p>`).join('');$('countConfirmMessage').textContent='';workspace.openModal('countConfirmModal');}
  $('countPreview').addEventListener('click',preview);$('countReload').addEventListener('click',load);
  $('countCancel').addEventListener('click',()=>workspace.closeModal('countConfirmModal'));
  $('countApprove').addEventListener('click',async()=>{
    if(!pending)return;const button=$('countApprove');button.disabled=true;
    try {await workspace.api(pending.path,pending.payload);workspace.closeModal('countConfirmModal');pending=null;await load();await loadSummary();$('countMessage').textContent='הספירה נשמרה והתאמת המלאי נרשמה.';}
    catch(error){$('countConfirmMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}finally{button.disabled=false;}
  });
  $('meshCountRows').addEventListener('click',async event=>{
    const button=event.target.closest('[data-mesh-count]');if(!button)return;
    try {const i=Number(button.dataset.meshCount),input=$(`meshCount-${i}`);if(input.value==='')throw new Error('יש להזין כמות רשתות שנספרה.');const payload={specification:sheets[i].specification,counted_units:Number(input.value),reason:$('countReason').value};const result=await workspace.api('/api/inventory/mesh/stocktakes/preview',payload);pending={path:'/api/inventory/mesh/stocktakes',payload:{...payload,preview_token:result.preview_token,idempotency_key:uid()}};showPreview([`רשתות: יתרה ${result.expected_units}, נספר ${result.counted_units}, התאמה ${result.adjustment_units} יחידות`]);}
    catch(error){$('countMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  });
  let meshReceiptKey=uid();
  $('inventoryMeshReceipt').addEventListener('click',async()=>{
    workspace.openModal('meshReceiptModal');$('meshReceiptMessage').textContent='';meshReceiptKey=uid();await load();updateMeshWeight();
    try{const suppliers=await workspace.api('/api/suppliers');$('meshSupplier').innerHTML='<option value="">ללא ספק</option>'+suppliers.map(row=>`<option value="${row.id}">${esc(row.name)}</option>`).join('');}catch(error){$('meshReceiptMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  });
  $('meshReceiptClose').addEventListener('click',()=>workspace.closeModal('meshReceiptModal'));
  $('meshReceiptSave').addEventListener('click',async()=>{
    const button=$('meshReceiptSave');button.disabled=true;
    try{const specification=receiptSpecification();
      await workspace.api('/api/inventory/mesh/receipts',{specification,quantity_units:Number($('meshUnits').value),supplier_id:Number($('meshSupplier').value)||null,delivery_note_num:$('meshNote').value,idempotency_key:meshReceiptKey});workspace.closeModal('meshReceiptModal');await loadReceipts();}
    catch(error){$('meshReceiptMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}finally{button.disabled=false;}
  });
  async function loadReceipts() {
    const box=$('receiptReviewList');box.textContent='טוען קבלות...';
    try {
      const [raw,mesh,ocr,verification]=await Promise.all([workspace.api('/api/inventory/pending-receipts?status=draft'),workspace.api('/api/inventory/mesh/receipts'),workspace.api('/api/inventory/receipt-reviews?status=pending_review'),canVerify?workspace.api('/api/inventory/pending-verification'):Promise.resolve([])]);
      verificationLots=verification;renderVerificationNotice();
      receiptReviews=ocr;
      box.innerHTML=raw.map(row=>`<article class="receipt-card"><div class="receipt-body"><strong>${esc(row.delivery_note_num||'קבלה ידנית')} · ${row.lines.length} שורות</strong>${row.lines.map(line=>`<div>Ø${esc(line.diameter)} · ${fmt(line.weight_received)} ק״ג</div>`).join('')}<button class="btn btn-primary btn-sm" data-approve-receipt="${row.id}" data-duplicate="${row.duplicate_warning?.suspected?'1':'0'}">אישור קבלה למלאי</button></div></article>`).join('')+mesh.map(row=>`<article class="receipt-card"><div class="receipt-body"><strong>רשתות · ${esc(row.delivery_note_num||'ללא תעודה')} · ${row.quantity_units} יחידות</strong><div>${esc(workspace.meshDescription(JSON.parse(row.specification_json)))}</div>${JSON.parse(row.specification_json).calculation?`<div>משקל תיאורטי: ${(JSON.parse(row.specification_json).calculation.weightKg*row.quantity_units).toFixed(2)} ק״ג</div>`:''}<button class="btn btn-primary btn-sm" data-approve-mesh="${row.id}">אישור רשתות למלאי</button></div></article>`).join('')+ocr.map(renderReceiptReview).join('')||'<div class="muted">אין קבלות ממתינות לאישור.</div>';
      if(verificationLots.length)box.innerHTML=verificationLots.map(verificationCard).join('')+(raw.length||mesh.length||ocr.length?box.innerHTML:'');
      if(ocr[0])showReceiptSource(ocr[0].id);
    }catch(error){box.textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  }
  $('receiptReviewList').addEventListener('click',async event=>{
    const verify=event.target.closest('[data-verify-lot]');
    if(verify){
      const row=verificationLots.find(lot=>String(lot.id)===verify.dataset.verifyLot);if(!row||!canVerify)return;
      editBatch(row.id,row);
      validateBatchFields();
      return;
    }
    const button=event.target.closest('[data-approve-receipt],[data-approve-mesh]');if(!button)return;button.disabled=true;
    try{let duplicate=false;if(button.dataset.duplicate==='1'){if(!confirm('נמצאה קבלה דומה. בדקת שזו קבלה נוספת שצריך להוסיף למלאי?'))return;duplicate=true;}
      const mesh=button.dataset.approveMesh,id=mesh||button.dataset.approveReceipt;
      const path=mesh?`/api/inventory/mesh/receipts/${id}/approve`:`/api/inventory/pending-receipts/${id}/approve`;
      try{await workspace.api(path,{idempotency_key:`receipt-approve:${id}`,confirm_duplicate:duplicate});}
      catch(error){if(error.code!=='duplicate_confirmation_required'||!confirm('נמצאה קבלה דומה. בדקת שזו תוספת נפרדת למלאי?'))throw error;await workspace.api(path,{idempotency_key:`receipt-approve:${id}`,confirm_duplicate:true});}
      await loadReceipts();await loadSummary();}
    catch(error){alert(error.message);}finally{button.disabled=false;}
  });
  window.loadReceiptReviews=loadReceipts;
  window.InventoryCounts={load,loadReceipts};
  if(location.hash==='#stocktake')showTab('stocktake');
  loadReceipts();
})();
