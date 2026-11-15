const test=require('node:test'),assert=require('node:assert/strict');
const {dailyScanActivity}=require('../services/productionDailyScanActivity');
const {asDate,israelDay}=require('../services/productionTiming');
const row=(id)=>({id,report_order_id:1,report_order_num:'DAY-1',shape_name:'straight',diameter:12,quantity:100,machine:'A',status:'ממתין'});
const event=(kind,at)=>({kind,at:new Date(at),source:'worker_card_activity'});
function run(records,events,completedCards=[],fromDate='2026-11-12',toDate='2026-11-15'){
 return dailyScanActivity({records,scans:{byItem:new Map(Object.entries(events).map(([id,list])=>[Number(id),list]))},completedCards,fromDate,toDate,dayOf:israelDay,parseDate:asDate,machineOf:r=>({id:r.id===99?2:1,name:r.id===99?'B':'A'})});
}
const day=(result,date)=>result.days.find(d=>d.date===date);
test('Friday end-only reports stay visible even when the card is scanned again on Sunday',()=>{
 const r=run([row(1)],{1:[event('end','2026-11-13T11:30:00Z'),event('start','2026-11-15T06:00:00Z'),event('end','2026-11-15T06:30:00Z')]},[{item_id:1,production_day:'2026-11-15',started_at:'2026-11-15T06:00:00Z',completed_at:'2026-11-15T06:30:00Z',quantity:10,weight_kg:50,weight_source:'theoretical',included_in_statistics:true,reliability_status:'reliable',timing_end_source:'scan'}]);
 assert.equal(day(r,'2026-11-13').unmatched_end_cards,1);assert.equal(day(r,'2026-11-13').historical_end_without_quantity_cards,1);assert.equal(day(r,'2026-11-13').reported_units,0);
 assert.equal(day(r,'2026-11-15').same_day_cards,1);assert.equal(day(r,'2026-11-15').confirmed_units,10);assert.equal(day(r,'2026-11-15').confirmed_weight_kg,50);
});
test('open starts and cross-day completions do not invent daily manufactured quantities',()=>{
 const r=run([row(1),row(2)],{1:[event('start','2026-11-13T06:00:00Z')],2:[event('start','2026-11-12T14:00:00Z'),event('end','2026-11-13T06:00:00Z')]},[{item_id:2,production_day:'2026-11-13',started_at:'2026-11-12T14:00:00Z',completed_at:'2026-11-13T06:00:00Z',quantity:20,weight_kg:70,included_in_statistics:true,reliability_status:'reliable',timing_end_source:'scan'}]);
 const fri=day(r,'2026-11-13');assert.equal(fri.started_cards,1);assert.equal(fri.not_finished_same_day_cards,1);assert.equal(fri.prior_day_cards,1);assert.equal(fri.reported_units,20);assert.equal(fri.confirmed_units,0);assert.equal(fri.confirmed_weight_kg,0);
});
test('duplicate start/finish events and corrected cycles count each card once per day',()=>{
 const r=run([row(1)],{1:[event('start','2026-11-13T06:00:00Z'),event('start','2026-11-13T06:01:00Z'),event('end','2026-11-13T07:00:00Z'),event('end','2026-11-13T07:01:00Z'),event('reset','2026-11-13T08:00:00Z'),event('start','2026-11-13T09:00:00Z'),event('end','2026-11-13T10:00:00Z')]});
 const fri=day(r,'2026-11-13');assert.equal(fri.started_cards,1);assert.equal(fri.same_day_cards,1);assert.equal(fri.ended_cards,1);assert.equal(r.cards.filter(c=>c.date==='2026-11-13').length,1);assert.equal(r.cards.find(c=>c.date==='2026-11-13').ended.started_at,'2026-11-13T09:00:00.000Z');
});
test('Israel date boundaries and manual completion without full scans remain explicit',()=>{
 const r=run([row(1),row(99)],{1:[event('start','2026-11-12T22:30:00Z'),event('end','2026-11-12T23:00:00Z')]},[{item_id:99,production_day:'2026-11-13',started_at:null,completed_at:'2026-11-13T10:00:00Z',quantity:5,weight_kg:10,included_in_statistics:false,timing_end_source:'item_timestamp',reliability_status:'unreliable'}]);
 const fri=day(r,'2026-11-13');assert.equal(fri.same_day_cards,1);assert.equal(fri.unmatched_end_cards,1);assert.equal(fri.ended_cards,2);assert.equal(fri.reported_units,5);assert.equal(fri.confirmed_cards,0);
 assert.equal(r.machine_days.filter(d=>d.date==='2026-11-13').reduce((n,g)=>n+g.ended_cards,0),2);
 assert.equal(day(r,'2026-11-14').ended_cards,0);
});
test('a subsequently corrected scan is shown as requiring clarification, never as confirmed output',()=>{
 const r=run([row(1)],{1:[event('start','2026-11-13T06:00:00Z'),event('end','2026-11-13T07:00:00Z'),event('reset','2026-11-15T07:00:00Z')]});
 assert.equal(day(r,'2026-11-13').unmatched_end_cards,1);assert.equal(day(r,'2026-11-13').same_day_cards,0);assert.equal(day(r,'2026-11-13').confirmed_cards,0);
});
