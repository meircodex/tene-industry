const test=require('node:test'),assert=require('node:assert/strict');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
const activity={cards:[1,2,3].map((id,n)=>({item_id:id,date:'2026-11-15',machine:'MEP',diameter_mm:n===2?12:8,reported_complete:true,reported_quantity:1,reported_weight_kg:100*id,reliability_status:n===2?'review':'reliable'}))};
const cards=[{item_id:1,included_in_statistics:true,net_minutes_exact:10,cut_length_mm:100000},{item_id:2,included_in_statistics:true,net_minutes_exact:100,cut_length_mm:100000},{item_id:3,included_in_statistics:false,net_minutes_exact:.01,cut_length_mm:100000}];
test('charts use all filtered cards before pagination and agree with table summary',()=>{
 const r=unifiedProductionReport({cards,activity},parseFilters({flat:'1',limit:'1'}));
 assert.equal(r.rows.length,1);assert.equal(r.charts.daily[0].value,600);assert.equal(r.charts.diameters.reduce((s,p)=>s+p.value,0),r.summary.weight_kg);
 assert.equal(r.charts.machines[0].value,200/110);assert.equal(r.charts.machines[0].cards,2);assert.equal(r.charts.reliability.reduce((s,p)=>s+p.value,0),r.total);
 const filtered=unifiedProductionReport({cards,activity},parseFilters({flat:'1',diameter_in:'["12"]'}));assert.equal(filtered.charts.daily[0].value,300);assert.equal(filtered.charts.machines.length,0);
});
test('cross-day activity is not duplicated in graph totals and start-only rows have no invented weight',()=>{
 const extra={...activity.cards[0],date:'2026-11-12',reported_complete:false,reported_weight_kg:null,started:{started_at:'2026-11-12T08:00:00Z'}};
 const r=unifiedProductionReport({cards,activity:{cards:[...activity.cards,extra]}},parseFilters({flat:'1'}));
 assert.equal(r.charts.daily.reduce((s,p)=>s+p.value,0),600);assert.equal(r.charts.reliability.reduce((s,p)=>s+p.value,0),3);
});
