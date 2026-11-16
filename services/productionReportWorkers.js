'use strict';
// Reporting reads configured people separately from actual production receipts.
const identity=require('./workerIdentity');
const {asDate,israelDay}=require('./productionTiming');
const unknown='לא מזוהה';
function readDirectory(db){
 const result=new Map(),put=entry=>result.set(entry.key,entry);
 const links=db.prepare('SELECT profile_id,user_id FROM worker_portal_accounts').all(),linkedUsers=new Set(links.map(r=>Number(r.user_id)));
 const profileAliases=new Map(links.map(r=>[Number(r.profile_id),[identity.key('user',r.user_id)]]));
 const devices=db.prepare(`SELECT d.id,d.requester_name,d.status,wi.worker_profile_id FROM device_enrollment_requests d
  LEFT JOIN worker_invitations wi ON wi.id=d.invitation_id`).all();
 for(const d of devices)if(d.worker_profile_id){const aliases=profileAliases.get(Number(d.worker_profile_id))||[];aliases.push(identity.key('device',d.id));profileAliases.set(Number(d.worker_profile_id),aliases);}

 for(const p of db.prepare('SELECT id,worker_name,active FROM worker_qr_profiles').all())put({key:identity.key('profile',p.id),name:p.worker_name,active:Boolean(p.active),source:'profile',aliases:profileAliases.get(Number(p.id))||[]});
 for(const u of db.prepare('SELECT id,display_name,username,role,active FROM users').all()){
  if(linkedUsers.has(Number(u.id))||['kiosk','customer'].includes(u.role))continue;
  put({key:identity.key('user',u.id),name:u.display_name||u.username,active:Boolean(u.active),source:'user',aliases:[]});
 }
 for(const w of db.prepare('SELECT id,name,active FROM workers').all())put({key:identity.key('legacy',w.id),name:w.name,active:Boolean(w.active),source:'station',aliases:[]});
 for(const d of devices)if(!d.worker_profile_id&&d.requester_name&&['approved','revoked'].includes(d.status))put({key:identity.key('device',d.id),name:d.requester_name,active:d.status==='approved',source:'device',aliases:[]});
 return [...result.values()];
}
function readWorkers(db,itemIds,{to}={}){
 const ids=[...new Set(itemIds.map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))],rows=[];
 for(let offset=0;offset<ids.length;offset+=400){
  const batch=ids.slice(offset,offset+400),marks=batch.map(()=>'?').join(',');
  for(const r of db.prepare(`SELECT a.id,a.item_id,a.actor_name,a.actor_user_id,a.device_enrollment_id,a.occurred_at,a.action,a.details_json,
   COALESCE(wi.worker_profile_id,pa.profile_id) AS worker_profile_id FROM worker_card_activity a
   LEFT JOIN device_enrollment_requests d ON d.id=a.device_enrollment_id
   LEFT JOIN worker_invitations wi ON wi.id=d.invitation_id
   LEFT JOIN worker_portal_accounts pa ON pa.user_id=a.actor_user_id
   WHERE a.item_id IN (${marks}) AND a.action IN ('status_changed','updated') ORDER BY a.occurred_at,a.id`).all(...batch)){
   let details={};try{details=JSON.parse(r.details_json||'{}')||{};}catch{}
   if(details.unchanged&&!details.zone&&details.actual_weight_kg==null)continue;
   const worker_key=identity.eventKey(r,details);
   rows.push({item_id:Number(r.item_id),worker_key,actor_name:worker_key==='anonymous'?unknown:r.actor_name||unknown,
    occurred_at:r.occurred_at,action:r.action,source:'worker_card_activity',source_id:r.id,
    to_status:details.from_status!==details.to_status?details.to_status||null:null});
  }
  for(const r of db.prepare(`SELECT s.id,s.item_id,s.worker_id,s.action,s.scanned_at,w.name FROM scan_log s
    LEFT JOIN workers w ON w.id=s.worker_id WHERE s.item_id IN (${marks})
    AND s.action IN ('start','complete','close_prev','end_of_day') ORDER BY s.scanned_at,s.id`).all(...batch)){
   rows.push({item_id:Number(r.item_id),worker_key:r.name?identity.key('legacy',r.worker_id):'anonymous',actor_name:r.name||unknown,occurred_at:r.scanned_at,
    action:'status_changed',source:'scan_log',source_id:r.id,to_status:r.action==='start'?'בייצור':'הושלם'});
  }
 }
 return rows.filter(r=>!to||asDate(r.occurred_at)&&israelDay(r.occurred_at)<=to).sort((a,b)=>(asDate(a.occurred_at)?.getTime()||0)-(asDate(b.occurred_at)?.getTime()||0)||a.source.localeCompare(b.source)||a.source_id-b.source_id);
}
function readWorkerData(db,itemIds,period){return {workers:readWorkers(db,itemIds,period),workerDirectory:readDirectory(db),workerIdentitiesVisible:true};}
module.exports={readWorkers,readDirectory,readWorkerData};
