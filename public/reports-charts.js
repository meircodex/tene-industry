'use strict';
(()=>{
 const esc=v=>window.IronBendSafe.escapeHtml(String(v??''));
 const fmt=v=>Number(v||0).toLocaleString('he-IL',{maximumFractionDigits:2});
 const colors=['#2868a8','#db7d24','#37956a','#9973bf','#e0b23e','#529ba9','#c65c69','#6f83b5','#8f9364','#b67e55','#65a18c','#a37f9d'];
 const specs={
  daily:{title:'משקל שיוצר לפי יום',unit:'ק״ג',types:['bar','line','pie'],label:k=>String(k).split('-').reverse().join('.')},
  diameters:{title:'משקל שיוצר לפי קוטר',unit:'ק״ג',types:['bar','line','pie'],label:k=>k==='unknown'?'קוטר לא ידוע':'Ø'+k},
  machines:{title:'קצב עבודה לפי מכונה',unit:'מטר לדקה',types:['bar','line'],label:k=>k},
  reliability:{title:'אמינות המדידות',unit:'כרטיסים',types:['bar','pie'],label:k=>({reliable:'אמינות',review:'דורשות בדיקה',unreliable:'לא אמינות',unknown:'טרם נמדדו'})[k]||k}
 };
 const typeNames={bar:'עמודות',line:'קו',pie:'עוגה'};
 let data=null,metric='daily',zoom=null,rangeKey='',prefs={};try{prefs=JSON.parse(localStorage.getItem('reportChartTypesV1'))||{};}catch{}
 function plot(series,spec,type){
  const points=series.map(p=>({...p,label:spec.label(p.key),value:Number(p.value)||0}));
  if(!points.length)return '<div class="chart-empty">אין נתונים מתאימים בסינון הנוכחי</div>';
  const minimumSlot=spec.bucket==='week'?108:78;
  const plotWidth=type==='pie'?600:Math.max(360,document.getElementById('chartPlot').clientWidth||600,100+points.length*minimumSlot);
  const svgStart=`<svg viewBox="0 0 ${plotWidth} 270" style="min-width:${type==='pie'?0:plotWidth}px" role="img" aria-label="${esc(spec.title+' — '+typeNames[type])}" xmlns="http://www.w3.org/2000/svg">`;
  if(type==='pie'){
   let list=points.filter(p=>p.value>0).sort((a,b)=>b.value-a.value);
   if(list.length>12)list=[...list.slice(0,11),{label:'יתר הנתונים',value:list.slice(11).reduce((sum,p)=>sum+p.value,0)}];
   const total=list.reduce((sum,p)=>sum+p.value,0),circumference=2*Math.PI*88;let offset=0;
   const segments=list.map((p,i)=>{const size=p.value/total*circumference;const markup=`<circle cx="300" cy="130" r="88" fill="none" stroke="${colors[i%colors.length]}" stroke-width="42" stroke-dasharray="${size} ${circumference-size}" stroke-dashoffset="${-offset}" transform="rotate(-90 300 130)"><title>${esc(p.label)}: ${esc(fmt(p.value))} ${esc(spec.unit)} (${fmt(p.value/total*100)}%)</title></circle>`;offset+=size;return markup;}).join('');
   return svgStart+segments+`<text x="300" y="129" text-anchor="middle" fill="#193753" font-size="24" font-weight="700">${esc(fmt(total))}</text><text x="300" y="153" text-anchor="middle" fill="#6b7e92" font-size="16">${esc(spec.unit)}</text></svg><div class="chart-legend">`+list.map((p,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${esc(p.label)}: ${esc(fmt(p.value))}</span>`).join('')+'</div>';
  }
  const left=80,right=plotWidth-20,top=25,bottom=210,w=right-left,h=bottom-top,max=(Math.max(...points.map(p=>p.value))||1)*1.12;
  const x=i=>left+w*(i+.5)/points.length,y=v=>bottom-h*v/max;
  let markup=svgStart;
  for(let n=0;n<=4;n++){const value=max*n/4,yy=y(value);markup+=`<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="#e5edf4"/><text x="${left-9}" y="${yy+5}" text-anchor="end" fill="#6b7e92" font-size="13">${esc(fmt(value))}</text>`;}
  if(type==='line')markup+=`<polyline points="${points.map((p,i)=>x(i)+','+y(p.value)).join(' ')}" fill="none" stroke="${colors[0]}" stroke-width="3"/>`;
  points.forEach((p,i)=>{const xx=x(i),yy=y(p.value),width=Math.max(1,Math.min(52,w/points.length*.65)),title=`<title>${esc(p.label)}: ${esc(fmt(p.value))} ${esc(spec.unit)}</title>`;
   markup+=type==='line'?`<circle cx="${xx}" cy="${yy}" r="4" fill="${colors[0]}">${title}</circle>`:`<rect x="${xx-width/2}" y="${yy}" width="${width}" height="${Math.max(0,bottom-yy)}" rx="3" fill="${colors[i%colors.length]}">${title}</rect>`;
   markup+=`<text x="${xx}" y="${yy-8}" text-anchor="middle" fill="#193753" font-size="14">${esc(fmt(p.value))}</text>`;
   const labels=String(p.label).split('–');
   markup+=`<text x="${xx}" y="237" text-anchor="middle" fill="#526c84" font-size="13" data-axis-label="${esc(p.key)}">${labels.map((label,n)=>`<tspan x="${xx}" dy="${n?16:0}">${esc(label)}</tspan>`).join('')}</text>`;
  });
  return markup+'</svg>';
 }
 function render(next){
  data=next;const host=document.getElementById('chartPlot');if(!host)return;
  const spec={...specs[metric]},period=next?.period||{};
  const currentRange=(period.from||'')+'|'+(period.to||'');
  if(currentRange!==rangeKey){rangeKey=currentRange;zoom=null;}
  const levels=window.IronBendReportPeriods.zoomLevels(period);
  const bucket=zoom||next?.bucket||'day';
  document.getElementById('chartZoom').hidden=metric!=='daily'||!next;
  document.getElementById('chartZoomLevel').textContent=({hour:'שעות',day:'ימים',week:'שבועות',month:'חודשים'})[bucket];
  document.getElementById('chartZoomIn').disabled=!next||levels.indexOf(bucket)<=0;
  document.getElementById('chartZoomOut').disabled=!next||levels.indexOf(bucket)>=levels.length-1;

  if(metric==='daily'){
   spec.title='תפוקה';spec.bucket=bucket;
   const short=day=>String(day).split('-').reverse().slice(0,2).join('.');
   spec.label=k=>{
    if(k==='unknown')return 'שעה לא ידועה';
    if(bucket==='hour')return k+':00';
    if(bucket==='month')return k.slice(5,7)+'.'+k.slice(0,4);
    if(bucket==='week'){
     const end=window.IronBendReportPeriods.range('week',k).to;
     return short(period.from&&k<period.from?period.from:k)+'–'+short(period.to&&end>period.to?period.to:end);
    }
    return short(k);
   };
  }
  const type=spec.types.includes(prefs[metric])?prefs[metric]:'bar',select=document.getElementById('chartType');
  select.innerHTML=spec.types.map(t=>`<option value="${t}" ${t===type?'selected':''}>${typeNames[t]}</option>`).join('');
  const date=v=>String(v).split('-').reverse().join('.');
  document.getElementById('chartTitle').textContent=spec.title+' · '+spec.unit+(period?.from?' · '+date(period.from)+(period.to!==period.from?'–'+date(period.to):''):'');
  const series=metric!=='daily'?next?.[metric]||[]:bucket==='hour'?next?.timeline||[]:next?window.IronBendReportPeriods.groupDays(next.daily||[],period,bucket):[];
  host.innerHTML=plot(series,spec,type);
 }
 document.getElementById('chartMetric').addEventListener('change',event=>{metric=event.target.value;if(!specs[metric])metric='daily';render(data);});
 document.getElementById('chartType').addEventListener('change',event=>{
  if(!specs[metric].types.includes(event.target.value))return;
  prefs[metric]=event.target.value;try{localStorage.setItem('reportChartTypesV1',JSON.stringify(prefs));}catch{}
  render(data);document.getElementById('chartType').focus();
 });
 for(const [id,step] of [['chartZoomIn',-1],['chartZoomOut',1]])document.getElementById(id).addEventListener('click',()=>{
  if(!data||metric!=='daily')return;
  const levels=window.IronBendReportPeriods.zoomLevels(data.period),index=levels.indexOf(zoom||data.bucket||'day'),next=levels[index+step];
  if(!next)return;zoom=next;render(data);
 });
 window.IronBendReportCharts={render};
})();
