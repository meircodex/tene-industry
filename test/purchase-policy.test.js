'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {purchasePolicy}=require('../services/purchasePolicy');
const {suggestedQuantity}=require('../public/purchase-units');
const row=(type,stock,demand=0,incoming=0,shortage=0)=>({material_type:type,physical_stock_kg:stock,backlog_kg:demand,incoming_kg:incoming,recommended_purchase_kg:shortage});
test('available stock is default; physical is an explicit choice with the same min/target/order thresholds',()=>{
  const rows=[row('coil',15000,10000)];
  assert.equal(purchasePolicy(rows).types[0].recommended_order_kg,30000);
  assert.equal(purchasePolicy(rows,'physical').types[0].should_reorder,false);
  assert.equal(purchasePolicy([row('coil',10000)]).types[0].should_reorder,false);
  assert.throws(()=>purchasePolicy(rows,'unexpected'),/invalid_stock_basis/);
});
test('confirmed incoming avoids a duplicate purchase and rolls never cover straight-stock thresholds',()=>{
  const plan=purchasePolicy([row('coil',9000,0,25000),row('straight',4000)]);
  assert.equal(plan.types[0].should_reorder,false);
  assert.equal(plan.types[1].recommended_order_kg,30000);
  assert.equal(suggestedQuantity('coil',30000),19);
  assert.equal(suggestedQuantity('straight',30000),15);
  assert.equal(suggestedQuantity('bent',10.2),11);
});
test('a missing diameter can require a purchase even while another diameter has excess',()=>{
  const plan=purchasePolicy([row('coil',50000),row('coil',0,3000,0,3000)]);
  assert.equal(plan.types[0].below_minimum,false);
  assert.equal(plan.types[0].should_reorder,true);
  assert.equal(plan.types[0].recommended_order_kg,30000);
});
