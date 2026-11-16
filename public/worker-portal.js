'use strict';
(()=>{
 const $=id=>document.getElementById(id),esc=v=>window.IronBendSafe.escapeHtml(String(v??''));
 let lang=localStorage.getItem('workerPortalLanguage')||'he',worker=null,card=null,original=null,cardToken='',busy=false,opening=false,pending=null,historyPage=1,historyRows=[],historyTotal=null,lastMessage=null;
 const dictionaries=window.WorkerPortalI18n,t=key=>(dictionaries[lang]||dictionaries.he)[key]||dictionaries.he[key]||key;
 const statusKeys={ממתין:'waiting',בייצור:'production',הושלם:'done',הועמס:'loaded',נשלח:'sent',סופק:'delivered',בוטל:'cancelled','ממתין לאיסוף':'done'};
 const fmt=value=>Number(value||0).toLocaleString(lang==='he'?'he-IL':lang==='th'?'th-TH':'en-GB',{maximumFractionDigits:2});
 const paths={back:'M15 5l-7 7 7 7',scan:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h3v3h-3z',gear:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',person:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21v-3a8 8 0 0 1 16 0v3',cards:'M7 3h13v16H7zM4 7H2v15h14v-2M10 7h7m-7 4h7m-7 4h5',card:'M4 3h16v18H4zM8 7h8m-8 5h8m-8 5h5',edit:'M4 17l-1 4 4-1L21 6l-4-4zM14 5l5 5',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l4 2',help:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01',globe:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',check:'M5 12l5 5L20 6',checkCircle:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM7 12l3 3 7-7',expand:'M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5',home:'M3 11l9-8 9 8M5 10v11h5v-7h4v7h5V10',play:'M7 3l14 9-14 9z',truck:'M2 5h12v12H2zm12 5h5l3 4v3h-8M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm11 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'};
 const icon=name=>`<svg class="portal-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]||paths.card}"/></svg>`;
 for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=icon(el.dataset.icon);
 function message(key,error=false){lastMessage=key?{key,error}:null;$('message').hidden=!key;$('message').textContent=key?t(key):'';$('message').classList.toggle('error',error);}
 function applyLanguage(value){
  lang=Object.hasOwn(dictionaries,value)?value:'he';document.documentElement.lang=lang;document.documentElement.dir=lang==='he'?'rtl':'ltr';localStorage.setItem('workerPortalLanguage',lang);$('language').value=lang;
  for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=t(el.dataset.i18n);
  $('enlargeCard').setAttribute('aria-label',t('enlarge'));$('cardScan').setAttribute('aria-label',t('scan'));document.querySelector('#cardAppbar .home-link').setAttribute('aria-label',t('back'));$('todayDate').textContent=new Intl.DateTimeFormat(lang==='he'?'he-IL':lang==='th'?'th-TH':'en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Jerusalem'}).format(new Date());$('settingsButton').setAttribute('aria-label',t('settings'));document.title=t('portal')+' · טנא';
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
 function show(next){scanner.stop();window.scrollTo(0,0);for(const name of ['login','home','scan','card','help'])$(name+'View').hidden=name!==next;document.body.dataset.view=next;$('cardAppbar').hidden=next!=='card';$('workerPresence').hidden=!worker;$('bottomNav').hidden=!worker;$('logout').hidden=!worker;$('identity').textContent=worker?.worker_name||'';$('settingsPanel').hidden=true;$('settingsButton').setAttribute('aria-expanded','false');for(const id of ['navHome','navScan','navWork'])$(id).classList.toggle('active',next==='scan'?id==='navScan':next==='help'?id==='navWork':id==='navHome');}
 function signOutLocal(){scanner.stop();worker=null;card=null;original=null;pending=null;historyRows=[];historyTotal=null;cardToken='';window.IronBendAuth.clearSession();$('password').value='';show('login');}
 async function boot(){
  try{const data=await api('/api/worker-portal/me');if(!data.worker)throw Error('offline');worker=data.worker;applyLanguage(worker.language);show('home');message(null);await loadHistory();}
  catch(e){show('login');if(window.IronBendAuth.accessToken())message(e.key==='session'?'loginRequired':e.key||'loginRequired',true);}
 }
 async function loadHistory(){
  try{const data=await api('/api/worker-portal/history?page='+historyPage+'&limit=10');if(!Array.isArray(data.rows))throw Object.assign(Error('offline'),{key:'offline'});historyRows=data.rows;historyTotal=data.total;renderHistory();$('historyPrev').disabled=historyPage<=1;$('historyNext').disabled=historyPage*10>=data.total;$('historyPage').textContent=historyPage+' / '+Math.max(1,Math.ceil(data.total/10));}
  catch(e){message(e.key||'error',true);}
 }
 function statusBadge(status){const key=statusKeys[status]||'onHold';return `<span class="status-badge ${esc(key)}">${esc(t(key))}</span>`;}
 function renderHistory(){
  $('cardCount').textContent=historyTotal===null?'—':fmt(historyTotal);
  $('history').innerHTML=historyRows.length?historyRows.map((r,i)=>`<button type="button" class="history-card" data-history="${i}"><strong class="history-id"><bdi>#${Number(r.item_id)}</bdi></strong><span class="history-client"><strong>${esc(r.customer_name||'')}</strong><small><bdi>${esc(r.order_num||'')}</bdi> · Ø${fmt(r.diameter)}</small></span>${statusBadge(r.status)}<strong class="history-weight">${fmt(r.total_weight)} <small>${esc(t('kg'))}</small></strong></button>`).join(''):`<p class="muted">${esc(t('noHistory'))}</p>`;
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
  $('originalCard').hidden=!original?.html;$('shape').hidden=!!original?.html;$('largeOriginalCard').innerHTML=original?.html||card.shape_svg||'';
  const actions=[{status:'בייצור',key:'start',icon:'play'},{status:'הושלם',key:'complete',icon:'checkCircle'},{status:'הועמס',key:'load',icon:'truck'}];
  const nextKey={ממתין:'start',בייצור:'complete',הושלם:'load'}[card.status];
  $('statusActions').innerHTML=actions.filter(a=>worker.permissions.includes(a.key)).map(a=>{const current=a.status===card.status,enabled=a.key===nextKey&&!busy&&!pending&&(a.key!=='start'||card.can_start_production);return `<button class="status-action ${current?'is-current':enabled?'is-next':''}" data-status="${esc(a.status)}" ${enabled?'':'disabled'}>${icon(a.icon)}<span>${esc(t(a.key))}</span></button>`;}).join('');
  const note=nextKey==='start'&&!card.can_start_production?'blocked':!worker.permissions.length?'noPermissions':!worker.permissions.includes(nextKey)?'noAction':null;
  $('statusNote').textContent=t('currentStatus')+': '+t(statusKeys[card.status]||'onHold')+(note?' · '+t(note):'');
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
 $('mainScan').addEventListener('click',()=>openScan(true));$('navScan').addEventListener('click',()=>openScan());$('nextScan').addEventListener('click',()=>openScan());$('navHome').addEventListener('click',openHome);$('navWork').addEventListener('click',()=>{if(!busy){show('help');message(null);}});for(const button of document.querySelectorAll('.home-link'))button.addEventListener('click',openHome);
 $('cardScan').addEventListener('click',()=>openScan(true));$('helpScanButton').addEventListener('click',()=>openScan(true));
 for(const button of document.querySelectorAll('.help-shortcut'))button.addEventListener('click',()=>{show('help');$('help-'+button.dataset.help).scrollIntoView({block:'start'});});
 $('languageShortcut').addEventListener('click',()=>{$('settingsPanel').hidden=false;$('settingsButton').setAttribute('aria-expanded','true');window.scrollTo(0,0);});
 $('recentShortcut').addEventListener('click',async()=>{await openHome();$('history').scrollIntoView({block:'start',behavior:'smooth'});});
 $('enlargeCard').addEventListener('click',()=>$('cardPreview').showModal());$('closeCardPreview').addEventListener('click',()=>$('cardPreview').close());
 $('startCamera').addEventListener('click',()=>scanner.start());$('stopCamera').addEventListener('click',scanner.stop);$('scanForm').addEventListener('submit',event=>{event.preventDefault();openCard($('scanCode').value);});
 $('history').addEventListener('click',event=>{const row=event.target.closest('[data-history]');if(row){const item=historyRows[Number(row.dataset.history)];openCard(item.card_token||String(item.item_id));}});
 $('refreshHistory').addEventListener('click',loadHistory);$('historyPrev').addEventListener('click',()=>{historyPage--;loadHistory();});$('historyNext').addEventListener('click',()=>{historyPage++;loadHistory();});
 $('statusActions').addEventListener('click',event=>{const target=event.target.closest('[data-status]')?.dataset.status;if(target)saveStatus(target);});$('retrySave').addEventListener('click',()=>saveStatus(null,true));
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('settingsPanel').hidden=true;$('settingsButton').setAttribute('aria-expanded','false');}});
 applyLanguage(lang);show('login');if(window.IronBendAuth.accessToken())boot();
})();
