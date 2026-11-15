const test=require('node:test'),assert=require('node:assert/strict');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
const rows=[{item_id:1,date:'2026-11-12',status:'הושלם',started:{started_at:'2026-11-12T08:00:00Z'},not_finished_same_day:true,reported_complete:false},{item_id:1,date:'2026-11-15',status:'הושלם',ended:{started_at:'2026-11-12T08:00:00Z',completed_at:'2026-11-15T08:00:00Z'},ended_from_prior_day:true,reported_complete:true,reported_quantity:10,reported_weight_kg:100,order_num:'O1',customer_name:'C1',reliability_status:'reliable'}];
const card={item_id:1,included_in_statistics:true,net_minutes_exact:100,cut_length_mm:100000,weight_kg:100};
const workers=[{item_id:1,worker_key:'profile:1',actor_name:'עובד',to_status:'בייצור'}];
test('fixed table has one card across days and quantities, weight and trusted duration count once',()=>{
 const r=unifiedProductionReport({cards:[card],activity:{cards:rows},workers},parseFilters({flat:'1'}));
 assert.equal(r.total,1);assert.equal(r.summary.units,10);assert.equal(r.summary.weight_kg,100);assert.equal(r.summary.net_minutes,100);assert.equal(r.rows[0].workers[0].worker_key,'profile:1');assert.equal(r.rows[0].activity_dates.length,2);
 for(const kind of ['started','prior','ended','open'])assert.equal(unifiedProductionReport({cards:[card],activity:{cards:rows}},parseFilters({flat:'1',kind})).total,1);
});
test('worker, status and order filters apply to the same fixed dataset and export pagination',()=>{
 for(const [key,value] of [['worker','profile:1'],['status','הושלם'],['order','O1']]){
  const r=unifiedProductionReport({cards:[card],activity:{cards:rows},workers},parseFilters({flat:'1',[key]:value,limit:'1'}));assert.equal(r.total,1);assert.equal(r.summary.units,10);
  assert.equal(unifiedProductionReport({cards:[card],activity:{cards:rows},workers},parseFilters({flat:'1',[key]:'none'})).total,0);
 }
 assert.throws(()=>parseFilters({flat:'2'}));assert.throws(()=>parseFilters({worker:['1']}));
});
test('start-only cards retain visibility but never invent completion output or duration',()=>{
 const r=unifiedProductionReport({cards:[],activity:{cards:[rows[0]]}},parseFilters({flat:'1'}));assert.equal(r.total,1);assert.equal(r.summary.units,0);assert.equal(r.summary.net_minutes,0);assert.equal(r.rows[0].worker_names,'לא מזוהה');
});
