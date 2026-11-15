'use strict';
const ACTIONS=['start','complete','load'];
const LANGUAGES=['he','en','th'];
function ensureSchema(db){db.exec(`CREATE TABLE IF NOT EXISTS worker_portal_accounts(
 profile_id INTEGER PRIMARY KEY REFERENCES worker_qr_profiles(id),
 user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
 permissions_json TEXT NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`);}
function fail(status,error){throw Object.assign(Error(error),{status});}
function accountForUser(db,userId){
 return db.prepare(`SELECT a.*,p.worker_name,p.active AS profile_active,u.active AS user_active,u.username,u.worker_portal_language AS language
 FROM worker_portal_accounts a JOIN worker_qr_profiles p ON p.id=a.profile_id JOIN users u ON u.id=a.user_id WHERE a.user_id=?`).get(Number(userId));
}
function publicAccount(row){return row?{profile_id:row.profile_id,user_id:row.user_id,username:row.username,worker_name:row.worker_name,language:row.language,active:Boolean(row.profile_active&&row.user_active),permissions:JSON.parse(row.permissions_json)}:null;}
function saveAccount(db,authService,profileId,body,actor){
 const profile=db.prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(profileId);if(!profile)fail(404,'worker_profile_not_found');
 const language=body.language||'he',permissions=body.permissions===undefined?ACTIONS:body.permissions;
 if(!LANGUAGES.includes(language)||!Array.isArray(permissions)||permissions.some(p=>!ACTIONS.includes(p))||(body.active!==undefined&&typeof body.active!=='boolean'))fail(400,'invalid_portal_account');
 const before=db.prepare('SELECT * FROM worker_portal_accounts WHERE profile_id=?').get(profileId);
 return db.transaction(()=>{
  const user=authService.savePortalUser({id:before?.user_id,username:body.username,password:body.password,displayName:profile.worker_name,language,active:body.active??true});
  db.prepare(`INSERT INTO worker_portal_accounts(profile_id,user_id,permissions_json)VALUES(?,?,?)
   ON CONFLICT(profile_id)DO UPDATE SET permissions_json=excluded.permissions_json,updated_at=CURRENT_TIMESTAMP`).run(profileId,user.id,JSON.stringify([...new Set(permissions)]));
  db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,user_id,user_name)
   VALUES('worker_portal',?,?,'account_updated','access',?,?,?,?)`).run(profileId,user.username,before?.permissions_json||null,JSON.stringify({username:user.username,language,permissions,active:body.active??true,password_reset:Boolean(body.password)}),Number(actor.sub)||null,actor.display_name||null);
  return publicAccount(accountForUser(db,user.id));
 })();
}
function identify(db,req){
 const account=accountForUser(db,req.auth?.sub);
 if(!account)fail(403,'worker_portal_account_required');
 if(!account.profile_active||!account.user_active)fail(403,'worker_portal_disabled');
 req.portalWorker=publicAccount(account);req.userId=String(account.user_id);
 req.auth={...req.auth,display_name:account.worker_name};
 // A shared device's former enrollment must never override the logged-in worker.
 req.approvedDevice=null;req.qrAccess={mode:'personal',permission:'production',actor_name:account.worker_name,device:null,invitation:null};
 return req.portalWorker;
}
function statusAllowed(db,req){
 const allowed={בייצור:'start',הושלם:'complete',הועמס:'load'},target=req.body?.status;
 if(!req.portalWorker.permissions.includes(allowed[target]))fail(403,'worker_portal_action_forbidden');
 const keys=Object.keys(req.body||{});if(keys.some(k=>!['status','card','expected_status','request_id'].includes(k)))fail(400,'invalid_portal_status_fields');
 if(typeof req.body.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(req.body.request_id))fail(400,'invalid_worker_request_id');
 const row=db.prepare('SELECT status FROM items WHERE id=?').get(Number(req.params.id));
 if(!row)fail(404,'not_found');
 const rank={ממתין:0,בייצור:1,הושלם:2,הועמס:3};
 if(row.status!==target&&!(rank[target]===rank[row.status]+1))fail(409,'worker_portal_invalid_transition');
 if(typeof req.body.expected_status!=='string')fail(400,'worker_status_required');
}
module.exports={ACTIONS,LANGUAGES,ensureSchema,saveAccount,identify,statusAllowed,accountForUser,publicAccount};
