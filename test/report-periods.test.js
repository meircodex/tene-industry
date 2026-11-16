const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const periods=require('../public/reports-periods');
const {reportCharts}=require('../services/productionReportCharts');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
test('calendar presets respect Sunday weeks, leap years and quarter/year boundaries',()=>{
 assert.deepEqual(periods.range('week','2026-11-01'),{from:'2026-11-01',to:'2026-11-07'});
 assert.deepEqual(periods.range('week','2026-01-01'),{from:'2025-12-28',to:'2026-01-03'});
 assert.deepEqual(periods.range('week','2026-08-01'),{from:'2026-07-26',to:'2026-08-01'});
 assert.deepEqual(periods.range('quarter','2024-02-29'),{from:'2024-01-01',to:'2024-03-31'});
 assert.deepEqual(periods.range('quarter','2026-12-31'),{from:'2026-10-01',to:'2026-12-31'});
 assert.deepEqual(periods.range('year','2024-02-29'),{from:'2024-01-01',to:'2024-12-31'});
 assert.deepEqual(periods.range('day','2024-02-29'),{from:'2024-02-29',to:'2024-02-29'});
 for(const d of ['2026-02-29','2026-13-01','bad',''])assert.throws(()=>periods.range('day',d));
 for(const mode of ['year','week',[]])assert.throws(()=>parseFilters({chart_bucket:mode}));
 assert.throws(()=>parseFilters({from:'2026-02-29'}));
 for(const [mode,bucket] of [['day','hour'],['week','day'],['quarter','month'],['year','month'],['custom','day']])assert.equal(periods.bucket(mode),bucket);
});
test('hourly output uses factory local completion time, preserves unknown-time weight and does not count starts',()=>{
 for(const [day,at] of [['2026-06-02','2026-06-01T21:30:00Z'],['2026-11-02','2026-11-01 22:30:00']]){
  const rows=[{date:day,reported_complete:true,reported_weight_kg:120,card:{completed_at:at}}, {date:day,reported_complete:true,reported_weight_kg:30}, {date:day,reported_complete:false,reported_weight_kg:999}];
  const r=reportCharts(rows,{bucket:'hour',from:day,to:day});assert.equal(r.timeline.find(p=>p.key==='00').value,120);assert.equal(r.timeline.find(p=>p.key==='unknown').value,30);assert.equal(r.timeline.reduce((s,p)=>s+p.value,0),150);assert.equal(r.timeline.length,25);
 }
});
test('year/month charts share filtered card totals across pagination without replacing reliable weighted pace',()=>{
 const activity={cards:[1,2,3].map((id,i)=>({item_id:id,date:i===2?'2026-12-01':'2026-01-02',reported_complete:true,reported_weight_kg:100*id,diameter_mm:i===2?12:8,machine:'MEP',reliability_status:'reliable'}))};
 const cards=[{item_id:1,included_in_statistics:true,net_minutes_exact:10,cut_length_mm:100000},{item_id:2,included_in_statistics:true,net_minutes_exact:100,cut_length_mm:100000},{item_id:3,included_in_statistics:false}];
 const q={flat:'1',chart_bucket:'month',from:'2026-01-01',to:'2026-12-31',limit:'1'};
 const r=unifiedProductionReport({cards,activity},parseFilters(q));assert.equal(r.rows.length,1);assert.equal(r.charts.timeline.length,12);assert.equal(r.charts.timeline.find(p=>p.key==='2026-01').value,300);assert.equal(r.charts.timeline.find(p=>p.key==='2026-12').value,300);assert.equal(r.charts.timeline.reduce((s,p)=>s+p.value,0),r.summary.weight_kg);assert.equal(r.charts.machines[0].value,200/110);
 const f=unifiedProductionReport({cards,activity},parseFilters({...q,diameter_in:'["12"]'}));assert.equal(f.charts.timeline.reduce((s,p)=>s+p.value,0),300);assert.equal(f.charts.machines.length,0);
 const empty=reportCharts([],{bucket:'day',from:'2026-11-01',to:'2026-11-07'});assert.equal(empty.timeline.length,7);assert.ok(empty.timeline.every(p=>p.value===0));
});
function fixture(){const els={};const el=id=>els[id]||=( {value:'',innerHTML:'',textContent:'',hidden:false,attrs:{},listeners:{},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){this.listeners[k]=fn},focus(){}});for(const id of ['chartPlot','chartType','chartTitle','chartMetric','chartZoom','chartZoomLevel','chartZoomIn','chartZoomOut'])el(id);const window={IronBendReportPeriods:periods,IronBendSafe:{escapeHtml:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}};const c={window,document:{getElementById:el},localStorage:{getItem:()=>null,setItem(){}}};vm.runInNewContext(fs.readFileSync('public/reports-charts.js','utf8'),c);return{els,api:window.IronBendReportCharts};}
test('one graph switches metrics/types, renders actual selected period, and clears stale results',()=>{
 const {els,api}=fixture();api.render({bucket:'hour',period:{from:'2026-11-16',to:'2026-11-16'},timeline:[{key:'08',value:100}],diameters:[{key:'<script>',value:50}],machines:[{key:'MEP',value:20}]});assert.match(els.chartPlot.innerHTML,/08:00/);assert.match(els.chartTitle.textContent,/16\.11\.2026/);assert.equal((els.chartPlot.innerHTML.match(/<svg /g)||[]).length,1);
 els.chartMetric.listeners.change({target:{value:'diameters'}});assert.doesNotMatch(els.chartPlot.innerHTML,/<script>/);assert.match(els.chartPlot.innerHTML,/&lt;script>/);
 els.chartType.listeners.change({target:{value:'pie'}});assert.match(els.chartPlot.innerHTML,/<circle/);
 els.chartMetric.listeners.change({target:{value:'machines'}});assert.doesNotMatch(els.chartType.innerHTML,/value="pie"/);assert.match(els.chartPlot.innerHTML,/MEP/);
 api.render(null);assert.doesNotMatch(els.chartPlot.innerHTML,/MEP/);assert.doesNotMatch(els.chartPlot.innerHTML,/<svg/);
});
test('period controls update one date range and reload once; custom date filters remain accessible',()=>{
 const els={},el=id=>els[id]||={value:'',hidden:false,attrs:{},listeners:{},textContent:'',setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){this.listeners[k]=fn}};
 const buttons=['day','week','quarter','year','custom'].map(mode=>({...el(mode),dataset:{period:mode}})),labels=[{},{}];el('reportPeriods').querySelectorAll=()=>buttons;
 const document={getElementById:el,querySelectorAll:()=>labels},window={};vm.runInNewContext(fs.readFileSync('public/reports-periods.js','utf8'),{window,document,Intl,Date});let loads=0;window.IronBendReportPeriods.setup({load:()=>loads++});assert.equal(loads,0);
 els.periodAnchor.value='2026-01-01';els.periodAnchor.listeners.change();assert.equal(els.fromDate.value,'2025-12-28');assert.equal(els.toDate.value,'2026-01-03');assert.equal(loads,1);
 const click=mode=>els.reportPeriods.listeners.click({target:{closest:()=>({dataset:{period:mode}})}});click('year');assert.equal(els.fromDate.value,'2026-01-01');assert.equal(els.toDate.value,'2026-12-31');assert.equal(window.IronBendReportPeriods.bucket(window.IronBendReportPeriods.selected()),'month');
 click('custom');assert.equal(labels[0].hidden,false);assert.equal(els.periodAnchorLabel.hidden,true);els.fromDate.value='2026-06-01';els.toDate.value='2026-06-02';els.toDate.listeners.change();assert.match(els.periodTitle.textContent,/01\.06\.2026/);assert.equal(els.toDate.value,'2026-06-02');
});

