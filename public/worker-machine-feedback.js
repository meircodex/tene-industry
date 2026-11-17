(function(root){
 'use strict';
 const KEY='ib-worker-machine-source-v1',OUTBOX='ib-worker-machine-feedback-outbox-v1';
 const S={stations:[],current:null,source:null,runId:null,mirror:null,generation:0,busy:false,dialog:null,allRows:false};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const uuid=()=>root.crypto?.randomUUID?.()||'mif-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const num=v=>v==null?'—':Number.isFinite(v)?String(v):'—';
 const stored=key=>{try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}};
 const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};
 async function json(url,options={},signal){
  const response=await fetch(url,{cache:'no-store',...options,signal:signal||AbortSignal.timeout(4000)}),body=await response.json();
  if(!response.ok)throw Error(body?.error||'MACHINE_FEEDBACK_UNAVAILABLE');return body;
 }
 async function request(context,action,payload,{id=uuid(),timeout=4500}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  const base='/api/machine-feedback',body={requestId:id,sourceId:context.sourceId,itemId:Number(context.itemId),card:context.card,action,payload};
  try{
   let result=await json(base+'/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},controller.signal);
   while(result.state==='pending'){
    await new Promise(resolve=>setTimeout(resolve,250));
    result=await json(base+'/requests/'+encodeURIComponent(result.id)+'?card='+encodeURIComponent(context.card),{},controller.signal);
   }
   if(result.state!=='done')throw Error('WORKER_MACHINE_REQUEST_EXPIRED');
   if(result.result?.ok!==true)throw Error(result.result?.error||'MACHINE_FEEDBACK_UNAVAILABLE');
   return result.result.data;
  }finally{clearTimeout(timer);}
 }
 function host(){
  let el=document.getElementById('workerMachineFeedback');if(el)return el;
  const original=document.getElementById('originalWorkCard'),stage=document.querySelector('.stage');
  if(!original&&!stage)return null;
  el=document.createElement('section');el.id='workerMachineFeedback';el.className='mif-panel';el.setAttribute('aria-label','שיקוף פרמטרים מהמכונה');
  // The original printed card and all original controls remain intact.
  if(original&&!original.hidden)original.append(el);else stage.prepend(el);return el;
 }
 function status(message,live=false){const el=document.querySelector('#workerMachineFeedback .mif-status');if(el){el.textContent=message;el.dataset.live=String(live);}}
 function render(){
  if(!S.stations.length||!S.current)return;const el=host();if(!el)return;
  const m=S.mirror,source=S.stations.find(s=>s.sourceId===S.source),expected=m?.expected?.sidesMm||[];
  el.innerHTML='<div class="mif-head"><strong>פרמטרים במכונה</strong><span class="mif-machine-label">'+(source?'מכונה '+esc(source.label):'שיוך אוטומטי')+'</span><span class="mif-status" data-live="false">ממתין לקריאת בקר</span></div>';
  if(!source){status('אין תחנה מקוונת ותואמת לכרטיס · העבודה הרגילה ממשיכה');return;}
  if(!m){status(source.online?'מתחבר למוניטור…':'המוניטור אינו זמין · העבודה הרגילה ממשיכה');return;}
  if(!m.rows?.length){status('אין קריאת בקר עדכנית לכרטיס הזה');return;}
  const count=Math.max(expected.length,...m.rows.filter(r=>r.length!==null&&r.length!==0||r.angle!==null&&r.angle!==0).map(r=>r.slot),1);
  const rows=m.rows.filter(r=>S.allRows||r.slot<=count);
  el.insertAdjacentHTML('beforeend','<div class="mif-special"><span>קוטר בכרטיס: <b>'+num(m.expected?.diameterMm)+'</b></span><span>קוטר בבקר: <b>'+num(m.special?.diameter)+'</b></span><span>חוטים בבקר: <b>'+num(m.special?.strands)+'</b></span><span>פלטה: <b>'+num(m.special?.plate)+'</b></span></div><div class="mif-table-wrap"><table><thead><tr><th>צעד</th><th>כרטיס · ס״מ</th><th>אורך בבקר</th><th>זווית בבקר</th><th>פיצוי אורך</th><th>פיצוי זווית</th><th>כיוון</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+r.slot+'</td><td class="mif-num">'+num(expected[r.slot-1]==null?null:expected[r.slot-1]/10)+'</td>'+['length','angle','lengthCompensation','angleCompensation','direction'].map(k=>'<td class="mif-num">'+num(r[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><div class="mif-note"><button type="button" class="mif-toggle" id="mif-all">'+(S.allRows?'צעדי הצורה':'כל שורות המתכון')+'</button> · תיקונים נעשים ב־HMI'+(m.mappingQualified?'':' · מיפוי מחקרי, סקיילים לא הוכשרו')+'</div>');
  document.getElementById('mif-all').onclick=()=>{S.allRows=!S.allRows;render();};
  status((m.live?'קריאה עדכנית':'קריאה אחרונה')+(m.observedAtUtc?' · '+new Date(m.observedAtUtc).toLocaleTimeString('he-IL'):'')+(m.live?'':' · הבקר לא מחובר'),m.live);
 }
 function chooseSource(item){
  // `machine` is a directory label even when numeric. Only `machine_id`
  // is an explicit central ID: physical machine 6 may be database row 7.
  const declared=String(item.machine??'').trim();
  const hasId=Number.isSafeInteger(Number(item.machine_id))&&Number(item.machine_id)>0;
  const matchesItem=s=>(hasId||!!declared)&&(!hasId||Number(s.machineId)===Number(item.machine_id))&&(!declared||s.label===declared);
  const matches=S.stations.filter(s=>s.online&&matchesItem(s));
  return matches.length===1?matches[0].sourceId:null;
 }
 async function onCardOpened({item,card,receipt}){
  S.generation++;S.dialog?.close('cancel');S.current={itemId:Number(item.id),card,receiptId:receipt?.id,openRequestId:uuid(),machine:item.machine,machine_id:item.machine_id,
   completed:['הושלם','הועמס','נשלח','סופק'].includes(item.status)};
  S.source=chooseSource(item);S.runId=null;S.mirror=null;render();await tick();
 }
 async function tick(){
  if(S.busy||!S.current||S.current.completed||!S.source||document.hidden)return;S.busy=true;
  const generation=S.generation,context={...S.current,sourceId:S.source};
  try{
   if(!S.runId){const result=await request(context,'card.open',{receiptId:context.receiptId},{id:context.openRequestId});
    if(generation!==S.generation)return;if(result.card!==context.card||result.sourceId!==context.sourceId)throw Error('MACHINE_SCOPE_MISMATCH');S.runId=result.runId;}
   const mirror=await request(context,'mirror.read',{runId:S.runId});
   if(generation!==S.generation)return;if(mirror.card!==context.card||mirror.sourceId!==context.sourceId||mirror.runId!==S.runId)throw Error('MACHINE_SCOPE_MISMATCH');
   S.mirror=mirror;render();
  }catch(error){if(generation===S.generation){if(error.message==='WORKER_MACHINE_REQUEST_EXPIRED')S.current.openRequestId=uuid();status('קריאת המוניטור לא זמינה · העבודה הרגילה ממשיכה');}}
  finally{S.busy=false;}
 }
 function confirmDialog(proposal){
  return new Promise(resolve=>{
   const dialog=document.createElement('dialog');dialog.className='mif-dialog';S.dialog=dialog;
   dialog.innerHTML='<h2>השלמת הכרטיס ושמירת הפרמטרים</h2><p>האם הפרמטרים הנוכחיים בבקר מפיקים מוצר תקין לפי הכרטיס?</p>'+
    (proposal.changes?.length?'<div class="mif-table-wrap"><table><thead><tr><th>פרמטר</th><th>בתחילת התצפית</th><th>כעת</th></tr></thead><tbody>'+proposal.changes.map(c=>'<tr><td>'+esc(c.labelHe||c.key)+'</td><td class="mif-num">'+num(c.before)+'</td><td class="mif-num">'+num(c.after)+'</td></tr>').join('')+'</tbody></table></div>':'<p>אין קריאת בסיס מלאה להשוואה; הערכים הנוכחיים יישמרו רק אם תאשר.</p>')+
    '<label class="mif-check"><input type="checkbox" id="mif-approve"><span>בדקתי מוצר והוא תואם לכרטיס. שמור את הפרמטרים הנוכחיים כמתכון שאישרתי.</span></label><div class="mif-dialog-actions"><button type="button" class="primary" id="mif-done">הושלם</button><button type="button" id="mif-back">חזור לכרטיס</button></div>';
   dialog.addEventListener('close',()=>{const result={cancelled:dialog.returnValue!=='done',saveRecipe:dialog.querySelector('#mif-approve').checked};dialog.remove();if(S.dialog===dialog)S.dialog=null;resolve(result);},{once:true});
   document.body.append(dialog);dialog.querySelector('#mif-done').onclick=()=>dialog.close('done');dialog.querySelector('#mif-back').onclick=()=>dialog.close('cancel');dialog.showModal();
  });
 }
 async function beforeComplete({itemId,card}){
  if(!S.current||S.current.completed||S.current.itemId!==Number(itemId)||S.current.card!==card||!S.source||!S.runId)return null;
  const generation=S.generation,context={...S.current,sourceId:S.source,runId:S.runId};
  try{
   const result=await request(context,'completion.prepare',{runId:context.runId},{timeout:6000});
   if(generation!==S.generation)return {cancelled:true};
   if(result.card!==context.card||result.runId!==context.runId||result.sourceId!==context.sourceId)throw Error('MACHINE_SCOPE_MISMATCH');
   const choice=result.proposal.requiresParameterConfirmation?await confirmDialog(result.proposal):{cancelled:false,saveRecipe:false};
   return {...context,...choice,proposalId:result.proposal.id};
  }catch(error){status('אפשר להשלים כרגיל · אין קריאה עדכנית לשמירת מתכון');return {...context,saveRecipe:false,proposalId:null};}
 }
 function outbox(){const items=stored(OUTBOX);return Array.isArray(items)?items:[];}
 let flushing=false;
 async function flush(){
  if(flushing)return;flushing=true;
  try{for(const entry of outbox().slice(0,5)){
   try{const result=await request(entry.context,'completion.record',entry.payload,{id:entry.id,timeout:4500});
    save(OUTBOX,outbox().filter(v=>v.id!==entry.id));
    if(S.current?.card===entry.context.card)status(result.approvalSaved?'הכרטיס הושלם · הפרמטרים שאישרת נשמרו':entry.payload.saveRecipe?'הכרטיס הושלם · המתכון לא אושר לשמירה: הקריאה השתנתה או אינה עדכנית':'השלמת הכרטיס תועדה במוניטור');
   }catch{break;}
  }}finally{flushing=false;}
 }
 function afterComplete({context,receipt,itemId,card}){
  if(!receipt||receipt.action!=='status_changed'||Number(receipt.item_id)!==Number(itemId))return;
  const c=context||(S.current&&!S.current.completed&&S.current.itemId===Number(itemId)&&S.current.card===card&&S.runId&&S.source
   ?{...S.current,sourceId:S.source,runId:S.runId}:null);
  if(!c||c.cancelled)return;
  if(S.current?.card===card)S.current.completed=true;
  const entry={id:uuid(),context:c,payload:{runId:c.runId,proposalId:c.proposalId||null,saveRecipe:c.saveRecipe===true,receiptId:receipt.id}};
  const pending=outbox();if(pending.length>=100){status('הכרטיס הושלם · תור משוב המוניטור מלא');return;}pending.push(entry);save(OUTBOX,pending);flush();
 }
 async function refreshStations(){
  try{const result=await json('/api/machine-feedback/stations');S.stations=Array.isArray(result.items)?result.items:[];if(S.current){const next=chooseSource(S.current);if(next!==S.source){S.generation++;S.source=next;S.runId=null;S.mirror=null;S.current.openRequestId=uuid();}render();tick();}}catch{}
 }
 async function initialize(){
  await refreshStations();
  setInterval(()=>{tick();flush();},4000);
  setInterval(()=>{if(!document.hidden)refreshStations();},10000);
 }
 root.IronBendMachineFeedback={onCardOpened,beforeComplete,afterComplete};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})(window);
