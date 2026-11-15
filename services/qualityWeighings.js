'use strict';
const crypto=require('node:crypto');
const {itemShapeMetrics}=require('./shapeSnapshot');
const {normalizeOrderStatus,ORDER_STATUS:S}=require('../status-contracts');
const {ensureQualityWeighingSchema}=require('../db/qualityWeighingSchema');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{statusCode:status});};
const id=value=>{if(!['string','number'].includes(typeof value))fail(400,'מזהה לא תקין');const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail(400,'מזהה לא תקין');return n;};
function pageQuery(q={}){const page=q.page==null?1:id(q.page),limit=q.limit==null?20:id(q.limit);if(page>100000||limit>100)fail(400,'טווח עמודים לא תקין');return {page,limit};}
function category(order){const status=normalizeOrderStatus(order.status);if(order.deleted_at||status===S.CANCELLED)return null;if([S.PRODUCTION_QUEUE,S.IN_PRODUCTION,S.PARTIAL_DELIVERY].includes(status))return 'production';if([S.DONE_WAITING_PICKUP,S.LOADING,S.ON_THE_WAY,S.SENT,S.DELIVERED_CONFIRMED,S.DELIVERY_PROBLEM,'הושלם','נשלח'].includes(status))return 'completed';return null;}
function createQualityWeighingsService(db){
 ensureQualityWeighingSchema(db);
 const readOrder=db.prepare('SELECT o.id,o.order_num,o.customer_id,o.status,o.deleted_at,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?');
 const readItems=db.prepare(`SELECT i.* FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id WHERE COALESCE(i.order_id,p.order_id)=? ORDER BY i.id`);
 function context(orderId){
  const order=readOrder.get(id(orderId));if(!order||!category(order))fail(409,'ההזמנה אינה זמינה לשקילת איכות במצבה הנוכחי');
  const raw=readItems.all(order.id).filter(i=>!i.cancelled_at&&!i.production_stopped_at&&!['בוטל','בוטלה'].includes(i.status)&&Number(i.quantity)>0);
  const items=raw.map(item=>{
   // Re-use Steel's authoritative weight basis, excluding a prior actual weighing.
   const metrics=itemShapeMetrics({...item,actual_weight_kg:null,actualWeightKg:null});
   const quantity=Number(metrics.quantity),weight=Number(metrics.totalWeightKg);
   const valid=Number.isFinite(quantity)&&quantity>0&&Number.isFinite(weight)&&weight>0&&!metrics.requiresWeightReview;
   return {id:item.id,quantity,shape_name:item.shape_name||'פריט',diameter:item.diameter||null,status:item.status,machine:item.machine||null,
    unit_weight_kg:valid?weight/quantity:null,expected_weight_kg:valid?weight:null,weight_source:metrics.weightSource||'unknown',
    blocked_reason:valid?null:'חסר משקל בסיס תקין לפריט; יש לתקן את נתוני הפריט לפני השקילה',
    specification:{shape_snapshot_json:item.shape_snapshot_json||null,segments:item.segments||null,total_length_mm:item.total_length_mm||null,shape_id:item.shape_id||null,shape_name:item.shape_name||null,diameter:item.diameter||null}};
  });
  const fingerprint=hash({order,items});
  return {...order,category:category(order),items,fingerprint,item_count:items.length,expected_weight_kg:items.every(i=>!i.blocked_reason)?items.reduce((sum,i)=>sum+i.expected_weight_kg,0):null};
 }
 function orders(q={}){
  const {page,limit}=pageQuery(q);if(q.status&&!['all','production','completed'].includes(q.status))fail(400,'סינון מצב לא תקין');
  const customer=q.customer_id?id(q.customer_id):null;
  // Orders owns statuses; use the shared normalizer for aliases as well.
  const eligible=db.prepare('SELECT o.id,o.order_num,o.customer_id,o.status,o.deleted_at,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.deleted_at IS NULL ORDER BY o.id DESC').all().filter(o=>category(o));
  const customers=[...new Map(eligible.filter(o=>o.customer_id).map(o=>[o.customer_id,{id:o.customer_id,name:o.customer_name||'ללא שם'}])).values()].sort((a,b)=>a.name.localeCompare(b.name,'he'));
  const filtered=eligible.filter(o=>(!customer||o.customer_id===customer)&&(!q.status||q.status==='all'||category(o)===q.status));
  return {rows:filtered.slice((page-1)*limit,page*limit).map(o=>{const c=context(o.id);return {...o,category:c.category,item_count:c.item_count,expected_weight_kg:c.expected_weight_kg};}),customers,total:filtered.length,page,limit};
 }
 function selection(body={}){
  if(!body||typeof body!=='object')fail(400,'בקשה לא תקינה');
  if(!Array.isArray(body.orders)||!body.orders.length||body.orders.length>100)fail(400,'יש לבחור בין הזמנה אחת למאה הזמנות');
  if(body.orders.some(o=>!o||typeof o!=='object'))fail(400,'בחירה לא תקינה');
  const seenOrders=new Set(),seenItems=new Set(),orders=[],lines=[],fingerprints=[];
  for(const choice of [...body.orders].sort((a,b)=>Number(a.order_id)-Number(b.order_id))){
   const orderId=id(choice.order_id);if(seenOrders.has(orderId))fail(400,'הזמנה נבחרה פעמיים');seenOrders.add(orderId);
   if(!['full','partial'].includes(choice.mode))fail(400,'יש לבחור הזמנה מלאה או חלקית');
   const c=context(orderId);fingerprints.push([orderId,c.fingerprint]);
   let chosen;
   if(choice.mode==='full'){
    if(choice.items?.length)fail(400,'בחירה מלאה אינה יכולה לכלול רשימת פריטים חלקית');chosen=c.items.map(i=>({item_id:i.id,quantity:i.quantity}));
   }else {if(!Array.isArray(choice.items)||!choice.items.length||choice.items.length>5000)fail(400,'יש לבחור פריטים להזמנה החלקית');chosen=choice.items;}
   const orderLines=[];
   for(const pick of [...chosen].sort((a,b)=>Number(a.item_id)-Number(b.item_id))){
    if(!pick||typeof pick!=='object')fail(400,'פריט לא תקין');
    const itemId=id(pick.item_id),item=c.items.find(i=>i.id===itemId),quantity=pick.quantity;
    if(seenItems.has(itemId))fail(400,'פריט נבחר פעמיים');seenItems.add(itemId);
    if(!item)fail(409,'פריט אינו שייך להזמנה או אינו זמין לשקילה');
    if(typeof quantity!=='number'||!Number.isFinite(quantity)||quantity<=0||quantity>item.quantity)fail(400,'הכמות שנבחרה אינה תקינה');
    if(item.blocked_reason)fail(422,item.blocked_reason);
    orderLines.push({order_id:orderId,item_id:itemId,quantity,order_quantity:item.quantity,expected_weight_kg:item.unit_weight_kg*quantity,unit_weight_kg:item.unit_weight_kg,weight_source:item.weight_source,shape_name:item.shape_name,diameter:item.diameter,machine:item.machine,item_status:item.status,specification:item.specification});
   }
   if(!orderLines.length)fail(422,'אין פריטים לשקילה בהזמנה');lines.push(...orderLines);if(lines.length>5000)fail(413,'הבחירה גדולה מדי; יש לפצל למספר שקילות');
   orders.push({order_id:orderId,order_num:c.order_num||String(orderId),customer_id:c.customer_id,customer_name:c.customer_name,order_status:c.status,scope:choice.mode,expected_weight_kg:orderLines.reduce((sum,i)=>sum+i.expected_weight_kg,0)});
  }
  if(lines.length>5000)fail(413,'הבחירה גדולה מדי; יש לפצל למספר שקילות');
  const expected_weight_kg=lines.reduce((sum,i)=>sum+i.expected_weight_kg,0);if(!Number.isFinite(expected_weight_kg)||expected_weight_kg<=0)fail(422,'משקל הבסיס אינו תקין');
  return {orders,lines,expected_weight_kg,fingerprint:hash({fingerprints,orders,lines})};
 }
 function actual(value){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>10000000)fail(400,'יש להזין משקל נטו חיובי בק״ג');return value;}
 function preview(body={}){const result=selection(body);if(body.actual_weight_kg!=null){const weight=actual(body.actual_weight_kg);return {...result,actual_weight_kg:weight,delta_kg:weight-result.expected_weight_kg,delta_pct:(weight-result.expected_weight_kg)/result.expected_weight_kg*100};}return result;}
 function detail(weighingId){const record=db.prepare('SELECT * FROM quality_weighings WHERE id=?').get(id(weighingId));if(!record)fail(404,'בדיקת השקילה לא נמצאה');const {request_hash,idempotency_key,...safe}=record;return {...safe,orders:db.prepare('SELECT * FROM quality_weighing_orders WHERE weighing_id=? ORDER BY order_id').all(record.id),lines:db.prepare('SELECT * FROM quality_weighing_lines WHERE weighing_id=? ORDER BY order_id,item_id').all(record.id)};}
 function save(body,actor){
  if(!body||typeof body!=='object')fail(400,'בקשה לא תקינה');
  const actorId=id(actor.id),weight=actual(body.actual_weight_kg),key=body.idempotency_key;
  if(typeof key!=='string'||! /^[a-zA-Z0-9_-]{16,100}$/.test(key)||typeof body.expected_fingerprint!=='string'||! /^[a-f0-9]{64}$/.test(body.expected_fingerprint))fail(400,'יש לרענן את הבחירה לפני השמירה');
  const requestHash=hash({orders:body.orders,actual_weight_kg:weight,fingerprint:body.expected_fingerprint,actorId});
  return db.transaction(()=>{
   const prior=db.prepare('SELECT id,request_hash FROM quality_weighings WHERE idempotency_key=?').get(key);
   if(prior){if(prior.request_hash!==requestHash)fail(409,'מפתח השמירה כבר שימש לבדיקה אחרת');return {...detail(prior.id),replay:true};}
   const selected=selection(body);if(selected.fingerprint!==body.expected_fingerprint)fail(409,'נתוני ההזמנה השתנו. הבחירה רועננה; בדוק את המשקל המחושב ושמור שוב');
   const inspector=db.prepare('SELECT display_name,username FROM users WHERE id=?').get(actorId);if(!inspector)fail(403,'לא נמצא משתמש בודק מאומת');
   const delta=weight-selected.expected_weight_kg,pct=delta/selected.expected_weight_kg*100;
   const result=db.prepare('INSERT INTO quality_weighings(idempotency_key,request_hash,selection_fingerprint,expected_weight_kg,actual_weight_kg,delta_kg,delta_pct,inspector_id,inspector_name,checked_day)VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,requestHash,selected.fingerprint,selected.expected_weight_kg,weight,delta,pct,actorId,inspector.display_name||inspector.username,require('./productionTiming').israelDay(new Date()));
   const weighingId=Number(result.lastInsertRowid);
   for(const o of selected.orders)db.prepare('INSERT INTO quality_weighing_orders(weighing_id,order_id,order_num,customer_id,customer_name,order_status,scope,expected_weight_kg)VALUES(?,?,?,?,?,?,?,?)').run(weighingId,o.order_id,o.order_num,o.customer_id,o.customer_name,o.order_status,o.scope,o.expected_weight_kg);
   for(const l of selected.lines)db.prepare('INSERT INTO quality_weighing_lines(weighing_id,order_id,item_id,quantity,order_quantity,expected_weight_kg,unit_weight_kg,weight_source,shape_name,diameter,machine,item_status,specification_json)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(weighingId,l.order_id,l.item_id,l.quantity,l.order_quantity,l.expected_weight_kg,l.unit_weight_kg,l.weight_source,l.shape_name,l.diameter,l.machine,l.item_status,JSON.stringify(l.specification));
   const payload={id:weighingId,order_ids:selected.orders.map(o=>o.order_id),expected_weight_kg:selected.expected_weight_kg,actual_weight_kg:weight,delta_kg:delta,delta_pct:pct};
   db.prepare('INSERT INTO quality_weighing_events(weighing_id,event_type,actor_id,payload_json)VALUES(?,?,?,?)').run(weighingId,'quality.weighing.recorded',actorId,JSON.stringify(payload));
   db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,new_value,user_id,user_name)VALUES(?,?,?,?,?,?,?)').run('quality_weighing',weighingId,String(weighingId),'recorded',JSON.stringify(payload),actorId,inspector.display_name||inspector.username);
   return {...detail(weighingId),replay:false};
  }).immediate();
 }
 function history(q={}){
  const {page,limit}=pageQuery(q),where=[],params=[];
  for(const [field,column] of [['customer_id','customer_id'],['order_id','order_id']])if(q[field]){where.push(`EXISTS(SELECT 1 FROM quality_weighing_orders o WHERE o.weighing_id=w.id AND o.${column}=?)`);params.push(id(q[field]));}
  for(const [field,operator] of [['from','>='],['to','<=']])if(q[field]){if(typeof q[field]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(q[field])||!require('./productionTiming').validDay(q[field]))fail(400,'תאריך לא תקין');where.push(`w.checked_day${operator}?`);params.push(q[field]);}
  if(q.from&&q.to&&q.from>q.to)fail(400,'טווח תאריכים לא תקין');
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const total=db.prepare('SELECT count(*) n FROM quality_weighings w'+clause).get(...params).n;
  const rows=db.prepare('SELECT w.id FROM quality_weighings w'+clause+' ORDER BY w.id DESC LIMIT ? OFFSET ?').all(...params,limit,(page-1)*limit).map(r=>{const {lines,...record}=detail(r.id);return {...record,line_count:lines.length};});
  const customers=db.prepare('SELECT customer_id AS id, MAX(customer_name) AS name FROM quality_weighing_orders WHERE customer_id IS NOT NULL GROUP BY customer_id ORDER BY name').all();
  return {rows,total,page,limit,customers};
 }
 return {orders,context,preview,save,detail,history};
}
module.exports={createQualityWeighingsService,category,pageQuery};
