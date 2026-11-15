'use strict';
(()=>{
 const $=id=>document.getElementById(id),esc=v=>window.IronBendSafe.escapeHtml(String(v??''));
 let lang=localStorage.getItem('workerPortalLanguage')||'he',worker=null,card=null,original=null,cardToken='',busy=false,opening=false,pending=null,historyPage=1,historyRows=[],lastMessage=null;
 const dictionaries=window.WorkerPortalI18n,t=key=>(dictionaries[lang]||dictionaries.he)[key]||dictionaries.he[key]||key;
 const statusKeys={ממתין:'waiting',בייצור:'production',הושלם:'done',הועמס:'loaded',נשלח:'sent',סופק:'delivered',בוטל:'cancelled','ממתין לאיסוף':'done'};
 const fmt=value=>Number(value||0).toLocaleString(lang==='he'?'he-IL':lang==='th'?'th-TH':'en-GB',{maximumFractionDigits:2});
 function message(key,error=false){lastMessage=key?{key,error}:null;$('message').hidden=!key;$('message').textContent=key?t(key):'';$('message').classList.toggle('error',error);}
 function applyLanguage(value){
  lang=Object.hasOwn(dictionaries,value)?value:'he';document.documentElement.lang=lang;document.documentElement.dir=lang==='he'?'rtl':'ltr';localStorage.setItem('workerPortalLanguage',lang);$('language').value=lang;
  for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=t(el.dataset.i18n);
  $('settingsButton').setAttribute('aria-label',t('settings'));document.title=t('portal')+' · טנא';
  if(worker){$('greeting').textContent=t('hello')+', '+worker.worker_name;renderHistory();if(card)renderCard();}
  if(lastMessage)message(lastMessage.key,lastMessage.error);
 }
 function errorKey(code,status){
  if(code==='invalid_worker_credentials')return 'loginError';
  if(code==='worker_login_locked'||status===423||status===429)return 'locked';
  if(code==='worker_portal_disabled')return 'disabled';
  if(code==='worker_portal_account_required')return 'loginRequired';
  if(code==='invalid_worker_card_token'||code==='invalid_card_split'||code==='specific_component_card_required')return 'invalidCode';
  if(code==='not_found')return 'notFound';
  if(code==='worker_status_changed'||code==='worker_portal_invalid_transition'||code==='worker_request_conflict')return 'changed';
  if(/production|cancel|approval|payment/.test(code||''))return 'blocked';
  if(status===401)return 'session';if(status===403)return 'forbidden';return 'error';
 }
 async function api(path,options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetch(path,{cache:'no-store',...options,signal:controller.signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'error'),{key:errorKey(data.error,response.status),status:response.status});if(data.offline)throw Error('offline');return data;}
  catch(e){if(e.status)throw e;throw Object.assign(Error('offline'),{key:'offline'});}finally{clearTimeout(timeout);}
 }
 const scanner=window.createWorkerPortalScanner({onCode:openCard,onError:()=>message('cameraError',true)});
 function show(next){scanner.stop();window.scrollTo(0,0);for(const name of ['login','home','scan','card'])$(name+'View').hidden=name!==next;$('bottomNav').hidden=!worker;$('logout').hidden=!worker;$('identity').textContent=worker?.worker_name||'';$('settingsPanel').hidden=true;$('settingsButton').setAttribute('aria-expanded','false');for(const id of ['navHome','navScan','navWork'])$(id).classList.toggle('active',next==='scan'?id==='navScan':id==='navHome');}
 function signOutLocal(){scanner.stop();worker=null;card=null;original=null;pending=null;historyRows=[];cardToken='';window.IronBendAuth.clearSession();$('password').value='';show('login');}
 async function boot(){
  try{const data=await api('/api/worker-portal/me');if(!data.worker)throw Error('offline');worker=data.worker;applyLanguage(worker.language);show('home');message(null);await loadHistory();}
  catch(e){show('login');if(window.IronBendAuth.accessToken())message(e.key==='session'?'loginRequired':e.key||'loginRequired',true);}
 }
 async function loadHistory(){
  try{const data=await api('/api/worker-portal/history?page='+historyPage+'&limit=10');if(!Array.isArray(data.rows))throw Object.assign(Error('offline'),{key:'offline'});historyRows=data.rows;renderHistory();$('historyPrev').disabled=historyPage<=1;$('historyNext').disabled=historyPage*10>=data.total;$('historyPage').textContent=historyPage+' / '+Math.max(1,Math.ceil(data.total/10));}
  catch(e){message(e.key||'error',true);}
 }
 function statusBadge(status){const key=statusKeys[status]||'onHold';return `<span class="status-badge ${esc(key)}">${esc(t(key))}</span>`;}
 function renderHistory(){
  $('history').innerHTML=historyRows.length?historyRows.map((r,i)=>`<button type="button" class="history-card" data-history="${i}"><span><strong><bdi>#${Number(r.item_id)}</bdi> · <bdi>${esc(r.customer_name||'')}</bdi></strong><small><bdi>${esc(r.order_num||'')}</bdi> · Ø${fmt(r.diameter)}</small></span>${statusBadge(r.status)}</button>`).join(''):`<p class="muted">${esc(t('noHistory'))}</p>`;
 }
 function normalizedCode(raw){
  let value=String(raw||'').trim();if(!value||value.length>1024)return '';
  if(value.includes('?')){try{const url=new URL(value,location.origin);value=url.searchParams.get('card')||'';}catch{return '';}}
  return value&&(/^[0-9]+$/.test(value)||/\|\d+/.test(value)||/-\d+(?:-[A-Z0-9]+)*$/i.test(value))?value:'';
 }
 async function openCard(raw){
  if(opening||busy||!worker)return;const token=normalizedCode(raw);if(!token){message('invalidCode',true);return;}
  opening=true;scanner.stop();message('loading');
  try{const data=await api('/api/worker-portal/card?original=1&card='+encodeURIComponent(token));if(!data.items?.[0]||!data.scan_receipt?.id)throw Object.assign(Error('offline'),{key:'offline'});card=data.items[0];original=data.original_card;cardToken=token;pending=null;show('card');renderCard();message(null);}
  catch(e){message(e.key||'error',true);}finally{opening=false;}
 }
 function renderCard(){
  $('cardNumber').textContent=t('card')+' #'+card.id;$('cardOrder').textContent=card.order_num||'';$('cardCustomer').textContent=card.customer_name||'';
  $('cardStatus').textContent=t(statusKeys[card.status]||'onHold');$('cardStatus').className='status-badge '+(statusKeys[card.status]||'');
  $('shape').innerHTML=card.shape_svg||'';$('shapeLabel').textContent=card.shape_name||'';
  $('cardDiameter').textContent=fmt(card.diameter)+' '+t('mm');$('cardQuantity').textContent=fmt(card.quantity)+' '+t('units');$('cardWeight').textContent=fmt(card.weight)+' '+t('kg');$('originalCard').innerHTML=original?.html||'';
  const next={ממתין:{status:'בייצור',key:'start'},בייצור:{status:'הושלם',key:'complete'},הושלם:{status:'הועמס',key:'load'}}[card.status];
  const permitted=next&&worker.permissions.includes(next.key);
  $('statusActions').innerHTML=permitted?`<button class="primary" data-status="${esc(next.status)}" ${busy||pending||next.key==='start'&&!card.can_start_production?'disabled':''}>${esc(t(next.key))}</button>`:`<p class="muted">${esc(t(worker.permissions.length?'noAction':'noPermissions'))}</p>`;
  if(next?.key==='start'&&!card.can_start_production)$('statusActions').innerHTML+=`<p class="muted">${esc(t('blocked'))}</p>`;
  $('retrySave').hidden=!pending;$('retrySave').disabled=busy;$('nextScan').disabled=busy;
 }
 function requestId(){if(crypto.randomUUID)return crypto.randomUUID();return [...crypto.getRandomValues(new Uint8Array(20))].map(n=>n.toString(16).padStart(2,'0')).join('');}
 let confirmPending=null;
 function confirmStatus(text){$('statusConfirmText').textContent=text;$('statusConfirm').showModal();return new Promise(resolve=>{confirmPending=resolve;});}
 function resolveConfirm(value){$('statusConfirm').close();const resolve=confirmPending;confirmPending=null;resolve?.(value);}
 $('statusConfirmYes').addEventListener('click',()=>resolveConfirm(true));$('statusConfirmNo').addEventListener('click',()=>resolveConfirm(false));$('statusConfirm').addEventListener('cancel',()=>resolveConfirm(false));
 async function saveStatus(target,retry=false){
  if(busy||!card)return;
  if(!retry&&target==='הושלם'&&!await confirmStatus(t('completeConfirm')+' '+fmt(card.quantity)+' '+t('units')))return;
  if(!retry&&target==='הועמס'&&!await confirmStatus(t('loadConfirm')))return;
  if(!retry)pending={id:card.id,body:{status:target,card:cardToken,expected_status:card.status,request_id:requestId()}};
  const operation=pending;if(!operation)return;busy=true;renderCard();message('saving');
  try{const data=await api('/api/worker-portal/card/'+operation.id+'/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation.body)});if(data.ok!==true||!data.receipt?.id||!data.item)throw Object.assign(Error('offline'),{key:'offline'});card=data.item;pending=null;message('saved');}
  catch(e){if(e.key!=='offline')pending=null;message(e.key||'error',true);if(e.status===409){try{const latest=await api('/api/worker-portal/card?card='+encodeURIComponent(cardToken));if(latest.items?.[0])card=latest.items[0];}catch{}}if(e.status===401){signOutLocal();message('session',true);}}
  finally{busy=false;if(card)renderCard();}
 }
 async function openHome(){if(busy)return;show('home');message(null);await loadHistory();}
 function openScan(camera=false){if(busy)return;show('scan');message(null);$('scanCode').value='';if(camera)scanner.start();else $('scanCode').focus();}
 $('loginForm').addEventListener('submit',async event=>{event.preventDefault();$('loginSubmit').disabled=true;message('loading');try{const result=await api('/api/auth/worker-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value.trim(),password:$('password').value})});if(!result.access_token||!result.user?.portal_only)throw Object.assign(Error('login'),{key:'loginError'});window.IronBendAuth.storeSession(result,false);$('password').value='';await boot();}catch(e){message(e.key||'error',true);}finally{$('loginSubmit').disabled=false;}});
 $('settingsButton').addEventListener('click',()=>{const open=$('settingsPanel').hidden;$('settingsPanel').hidden=!open;$('settingsButton').setAttribute('aria-expanded',String(open));});
 $('language').addEventListener('change',async()=>{const previous=lang,next=$('language').value;applyLanguage(next);if(worker){try{await api('/api/worker-portal/preferences',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({language:next})});worker.language=next;message('languageSaved');}catch(e){applyLanguage(previous);message(e.key||'error',true);}}});
 $('logout').addEventListener('click',async()=>{if(busy)return;try{await api('/api/auth/logout',{method:'POST'});}catch{}signOutLocal();message(null);});
 $('mainScan').addEventListener('click',()=>openScan(true));$('navScan').addEventListener('click',()=>openScan());$('nextScan').addEventListener('click',()=>openScan());$('navHome').addEventListener('click',openHome);$('navWork').addEventListener('click',async()=>{await openHome();$('history').scrollIntoView({block:'start',behavior:'smooth'});$('navHome').classList.remove('active');$('navWork').classList.add('active');});for(const button of document.querySelectorAll('.home-link'))button.addEventListener('click',openHome);
 $('startCamera').addEventListener('click',()=>scanner.start());$('stopCamera').addEventListener('click',scanner.stop);$('scanForm').addEventListener('submit',event=>{event.preventDefault();openCard($('scanCode').value);});
 $('history').addEventListener('click',event=>{const row=event.target.closest('[data-history]');if(row){const item=historyRows[Number(row.dataset.history)];openCard(item.card_token||String(item.item_id));}});
 $('refreshHistory').addEventListener('click',loadHistory);$('historyPrev').addEventListener('click',()=>{historyPage--;loadHistory();});$('historyNext').addEventListener('click',()=>{historyPage++;loadHistory();});
 $('statusActions').addEventListener('click',event=>{const target=event.target.closest('[data-status]')?.dataset.status;if(target)saveStatus(target);});$('retrySave').addEventListener('click',()=>saveStatus(null,true));
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('settingsPanel').hidden=true;$('settingsButton').setAttribute('aria-expanded','false');}});
 applyLanguage(lang);show('login');if(window.IronBendAuth.accessToken())boot();
})();
