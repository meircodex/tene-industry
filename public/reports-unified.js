'use strict';
const $=id=>document.getElementById(id);
const escH=value=>window.IronBendSafe.escapeHtml(String(value??''));
const num=value=>Number(value)||0;
const fmt=(value,digits=0)=>Number(value||0).toLocaleString('he-IL',{maximumFractionDigits:digits});
const rate=value=>value==null?'—':fmt(value,2);
const materialName=value=>({coil:'גליל',straight:'ליפט',bent:'ברזל מכופף',mesh:'רשת'})[value]||'סוג לא מאומת';
let page=1,requestId=0,current=null,visibleRows=[],columns=[],sortKey='',sortDirection='asc';
let chosen=null;try{chosen=JSON.parse(localStorage.getItem('reportColumnsV2'));}catch{}
function formatMinutes(value) {
 const minutes = num(value);
 if(!minutes)return '0 דק׳';
 if(minutes<1)return minutes*60<1?'פחות משנייה':`${Math.round(minutes*60)} שנ׳`;
 if(Math.round(minutes*10)<600)return `${minutes.toFixed(minutes%1?1:0)} דק׳`;
 const rounded=Math.round(minutes);return `${Math.floor(rounded/60)} שע׳ ${rounded%60} דק׳`;
}
function dateTime(value){if(!value)return '—';const raw=String(value);const d=new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(raw)?raw:raw.replace(' ','T')+'Z');return Number.isNaN(+d)?'—':d.toLocaleString('he-IL',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Jerusalem'});}
function dayText(day){return String(day||'').split('-').reverse().join('.');}
function badge(status){return `<span class="badge ${escH(status||'unknown')}">${({reliable:'אמינה',review:'דורשת בדיקה',unreliable:'לא אמינה'})[status]||'טרם נמדדה'}</span>`;}
function kindText(r){return r.same_day_scanned?'התחלה וסיום באותו יום':r.ended_from_prior_day?'התחיל ביום קודם':r.ended_unmatched?'סיום ללא התחלה מאומתת':r.started?'ללא סיום באותו יום':'—';}
async function api(url,options){const res=await fetch(url,options);let data;try{data=await res.json();}catch{throw Error('הנתונים לא נטענו. יש לנסות שוב.');}if(!res.ok)throw Error(res.status===403?'אין הרשאה לצפייה בדוח זה':res.status===401?'נדרשת התחברות מחדש':res.status===409?'המדידה השתנתה. טען שוב לפני שמירת החלטה.':'הפעולה לא הושלמה. בדוק את השדות ונסה שוב.');return data;}
const multiFields=['machine','diameter','material','customer','order','status','worker','kind','reliability'];
function selectedValues(id){return [...$(id).selectedOptions].map(o=>o.value).filter(v=>v&&v!=='all');}
function filterParams(targetPage=page){const p=new URLSearchParams({from:$('fromDate').value,to:$('toDate').value,unified:'1',flat:'1',group:'card',page:String(targetPage),limit:$('limit').value});for(const key of multiFields){const values=selectedValues(key);if(values.length)p.set(key+'_in',JSON.stringify(values));}if($('search').value)p.set('search',$('search').value);if(sortKey){p.set('sort',sortKey);p.set('direction',sortDirection);}return p;}
function renderMulti(id){const select=$(id),box=document.querySelector(`[data-multi="${id}"]`);if(!box)return;
 const items=[...select.options].filter(o=>o.value&&o.value!=='all'),values=selectedValues(id),title=[...select.selectedOptions].filter(o=>o.value&&o.value!=='all').map(o=>o.textContent);
 box.querySelector('summary').textContent=title.length?title.slice(0,2).join(' · ')+(title.length>2?` +${title.length-2}`:''):(select.options[0]?.textContent||'הכול');box.classList.toggle('has-selection',!!values.length);
 const signature=JSON.stringify(items.map(o=>[o.value,o.textContent]));if(box.dataset.options!==signature){box.dataset.options=signature;box.querySelector('.multi-options').innerHTML='<button type="button" class="multi-clear">הצג הכול / נקה בחירה</button>'+items.map(o=>`<label><input type="checkbox" data-filter-value="${escH(o.value)}">${escH(o.textContent)}</label>`).join('');}
 for(const input of box.querySelectorAll('[data-filter-value]'))input.checked=values.includes(input.dataset.filterValue);
}
function setupMulti(){for(const id of multiFields){const select=$(id);select.multiple=true;select.hidden=true;for(const o of select.options)o.selected=false;
 const box=document.createElement('details');box.className='multi-filter';box.dataset.multi=id;box.innerHTML='<summary></summary><div class="multi-options"></div>';select.insertAdjacentElement('afterend',box);
 box.addEventListener('change',event=>{if(!event.target.matches('[data-filter-value]'))return;const value=event.target.dataset.filterValue;for(const o of select.options)if(o.value===value)o.selected=event.target.checked;renderMulti(id);page=1;loadReport();});
 box.addEventListener('click',event=>{if(!event.target.closest('.multi-clear'))return;for(const o of select.options)o.selected=false;renderMulti(id);page=1;loadReport();});renderMulti(id);
 }
 document.addEventListener('click',event=>{for(const box of document.querySelectorAll('.multi-filter[open],.column-picker[open]'))if(!box.contains(event.target))box.open=false;});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const box of document.querySelectorAll('.multi-filter[open],.column-picker[open]'))box.open=false;});
}
function options(id,values,empty){const old=selectedValues(id);$(id).innerHTML=`<option value="">${escH(empty)}</option>`+values.map(v=>{const value=typeof v==='object'?v.value:v,label=typeof v==='object'?v.label:v;return `<option value="${escH(value)}" ${old.includes(String(value))?'selected':''}>${escH(label)}</option>`;}).join('');renderMulti(id);}
function productionColumns(){return [
 ['כרטיס',r=>'#'+r.item_id],['הזמנה',r=>r.order_num||'—'],['לקוח',r=>r.customer_name||'—'],['צורה',r=>r.shape_name],['קוטר (מ״מ)',r=>r.diameter_mm||'—'],['סוג חומר',r=>materialName(r.material_type)],['מכונה',r=>r.machine],['מצב כרטיס',r=>r.status||'—'],
 ['כמות מתוכננת',r=>fmt(r.planned_quantity)],['כמות שיוצרה',r=>r.reported_complete?fmt(r.reported_quantity):'—'],['משקל (ק״ג)',r=>r.reported_complete?fmt(r.reported_weight_kg,2):'—'],['מקור המשקל',r=>r.weight_source==='measured'?'שקילה':r.weight_source==='theoretical'?'תאורטי':'—'],
 ['אורך יחידה (מטר)',r=>r.card?.unitCutLengthMm==null?'—':fmt(r.card.unitCutLengthMm/1000,2)],['אורך שיוצר (מטר)',r=>r.produced_length_mm==null?'—':fmt(r.produced_length_mm/1000,2)],
 ['התחלה',r=>dateTime((r.ended||r.started)?.started_at)],['סיום',r=>dateTime(r.ended?.completed_at)],['עובדים שדיווחו',r=>r.worker_names],['דיווח התחלה',r=>r.start_worker||'לא מזוהה'],['דיווח סיום',r=>r.end_worker||'לא מזוהה'],
 ['זמן כולל',r=>r.card?.gross_minutes==null?'—':formatMinutes(r.card.gross_minutes)],['מחוץ לעבודה',r=>r.card?.outside_work_minutes==null?'—':formatMinutes(r.card.outside_work_minutes)],['צהריים',r=>r.card?.lunch_minutes==null?'—':formatMinutes(r.card.lunch_minutes)],['עצירות',r=>r.card?.documented_stop_minutes==null?'—':formatMinutes(r.card.documented_stop_minutes)],
 ['זמן נטו',r=>r.card?.net_minutes==null?'אין זמן מדוד':formatMinutes(r.card.net_minutes)],['מטר לדקה',r=>rate(r.card?.meters_per_min)],['ק״ג לדקה',r=>rate(r.card?.kg_per_min)],['אמינות',r=>badge(r.reliability_status),true],['נכלל בסטטיסטיקה',r=>r.card?.included_in_statistics?'כן':'לא'],['סיבת אמינות',r=>(r.card?.reliability_reasons||[]).join(' · ')],['סוג דיווח',r=>kindText(r)],['ימי פעילות בטווח',r=>(r.activity_dates||[]).map(dayText).join(' · ')],['פירוט',()=>'<button data-action="card">פתח</button>',true]
 ];}
