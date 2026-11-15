'use strict';
// Read-only identity snapshots; never infer a worker for an anonymous scan.
function readWorkers(db,itemIds){
 const ids=new Set(itemIds.map(Number));
 if(!ids.size)return [];
 return db.prepare(`SELECT a.item_id,a.actor_name,a.actor_user_id,a.device_enrollment_id,a.occurred_at,a.action,a.details_json,
   wi.worker_profile_id FROM worker_card_activity a
   LEFT JOIN device_enrollment_requests d ON d.id=a.device_enrollment_id
   LEFT JOIN worker_invitations wi ON wi.id=d.invitation_id
   WHERE a.action IN ('status_changed','updated') ORDER BY a.occurred_at,a.id`).all()
  .filter(r=>ids.has(Number(r.item_id))).map(r=>{
   let details={};try{details=JSON.parse(r.details_json||'{}');}catch{}
   return {item_id:Number(r.item_id),actor_name:r.actor_name||'לא מזוהה',
    worker_key:(!r.actor_name||r.actor_name==='סריקה פתוחה')?'anonymous':r.worker_profile_id?'profile:'+r.worker_profile_id:r.actor_user_id?'user:'+r.actor_user_id:r.device_enrollment_id?'device:'+r.device_enrollment_id:'anonymous',
    occurred_at:r.occurred_at,action:r.action,to_status:details.from_status!==details.to_status?details.to_status||null:null};
  });
}
module.exports={readWorkers};
