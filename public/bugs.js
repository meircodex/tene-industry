'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const labels = {new:'חדש',needs_info:'ממתין למידע',in_progress:'בטיפול',awaiting_confirmation:'תוקן — ממתין לאישור שלך',closed:'אושר ונסגר'};
  const kinds = {before:'לפני — הבעיה',expected:'מקור / המצב הרצוי',after:'אחרי — התיקון'};
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => new Date(value).toLocaleString('he-IL');
  const badge = (status,priority) => `<span class="badge ${esc(status)}">${esc(labels[status])}</span>${priority === 'urgent' ? ' <span class="badge urgent">דחוף</span>' : ''}`;
  let reports = [], selected = null, busy = false, detailGeneration = 0, imageUrls = [], createUid = crypto.randomUUID();
  function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').classList.toggle('error',error); }
  async function api(path, options) {
    const response = await fetch('/api/bug-reports' + path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'הפעולה נכשלה');
    return data;
  }
  function resetImages() { for (const u of imageUrls) URL.revokeObjectURL(u); imageUrls=[]; }
  function setupUploads(root) {
    root.querySelectorAll('.upload').forEach(zone => {
      const input = zone.querySelector('input[type=file]'); let files = [], urls=[];
      zone.tabIndex=0;
      function render() {
        urls.forEach(URL.revokeObjectURL); urls=[];
        const previews=zone.querySelector('.previews'); previews.replaceChildren();
        files.forEach((file,index) => {
          const wrap=document.createElement('div'), img=document.createElement('img'), remove=document.createElement('button');
          const url=URL.createObjectURL(file); urls.push(url); img.src=url; img.alt=file.name;
          remove.type='button'; remove.textContent='הסר תמונה'; remove.onclick=()=>{files.splice(index,1);render();};
          wrap.append(img,remove); previews.append(wrap);
        });
      }
      function add(list) {
        if (busy) return;
        for(const f of list) {
          if (!['image/png','image/jpeg','image/webp'].includes(f.type)) {feedback('אפשר לצרף רק PNG, JPG או WebP',true);continue;}
          if(f.size>4*1024*1024 || files.length>=3){feedback('עד 3 תמונות לתיבה, כל תמונה עד 4 מ״ב',true);continue;}
          files.push(f);
        }
        render(); input.value='';
      }
      input.onchange=()=>add(input.files);
      zone.addEventListener('paste',e=>{const list=[...(e.clipboardData?.files || [])];if(list.length){e.preventDefault();add(list);}});
      zone.addEventListener('dragover',e=>e.preventDefault());
      zone.addEventListener('drop',e=>{e.preventDefault();add(e.dataTransfer.files);});
      zone.bugFiles=()=>files.slice(); zone.clearBugFiles=()=>{files=[];render();}; zone.disposeBugFiles=()=>urls.forEach(URL.revokeObjectURL);
    });
  }
  function formData(form) {
    const data = new FormData(form); data.delete('before');data.delete('expected');data.delete('after');
    form.querySelectorAll('.upload').forEach(zone=>zone.bugFiles().forEach(f=>data.append(zone.dataset.kind,f,f.name)));
    return data;
  }
  async function saving(action) {
    if(busy)return; busy=true;
    document.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);
    try { await action(); } catch(e){feedback(e.message,true);} finally {busy=false;document.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=false);}
  }
  function renderList() {
    const filter=$('filter').value, term=$('search').value.trim().toLowerCase();
    const rows=reports.filter(r=>(filter==='all'||(filter==='open'?r.status!=='closed':r.status===filter)) && `${r.id} ${r.title} ${r.order_reference} ${r.item_reference}`.toLowerCase().includes(term));
    $('list-summary').textContent=`${rows.length} דיווחים מוצגים · ${reports.filter(r=>r.status!=='closed').length} פתוחים${reports.length===500?' · מוצגים 500 הדיווחים האחרונים':''}`;
    $('report-list').innerHTML=rows.map(r=>`<button class="report-card ${selected?.report.id===r.id?'selected':''}" data-id="${r.id}"><span>#${r.id}</span><strong>${esc(r.title)}</strong>${badge(r.status,r.priority)}<p class="muted">${r.order_reference?'הזמנה '+esc(r.order_reference)+' · ':''}${esc(r.created_by_name)}<br>${esc(date(r.updated_at))}</p></button>`).join('') || '<p class="muted">אין דיווחים בתצוגה הזו.</p>';
    $('report-list').querySelectorAll('button').forEach(b=>b.onclick=()=>openReport(b.dataset.id).catch(e=>feedback(e.message,true)));
  }
  async function refreshList(){const data=await api('');reports=data.reports;renderList();}
  function gallery(files){return files.length?`<div class="gallery">${files.map(f=>`<figure class="image-card"><button data-image="${f.id}" aria-label="הגדל ${esc(kinds[f.kind])}"><img data-file="${f.id}" alt="${esc(kinds[f.kind])}" loading="lazy"></button><figcaption>${esc(kinds[f.kind])} · ${esc(f.filename)}</figcaption></figure>`).join('')}</div>`:'';}
  function disposeDetail(){ $('detail').querySelectorAll('.upload').forEach(z=>z.disposeBugFiles?.()); resetImages(); }
  async function loadImages(data,generation){
    for(const file of data.attachments){
      try{
        const response=await fetch(`/api/bug-reports/${data.report.id}/images/${file.id}`);
        if(!response.ok)throw new Error('טעינת התמונה נכשלה');
        const blob=await response.blob(); if(generation!==detailGeneration)return;
        const url=URL.createObjectURL(blob);imageUrls.push(url);
        $('detail').querySelectorAll(`[data-file="${file.id}"]`).forEach(img=>img.src=url);
        $('detail').querySelectorAll(`[data-image="${file.id}"]`).forEach(btn=>btn.onclick=()=>{$('full-image').src=url;$('image-dialog').showModal();});
      }catch(e){if(generation===detailGeneration)feedback(e.message,true);}
    }
  }
  function renderDetail(data){
    disposeDetail();selected=data;const r=data.report;
    const created=data.events.find(e=>e.event_type==='created');
    $('detail').innerHTML=`<div class="list-heading"><h2>#${r.id} · ${esc(r.title)}</h2><button id="copy-brief">העתק פרטי דיווח לצ׳אט</button></div>${badge(r.status,r.priority)}<p class="context">${r.order_reference?'הזמנה '+esc(r.order_reference)+' · ':''}${r.item_reference?'פריט '+esc(r.item_reference)+' · ':''}דווח על ידי ${esc(r.created_by_name)} · ${esc(date(r.created_at))}${r.page_path?`<br><a href="${esc(r.page_path)}">פתח את המסך שבו התגלתה הבעיה</a>`:''}</p>
      <div class="two"><div><h3>מה לא טוב</h3><div class="prose">${esc(r.actual)}</div></div><div><h3>איך צריך להיות</h3><div class="prose">${esc(r.expected)}</div></div></div>${gallery(data.attachments.filter(f=>f.event_id===created?.id))}
      ${r.resolution?`<section class="treatment"><h3>${r.status==='closed'?'התיקון שאושר':'התיקון האחרון שהוגש — יש לבדוק לפני אישור'}</h3><p>מטפל: ${esc(r.handler_name)}</p><div class="prose">${esc(r.resolution)}</div><p class="muted">גרסה / בדיקה: ${esc(r.resolution_reference||'לא צוין')}</p></section>`:''}
      <h3 style="margin-top:24px">היסטוריית הטיפול והשיחה</h3>${data.events.map(e=>`<article class="event"><strong>${esc(e.actor_name)}</strong> · <span class="muted">${esc(date(e.created_at))}</span>${e.from_status!==e.to_status?`<p>${esc(labels[e.from_status])} ← ${esc(labels[e.to_status])}</p>`:''}<div class="prose">${esc(e.message)}</div>${e.resolution?`<p><strong>איך טופל · ${esc(e.handler_name)}</strong></p><div class="prose">${esc(e.resolution)}</div><p class="muted">${esc(e.resolution_reference)}</p>`:''}${e.event_type!=='created'?gallery(data.attachments.filter(f=>f.event_id===e.id)):''}</article>`).join('')}
      <form id="comment-form"><h3>הוסף הודעה או תמונה</h3><label>הודעה<textarea name="message" maxlength="6000" placeholder="פרטים נוספים, תשובה לשאלה או מה עדיין לא תקין"></textarea></label><div class="upload" data-kind="before"><label>תמונות נוספות<input type="file" name="before" accept="image/png,image/jpeg,image/webp" multiple></label><div class="previews"></div></div><button class="primary" type="submit">הוסף לשיחה</button></form>
      ${data.can_manage && ['new','needs_info','in_progress'].includes(r.status)?`<form id="treatment-form" class="treatment"><h3>טיפול בדיווח — מנהלים</h3><div class="actions"><button type="button" data-status="in_progress">התחל / המשך טיפול</button><button type="button" data-status="needs_info">בקש מידע נוסף</button></div><label>מי טיפל?<input name="handler_name" maxlength="100" required placeholder="שם המטפל"></label><label>איך טופל ומה נבדק?<textarea name="resolution" maxlength="6000" required></textarea></label><label>גרסת התוכנה / אסמכתת בדיקה<input name="resolution_reference" maxlength="300"></label><div class="upload" data-kind="after"><label>תמונה חדשה של התוצאה המתוקנת — חובה<input type="file" name="after" accept="image/png,image/jpeg,image/webp" multiple></label><div class="previews"></div></div><button type="submit" class="primary">תוקן — שלח לאישור המדווח</button></form>`:''}
      ${r.status==='awaiting_confirmation'?`<section class="confirmation"><h3>בדיקה ואישור התיקון</h3><label>מה בדקת? האם התיקון מתאים?<textarea id="confirmation-message" maxlength="6000" placeholder="יש לכתוב אישור או להסביר מה עדיין לא תקין"></textarea></label><div class="actions"><button id="confirm-fix" class="primary">בדקתי — התיקון תקין, סגור דיווח</button><button id="reject-fix" class="danger">לא תקין — החזר לטיפול</button></div></section>`:''}
      ${r.status==='closed'?'<button id="reopen-fix" class="danger">הבעיה חזרה — פתח מחדש</button>':''}`;
    setupUploads($('detail'));renderList();
    $('copy-brief').onclick=async()=>{try{await navigator.clipboard.writeText(`דיווח #${r.id}: ${r.title}\nמצב: ${labels[r.status]}\nהזמנה: ${r.order_reference} פריט: ${r.item_reference}\nמה לא טוב: ${r.actual}\nאיך צריך להיות: ${r.expected}\n${location.origin}/bugs.html?id=${r.id}\n${r.resolution?'תיקון שהוגש: '+r.resolution:''}`);feedback('פרטי הדיווח הועתקו. אפשר להדביק אותם בצ׳אט איתי.');}catch{feedback('לא ניתן להעתיק כרגע. שלח בצ׳אט את מספר הדיווח: '+r.id,true);}};
    $('comment-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;const body=formData(form);saveEvent(body);};
    $('treatment-form')?.addEventListener('submit',e=>{e.preventDefault();const body=formData(e.currentTarget);body.set('status','awaiting_confirmation');saveEvent(body);});
    $('detail').querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{if(b.dataset.status===r.status){feedback('הדיווח כבר במצב זה');return;}const message=prompt(b.dataset.status==='needs_info'?'איזה מידע חסר?':'מה מתוכנן במסגרת הטיפול?');if(message?.trim()){const body=new FormData();body.set('status',b.dataset.status);body.set('message',message);saveEvent(body);}});
    function confirm(status){const message=$('confirmation-message').value.trim();if(!message){feedback('נא לכתוב מה בדקת או מה עדיין לא תקין',true);return;}const body=new FormData();body.set('status',status);body.set('message',message);saveEvent(body);}
    if($('confirm-fix'))$('confirm-fix').onclick=()=>confirm('closed');
    if($('reject-fix'))$('reject-fix').onclick=()=>confirm('in_progress');
    if($('reopen-fix'))$('reopen-fix').onclick=()=>{const message=prompt('מה חזר או עדיין לא תקין? ההיסטוריה ותמונות התיקון הקודמות יישמרו.');if(message?.trim()){const body=new FormData();body.set('status','in_progress');body.set('message',message);saveEvent(body);}};
  }
  async function openReport(id){if(busy)return;const generation=++detailGeneration;const data=await api('/'+encodeURIComponent(id));if(generation!==detailGeneration)return;renderDetail(data);history.replaceState(null,'','/bugs.html?id='+data.report.id);await loadImages(data,generation);}
  function saveEvent(body){const id=selected.report.id;body.set('version',String(selected.report.version));saving(async()=>{const data=await api('/'+id+'/events',{method:'POST',body});const generation=++detailGeneration;renderDetail(data);await refreshList();feedback('העדכון נשמר בהיסטוריית הדיווח');await loadImages(data,generation);});}
  $('new-report').onclick=()=>{$('create-panel').hidden=false;$('create-form').elements.title.focus();};
  $('cancel-create').onclick=()=>{$('create-panel').hidden=true;};
  $('create-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget,body=formData(form);body.set('request_uid',createUid);saving(async()=>{const data=await api('',{method:'POST',body});form.reset();form.querySelectorAll('.upload').forEach(z=>z.clearBugFiles());createUid=crypto.randomUUID();$('create-panel').hidden=true;const generation=++detailGeneration;renderDetail(data);history.replaceState(null,'','/bugs.html?id='+data.report.id);await refreshList();feedback('הדיווח נפתח ונשמר עם התמונות');await loadImages(data,generation);});};
  $('refresh').onclick=()=>saving(async()=>{await refreshList();if(selected){const data=await api('/'+selected.report.id);const generation=++detailGeneration;renderDetail(data);await loadImages(data,generation);}feedback('הדיווחים עודכנו');});
  $('search').oninput=renderList;$('filter').onchange=renderList;
  $('close-image').onclick=()=>{$('image-dialog').close();$('full-image').removeAttribute('src');};
  setupUploads($('create-panel'));
  refreshList().then(()=>{const id=new URLSearchParams(location.search).get('id');if(/^\d+$/.test(id||''))return openReport(id);}).catch(e=>feedback(e.message,true));
})();
