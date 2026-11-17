'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/orders.html'),'utf8');
const source=html.slice(html.indexOf('async function undoOrderStatus('),html.indexOf('async function loadPortalSourceDocuments'));
test('order undo passes the existing plain-text correction dialog reason and refreshes after accepted restore',async()=>{
  const writes=[],alerts=[],refresh=[];
  const context=vm.createContext({
    requestCorrectionReason:async()=> 'תיקון שנבחר בטעות',
    fetch:async(url,options)=>{
      if(!options)return {ok:true,json:async()=>({available:true,restore_point_id:42,fingerprint:'current',target_status:'בייצור'})};
      writes.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({success:true})};
    },fetchOrders:async()=>refresh.push('list'),openDetail:async id=>refresh.push(id),alert:message=>alerts.push(message),
  });
  vm.runInContext(source,context);await context.undoOrderStatus(131);
  assert.deepEqual(writes,[{url:'/api/orders/131/status-undo',body:{restore_point_id:42,fingerprint:'current',reason:'תיקון שנבחר בטעות'}}]);
  assert.deepEqual(refresh,['list',131]);assert.deepEqual(alerts,[]);
});
test('order undo cancellation or a changed-state review never submits a restore',async()=>{
  for(const available of [true,false]){
    let writes=0,dialogs=0;
    const context=vm.createContext({fetch:async(_url,options)=>{if(options)writes++;return {ok:true,json:async()=>({available,reason:'נוסף דיווח'})};},
      requestCorrectionReason:async()=>{dialogs++;return null;},alert:()=>{},fetchOrders:async()=>{},openDetail:async()=>{}});
    vm.runInContext(source,context);await context.undoOrderStatus(131);assert.equal(writes,0);assert.equal(dialogs,available?1:0);
  }
});
