'use strict';
// Stable identity keys shared by new production receipts and report readers.
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
function key(kind,id){return ['profile','user','device','legacy'].includes(kind)&&positive(id)?kind+':'+positive(id):'anonymous';}
function snapshot(req){
 const profile=positive(req?.portalWorker?.profile_id)||positive(req?.qrAccess?.invitation?.worker_profile_id);
 if(profile)return {kind:'profile',id:profile};
 const verifiedDevice=positive(req?.approvedDevice?.id);
 if(verifiedDevice&&positive(req?.qrAccess?.device?.id)===verifiedDevice)return {kind:'device',id:verifiedDevice};
 const user=positive(req?.userId)||positive(req?.auth?.sub);if(user)return {kind:'user',id:user};
 const device=positive(req?.approvedDevice?.id);if(device)return {kind:'device',id:device};
 return {kind:'anonymous'};
}
function eventKey(row,details={}){
 // An immutable receipt identity outranks today's account/device association.
 if(details._actor_identity)return key(details._actor_identity.kind,details._actor_identity.id);
 if(positive(row.worker_profile_id))return key('profile',row.worker_profile_id);
 if(row.actor_name&&row.actor_name!=='סריקה פתוחה'&&positive(row.device_enrollment_id))return key('device',row.device_enrollment_id);
 if(positive(row.actor_user_id))return key('user',row.actor_user_id);
 return 'anonymous';
}
module.exports={key,snapshot,eventKey};
