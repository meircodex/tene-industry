'use strict';
const crypto=require('node:crypto');
const {sha256}=require('../auth-core');
const accounts=require('./workerPortalAccounts');
function fail(){throw Object.assign(Error('worker_device_unavailable'),{status:403});}
function canUsePortal(profile){
 let permissions=[];try{permissions=JSON.parse(profile?.permissions_json||'[]');}catch{}
 return !!profile?.active&&permissions.includes('production');
}
function provision(db,authService,profile,actor){
 if(!canUsePortal(profile))return null;
 const linked=db.prepare('SELECT user_id FROM worker_portal_accounts WHERE profile_id=?').get(profile.id);
 if(linked){const account=accounts.accountForUser(db,linked.user_id);if(!account?.user_active)fail();return accounts.publicAccount(account);}
 return accounts.saveAccount(db,authService,profile.id,{username:'worker-link-'+profile.id+'-'+crypto.randomBytes(4).toString('hex'),language:'he'},actor);
}
const COOKIE='ironbend_worker_device';
function cookie(credential,maxAge=365*24*60*60){return COOKIE+'='+encodeURIComponent(credential)+'; HttpOnly; SameSite=Strict; Path=/api/worker-portal; Max-Age='+maxAge+(process.env.NODE_ENV==='production'?'; Secure':'');}
function credentialCookie(req){try{const value=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));return value?decodeURIComponent(value.slice(COOKIE.length+1)):'';}catch{return'';}}
function authenticate(db,req){
 // An authenticated personal/password account always retains its own identity.
 if(req.auth||req.get('Authorization'))return;
 const credential=String(req.get('X-IronBend-Device')||credentialCookie(req)).trim();if(!credential)return;
 if(credential.length>200||!/^DEV-[A-F0-9]+\.[A-Za-z0-9_-]+$/.test(credential))fail();
 const device=db.prepare(`SELECT d.* FROM device_enrollment_requests d JOIN worker_invitations i ON i.id=d.invitation_id
 WHERE d.credential_hash=? AND d.status='approved' AND i.status='claimed' AND i.claimed_device_id=d.id`).get(sha256(credential));
 if(!device)fail();
 const invite=db.prepare('SELECT worker_profile_id FROM worker_invitations WHERE id=?').get(device.invitation_id);
 const profile=db.prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(invite.worker_profile_id);
 if(!canUsePortal(profile))fail();
 const linked=db.prepare('SELECT user_id FROM worker_portal_accounts WHERE profile_id=?').get(profile.id);
 const account=linked&&accounts.accountForUser(db,linked.user_id);if(!account?.user_active||!account.profile_active)fail();
 req.workerPortalDevice=device;
 req.auth={sub:String(account.user_id),role:'production',display_name:account.worker_name,portal_only:true,portal_device_id:device.id};
 db.prepare("UPDATE device_enrollment_requests SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<datetime('now','-5 minutes'))").run(device.id);
}
function logoutProof(db,req){
 const credential=String(req.get('X-IronBend-Device')||credentialCookie(req)).trim();
 if(!credential||credential.length>200)return null;
 return db.prepare(`SELECT d.id,a.user_id,p.worker_name FROM device_enrollment_requests d JOIN worker_invitations i ON i.id=d.invitation_id
 JOIN worker_qr_profiles p ON p.id=i.worker_profile_id JOIN worker_portal_accounts a ON a.profile_id=p.id
 WHERE d.credential_hash=? AND i.status='claimed' AND i.claimed_device_id=d.id`).get(sha256(credential))||null;
}
module.exports={canUsePortal,provision,authenticate,cookie,logoutProof};
