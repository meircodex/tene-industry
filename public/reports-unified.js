'use strict';
const $=id=>document.getElementById(id);
const escH=value=>window.IronBendSafe.escapeHtml(String(value??''));
const num=value=>Number(value)||0;
const fmt=(value,digits=0)=>Number(value||0).toLocaleString('he-IL',{maximumFractionDigits:digits});
const rate=value=>value==null?'—':fmt(value,2);
const labels={card:'כרטיס',day:'יום',machine:'מכונה',diameter:'קוטר',order:'הזמנה',customer:'לקוח',shape:'צורה'};
const materialName=value=>({coil:'גליל',straight:'ליפט',bent:'ברזל מכופף',mesh:'רשת'})[value]||'סוג לא מאומת';
let page=1,requestId=0,current=null,visibleRows=[],columns=[],genericRows=[],exportRows=[],drill=null;
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
function filterParams(targetPage=page){const p=new URLSearchParams({from:$('fromDate').value,to:$('toDate').value,unified:'1',page:String(targetPage),limit:$('limit').value});for(const key of ['group','machine','diameter','material','customer','kind','reliability','search'])if($(key).value)p.set(key,$(key).value);if(drill?.field){p.set('drill_field',drill.field);p.set('drill_value',drill.key);}return p;}
function options(id,values,empty){const old=$(id).value;$(id).innerHTML=`<option value="">${escH(empty)}</option>`+values.map(v=>`<option value="${escH(v)}">${escH(v)}</option>`).join('');$(id).value=values.map(String).includes(old)?old:'';}
function configureTopic(){const topic=$('topic').value,prod=topic==='production';for(const key of ['group','material','customer','kind','reliability'])$(key+'Label').hidden=!prod;$('machineLabel').hidden=!['production','waste','transitions','recipes'].includes(topic);$('diameterLabel').hidden=!['production','waste','workers','recipes'].includes(topic);$('workerLabel').hidden=topic!=='workers';for(const id of ['fromDate','toDate'])$(id).disabled=['finance','oee'].includes(topic);$('search').placeholder=prod?'לקוח, הזמנה, כרטיס או צורה':'חיפוש בתוצאות';}
function productionColumns(group){
 if(group!=='card')return [[labels[group],r=>group==='day'?dayText(r.label):group==='diameter'?'Ø'+r.label:r.label],['כרטיסים',r=>fmt(r.cards)],['יחידות שדווחו',r=>fmt(r.units)],['משקל מדווח (ק״ג)',r=>fmt(r.weight_kg,1)],['התחילו',r=>fmt(r.started_cards)],['סיומים',r=>fmt(r.ended_cards)],['מדידות אמינות',r=>fmt(r.reliable_cards)],['זמן אמין נטו',r=>formatMinutes(r.net_minutes)],['מטר לדקה',r=>rate(r.meters_per_min)],['ק״ג לדקה',r=>rate(r.kg_per_min)],['פירוט',()=>'<button data-action="group">פתח כרטיסים</button>',true]];
 return [['יום / הזמנה',r=>`${dayText(r.date)}<small>${escH(r.order_num||'—')} · ${escH(r.customer_name||'')}</small>`,true],['כרטיס / צורה',r=>`#${num(r.item_id)}<small>${escH(r.shape_name)}</small>`,true],['מכונה / קוטר',r=>`${escH(r.machine)}<small>Ø${num(r.diameter_mm)||'—'} · ${materialName(r.material_type)}</small>`,true],['יחידות / משקל',r=>r.reported_complete?`${fmt(r.reported_quantity)} יח׳<small>${fmt(r.reported_weight_kg,1)} ק״ג · ${r.weight_source==='measured'?'שקילה':'תאורטי'}</small>`:'—<small>אין כמות סיום ליום זה</small>',true],['התחלה',r=>dateTime((r.ended||r.started)?.started_at)],['סיום',r=>dateTime(r.ended?.completed_at)],['זמן נטו שנרשם',r=>r.card?.net_minutes==null?'אין זמן מדוד':formatMinutes(r.card.net_minutes)],['מטר לדקה',r=>r.card?.meters_per_min==null?'—':`${rate(r.card.meters_per_min)}${r.card.included_in_statistics?'':'<small>מחוץ לסטטיסטיקה</small>'}`,true],['אמינות',r=>badge(r.reliability_status),true],['פירוט',()=>'<button data-action="card">פתח</button>',true]];
}
function drawTable(rows){visibleRows=rows;$('reportHead').innerHTML='<tr>'+columns.map(([title])=>`<th scope="col">${escH(title)}</th>`).join('')+'</tr>';$('reportBody').innerHTML=rows.map((r,index)=>`<tr data-row="${index}">${columns.map(([,fn,html])=>`<td>${html?fn(r):escH(fn(r))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${columns.length}" style="text-align:center;padding:32px">אין תוצאות לסינון שנבחר</td></tr>`;}
function pagination(total,pages){$('resultCount').textContent=`${fmt(total)} תוצאות${drill?' · סינון מתוך סיכום':''}`;$('pageNumber').textContent=`${page} / ${pages}`;$('prevPage').disabled=page<=1;$('nextPage').disabled=page>=pages;}
function productionSummary(s){$('reportSummary').innerHTML=[['כרטיסים',fmt(s.cards)],['סיומים מדווחים',fmt(s.reported_cards)],['משקל מדווח',fmt(s.weight_kg,1)+' ק״ג'],['זמן אמין',formatMinutes(s.net_minutes)],['מטר לדקה',rate(s.meters_per_min)],['מדידות אמינות',fmt(s.reliable_cards)]].map(([k,v])=>`<span>${k}<strong>${escH(v)}</strong></span>`).join('');}
async function loadReport(){
 const ticket=++requestId,topic=$('topic').value;
 if(!$('fromDate').value||!$('toDate').value||$('fromDate').value>$('toDate').value){$('reportState').textContent='יש לבחור טווח תאריכים תקין';return;}
 $('reportState').textContent='טוען דוח…';$('exportReport').disabled=true;
 try{
  if(topic==='production'){
   const data=await api('/api/reports/production-timing?'+filterParams());if(ticket!==requestId)return;
   current=data.unified;page=current.page;columns=productionColumns($('group').value);drawTable(current.rows);productionSummary(current.summary);pagination(current.total,current.pages);
   options('machine',current.facets.machines,'כל המכונות');options('diameter',current.facets.diameters,'כל הקטרים');options('customer',current.facets.customers,'כל הלקוחות');
   $('reportNote').textContent='מטר לדקה בסיכום = סך המטרים במדידות האמינות ÷ סך הדקות שלהן. בטבלה מוצג גם הקצב שנרשם במדידות חשודות, עם סימון. זמן נטו מחושב מסריקות בשעות העבודה, בניכוי הפסקות ועצירות. משקל וכמות נזקפים ליום הסיום בלבד; כרטיס חוצה ימים אינו מוכיח כמה יוצר בכל יום. ימים ללא התחלה נשארים גלויים.';
  }else{
   const model=await loadTopic(topic);if(ticket!==requestId)return;current=null;genericRows=model.rows;columns=model.columns;$('reportNote').textContent=model.note||'';renderGeneric();
  }
  $('reportState').textContent='';$('exportReport').disabled=false;
 }catch(error){if(ticket===requestId){$('reportState').textContent=error.message+' הנתונים הקודמים הוסתרו כדי למנוע בלבול.';current=null;genericRows=[];drawTable([]);$('reportSummary').textContent='';pagination(0,1);}}
}
async function loadTopic(topic){
 const params=new URLSearchParams({from:$('fromDate').value,to:$('toDate').value});
 if(topic==='workers'){
  if($('worker').value)params.set('worker_id',$('worker').value);
  const data=await api('/api/reports/worker-card-activity?'+params);const old=$('worker').value;$('worker').innerHTML='<option value="">כל העובדים</option>'+data.workers.map(w=>`<option value="${num(w.id)}">${escH(w.name)}</option>`).join('');$('worker').value=old;
  options('diameter',[...new Set(data.rows.map(r=>r.diameter).filter(Boolean))],'כל הקטרים');
  return {rows:data.rows,columns:[['מועד',r=>dateTime(r.occurred_at)],['עובד',r=>r.actor_name],['מכשיר',r=>r.device_name||'—'],['הזמנה',r=>r.order_num],['כרטיס',r=>'#'+r.item_id],['צורה',r=>r.shape_name||'—'],['קוטר',r=>r.diameter],['פעולה',r=>({opened:'פתיחת כרטיס',status_changed:'שינוי מצב',updated:'עדכון ביצוע'})[r.action]||r.action],['פרטים',r=>[r.details?.from_status,r.details?.to_status,r.details?.produced_qty==null?'':`כמות: ${r.details.produced_qty}`].filter(Boolean).join(' ← ')]],note:'יומן פעולות העובדים; פתיחת כרטיס אינה התחלת ייצור. מוצגות עד 500 הפעולות האחרונות בטווח. לצפייה בימים נוספים צמצם את התאריכים.'};
 }
 if(topic==='recipes'){
  const data=await api('/api/reports/production-timing?'+params);options('machine',[...new Set(data.recipes.map(r=>r.machine))],'כל המכונות');options('diameter',[...new Set(data.recipes.map(r=>r.diameter_mm).filter(Boolean))],'כל הקטרים');
  return {rows:data.recipes,columns:[['מכונה',r=>r.machine],['צורה',r=>r.shape_name],['קוטר',r=>r.diameter_mm],['אורך יחידה (מטר)',r=>fmt(r.unit_cut_length_mm/1000,2)],['כיפופים',r=>r.bend_count],['מדידות אמינות',r=>r.sample_count],['זמן נטו',r=>formatMinutes(r.net_minutes)],['מטר לדקה',r=>rate(r.meters_per_min)],['ק״ג לדקה',r=>rate(r.kg_per_min)],['צפי דקות ליחידה',r=>rate(r.median_min_per_unit)]],note:'מתכונים זהים לפי מכונה, צורה, קוטר, מידות וכיפופים. רק מדידות אמינות נכללות; צפי מוצג לאחר 5 מדידות זהות לפחות.'};
 }
 if(topic==='transitions'){
  const data=await api('/api/reports/production-timing?'+params);options('machine',[...new Set(data.transitions.map(r=>r.machine))],'כל המכונות');return {rows:data.transitions,columns:[['מכונה',r=>r.machine],['כרטיס קודם',r=>r.previous_item_id],['כרטיס הבא',r=>r.item_id],['פער גולמי',r=>formatMinutes(r.gross_gap_minutes)],['מחוץ לעבודה',r=>formatMinutes(r.outside_work_minutes)],['צהריים',r=>formatMinutes(r.lunch_minutes)],['עצירה',r=>formatMinutes(r.documented_stop_minutes)],['טעינת גליל',r=>formatMinutes(r.coil_load_minutes)],['מעבר / הכנה',r=>r.gap_status==='overlap'?'חפיפה — לבדיקה':formatMinutes(r.transition_minutes)]],note:'פער בין כרטיסים באותה מכונה. זמן טעינת גליל מוצג בנפרד; אין להסיק שזה זמן עבודה על הכרטיס.'};
 }
 if(topic==='oee')return {rows:await api('/api/machines/oee'),columns:[['מכונה',r=>r.name],['OEE',r=>r.oee==null?'אין מדידה':r.oee+'%'],['זמינות',r=>r.availability==null?'—':r.availability+'%'],['איכות',r=>r.quality==null?'—':r.quality+'%'],['עצירות',r=>formatMinutes(r.downtime_min)],['משקל היום (טון)',r=>fmt(r.tons_today,2)],['הערה',r=>r.measurement_reason||'']],note:'נתוני היום בלבד; ללא תקן ומדידה אין לחשב אחוז יעילות.'};
 if(topic==='finance'){
  const data=await api('/api/orders?status='+encodeURIComponent('נשלח')+'&limit=20');const orders=(Array.isArray(data)?data:data.orders||[]).slice(0,20);
  const rows=await Promise.all(orders.map(async o=>({...await api('/api/orders/'+num(o.id)+'/margin'),customer_name:o.customer_name||''})));
  return {rows,columns:[['הזמנה',r=>r.order_num],['לקוח',r=>r.customer_name],['עלות חומר',r=>fmt(r.cost_material)+' ₪'],['עלות עבודה',r=>fmt(r.cost_labor)+' ₪'],['מחיר מכירה',r=>fmt(r.sale_price)+' ₪'],['רווח גולמי',r=>fmt(r.gross_profit)+' ₪'],['מרווח',r=>r.margin_pct+'%']],note:'20 ההזמנות האחרונות בסטטוס נשלח, כפי שהיה בדוח הקודם; ללא סינון תאריך. לא נתוני תפוקת ייצור.'};
 }
 const data=await api('/api/reports/summary?'+params);
 if(topic==='waste'){options('machine',[...new Set(data.waste.map(r=>r.machine).filter(Boolean))],'כל המכונות');options('diameter',[...new Set(data.waste.map(r=>r.diameter).filter(Boolean))],'כל הקטרים');return {rows:data.waste,columns:[['מכונה',r=>r.machine],['קוטר',r=>r.diameter],['צורה',r=>r.shape_name],['כרטיסים',r=>r.item_count],['כמות',r=>r.total_ordered],['פחת שנרשם',r=>r.total_waste],['פחת',r=>r.waste_pct+'%']],note:'נתוני הפחת שנרשמו בכרטיסים שהושלמו בתקופה.'};}
 if(topic==='customers')return {rows:data.topCustomers,columns:[['לקוח',r=>r.name],['הזמנות',r=>r.order_count],['משקל הזמנות (ק״ג)',r=>fmt(r.total_weight,1)]],note:'הזמנות שנוצרו בתקופה, לפי נתוני הלקוחות; משקל הזמנה אינו תפוקה שיוצרה.'};
 return {rows:data.orders,columns:[['יום',r=>dayText(r.date)],['הזמנות',r=>r.count],['משקל הזמנות (ק״ג)',r=>fmt(r.weight,1)]],note:'הזמנות לפי יום יצירתן, ללא קשר למועד הייצור.'};
}
function filteredGeneric(){const term=$('search').value.trim().toLocaleLowerCase('he'),topic=$('topic').value;return genericRows.filter(r=>{
 if(['waste','transitions','recipes'].includes(topic)&&$('machine').value&&r.machine!==$('machine').value)return false;
 if(['waste','workers','recipes'].includes(topic)&&$('diameter').value&&num(r.diameter??r.diameter_mm)!==num($('diameter').value))return false;
 return !term||columns.some(([,fn])=>String(fn(r)||'').toLocaleLowerCase('he').includes(term));
 });}
function renderGeneric(){const rows=filteredGeneric();exportRows=rows;const limit=num($('limit').value),pages=Math.max(1,Math.ceil(rows.length/limit));page=Math.min(page,pages);drawTable(rows.slice((page-1)*limit,page*limit));$('reportSummary').textContent=`${fmt(rows.length)} תוצאות לפי הסינון`;pagination(rows.length,pages);}
function groupDrill(row){const group=$('group').value;drill={group,key:row.key,field:{order:'order_num',shape:'shape_name',machine:'machine',diameter:'diameter_mm',customer:'customer_name'}[group]};$('group').value='card';if(group==='day'){$('fromDate').value=row.key;$('toDate').value=row.key;}else if(['machine','diameter','customer'].includes(group))$(group).value=row.key;else $('search').value='';$('clearDrill').hidden=false;$('clearDrill').textContent='נקה סינון: '+labels[group]+' '+row.label;page=1;loadReport();}
function detail(r){
 const c=r.card,title=`כרטיס #${r.item_id} · ${r.order_num||''}`;$('detailTitle').textContent=title;
 const fields=[['לקוח',r.customer_name||'—'],['צורה',r.shape_name],['מכונה / קוטר',`${r.machine} · Ø${r.diameter_mm||'—'} · ${materialName(r.material_type)}`],['סוג הדיווח',kindText(r)],['התחלה',dateTime((r.ended||r.started)?.started_at)],['סיום',dateTime(r.ended?.completed_at)],['כמות שדווחה ליום זה',r.reported_complete?fmt(r.reported_quantity):'אין סיום מדווח ליום זה'],['משקל',r.reported_complete?`${fmt(r.reported_weight_kg,2)} ק״ג · ${r.weight_source==='measured'?'שקילה':'תאורטי'}`:'—'],['מטר לדקה שנרשם',rate(c?.meters_per_min)],['ק״ג לדקה שנרשם',rate(c?.kg_per_min)],['זמן נטו שנרשם',c?.net_minutes==null?'אין זמן מדוד':formatMinutes(c.net_minutes)]];
 let html=`<div class="detail-grid">${fields.map(([k,v])=>`<div><small>${escH(k)}</small><strong>${escH(v)}</strong></div>`).join('')}</div>${badge(r.reliability_status)}<p>${c?.included_in_statistics?'נכלל בסטטיסטיקה':'מחוץ לסטטיסטיקת הקצב'}</p><p>${(c?.reliability_reasons||[]).map(escH).join('<br>')}</p>`;
 if(c&&c.net_minutes!=null)html+=`<details><summary>איך חושב הזמן?</summary>זמן כולל: ${formatMinutes(c.gross_minutes)}<br>מחוץ לשעות עבודה: ${formatMinutes(c.outside_work_minutes)}<br>צהריים: ${formatMinutes(c.lunch_minutes)}<br>עצירות: ${formatMinutes(c.documented_stop_minutes)}<p>א׳–ה׳ 07:00–18:00; שישי עם סריקות 07:00–14:00; שבת לא נספרת. צהריים 12:00–12:45.</p></details>`;
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
 const exportColumns=columns.slice();let rows=exportRows;
 if($('topic').value==='production'){
  const params=filterParams(1);params.set('limit','200');const first=(await api('/api/reports/production-timing?'+params)).unified;rows=[...first.rows];
  for(let n=2;n<=first.pages;n++){params.set('page',String(n));rows.push(...(await api('/api/reports/production-timing?'+params)).unified.rows);}
 }
 const cols=exportColumns.filter(([title])=>title!=='פירוט'),csv=[cols.map(([title])=>csvCell(title)).join(','),...rows.map(r=>cols.map(([,fn])=>csvCell(fn(r))).join(','))].join('\r\n');
 const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`ironbend-report-${$('topic').value}-${$('fromDate').value}.csv`;a.click();URL.revokeObjectURL(url);
 }catch(error){$('reportState').textContent=error.message;}finally{button.disabled=false;}}
document.addEventListener('DOMContentLoaded',()=>{
 const now=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);$('toDate').value=today;$('fromDate').value=new Date(Date.parse(today+'T12:00:00Z')-30*86400000).toISOString().slice(0,10);
 $('reportFilters').addEventListener('submit',event=>{event.preventDefault();page=1;loadReport();});
 $('topic').addEventListener('change',()=>{$('clearDrill').hidden=true;drill=null;page=1;for(const id of ['machine','diameter','material','customer','reliability','worker','search'])$(id).value='';$('kind').value='all';configureTopic();loadReport();});
 for(const id of ['group','machine','diameter','material','customer','kind','reliability','worker','limit'])$(id).addEventListener('change',()=>{page=1;if($('topic').value!=='production'&&['machine','diameter','limit'].includes(id))renderGeneric();else loadReport();});
 $('clearFilters').addEventListener('click',()=>{$('clearDrill').hidden=true;drill=null;for(const id of ['machine','diameter','material','customer','reliability','worker','search'])$(id).value='';$('kind').value='all';$('group').value='card';page=1;loadReport();});
 $('prevPage').addEventListener('click',()=>{page--;if(current)loadReport();else renderGeneric();});$('nextPage').addEventListener('click',()=>{page++;if(current)loadReport();else renderGeneric();});
 $('reportBody').addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const row=visibleRows[num(button.closest('tr').dataset.row)];if(button.dataset.action==='group')groupDrill(row);else detail(row);});
 $('clearDrill').addEventListener('click',()=>$('clearFilters').click());
 $('closeDetail').addEventListener('click',()=>$('reportDetail').close());$('exportReport').addEventListener('click',exportReport);configureTopic();loadReport();
});
