'use strict';
const bcrypt=require('bcryptjs');
const {delivered,cancelled}=require('../public/order-workspace');
function fail(statusCode,message){throw Object.assign(new Error(message),{statusCode});}
function text(value,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,'נדרשת סיבה תקינה לפעולה');return value.trim();}
function bucketCondition(bucket){
  const quoted=list=>list.map(s=>"'"+s.replace(/'/g,"''")+"'").join(',');
  const paid="(o.payment_status='paid' OR o.status='שולם')",supplied=`o.status IN (${quoted(delivered)})`,voided=`o.status IN (${quoted(cancelled)})`;
  const visible='o.deleted_at IS NULL';
  const conditions={active:`${visible} AND NOT ${paid} AND NOT (${supplied}) AND NOT (${voided})`,delivered:`${visible} AND NOT ${paid} AND (${supplied})`,closed:`${visible} AND ${paid}`,cancelled:`${visible} AND NOT ${paid} AND (${voided})`,trash:'o.deleted_at IS NOT NULL',all:visible};
  if(bucket && !conditions[bucket])fail(400,'לשונית הזמנות לא תקינה');
  return conditions[bucket||'all'];
}
function createOrderWorkspaceService({db}){
  function read(id){const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!row)fail(404,'הזמנה לא נמצאה');return row;}
  function check(row,body){if(Number(body.version)!==row.workspace_version)fail(409,'ההזמנה עודכנה בינתיים. יש לרענן ולבדוק לפני אישור הפעולה');if(body.confirmed!==true)fail(400,'נדרש אישור מפורש לפעולה');}
  function event(row,actor,action,reason,after){db.prepare('INSERT INTO order_workspace_events(order_id,order_num,action,actor_id,actor_name,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.order_num,action,String(actor.id),actor.name,reason,JSON.stringify(row),JSON.stringify(after));}
  function trash(id,actor,body){return db.transaction(()=>{const row=read(id);check(row,body);if(row.deleted_at)fail(409,'ההזמנה כבר בסל המחזור');const reason=text(body.reason);db.prepare("UPDATE orders SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),deleted_by=?,deletion_reason=?,workspace_version=workspace_version+1 WHERE id=?").run(String(actor.id),reason,row.id);const after=read(id);event(row,actor,'trash',reason,after);return after;})();}
  function restore(id,actor,body){return db.transaction(()=>{const row=read(id);check(row,body);if(!row.deleted_at)fail(409,'ההזמנה אינה בסל המחזור');const reason=text(body.reason);db.prepare('UPDATE orders SET deleted_at=NULL,deleted_by=NULL,deletion_reason=NULL,workspace_version=workspace_version+1 WHERE id=?').run(row.id);const after=read(id);event(row,actor,'restore',reason,after);return after;})();}
  function payment(id,actor,body){return db.transaction(()=>{const row=read(id);check(row,body);if(row.deleted_at)fail(409,'יש לשחזר את ההזמנה לפני שינוי');if(!['paid','unpaid'].includes(body.payment_status))fail(400,'מצב תשלום לא תקין');if(row.payment_status===body.payment_status)fail(409,'מצב התשלום כבר מעודכן');const reason=text(body.reason);const paid=body.payment_status==='paid';db.prepare("UPDATE orders SET payment_status=?,paid_marked_at=?,paid_marked_by=?,workspace_version=workspace_version+1 WHERE id=?").run(body.payment_status,paid?new Date().toISOString():null,paid?String(actor.id):null,row.id);const after=read(id);event(row,actor,paid?'mark_paid':'correct_payment',reason,after);return after;})();}
  function verifyPassword(actor,password){
    if(typeof password!=='string'||!password||password.length>128)fail(400,'נדרשת סיסמת מנהל');
    const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(actor.id);
    if(!user||user.role!=='admin')fail(403,'מחיקה לצמיתות דורשת מנהל מערכת פעיל');
    if(user.locked_until&&new Date(user.locked_until)>new Date())fail(423,'החשבון נעול זמנית');
    if(!user.pin_hash||!bcrypt.compareSync(password,user.pin_hash)){
      const count=Number(user.failed_attempts||0)+1;
      db.prepare('UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?').run(count,count>=5?new Date(Date.now()+15*60000).toISOString():null,user.id);
      fail(403,'סיסמת המנהל אינה נכונה');
    }
    db.prepare('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?').run(user.id);
  }
  function purgeBlock(row){
    if(!row.deleted_at)return'מחיקה לצמיתות אפשרית רק מסל המחזור';
    if(row.payment_status==='paid'||delivered.includes(row.status)||cancelled.includes(row.status)||['נשלחה','בדרך ללקוח','בהעמסה','הושלם – ממתין לאיסוף'].includes(row.status))return'קיימת היסטוריית עבודה, אספקה או תשלום שחייבת להישמר';
    const items=db.prepare('SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=?').all(row.id);
    if(items.some(i=>Number(i.produced_qty||0)>0||i.started_at||i.completed_at||!['ממתין','בהמתנה'].includes(i.status)))return'התחיל ייצור; ההזמנה נשארת בסל המחזור עם ההיסטוריה שלה';
    const ids={orders:[row.id],pallets:db.prepare('SELECT id FROM pallets WHERE order_id=?').all(row.id).map(p=>p.id),items:items.map(i=>i.id)};
    // Be conservative: never cascade-delete commercial, delivery, inventory,
    // source-import or machine history. The local lifecycle ledger is retained.
    const owned=new Set(['orders','pallets','items','order_workspace_events']);
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
      if(owned.has(name)||!/^\w+$/.test(name))continue;
      const checks=[];const params=[];
      const columns=db.pragma(`table_info("${name}")`).map(c=>c.name);
      for(const column of columns.filter(c=>['order_id','source_order_id','converted_order_id'].includes(c))){checks.push(`"${column}"=?`);params.push(row.id);}
      if(columns.includes('order_num')){checks.push('order_num=?');params.push(row.order_num);}
      for(const fk of db.pragma(`foreign_key_list("${name}")`)){
        const values=ids[fk.table];if(!values?.length||!/^\w+$/.test(fk.from)||fk.to!=='id')continue;
        checks.push(`"${fk.from}" IN (${values.map(()=>'?').join(',')})`);params.push(...values);
      }
      if(checks.length&&db.prepare(`SELECT 1 FROM "${name}" WHERE ${checks.join(' OR ')} LIMIT 1`).get(...params))return'קיימים מסמכים או רישומי היסטוריה מקושרים שחייבים להישמר; אפשר להשאיר בסל המחזור או לשחזר';
    }
    return null;
  }
  function purge(id,actor,body){
    const row=read(id);check(row,body);const reason=text(body.reason);verifyPassword(actor,body.password);
    return db.transaction(()=>{const current=read(id);check(current,body);const blocked=purgeBlock(current);if(blocked)fail(409,blocked);
      event(current,actor,'purge',reason,{deleted_permanently:true});
      db.prepare('DELETE FROM items WHERE pallet_id IN (SELECT id FROM pallets WHERE order_id=?)').run(current.id);
      db.prepare('DELETE FROM pallets WHERE order_id=?').run(current.id);
      db.prepare('DELETE FROM orders WHERE id=?').run(current.id);
      return{orderNum:current.order_num};
    })();
  }
  return{trash,restore,payment,purge,purgeBlock,read};
}
module.exports={createOrderWorkspaceService,bucketCondition};
