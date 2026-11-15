const test=require('node:test'),assert=require('node:assert/strict');
const {parseFilters,unifiedProductionReport}=require('../services/unifiedProductionReport');
const activity={cards:[2,10,100].map((id,n)=>({item_id:id,date:'2026-11-15',reported_complete:true,reported_quantity:id,reported_weight_kg:[10,2,null][n],shape_name:'צורה '+id,machine:'MEP',status:'הושלם'}))};
const cards=activity.cards.map(r=>({...r,weight_kg:r.reported_weight_kg,unitCutLengthMm:1000,quantity:r.reported_quantity}));
function report(q){return unifiedProductionReport({cards,activity},parseFilters({flat:'1',...q}));}
test('numeric sorting runs before pagination, asc and desc keep missing values last',()=>{
 assert.equal(report({sort:'weight',direction:'asc',limit:'1'}).rows[0].item_id,10);
 assert.equal(report({sort:'weight',direction:'asc',limit:'1',page:'2'}).rows[0].item_id,2);
 assert.deepEqual(report({sort:'weight',direction:'desc'}).rows.map(r=>r.item_id),[2,10,100]);
 assert.deepEqual(report({sort:'card',direction:'asc'}).rows.map(r=>r.item_id),[2,10,100]);
 assert.deepEqual(report({sort:'shape',direction:'asc'}).rows.map(r=>r.item_id),[2,10,100]);
 assert.equal(report({sort:'weight'}).summary.units,report({sort:'card'}).summary.units);
});
test('every exposed sort field supports both directions without changing row set',()=>{
 for(const sort of Object.keys(require('../services/productionReportSort').fields))for(const direction of ['asc','desc'])assert.equal(report({sort,direction}).total,3);
 for(const query of [{sort:'drop table'},{direction:'up'},{sort:['card']},{sort:'__proto__'}])assert.throws(()=>parseFilters(query),/invalid_report_filter/);
});
