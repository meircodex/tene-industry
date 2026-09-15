'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadPortalClient}=require('./helpers/customer-portal-client');
test('portal lift weighing is the line total regardless of package count',()=>{
  const c=loadPortalClient();
  c.context.lift={qty:4,shapeSnapshot:{contractVersion:2,family:'lifts',data:{weighedKg:194,barLength:12000}}};
  const metrics=c.run('portalItemShapeMetrics(lift)');
  assert.equal(metrics.totalWeightKg,194);
  assert.equal(metrics.unitWeightKg,48.5);
});
test('projected customer status shows approval only for an authorized approver',()=>{
  const c=loadPortalClient();
  c.context.order={id:1,order_num:'QA',status:'ממתינה לאישורך',customerStatus:'awaiting_customer_approval',customerCanApprove:true,pallets:[]};
  c.run('renderDetail(order)');
  assert.match(c.element('detailContent').innerHTML,/onclick="approveOrder\(1, event\)"/);
  c.context.order.customerCanApprove=false;c.run('renderDetail(order)');
  assert.doesNotMatch(c.element('detailContent').innerHTML,/onclick="approveOrder/);
  c.context.order.customerStatus='submitted_review';c.run('renderDetail(order)');
  assert.match(c.element('detailContent').innerHTML,/עדיין לא אושרה לייצור/);
});
test('actual canonical portal row renders without temporal-dead-zone or duplicate blur handlers',()=>{
  const c=loadPortalClient();c.run('addItem()');
  assert.match(c.element('itemsList').innerHTML,/class="order-line-row/);
  assert.doesNotMatch(c.element('itemsList').innerHTML,/onblur=/);
  assert.equal(c.run('typeof uploadSourceDocuments'),'function');
});
test('real file upload failure releases submit button and retry never creates a second order',async()=>{
  const c=loadPortalClient();c.run('addItem()');
  c.context.file=new File(['a,b\n1,2'],'source.csv',{type:'text/csv'});
  c.run('handlePortalFiles([file]); portalDraftIdempotencyKey="retry-file"; TOKEN="test"');
  const calls=[];let fail=true;
  c.context.showHome=async()=>{};
  c.context.fetch=async(url,options)=>{
    calls.push(url);
    if(url==='/api/c/order')return{ok:true,json:async()=>({success:true,orderId:77,orderNum:'TEST'})};
    assert.equal(url,'/api/c/orders/77/source-documents');
    assert.equal(await options.body.get('file').text(),'a,b\n1,2');
    if(fail){fail=false;throw Error('offline');}
    return{ok:true,json:async()=>({success:true,documentId:4})};
  };
  await c.run('submitOrder()');
  assert.equal(c.element('submitOrderBtn').disabled,false);
  assert.equal(c.run('createdOrderId'),77);
  assert.equal(c.run('portalSourceFiles[0].uploaded'),undefined);
  await c.run('submitOrder()');
  assert.equal(calls.filter(u=>u==='/api/c/order').length,1);
  assert.equal(calls.filter(u=>u.includes('source-documents')).length,2);
  assert.equal(c.element('submitOrderBtn').disabled,false);
});
