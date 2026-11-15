const test=require('node:test'),assert=require('node:assert/strict');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
const activity={cards:[['A',8,'C1'],['B',10,'C1'],['D',12,'C2'],['A',12,'C2']].map(([machine,diameter_mm,customer_name],n)=>({item_id:n+1,machine,diameter_mm,customer_name,date:'2026-11-15',reported_complete:true,reported_quantity:10,reported_weight_kg:10}))};
const report=q=>unifiedProductionReport({cards:[],activity},parseFilters({flat:'1',...q}));
test('checkbox values combine OR within a filter and AND between filters before pagination',()=>{
 const r=report({machine_in:JSON.stringify(['A','B']),diameter_in:JSON.stringify(['8','10']),customer_in:JSON.stringify(['C1']),sort:'card',direction:'desc',limit:'1'});
 assert.equal(r.total,2);assert.equal(r.summary.units,20);assert.equal(r.rows[0].item_id,2);assert.equal(r.pages,2);
 assert.equal(report({machine_in:'[]'}).total,4);
 assert.equal(report({machine_in:'["A","A"]'}).total,2);
});
test('checkbox filters reject malformed or excessive inputs rather than ignoring them',()=>{
 for(const query of [{machine_in:'A'},{machine_in:'{}'},{machine_in:'[1]'},{machine_in:['A']},{diameter_in:'["-1"]'},{kind_in:'["bad"]'},{reliability_in:'["trusted"]'},{material_in:'["x"]'},{order_in:JSON.stringify(Array(51).fill('O'))}])assert.throws(()=>parseFilters(query),/invalid_report_filter/);
});
