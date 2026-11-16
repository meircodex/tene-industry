'use strict';
const crypto=require('node:crypto');
const {getRolePermission}=require('../permissions');
const TTL_MS=15*60*1000;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(error,status=400)=>{throw Object.assign(Error(error),{status});};
function ensureSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS auth_system_login_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','claimed','cancelled')),
  expires_at TEXT NOT NULL,created_at TEXT NOT NULL,created_by INTEGER NOT NULL,
  claimed_at TEXT,cancelled_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id));
  CREATE INDEX IF NOT EXISTS idx_auth_system_login_links_user ON auth_system_login_links(user_id,status);
  CREATE TABLE IF NOT EXISTS auth_system_login_link_events(
   id INTEGER PRIMARY KEY AUTOINCREMENT,link_id INTEGER NOT NULL,event TEXT NOT NULL,
   actor_id INTEGER NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(link_id) REFERENCES auth_system_login_links(id));`);
}
function createService({db,now=()=>new Date()}){
 function eligible(user){return !!user?.active&&!user.worker_portal_only&&!!getRolePermission(user.role);}
 function user(id){return db.prepare('SELECT * FROM users WHERE id=?').get(id);}
 function assertAdmin(actor){const actual=user(Number(actor?.sub));if(!actual?.active||actual.worker_portal_only||actual.role!=='admin')fail('Forbidden',403);return actual;}
 function event(row,action,actor){
  db.prepare('INSERT INTO auth_system_login_link_events(link_id,event,actor_id,created_at)VALUES(?,?,?,?)').run(row.id,action,actor.id,now().toISOString());
  db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,notes,user_id,user_name)
   VALUES('auth_system_login_link',?,?,?, ?,?,?)`).run(row.id,String(row.user_id),action,'Personal system access; no credential recorded',actor.id,actor.display_name||actor.username);
 }
 function cancel(row,actor,action){
  if(db.prepare("UPDATE auth_system_login_links SET status='cancelled',cancelled_at=? WHERE id=? AND status<>'cancelled'").run(now().toISOString(),row.id).changes){
   db.prepare('UPDATE refresh_tokens SET revoked=1,revoked_at=? WHERE system_link_id=? AND revoked=0').run(now().toISOString(),row.id);event(row,action,actor);
  }
 }
 function lookup(token){
  if(typeof token!=='string'||!/^SLNK-[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/.test(token))fail('system_link_invalid',404);
  const row=db.prepare('SELECT * FROM auth_system_login_links WHERE token_hash=?').get(hash(token));
  if(!row)fail('system_link_invalid',404);
  if(row.status==='cancelled')fail('system_link_cancelled',410);
  if(row.status==='claimed')fail('system_link_used',409);
  if(new Date(row.expires_at)<=now())fail('system_link_expired',410);
  const target=user(row.user_id);if(!eligible(target))fail('system_link_user_unavailable',403);
  return {row,user:target};
 }
 function create(userId,actor){return db.transaction(()=>{
  const admin=assertAdmin(actor),target=user(userId);if(!eligible(target))fail('system_link_user_unavailable',403);
  for(const row of db.prepare("SELECT * FROM auth_system_login_links WHERE user_id=? AND status='pending'").all(userId))cancel(row,admin,'replaced_pending');
  const token='SLNK-'+crypto.randomBytes(8).toString('hex')+'.'+crypto.randomBytes(32).toString('base64url');
  const at=now().toISOString(),expires=new Date(now().getTime()+TTL_MS).toISOString();
  const id=Number(db.prepare('INSERT INTO auth_system_login_links(user_id,token_hash,expires_at,created_at,created_by)VALUES(?,?,?,?,?)').run(userId,hash(token),expires,at,admin.id).lastInsertRowid);
  const row={id,user_id:userId};event(row,'issued',admin);
  return {id,expires_at:expires,activation_path:'/system-invite.html#token='+encodeURIComponent(token),user:{id:target.id,display_name:target.display_name,role:target.role}};
 })();}
 function preview(token){const found=lookup(token);return {expires_at:found.row.expires_at,user:{display_name:found.user.display_name,role:found.user.role}};}
 function claim(token){
  const found=lookup(token),{row,user:target}=found;
  const changed=db.prepare("UPDATE auth_system_login_links SET status='claimed',claimed_at=? WHERE id=? AND status='pending' AND expires_at>?").run(now().toISOString(),row.id,now().toISOString());
  if(changed.changes!==1)fail('system_link_used',409);
  for(const previous of db.prepare("SELECT * FROM auth_system_login_links WHERE user_id=? AND status='claimed' AND id<>?").all(target.id,row.id))cancel(previous,target,'replaced_session');
  event(row,'activated',target);return {user:target,id:row.id};
 }
 function session(id,userId){const row=db.prepare("SELECT * FROM auth_system_login_links WHERE id=? AND user_id=? AND status='claimed'").get(id,userId),target=user(userId);if(!row||!eligible(target))fail('system_link_session_revoked',401);return target;}
 function revoke(userId,actor){return db.transaction(()=>{const admin=assertAdmin(actor);let count=0;for(const row of db.prepare("SELECT * FROM auth_system_login_links WHERE user_id=? AND status<>'cancelled'").all(userId)){cancel(row,admin,'admin_revoked');count++;}return count;})();}
 function logout(id,userId){return db.transaction(()=>{const row=db.prepare("SELECT * FROM auth_system_login_links WHERE id=? AND user_id=? AND status='claimed'").get(id,userId);if(row)cancel(row,user(userId),'logout');})();}
 return {create,preview,claim,session,revoke,logout};
}
module.exports={ensureSchema,createService,TTL_MS};
