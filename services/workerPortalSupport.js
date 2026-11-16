'use strict';
const crypto=require('node:crypto');
const TOPICS=['safety','operating','troubleshooting'];
function fail(status,error){throw Object.assign(Error(error),{status});}
function ensureSchema(db){db.exec(`
 CREATE TABLE IF NOT EXISTS worker_help_documents(topic TEXT NOT NULL,language TEXT NOT NULL,body TEXT NOT NULL,updated_by INTEGER,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(topic,language));
 CREATE TABLE IF NOT EXISTS worker_fault_reports(id INTEGER PRIMARY KEY AUTOINCREMENT,maintenance_id INTEGER NOT NULL REFERENCES maintenance_logs(id),actor_user_id INTEGER NOT NULL REFERENCES users(id),item_id INTEGER REFERENCES items(id),request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,photo_mime TEXT,photo BLOB,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);}
function documents(db,language){return db.prepare('SELECT topic,body,language,updated_at FROM worker_help_documents WHERE language=? ORDER BY topic').all(language);}
function publish(db,body,actor){
 if(Object.keys(body).some(k=>!['topic','language','body'].includes(k))||!TOPICS.includes(body.topic)||!['he','en','th'].includes(body.language)||typeof body.body!=='string'||body.body.length>20000)fail(400,'invalid_worker_help');
 db.transaction(()=>{db.prepare(`INSERT INTO worker_help_documents(topic,language,body,updated_by)VALUES(?,?,?,?) ON CONFLICT(topic,language)DO UPDATE SET body=excluded.body,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(body.topic,body.language,body.body.trim(),Number(actor.sub));
 db.prepare(`INSERT INTO audit_log(entity_type,entity_ref,action,new_value,user_id,user_name)VALUES('worker_help',?,'published',?,?,?)`).run(body.topic+':'+body.language,body.body.trim(),Number(actor.sub),actor.display_name);})();
}
function report(db,body,worker){
 if(Object.keys(body).some(k=>!['description','item_id','request_id','photo'].includes(k))||typeof body.description!=='string'||!body.description.trim()||body.description.length>4000||typeof body.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(body.request_id))fail(400,'invalid_worker_fault');
 let photo=null,mime=null;
 if(body.photo){const m=typeof body.photo==='string'&&body.photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);if(!m)fail(400,'invalid_fault_photo');mime=m[1];photo=Buffer.from(m[2],'base64');
 const valid=mime==='image/jpeg'?photo[0]===255&&photo[1]===216&&photo[2]===255:mime==='image/png'?photo.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):photo.toString('ascii',0,4)==='RIFF'&&photo.toString('ascii',8,12)==='WEBP';if(!valid||photo.length>2*1024*1024)fail(400,'invalid_fault_photo');}
 const itemId=body.item_id==null?null:Number(body.item_id);if(itemId!==null&&(!Number.isSafeInteger(itemId)||itemId<1||!db.prepare('SELECT id FROM items WHERE id=?').get(itemId)))fail(400,'invalid_fault_item');
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({...body,actor:worker.user_id})).digest('hex');
 return db.transaction(()=>{const previous=db.prepare('SELECT * FROM worker_fault_reports WHERE request_id=?').get(body.request_id);if(previous){if(previous.fingerprint!==fingerprint)fail(409,'worker_request_conflict');return{id:previous.id,maintenance_id:previous.maintenance_id};}
 const log=db.prepare(`INSERT INTO maintenance_logs(log_type,description,reported_by,priority)VALUES('inspection',?,?,'רגיל')`).run(body.description.trim(),worker.user_id);
 const result=db.prepare('INSERT INTO worker_fault_reports(maintenance_id,actor_user_id,item_id,request_id,fingerprint,photo_mime,photo)VALUES(?,?,?,?,?,?,?)').run(log.lastInsertRowid,worker.user_id,itemId,body.request_id,fingerprint,mime,photo);
 db.prepare(`INSERT INTO audit_log(entity_type,entity_id,action,new_value,user_id,user_name)VALUES('maintenance',?,'worker_fault_reported',?,?,?)`).run(log.lastInsertRowid,JSON.stringify({item_id:itemId,photo:!!photo}),worker.user_id,worker.worker_name);
 return{id:Number(result.lastInsertRowid),maintenance_id:Number(log.lastInsertRowid)};})();
}
function list(db,page=1){if(!Number.isSafeInteger(page)||page<1||page>100000)fail(400,'invalid_page');return{page,total:db.prepare('SELECT COUNT(*) n FROM worker_fault_reports').get().n,rows:db.prepare(`SELECT r.id,r.item_id,r.maintenance_id,r.photo_mime,r.created_at,m.description,m.status,u.display_name FROM worker_fault_reports r JOIN maintenance_logs m ON m.id=r.maintenance_id JOIN users u ON u.id=r.actor_user_id ORDER BY r.id DESC LIMIT 30 OFFSET ?`).all((page-1)*30)};}
module.exports={ensureSchema,documents,publish,report,list,TOPICS};