const defaultColumns=['כרטיס','הזמנה','לקוח','קוטר (מ״מ)','מכונה','כמות שיוצרה','משקל (ק״ג)','התחלה','סיום','עובדים שדיווחו','זמן נטו','מטר לדקה','אמינות','פירוט'];
function configureColumns(){const all=productionColumns();if(!Array.isArray(chosen)||!chosen.some(t=>all.some(([name])=>name===t)))chosen=defaultColumns.slice();columns=all.filter(([t])=>chosen.includes(t)||t==='פירוט');$('columnChoices').innerHTML=all.filter(([t])=>t!=='פירוט').map(([t])=>`<label><input type="checkbox" data-column="${escH(t)}" ${chosen.includes(t)?'checked':''}>${escH(t)}</label>`).join('')+'<button type="button" id="allColumns">כל העמודות</button><button type="button" id="defaultColumns">תצוגה רגילה</button>';}
const sortFields=['card','order','customer','shape','diameter','material','machine','status','planned','quantity','weight','weight_source','unit_length','length','start','end','workers','start_worker','end_worker','gross','outside','lunch','stops','net','pace','kg_pace','reliability','included','reason','kind','dates'];
function columnSort(title){return sortFields[productionColumns().findIndex(([t])=>t===title)]||'';}
function drawTable(rows){visibleRows=rows;$('reportHead').innerHTML='<tr>'+columns.map(([title])=>{const key=columnSort(title),active=key===sortKey;return `<th scope="col" ${active?`aria-sort="${sortDirection==='asc'?'ascending':'descending'}"`:''}>${key?`<span class="column-heading"><button type="button" class="column-sort ${active?'active':''}" data-sort="${key}" title="מיון לפי ${escH(title)} — לחץ להחלפת כיוון">${escH(title)} <span aria-hidden="true">${active?(sortDirection==='asc'?'↑':'↓'):'↕'}</span></button><button type="button" class="column-hide" data-hide-column="${escH(title)}" title="הסתר עמודה: ${escH(title)}" aria-label="הסתר עמודה: ${escH(title)}">×</button></span>`:escH(title)}</th>`;}).join('')+'</tr>';$('reportBody').innerHTML=rows.map((r,index)=>`<tr data-row="${index}">${columns.map(([,fn,html])=>`<td>${html?fn(r):escH(fn(r))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${columns.length}" style="text-align:center;padding:32px">אין תוצאות לסינון שנבחר</td></tr>`;}
function pagination(total,pages){$('resultCount').textContent=`${fmt(total)} תוצאות`;$('pageNumber').textContent=`${page} / ${pages}`;$('prevPage').disabled=page<=1;$('nextPage').disabled=page>=pages;}
function productionSummary(s){$('reportSummary').innerHTML=[['כרטיסים',fmt(s.cards)],['כרטיסים שהושלמו',fmt(s.reported_cards)],['משקל שיוצר',fmt(s.weight_kg,1)+' ק״ג'],['זמן אמין',formatMinutes(s.net_minutes)],['מטר לדקה',rate(s.meters_per_min)],['מדידות אמינות',fmt(s.reliable_cards)]].map(([k,v])=>`<span>${k}<strong>${escH(v)}</strong></span>`).join('');}
async function loadReport(){
 const ticket=++requestId;
 if(!$('fromDate').value||!$('toDate').value||$('fromDate').value>$('toDate').value){$('reportState').textContent='יש לבחור טווח תאריכים תקין';return;}
 $('reportState').textContent='טוען נתונים…';$('exportReport').disabled=true;
 try{
  const data=await api('/api/reports/production-timing?'+filterParams());if(ticket!==requestId)return;
  if(!data.unified||!Array.isArray(data.unified.rows))throw Error('לא התקבלו נתונים עדכניים מהשרת. יש ללחוץ שוב על הצג.');
  current=data.unified;page=current.page;configureColumns();drawTable(current.rows);productionSummary(current.summary);window.IronBendReportCharts?.render(current.charts);pagination(current.total,current.pages);
  options('machine',current.facets.machines,'כל המכונות');options('diameter',current.facets.diameters,'כל הקטרים');options('customer',current.facets.customers,'כל הלקוחות');options('order',current.facets.orders,'כל ההזמנות');options('status',current.facets.statuses,'כל המצבים');
  options('worker',current.facets.workers.map(w=>({value:w.key,label:w.name})),'כל העובדים');
  $('reportNote').textContent='כל כרטיס מופיע פעם אחת, אם יש לו סריקת התחלה או סיום בטווח התאריכים. הכמות והמשקל נספרים רק כשהסיום בתקופה. בחירת עמודות אינה משנה את הנתונים או את הסיכום. הקצב בסיכום מחושב רק ממדידות אמינות; זמן נטו מנכה שעות סגירה, שבת, הפסקות ועצירות. דיווחים ישנים ללא זיהוי נשארים לא מזוהים.';
  $('reportState').textContent='';$('exportReport').disabled=false;
 }catch(error){if(ticket===requestId){$('reportState').textContent=error.message;current=null;drawTable([]);$('reportSummary').textContent='';window.IronBendReportCharts?.render(null);pagination(0,1);}}
}
function detail(r){
 const c=r.card,title=`כרטיס #${r.item_id} · ${r.order_num||''}`;$('detailTitle').textContent=title;
 const fields=[['עובדים שדיווחו',r.worker_names||'לא מזוהה'],['לקוח',r.customer_name||'—'],['צורה',r.shape_name],['מכונה / קוטר',`${r.machine} · Ø${r.diameter_mm||'—'} · ${materialName(r.material_type)}`],['סוג הדיווח',kindText(r)],['התחלה',dateTime((r.ended||r.started)?.started_at)],['סיום',dateTime(r.ended?.completed_at)],['כמות שיוצרה בתקופה',r.reported_complete?fmt(r.reported_quantity):'אין סיום מדווח בתקופה'],['משקל',r.reported_complete?`${fmt(r.reported_weight_kg,2)} ק״ג · ${r.weight_source==='measured'?'שקילה':'תאורטי'}`:'—'],['מטר לדקה שנרשם',rate(c?.meters_per_min)],['ק״ג לדקה שנרשם',rate(c?.kg_per_min)],['זמן נטו שנרשם',c?.net_minutes==null?'אין זמן מדוד':formatMinutes(c.net_minutes)]];
 let html=`<div class="detail-grid">${fields.map(([k,v])=>`<div><small>${escH(k)}</small><strong>${escH(v)}</strong></div>`).join('')}</div>${badge(r.reliability_status)}<p>${c?.included_in_statistics?'נכלל בסטטיסטיקה':'מחוץ לסטטיסטיקת הקצב'}</p><p>${(c?.reliability_reasons||[]).map(escH).join('<br>')}</p>`;
 if(c&&c.net_minutes!=null)html+=`<details><summary>איך חושב הזמן?</summary>זמן כולל: ${formatMinutes(c.gross_minutes)}<br>מחוץ לשעות עבודה: ${formatMinutes(c.outside_work_minutes)}<br>צהריים: ${formatMinutes(c.lunch_minutes)}<br>עצירות: ${formatMinutes(c.documented_stop_minutes)}<p>א׳–ה׳ 07:00–18:00; שישי עם סריקה של אותו כרטיס 07:00–14:00; שבת לא נספרת. צהריים 12:00–12:45.</p></details>`;
 if(c?.working_day_breakdown?.length)html+=`<details><summary>כמה זמן נספר בכל יום?</summary>${c.working_day_breakdown.map(day=>`<p><strong>${escH(dayText(day.date))}: ${formatMinutes(day.net_minutes)}</strong> · מחוץ לעבודה: ${formatMinutes(day.outside_work_minutes)} · הפסקות: ${formatMinutes(day.lunch_minutes+day.documented_stop_minutes)}</p>`).join('')}<p>שבת אינה נספרת; שישי נספר רק עם סריקה של אותו כרטיס. זמן בין הסריקות בתוך שעות העבודה אינו הוכחה שהמכונה עבדה ברציפות.</p></details>`;
 if(c&&['manager','admin'].includes(window.IronBendAuth?.currentUser()?.role))html+=`<details><summary>בדיקת מנהל</summary><form id="timingReview"><label>החלטה<select name="decision" required><option value="">בחר החלטה</option><option value="include" ${c.measurement_status!=='measured'||!num(c.net_minutes)?'disabled':''}>אישור המדידה כאמינה</option><option value="exclude">סימון כלא אמינה</option></select></label><label>סיבה<textarea name="reason" minlength="3" maxlength="500" required>${escH(c.timing_review?.reason||'')}</textarea></label><button type="submit">שמור החלטה</button><small>${c.timing_review?escH(c.timing_review.reviewer_name||'מנהל')+' · '+dateTime(c.timing_review.reviewed_at):'הזמנים המקוריים אינם משתנים.'}</small></form></details>`;
 if(num(r.order_id))html+=`<p><a href="/orders.html?id=${num(r.order_id)}">פתח הזמנה ${escH(r.order_num)}</a></p>`;
 $('detailBody').innerHTML=html;$('reviewMessage').textContent='';$('reportDetail').showModal();const form=$('timingReview');if(form)form.addEventListener('submit',event=>saveReview(event,c));
}
async function saveReview(event,card){event.preventDefault();const form=event.target,button=form.querySelector('button');button.disabled=true;$('reviewMessage').textContent='שומר החלטה…';try{
 await api('/api/production-timing/'+card.item_id+'/review',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({production_day:card.production_day,measurement_key:card.measurement_key,expected_review_revision:card.review_revision,decision:form.elements.decision.value,reason:form.elements.reason.value})});
 await loadReport();$('detailBody').innerHTML='<p>ההחלטה נשמרה. הטבלה והסיכום עודכנו לפי הסינון הנוכחי.</p>';$('reviewMessage').textContent='';
 }catch(error){$('reviewMessage').textContent=error.message;}finally{button.disabled=false;}}
function csvCell(value){const text=String(value??'').replace(/<[^>]*>/g,' · ');return '"'+(/^[\s]*[=+@\-]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';}
async function exportReport(){const button=$('exportReport');button.disabled=true;try{
 const exportColumns=columns.slice(),params=filterParams(1);params.set('limit','200');const first=(await api('/api/reports/production-timing?'+params)).unified;const rows=[...first.rows];
 for(let n=2;n<=first.pages;n++){params.set('page',String(n));rows.push(...(await api('/api/reports/production-timing?'+params)).unified.rows);}
 const cols=exportColumns.filter(([title])=>title!=='פירוט'),csv=[cols.map(([title])=>csvCell(title)).join(','),...rows.map(r=>cols.map(([,fn])=>csvCell(fn(r))).join(','))].join('\r\n');
 const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`ironbend-cards-${$('fromDate').value}.csv`;a.click();URL.revokeObjectURL(url);
 }catch(error){$('reportState').textContent=error.message;}finally{button.disabled=false;}}
document.addEventListener('DOMContentLoaded',()=>{
 const now=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);$('toDate').value=today;$('fromDate').value=new Date(Date.parse(today+'T12:00:00Z')-30*86400000).toISOString().slice(0,10);
 $('reportFilters').addEventListener('submit',event=>{event.preventDefault();page=1;loadReport();});
 for(const id of ['limit'])$(id).addEventListener('change',()=>{page=1;loadReport();});
 $('clearFilters').addEventListener('click',()=>{for(const id of multiFields){for(const o of $(id).options)o.selected=false;renderMulti(id);}$('search').value='';page=1;loadReport();});
 $('columnChoices').addEventListener('change',event=>{const title=event.target.dataset.column;if(!title)return;chosen=event.target.checked?[...new Set([...chosen,title])]:chosen.filter(t=>t!==title);localStorage.setItem('reportColumnsV2',JSON.stringify(chosen));configureColumns();drawTable(current?.rows||[]);});
 $('columnChoices').addEventListener('click',event=>{if(!['allColumns','defaultColumns'].includes(event.target.id))return;chosen=event.target.id==='allColumns'?productionColumns().map(([t])=>t):defaultColumns.slice();localStorage.setItem('reportColumnsV2',JSON.stringify(chosen));configureColumns();drawTable(current?.rows||[]);});
 $('reportHead').addEventListener('click',event=>{const hide=event.target.closest('[data-hide-column]')?.dataset.hideColumn;if(hide){chosen=chosen.filter(t=>t!==hide);localStorage.setItem('reportColumnsV2',JSON.stringify(chosen));configureColumns();drawTable(current?.rows||[]);return;}const key=event.target.closest('[data-sort]')?.dataset.sort;if(!key)return;sortDirection=sortKey===key&&sortDirection==='asc'?'desc':'asc';sortKey=key;page=1;loadReport();});
 $('prevPage').addEventListener('click',()=>{page--;loadReport();});$('nextPage').addEventListener('click',()=>{page++;loadReport();});
 $('reportBody').addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button)detail(visibleRows[num(button.closest('tr').dataset.row)]);});
 $('toggleCharts').addEventListener('click',()=>{const show=$('reportCharts').hidden;$('reportCharts').hidden=!show;$('toggleCharts').setAttribute('aria-expanded',String(show));$('toggleCharts').textContent=show?'הסתר גרפים':'הצג גרפים';});
 $('closeDetail').addEventListener('click',()=>$('reportDetail').close());$('exportReport').addEventListener('click',exportReport);setupMulti();configureColumns();loadReport();
});
