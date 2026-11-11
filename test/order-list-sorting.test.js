'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const sorting=require('../public/order-list-sorting'),workspace=require('../public/order-workspace');
const rows=[{id:1,order_num:'10',total_weight:100,delivery_date:null,customer_name:'ב',status:'בייצור',priority:'דחוף'},{id:2,order_num:'2',total_weight:9,delivery_date:'2026-12-01',customer_name:'א',status:'בתור ייצור',priority:'רגיל'},{id:3,order_num:'1',total_weight:9,delivery_date:'2026-11-11',customer_name:'ג',status:'אספקה חלקית',delivery_progress:{production_status:'בייצור'}}];
const ids=(key,direction='asc')=>sorting.sort(rows,{key,direction},workspace).map(row=>row.id);
test('order header sorting uses numeric order numbers, weights, Hebrew and chronological dates',()=>{
  assert.deepEqual(ids('order_num'),[3,2,1]);assert.deepEqual(ids('order_num','desc'),[1,2,3]);
  assert.deepEqual(ids('total_weight'),[2,3,1]);assert.deepEqual(ids('total_weight','desc'),[1,2,3]);
  assert.deepEqual(ids('delivery_date'),[3,2,1]);assert.deepEqual(ids('delivery_date','desc'),[2,3,1]);
  assert.deepEqual(ids('customer_name'),[2,1,3]);assert.deepEqual(ids('priority'),[2,3,1]);
  assert.deepEqual(rows.map(row=>row.id),[1,2,3]);
});
test('explicit sorting toggles direction without changing default partial delivery priority or row meaning',()=>{
  assert.deepEqual(sorting.toggle(null,'order_num'),{key:'order_num',direction:'asc'});
  assert.deepEqual(sorting.toggle({key:'order_num',direction:'asc'},'order_num'),{key:'order_num',direction:'desc'});
  assert.equal(sorting.toggle(null,'actions'),null);
  const defaultOrder=workspace.sortActiveOrders(rows);assert.equal(defaultOrder[0].id,3);
  assert.deepEqual(sorting.sort(defaultOrder,null,workspace),defaultOrder);
  assert.equal(sorting.sort(rows,{key:'status',direction:'asc'},workspace).filter(row=>workspace.primaryStatus(row)==='בייצור').length,2);
});
