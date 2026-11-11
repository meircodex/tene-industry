'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {defaultDate,resolve}=require('../public/order-delivery-date');
const Database=require('better-sqlite3'),{ensureCoreSchema}=require('../db/coreSchema'),{runCoreMigrations}=require('../db/startup');
const {createOrderFactory}=require('../services/orders'),industry=require('../modules/steel-rebar');

test('missing delivery date resolves to two factory calendar days ahead including weekends and rollover',()=>{
  for(const [instant,expected] of [
    ['2026-11-11T10:00:00Z','2026-11-13'],
    ['2026-11-11T22:30:00Z','2026-11-14'],
    ['2026-12-31T12:00:00Z','2027-01-02'],
    ['2028-02-28T12:00:00Z','2028-03-01'],
    ['2026-03-26T22:30:00Z','2026-03-29'],
    ['2026-10-24T21:30:00Z','2026-10-27'],
  ]){
    const now=new Date(instant);assert.equal(defaultDate(now),expected);
    for(const missing of [undefined,null,'','  '])assert.equal(resolve(missing,now),expected);
    assert.equal(resolve('2026-11-20',now),'2026-11-20');
  }
});

test('canonical customer order creation fills blank/missing dates and preserves explicit dates without rewriting existing orders',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');ensureCoreSchema(db);runCoreMigrations(db);
  let seq=0;const service=createOrderFactory(db,{generateOrderNum:()=>`DATE-${++seq}`,industry});
  const payload=date=>({customer:{name:'Delivery date fixture'},order:{channel:'manual',deliveryAddress:'Test site',...(date===undefined?{}:{deliveryDate:date})},pallets:[{items:[{shapeName:'straight',diameter:12,length:1000,qty:1,sides:[1000],angles:[0]}]}]});
  const previous=db.prepare("INSERT INTO orders(order_num,delivery_date) VALUES('HISTORIC',NULL)").run().lastInsertRowid;
  for(const date of [undefined,null,'','  ','2026-12-20']){
    const before=defaultDate(),result=db.transaction(()=>service.createOrderFromPayload(payload(date)))();
    const saved=db.prepare('SELECT delivery_date FROM orders WHERE id=?').get(result.orderId).delivery_date;
    assert.ok(date?.trim()?saved===date:[before,defaultDate()].includes(saved));
  }
  assert.equal(db.prepare('SELECT delivery_date FROM orders WHERE id=?').get(previous).delivery_date,null);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