test('invalid date change releases an in-flight busy state and blocks exporting an invalid period',async()=>{
 const els={fromDate:{value:''},toDate:{value:'2026-11-16'},reportState:{},reportCharts:{setAttribute(k,v){this[k]=v}},exportReport:{}};
 const table={setAttribute(k,v){this[k]=v}};const c={requestId:4,$:id=>els[id],document:{querySelector:()=>table}};
 vm.runInNewContext(fs.readFileSync('public/reports-unified.js','utf8').match(/async function loadReport\(\)\{[\s\S]*?\n\}/)[0],c);await c.loadReport();assert.equal(table['aria-busy'],'false');assert.equal(els.reportCharts['aria-busy'],'false');assert.equal(els.exportReport.disabled,true);
});
test('every date is labelled in a weekly chart, including zero days, with space instead of skipped labels',()=>{
 const {els,api}=fixture();api.render({bucket:'day',period:{from:'2026-11-15',to:'2026-11-21'},daily:[{key:'2026-11-15',value:9869.73},{key:'2026-11-16',value:14827.98}]});
 for(let day=15;day<=21;day++){assert.match(els.chartPlot.innerHTML,new RegExp('data-axis-label="2026-11-'+day+'"'));assert.match(els.chartPlot.innerHTML,new RegExp('>'+day+'\\.11</tspan>'));}
 assert.equal((els.chartPlot.innerHTML.match(/data-axis-label=/g)||[]).length,7);assert.doesNotMatch(els.chartPlot.innerHTML,/NaN|Infinity/);assert.match(els.chartPlot.innerHTML,/min-width:\d+px/);assert.equal(els.chartZoomLevel.textContent,'ימים');
 api.render({bucket:'day',period:{from:'2026-11-15',to:'2026-11-21'},daily:[]});assert.equal((els.chartPlot.innerHTML.match(/data-axis-label=/g)||[]).length,7);
});
test('quarter zoom changes months to clipped calendar weeks and days without discarding dates or changing totals',()=>{
 const period={from:'2026-10-01',to:'2026-12-31'},daily=[{key:'2026-10-01',value:100},{key:'2026-10-03',value:50},{key:'2026-10-04',value:70},{key:'2026-12-31',value:300}];
 for(const level of ['day','week','month'])assert.equal(periods.groupDays(daily,period,level).reduce((s,p)=>s+p.value,0),520);
 const weeks=periods.groupDays(daily,period,'week');assert.equal(weeks[0].key,'2026-09-27');assert.equal(weeks[0].value,150);assert.equal(weeks[1].value,70);
 assert.equal(periods.groupDays(daily,period,'day').length,92);assert.equal(periods.groupDays(daily,period,'month').length,3);
 const {els,api}=fixture();api.render({bucket:'month',period,daily});assert.equal(els.chartZoomLevel.textContent,'חודשים');assert.equal(els.chartZoomOut.disabled,true);
 els.chartZoomIn.listeners.click();assert.equal(els.chartZoomLevel.textContent,'שבועות');assert.match(els.chartPlot.innerHTML,/>01\.10<\/tspan>/);assert.match(els.chartPlot.innerHTML,/>03\.10<\/tspan>/);
 els.chartZoomIn.listeners.click();assert.equal(els.chartZoomLevel.textContent,'ימים');assert.equal(els.chartZoomIn.disabled,true);assert.equal((els.chartPlot.innerHTML.match(/data-axis-label=/g)||[]).length,92);
 els.chartMetric.listeners.change({target:{value:'machines'}});assert.equal(els.chartZoom.hidden,true);els.chartMetric.listeners.change({target:{value:'daily'}});assert.equal(els.chartZoomLevel.textContent,'ימים');
 els.chartZoomOut.listeners.click();assert.equal(els.chartZoomLevel.textContent,'שבועות');
 api.render({bucket:'day',period:{from:'2026-11-15',to:'2026-11-21'},daily:[]});assert.equal(els.chartZoomLevel.textContent,'ימים');
});
test('year/day zoom retains leap day and clips a year-crossing week at the selected boundaries',()=>{
 assert.equal(periods.groupDays([],{from:'2024-01-01',to:'2024-12-31'},'day').length,366);
 const p={from:'2025-12-31',to:'2026-01-02'},daily=[{key:'2025-12-31',value:10},{key:'2026-01-01',value:20}];assert.deepEqual(periods.groupDays(daily,p,'week'),[{key:'2025-12-28',value:30}]);
 const {els,api}=fixture();api.render({bucket:'hour',period:{from:'2026-11-16',to:'2026-11-16'},daily:[{key:'2026-11-16',value:30}],timeline:[{key:'08',value:30}]});assert.equal(els.chartZoomLevel.textContent,'שעות');assert.equal(els.chartZoomIn.disabled,true);els.chartZoomOut.listeners.click();assert.equal(els.chartZoomLevel.textContent,'ימים');assert.equal(els.chartZoomOut.disabled,true);assert.match(els.chartPlot.innerHTML,/16\.11/);
});
