'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {filter,customerKey}=require('../public/production-queue-filters');
const {classifyStock}=require('../services/productionQueueStock');
const rows=[
  {id:1,diameter:12,customer_id:1,customer_name:'לקוח',order_id:10,machine:'A',status:'ממתין',stock_state:{code:'available'}},
  {id:2,diameter:12,customer_id:2,customer_name:'לקוח',order_id:11,machine:'A',status:'ממתין',stock_state:{code:'shortage'}},
  {id:3,diameter:16,customer_id:1,customer_name:'לקוח',order_id:10,machine:null,status:'בייצור',stock_state:{code:'allocation'}},
];
test('all six queue filters intersect without confusing customers with identical names or changing source rows',()=>{
  const original=JSON.stringify(rows),selection={diameter:'12',customer:customerKey(rows[0]),order:'10',machine:'A',status:'ממתין',stock:'available'};
  assert.deepEqual(filter(rows,selection).map(i=>i.id),[1]);
  assert.deepEqual(filter(rows,{...selection,stock:'shortage'}),[]);
  assert.deepEqual(filter(rows,{machine:'__unassigned'}).map(i=>i.id),[3]);
  assert.deepEqual(filter(rows,{}),rows);assert.equal(JSON.stringify(rows),original);
});
test('missing stock evidence remains unverified rather than available',()=>{
  assert.deepEqual(filter([{id:4}],{stock:'available'}),[]);
  assert.equal(filter([{id:4}],{stock:'unknown'}).length,1);
});
test('stock availability respects total commitments, confirmed own coverage and uncertain identities',()=>{
  assert.equal(classifyStock({need:40,physical:100,total:90}).code,'available');
  assert.equal(classifyStock({need:40,physical:100,total:150}).code,'allocation');
  assert.equal(classifyStock({need:40,physical:100,total:150,allocated:40}).code,'available');
  assert.equal(classifyStock({need:40,physical:30,total:150,allocated:40}).code,'shortage');
  for(const extra of [{review:true},{conflict:true},{physical:NaN}])assert.equal(classifyStock({need:40,physical:100,total:90,...extra}).code,'unknown');
});
