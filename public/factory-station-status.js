(function(root){
 'use strict';
 const host=document.getElementById('factoryStationStatus');if(!host)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let stations=[],machineId=null,inFlight=false,failed=false;
 const val=v=>typeof v==='number'&&Number.isFinite(v)?String(v):'—';
 function render(){
  const expanded=new Set([...host.querySelectorAll('details[open]')].map(el=>el.dataset.source));
  const selectedLabel=document.getElementById('queueFilterMachine')?.value;
  const items=stations.filter(s=>(machineId===null||s.machineId===machineId)&&(!selectedLabel||s.label===selectedLabel));
  host.innerHTML='<div class="fss-heading"><strong>חיבור למכונות</strong><span>תור הייצור והסריקה מסונכרנים עם תחנות הניטור</span><a href="/worker-visual.html">סריקת כרטיס</a></div>'+
   (failed?'<p class="fss-message">לא ניתן לעדכן את מצב התחנות · תור הייצור זמין כרגיל</p>':!items.length?'<p class="fss-message">אין תחנת ניטור רשומה למכונות שבסינון</p>':'<div class="fss-stations">'+items.map(s=>{
    const m=s.mirror,label=s.online?'תחנה מחוברת':'תחנה לא מקוונת';
    const controller=m?.live?'קריאת בקר עדכנית':m?'קריאה אחרונה · אינה חיה':'אין קריאת בקר חיה';
    return '<article class="fss-station"><div class="fss-line"><strong>מכונה '+esc(s.label)+'</strong><span class="fss-presence" data-online="'+s.online+'">'+label+'</span></div><div class="fss-controller" data-live="'+(m?.live===true)+'">'+controller+'</div>'+
     (m?'<details data-source="'+esc(s.sourceId)+'"'+(expanded.has(s.sourceId)?' open':'')+'><summary>פרמטרים · '+esc(m.card)+'</summary><p class="fss-message">'+(m.observedAtUtc?'נקרא '+esc(new Date(m.observedAtUtc).toLocaleString('he-IL')):'מועד קריאה לא זמין')+(m.mappingQualified?'':' · מיפוי מחקרי')+'</p><div class="mif-table-wrap"><table><thead><tr><th>צעד</th><th>אורך בבקר</th><th>זווית</th><th>פיצוי אורך</th><th>פיצוי זווית</th></tr></thead><tbody>'+m.rows.filter(r=>[r.length,r.angle,r.lengthCompensation,r.angleCompensation].some(v=>v!=null&&v!==0)).slice(0,100).map(r=>'<tr><td>'+esc(r.slot)+'</td>'+['length','angle','lengthCompensation','angleCompensation'].map(k=>'<td>'+val(r[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></details>':'<span class="fss-idle">ממתין לשיקוף כרטיס מהמכונה</span>')+'</article>';
   }).join('')+'</div>');
 }
 async function refresh(){
  if(inFlight||document.hidden)return;inFlight=true;
  try{
   const all=[];let offset=0,total=0;
   do{const response=await fetch('/api/machine-integration/station-state?limit=100&offset='+offset,{cache:'no-store',signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error('station_state_unavailable');const data=await response.json();if(!Array.isArray(data.items))throw Error('invalid_station_state');all.push(...data.items);total=data.total;offset+=100;}while(offset<total&&offset<1000);
   stations=all;failed=false;
  }catch{stations=[];failed=true;}finally{inFlight=false;render();}
 }
 root.IronBendStationStatus={selectMachine(id){const next=Number(id)||null;if(next!==machineId){machineId=next;render();}},refresh};
 document.getElementById('queueFilterMachine')?.addEventListener('change',render);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 refresh();setInterval(refresh,5000);
})(window);
