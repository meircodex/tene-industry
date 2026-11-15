const test=require('node:test'),assert=require('node:assert/strict');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
const card=(id,minutes,length,extra={})=>({item_id:id,net_minutes:minutes,cut_length_mm:length,weight_kg:id*10,included_in_statistics:true,material_type:'coil',...extra});
const activity=(id,date,extra={})=>({item_id:id,date,order_num:'ORDER-'+id,customer_name:'לקוח '+id,machine:'MEP',diameter_mm:8,shape_name:'צורה 3',reported_complete:true,reported_quantity:id*5,reported_weight_kg:id*10,weight_source:'theoretical',reliability_status:'reliable',started:{started_at:date+'T07:00:00Z'},ended:{completed_at:date+'T08:00:00Z'},same_day_scanned:true,...extra});
const data={cards:[card(1,10,100000),card(2,100,100000),card(3,0.01,100000,{included_in_statistics:false})],activity:{cards:[activity(1,'2026-11-13'),activity(2,'2026-11-13'),activity(3,'2026-11-13',{reliability_status:'review'}),activity(1,'2026-11-12',{reported_complete:false,reported_quantity:null,reported_weight_kg:null,ended:null,not_finished_same_day:true,reliability_status:null})]}};
test('unified pace is length divided by trusted duration, not average rates or untrusted output',()=>{
 const r=unifiedProductionReport(data,parseFilters());assert.equal(r.summary.units,30);assert.equal(r.summary.weight_kg,60);assert.equal(r.summary.net_minutes,110);assert.equal(r.summary.cards,3);assert.equal(r.summary.rows,4);assert.equal(r.summary.reliable_cards,2);assert.equal(r.summary.meters_per_min,200/110);assert.equal(r.summary.kg_per_min,30/110);
});
test('all groups preserve totals, customer filtering and pagination operate before aggregation',()=>{
 for(const group of ['day','machine','diameter','order','customer','shape']){const r=unifiedProductionReport(data,parseFilters({group,limit:'1',page:'999'}));assert.ok(r.rows.length<=1);assert.equal(r.summary.units,30);assert.equal(r.summary.meters_per_min,200/110);assert.ok(r.page<=r.pages);}
 const r=unifiedProductionReport(data,parseFilters({customer:'לקוח 2',reliability:'reliable',diameter:'8',machine:'MEP',material:'coil'}));assert.equal(r.total,1);assert.equal(r.summary.units,10);assert.equal(r.summary.meters_per_min,1);assert.equal(r.facets.customers.length,3);
});
test('open starts and historical ends remain visible without attributing completion quantity or pace',()=>{
 const open=unifiedProductionReport(data,parseFilters({kind:'open'}));assert.equal(open.total,1);assert.equal(open.summary.units,0);assert.equal(open.summary.meters_per_min,null);assert.equal(open.rows[0].card,null);
 const unknown=unifiedProductionReport(data,parseFilters({reliability:'unknown'}));assert.equal(unknown.total,1);
 const review=unifiedProductionReport(data,parseFilters({reliability:'review'}));assert.equal(review.summary.units,15);assert.equal(review.summary.meters_per_min,null);
});
test('report query rejects malformed values and array injection',()=>{
 for(const query of [{page:'0'},{limit:'201'},{group:'sql'},{diameter:'-1'},{material:'x'},{kind:['all']},{machine:['MEP']},{search:'a'.repeat(161)},{reliability:'trusted'}])assert.throws(()=>parseFilters(query),/invalid_report_filter/);
 assert.equal(unifiedProductionReport({cards:[],activity:{cards:[]}},parseFilters()).summary.meters_per_min,null);
});

test('drilling into a shape matches exactly, without including similarly named shapes',()=>{
 const copy=structuredClone(data);copy.activity.cards[0].shape_name='צורה 13';
 const result=unifiedProductionReport(copy,parseFilters({drill_field:'shape_name',drill_value:'צורה 3'}));
 assert.ok(result.rows.every(r=>r.shape_name==='צורה 3'));assert.equal(result.total,3);
});

test('pace uses the canonical unrounded duration, so a single trusted card agrees with its summary',()=>{
 const exact=191/60,cardRow=card(1,3.183,90045,{net_minutes_exact:exact,meters_per_min:90045/1000/exact});
 const result=unifiedProductionReport({cards:[cardRow],activity:{cards:[activity(1,'2026-11-15')]}},parseFilters());
 assert.equal(result.summary.meters_per_min,cardRow.meters_per_min);
});
