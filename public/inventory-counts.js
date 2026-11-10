(function () {
  'use strict';
  const workspace=window.InventoryWorkspace,$=id=>document.getElementById(id),esc=workspace.escape;
  let lots=[],sheets=[],pending=null;
  const fmt=value=>Number(value||0).toLocaleString('he-IL',{maximumFractionDigits:0});
  const uid=()=>crypto.randomUUID();
  $('tab-batches').insertAdjacentHTML('afterend',`<div id="tab-stocktake" class="tab-panel"><div class="card"><div class="card-header"><span class="card-title">ספירת מלאי — יתרה בפועל</span><button class="btn btn-outline btn-sm" id="countReload">רענן אצוות</button></div>
    <div class="inventory-toolbar"><div class="form-row"><label for="countTime">מועד הספירה</label><input id="countTime" type="datetime-local" step="1"></div><div class="form-row"><label for="countReason">סיבת ההתאמה</label><input id="countReason" value="ספירת מלאי"></div></div>
    <p class="inventory-caption">מזינים את הכמות שנספרה, ולא את הכמות שהתקבלה בעבר. שורות ריקות לא משתנות; אפשר להזין אפס. אם היו תנועות מאז הספירה, יש לרשום את השינוי נטו ואת פירוט הבדיקה.</p>
    <div class="inventory-table-wrap"><table><thead><tr><th>סוג / קוטר / אצווה</th><th>מיקום</th><th>יתרה במערכת</th><th>נספר (ק״ג)</th><th>תנועות מאז (+/− ק״ג)</th><th>פירוט הבדיקה</th></tr></thead><tbody id="countRows"></tbody></table></div><div class="inventory-caption"><button class="btn btn-primary" id="countPreview">בדיקת הפרשים לפני אישור</button></div>
    <h3 class="inventory-caption">רשתות — ספירה ביחידות לפי מפרט</h3><p class="inventory-caption">לרשתות יש להזין יתרה עדכנית לאחר התנועות שבוצעו מאז הספירה. כל מפרט מאושר בנפרד.</p><div class="inventory-table-wrap"><table><thead><tr><th>מפרט</th><th>יתרה</th><th>נספר כעת (יחידות)</th><th></th></tr></thead><tbody id="meshCountRows"></tbody></table></div><p id="countMessage" class="inventory-caption" role="status"></p></div></div>`);
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-overlay inventory-overlay" id="countConfirmModal" role="dialog" aria-modal="true" aria-labelledby="countConfirmTitle"><div class="modal"><h2 id="countConfirmTitle">בדיקת הפרשי ספירה</h2><div id="countConfirmRows"></div><p class="muted">אישור ירשום תנועת התאמה מתועדת. היסטוריית הקבלות והצריכה נשמרת.</p><p id="countConfirmMessage" role="status" class="muted"></p><div class="modal-footer"><button class="btn btn-outline" id="countCancel">חזרה לבדיקה</button><button class="btn btn-primary" id="countApprove">אישור התאמת מלאי</button></div></div></div>
  <div class="modal-overlay inventory-overlay" id="meshReceiptModal" role="dialog" aria-modal="true" aria-labelledby="meshReceiptTitle"><div class="modal"><h2 id="meshReceiptTitle">הכנסת רשתות — תוספת למלאי</h2><p class="muted">הכמות תתווסף לאחר אישור הקבלה. רשתות נרשמות ביחידות ומופרדות לפי מפרט.</p><div class="form-grid" id="meshReceiptFields"></div><p id="meshReceiptMessage" class="muted" role="status"></p><div class="modal-footer"><button class="btn btn-outline" id="meshReceiptClose">סגירה</button><button class="btn btn-primary" id="meshReceiptSave">שמירה לאישור</button></div></div></div>`);
  const fields=[['length_mm','אורך רשת (ס״מ)',10],['width_mm','רוחב רשת (ס״מ)',10],['longitudinal_diameter_mm','קוטר אורכי (מ״מ)',1],['transverse_diameter_mm','קוטר רוחבי (מ״מ)',1],['longitudinal_spacing_mm','מרווח אורכי (ס״מ)',10],['transverse_spacing_mm','מרווח רוחבי (ס״מ)',10]];
  $('meshReceiptFields').innerHTML=fields.map(([key,label])=>`<div class="form-row"><label for="mesh-${key}">${label}</label><input id="mesh-${key}" type="number" min="0.1" step="0.1"></div>`).join('')+`<div class="form-row"><label for="meshGrade">דרגת פלדה</label><input id="meshGrade" value="B500A"></div><div class="form-row"><label for="meshStandard">תקן</label><input id="meshStandard"></div><div class="form-row"><label for="meshUnits">כמות רשתות (יחידות)</label><input id="meshUnits" type="number" min="1" step="1"></div><div class="form-row"><label for="meshNote">מספר תעודת ספק</label><input id="meshNote"></div><div class="form-row"><label for="meshSupplier">ספק</label><select id="meshSupplier"><option value="">ללא ספק</option></select></div>`;
  function localTime(){return new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);}
  async function load() {
    $('countMessage').textContent='טוען אצוות...';
    try {
      lots=[];for(let offset=0;;offset+=1000){const rows=await workspace.api(`/api/inventory?limit=1000&offset=${offset}`);lots.push(...rows);if(rows.length<1000)break;}
      sheets=[];for(let offset=0;;offset+=500){const rows=await workspace.api(`/api/inventory/mesh?limit=500&offset=${offset}`);sheets.push(...rows);if(rows.length<500)break;}
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
    workspace.openModal('meshReceiptModal');$('meshReceiptMessage').textContent='';meshReceiptKey=uid();
    try{const suppliers=await workspace.api('/api/suppliers');$('meshSupplier').innerHTML='<option value="">ללא ספק</option>'+suppliers.map(row=>`<option value="${row.id}">${esc(row.name)}</option>`).join('');}catch(error){$('meshReceiptMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  });
  $('meshReceiptClose').addEventListener('click',()=>workspace.closeModal('meshReceiptModal'));
  $('meshReceiptSave').addEventListener('click',async()=>{
    const button=$('meshReceiptSave');button.disabled=true;
    try{const specification={grade:$('meshGrade').value,standard_code:$('meshStandard').value};for(const [key,,factor]of fields)specification[key]=Number($(`mesh-${key}`).value)*factor;
      await workspace.api('/api/inventory/mesh/receipts',{specification,quantity_units:Number($('meshUnits').value),supplier_id:Number($('meshSupplier').value)||null,delivery_note_num:$('meshNote').value,idempotency_key:meshReceiptKey});workspace.closeModal('meshReceiptModal');await loadReceipts();}
    catch(error){$('meshReceiptMessage').textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}finally{button.disabled=false;}
  });
  async function loadReceipts() {
    const box=$('receiptReviewList');box.textContent='טוען קבלות...';
    try {
      const [raw,mesh,ocr]=await Promise.all([workspace.api('/api/inventory/pending-receipts?status=draft'),workspace.api('/api/inventory/mesh/receipts'),workspace.api('/api/inventory/receipt-reviews?status=pending_review')]);
      receiptReviews=ocr;
      box.innerHTML=raw.map(row=>`<article class="receipt-card"><div class="receipt-body"><strong>${esc(row.delivery_note_num||'קבלה ידנית')} · ${row.lines.length} שורות</strong>${row.lines.map(line=>`<div>Ø${esc(line.diameter)} · ${fmt(line.weight_received)} ק״ג</div>`).join('')}<button class="btn btn-primary btn-sm" data-approve-receipt="${row.id}" data-duplicate="${row.duplicate_warning?.suspected?'1':'0'}">אישור קבלה למלאי</button></div></article>`).join('')+mesh.map(row=>`<article class="receipt-card"><div class="receipt-body"><strong>רשתות · ${esc(row.delivery_note_num||'ללא תעודה')} · ${row.quantity_units} יחידות</strong><div>${esc(workspace.meshDescription(JSON.parse(row.specification_json)))}</div><button class="btn btn-primary btn-sm" data-approve-mesh="${row.id}">אישור רשתות למלאי</button></div></article>`).join('')+ocr.map(renderReceiptReview).join('')||'<div class="muted">אין קבלות ממתינות לאישור.</div>';
      if(ocr[0])showReceiptSource(ocr[0].id);
    }catch(error){box.textContent=(window.IronBendMessages?.text(error.message) ?? error.message);}
  }
  $('receiptReviewList').addEventListener('click',async event=>{
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
  if(location.hash==='#receipts')loadReceipts();
})();
