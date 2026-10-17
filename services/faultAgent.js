'use strict';
const crypto = require('node:crypto');
const { createBugReportsService } = require('./bugReports');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
function text(value, max = 6000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'שדה חסר או ארוך מדי');
  return value.trim();
}
function createFaultAgentService({ db, clock = Date.now }) {
  const reports = createBugReportsService({ db });
  const admin = actor => { if (!['admin','manager'].includes(actor.role)) fail(403, 'נדרשת הרשאת מנהל'); };
  const actorFor = credential => ({ id:`fault-agent:${credential.id}`, role:'admin', name:`סוכן תקלות · ${credential.name}` });
  function log(report, actor, message, status = report.status, resolution = '', reference = '') {
    db.prepare('INSERT INTO bug_report_events(report_id,actor_id,actor_name,event_type,message,from_status,to_status,resolution,resolution_reference,handler_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(report.id,actor.id,actor.name,'agent',message,report.status,status,resolution,reference,resolution ? actor.name : '');
    db.prepare("UPDATE bug_reports SET status=?,version=version+1,updated_at=? WHERE id=?").run(status,now(),report.id);
  }
  function pair(actor, name) {
    admin(actor);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiry = new Date(clock() + 7*86400000).toISOString();
    const id = Number(db.prepare('INSERT INTO fault_agent_credentials(token_hash,name,created_by,expires_at) VALUES(?,?,?,?)').run(hash(token),text(name,80,true),actor.id,expiry).lastInsertRowid);
    return { id, token, expires_at:expiry, scope:'fault_reports_only', order_data_write:false };
  }
  function credentials(actor) {
    admin(actor);
    return db.prepare('SELECT id,name,expires_at,revoked_at,last_seen_at FROM fault_agent_credentials ORDER BY id DESC').all();
  }
  function revoke(actor, id) {
    admin(actor);
    db.transaction(() => {
      if (!db.prepare('UPDATE fault_agent_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(),id).changes) fail(404,'החיבור לא נמצא');
      db.prepare("UPDATE fault_agent_jobs SET status='failed',lease_hash=NULL,lease_until=NULL,summary='חיבור הסוכן בוטל; נדרשת בדיקה לפני ניסיון נוסף',updated_at=? WHERE credential_id=? AND status='running'").run(now(),id);
    })();
    return {ok:true};
  }
  function authenticate(token) {
    if (typeof token !== 'string' || token.length !== 43) fail(401,'חיבור סוכן לא תקף');
    const credential = db.prepare('SELECT * FROM fault_agent_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at > ?').get(hash(token),now());
    if (!credential) fail(401,'חיבור סוכן לא תקף או שפג תוקפו');
    db.prepare('UPDATE fault_agent_credentials SET last_seen_at=? WHERE id=?').run(now(),credential.id);
    return credential;
  }
  function enqueue(id, actor, version) {
    return db.transaction(() => {
      const {report} = reports.detail(id,actor);
      if (Number(version) !== report.version) fail(409,'התקלה עודכנה. יש לרענן');
      if (['closed','awaiting_confirmation'].includes(report.status)) fail(409,'יש לפתוח מחדש את התקלה לפני שליחתה לסוכן');
      if (db.prepare("SELECT 1 FROM fault_agent_jobs WHERE report_id=? AND status IN ('queued','running')").get(report.id)) fail(409,'התקלה כבר נמצאת בתור הסוכן');
      db.prepare('INSERT INTO fault_agent_jobs(report_id) VALUES(?)').run(report.id);
      log(report,actor,'התקלה נשלחה לסוכן. שינוי בנתוני הזמנות מחייב אישור מנהל.');
      return reports.detail(id,actor);
    })();
  }
  function claim(credential) {
    return db.transaction(() => {
      // Never retry an abandoned repair automatically: it may already have published a change.
      db.prepare("UPDATE fault_agent_jobs SET status='failed',lease_hash=NULL,lease_until=NULL,summary='הקשר עם הסוכן אבד. יש לבדוק את התוצאה לפני ניסיון נוסף',updated_at=? WHERE status='running' AND lease_until < ?").run(now(),now());
      const job = db.prepare("SELECT j.* FROM fault_agent_jobs j JOIN bug_reports b ON b.id=j.report_id WHERE j.status='queued' AND b.status IN ('new','needs_info','in_progress') ORDER BY j.id LIMIT 1").get();
      if (!job) return {job:null};
      const lease = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(clock()+5*60000).toISOString();
      db.prepare("UPDATE fault_agent_jobs SET status='running',credential_id=?,lease_hash=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(credential.id,hash(lease),expires,now(),job.id);
      const actor = actorFor(credential), report = reports.detail(job.report_id,actor).report;
      log(report,actor,'הסוכן התחיל בבדיקת התקלה.','in_progress');
      return {job:{id:job.id,report_id:job.report_id,lease,lease_until:expires},...reports.detail(job.report_id,actor),policy:{software_auto_repair:true,order_data_write:false,production_credentials:false}};
    })();
  }
  function leased(id, credential, lease) {
    if (!Number.isSafeInteger(Number(id)) || typeof lease !== 'string' || lease.length !== 43) fail(403,'פעולת סוכן לא מורשית');
    const job = db.prepare("SELECT * FROM fault_agent_jobs WHERE id=? AND credential_id=? AND status='running' AND lease_until > ? AND lease_hash=?").get(id,credential.id,now(),hash(lease));
    if (!job) fail(409,'הטיפול אינו פעיל או שהועבר למטפל אחר');
    return job;
  }
  function heartbeat(id,credential,lease) {
    const job=leased(id,credential,lease), expiry=new Date(clock()+5*60000).toISOString();
    db.prepare('UPDATE fault_agent_jobs SET lease_until=?,updated_at=? WHERE id=?').run(expiry,now(),job.id);
    return {lease_until:expiry};
  }
  function complete(id,credential,body) {
    return db.transaction(() => {
      const job=leased(id,credential,body.lease), actor=actorFor(credential);
      const report=reports.detail(job.report_id,actor).report;
      if (!['needs_approval','patch_ready','fixed','failed'].includes(body.outcome)) fail(400,'תוצאת טיפול לא תקינה');
      const summary=text(body.summary,6000,true), reference=text(body.reference || '',300);
      if (['patch_ready','fixed'].includes(body.outcome) && !reference) fail(400,'נדרשת אסמכתת בדיקה וגרסה');
      if (body.order_data_changed === true || body.order_data_changed === 'true') fail(403,'לסוכן אין הרשאת שינוי נתוני הזמנות');
      db.prepare('UPDATE fault_agent_jobs SET status=?,summary=?,reference=?,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(body.outcome,summary,reference,now(),job.id);
      const message = {needs_approval:'נדרש אישור שלך לפני שינוי נתונים. לא בוצע שינוי.',patch_ready:'תיקון קוד הוכן ונבדק, אך עדיין לא הועלה לתוכנה החיה.',fixed:'תיקון תוכנה בוצע ונשלח לבדיקה שלך.',failed:'הסוכן לא הצליח להשלים את הטיפול.'}[body.outcome];
      log(report,actor,`${message}\n${summary}`,body.outcome==='fixed'?'awaiting_confirmation':report.status,body.outcome==='fixed'?summary:'',reference);
      if (body.outcome==='fixed') db.prepare('UPDATE bug_reports SET resolution=?,resolution_reference=?,handler_name=? WHERE id=?').run(summary,reference,actor.name,report.id);
      return reports.detail(report.id,actor);
    })();
  }
  function image(id,imageId,credential,lease) {
    const job=leased(id,credential,lease);
    return reports.attachment(job.report_id,imageId,actorFor(credential));
  }
  function resetPreview(actor) {
    if (actor.role!=='admin') fail(403,'רק מנהל מערכת יכול לאפס תקלות');
    const counts=db.prepare('SELECT count(*) report_count,coalesce(max(id),0) latest_id FROM bug_reports').get();
    const images=db.prepare('SELECT count(*) n,coalesce(max(id),0) last_id FROM bug_report_attachments').get();
    const snapshot=hash(JSON.stringify({reports:db.prepare('SELECT id,version FROM bug_reports ORDER BY id').all(),images}));
    return {...counts,image_count:images.n,snapshot};
  }
  function reset(actor,body) {
    return db.transaction(() => {
      const preview=resetPreview(actor);
      if (body.confirmation!=='מחיקת התקלות הישנות' || Number(body.report_count)!==preview.report_count || Number(body.latest_id)!==preview.latest_id || body.snapshot!==preview.snapshot) fail(409,'יש לאשר מחדש את רשימת התקלות לפני מחיקה');
      if(db.prepare("SELECT 1 FROM fault_agent_jobs WHERE status='running'").get()) fail(409,'יש טיפול סוכן פעיל. יש לעצור אותו לפני האיפוס');
      const archive={format:'ironbend-faults-backup-v1',reports:db.prepare('SELECT * FROM bug_reports').all(),events:db.prepare('SELECT * FROM bug_report_events').all(),attachments:db.prepare('SELECT * FROM bug_report_attachments').all().map(f=>({...f,data:f.data.toString('base64')})),jobs:db.prepare('SELECT id,report_id,status,summary,reference FROM fault_agent_jobs').all()};
      const backupId=Number(db.prepare('INSERT INTO fault_report_backups(created_by,report_count,data) VALUES(?,?,?)').run(actor.id,preview.report_count,Buffer.from(JSON.stringify(archive))).lastInsertRowid);
      db.exec('DELETE FROM fault_agent_jobs; DELETE FROM bug_report_attachments; DELETE FROM bug_report_events; DELETE FROM bug_reports;');
      return {ok:true,backup_id:backupId,removed_reports:preview.report_count,removed_images:preview.image_count};
    })();
  }
  function backup(actor,id) {
    if(actor.role!=='admin') fail(403,'רק מנהל מערכת יכול להוריד גיבוי');
    const row=db.prepare('SELECT data FROM fault_report_backups WHERE id=?').get(id);
    if(!row) fail(404,'הגיבוי לא נמצא'); return row.data;
  }
  function backups(actor) {
    if(actor.role!=='admin') fail(403,'רק מנהל מערכת יכול לראות גיבויים');
    return db.prepare('SELECT b.id,b.report_count,b.created_at,r.restored_at FROM fault_report_backups b LEFT JOIN fault_report_restorations r ON r.backup_id=b.id ORDER BY b.id DESC LIMIT 30').all();
  }
  function restore(actor,id) {
    return db.transaction(() => {
      const archive=JSON.parse(backup(actor,id).toString('utf8'));
      if(db.prepare('SELECT 1 FROM fault_report_restorations WHERE backup_id=?').get(id)) fail(409,'הגיבוי כבר שוחזר');
      if(archive.format!=='ironbend-faults-backup-v1') fail(400,'גיבוי לא נתמך');
      const bytes=archive.attachments.reduce((n,f)=>n+Buffer.byteLength(f.data,'base64'),0);
      if(bytes+db.prepare('SELECT coalesce(sum(byte_size),0) n FROM bug_report_attachments').get().n>200*1024*1024)fail(413,'אין מספיק מקום לתמונות המשוחזרות');
      const reportIds=new Map(),eventIds=new Map();
      for(const r of archive.reports){
        const restored=Number(db.prepare('INSERT INTO bug_reports(request_uid,fingerprint,title,actual,expected,page_path,order_reference,item_reference,priority,status,created_by,created_by_name,handler_name,resolution,resolution_reference,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),hash(`restored:${id}:${r.id}`),r.title,r.actual,r.expected,r.page_path,r.order_reference,r.item_reference,r.priority,r.status,r.created_by,r.created_by_name,r.handler_name,r.resolution,r.resolution_reference,r.created_at).lastInsertRowid);reportIds.set(r.id,restored);
      }
      for(const e of archive.events){const restored=Number(db.prepare('INSERT INTO bug_report_events(report_id,actor_id,actor_name,event_type,message,from_status,to_status,resolution,resolution_reference,handler_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(reportIds.get(e.report_id),e.actor_id,e.actor_name,e.event_type,e.message,e.from_status,e.to_status,e.resolution,e.resolution_reference,e.handler_name,e.created_at).lastInsertRowid);eventIds.set(e.id,restored);}
      for(const f of archive.attachments){const data=Buffer.from(f.data,'base64');db.prepare('INSERT INTO bug_report_attachments(report_id,event_id,kind,filename,mime_type,byte_size,data,created_at) VALUES(?,?,?,?,?,?,?,?)').run(reportIds.get(f.report_id),eventIds.get(f.event_id),f.kind,f.filename,f.mime_type,data.length,data,f.created_at);}
      for(const r of archive.reports)log(reports.detail(reportIds.get(r.id),actor).report,actor,`שוחזר מגיבוי ${id}; מספר הדיווח המקורי היה ${r.id}. תורי סוכן ישנים לא הופעלו מחדש.`);
      db.prepare('INSERT INTO fault_report_restorations(backup_id,restored_by,restored_count,restored_at) VALUES(?,?,?,?)').run(id,actor.id,archive.reports.length,now());
      return{ok:true,restored_reports:archive.reports.length};
    })();
  }
  return {pair,credentials,revoke,authenticate,enqueue,claim,heartbeat,complete,image,resetPreview,reset,backup,backups,restore};
}
module.exports={createFaultAgentService};
