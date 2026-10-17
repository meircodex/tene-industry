'use strict';
const crypto = require('crypto');

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function field(value, max, required = false) {
  if (value !== undefined && typeof value !== 'string') fail(400, 'שדה לא תקין');
  const text = String(value || '').trim();
  if (text.length > max || (required && !text)) fail(400, 'נא למלא את השדות הנדרשים ולשמור על מגבלת האורך');
  return text;
}
// Context is informational, never a credential-bearing or external URL.
function safePagePath(value) {
  const raw = field(value, 2000);
  if (!raw) return '';
  let url;
  try { url = new URL(raw, 'https://ironbend-hmd.onrender.com'); } catch { fail(400, 'קישור לא תקין'); }
  if (url.origin !== 'https://ironbend-hmd.onrender.com' || !/^\/(?:[a-zA-Z0-9_-]+\.html)?$/.test(url.pathname)) fail(400, 'יש לציין מסך מתוך התוכנה בלבד');
  const params = new URLSearchParams();
  if (/^\d+$/.test(url.searchParams.get('id') || '')) params.set('id', url.searchParams.get('id'));
  if (/^(print-cards|print-production|print-delivery|print-a4)$/.test(url.searchParams.get('kind') || '')) params.set('kind', url.searchParams.get('kind'));
  return url.pathname + (params.size ? '?' + params : '');
}
function validateFiles(files = []) {
  if (files.length > 6) fail(413, 'עד שש תמונות בכל פעולה');
  let bytes = 0;
  return files.map(file => {
    const b = file.buffer;
    if (!Buffer.isBuffer(b) || !b.length || b.length > 4 * 1024 * 1024) fail(413, 'כל תמונה חייבת להיות עד 4 מ״ב');
    bytes += b.length;
    if (bytes > 20 * 1024 * 1024) fail(413, 'התמונות גדולות מדי');
    let mime = '';
    if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR' && b.toString('ascii', b.length - 8, b.length - 4) === 'IEND') {
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
      if (!w || !h || w * h > 16000000) fail(415, 'מידות תמונה לא תקינות');
      mime = 'image/png';
    } else if (b.length >= 20 && b[0] === 255 && b[1] === 216 && b[2] === 255 && b[b.length - 2] === 255 && b[b.length - 1] === 217) mime = 'image/jpeg';
    else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.readUInt32LE(4) + 8 === b.length && b.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))) mime = 'image/webp';
    if (!mime || file.mimetype !== mime || !['before','expected','after'].includes(file.fieldname)) fail(415, 'ניתן לצרף רק תמונות PNG, JPG או WebP תקינות');
    let name = String(file.originalname || 'image');
    // Multipart filenames arrive as Latin-1 from Busboy; decode valid UTF-8 without corrupting genuine Unicode service inputs.
    if (/^[\u0000-\u00ff]*$/.test(name)) {
      const raw=Buffer.from(name,'latin1'), decoded=raw.toString('utf8');
      if (!decoded.includes('\ufffd') && Buffer.from(decoded,'utf8').equals(raw)) name=decoded;
    }
    return { kind: file.fieldname, filename: name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160), mime, data: b };
  });
}
function createBugReportsService({ db }) {
  const manager = actor => ['admin','manager'].includes(actor.role);
  function read(id, actor) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) fail(404, 'הדיווח לא נמצא');
    const report = db.prepare('SELECT * FROM bug_reports WHERE id=?').get(Number(id));
    if (!report || (!manager(actor) && report.created_by !== actor.id)) fail(404, 'הדיווח לא נמצא');
    delete report.fingerprint; delete report.request_uid;
    return report;
  }
  function detail(id, actor) {
    const report = read(id, actor);
    return { report, can_manage: manager(actor), agent_jobs: db.prepare('SELECT id,status,summary,reference,created_at,updated_at FROM fault_agent_jobs WHERE report_id=? ORDER BY id DESC').all(report.id), events: db.prepare('SELECT * FROM bug_report_events WHERE report_id=? ORDER BY id').all(report.id), attachments: db.prepare('SELECT id,report_id,event_id,kind,filename,mime_type,byte_size,created_at FROM bug_report_attachments WHERE report_id=? ORDER BY id').all(report.id) };
  }
  function capacity(id, files) {
    const size = files.reduce((s, f) => s + f.data.length, 0);
    if (!size) return;
    const total = db.prepare('SELECT coalesce(sum(byte_size),0) AS n FROM bug_report_attachments').get().n;
    const own = id ? db.prepare('SELECT coalesce(sum(byte_size),0) AS n FROM bug_report_attachments WHERE report_id=?').get(id).n : 0;
    if (total + size > 200 * 1024 * 1024 || own + size > 40 * 1024 * 1024) fail(413, 'מכסת התמונות התמלאה. יש לפנות למנהל; שום תמונה קיימת לא נמחקה');
  }
  function event(report, actor, type, message, status, resolution = '', reference = '', handler = '') {
    return Number(db.prepare('INSERT INTO bug_report_events(report_id,actor_id,actor_name,event_type,message,from_status,to_status,resolution,resolution_reference,handler_name) VALUES(?,?,?,?,?,?,?,?,?,?)').run(report.id, actor.id, actor.name, type, message, report.status, status, resolution, reference, handler).lastInsertRowid);
  }
  function attach(id, eventId, files) {
    const insert = db.prepare('INSERT INTO bug_report_attachments(report_id,event_id,kind,filename,mime_type,byte_size,data) VALUES(?,?,?,?,?,?,?)');
    for (const f of files) insert.run(id, eventId, f.kind, f.filename, f.mime, f.data.length, f.data);
  }
  function create(actor, body, uploads) {
    const files = validateFiles(uploads);
    if (files.some(f => f.kind === 'after')) fail(400, 'תמונת תיקון מצרפים בשלב הטיפול');
    const uid = field(body.request_uid, 50, true);
    if (!/^[a-f0-9-]{36}$/i.test(uid)) fail(400, 'מזהה פעולה לא תקין');
    const actual = field(body.actual, 6000, true);
    const values = [field(body.title || actual.slice(0, 100), 160, true), actual, field(body.expected, 6000, true), safePagePath(body.page_path), field(body.order_reference, 80), field(body.item_reference, 80), body.priority || 'normal'];
    if (!['low','normal','urgent'].includes(values[6])) fail(400, 'עדיפות לא תקינה');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(values)).update(body.request_agent === '1' ? 'agent-requested' : '').update(JSON.stringify(files.map(f => [f.kind, f.filename, crypto.createHash('sha256').update(f.data).digest('hex')]))).digest('hex');
    return db.transaction(() => {
      const previous = db.prepare('SELECT id,created_by,fingerprint FROM bug_reports WHERE request_uid=?').get(uid);
      if (previous) {
        if (previous.created_by !== actor.id || previous.fingerprint !== fingerprint) fail(409, 'מזהה הפעולה כבר שימש לדיווח אחר');
        return detail(previous.id, actor);
      }
      capacity(null, files);
      const id = Number(db.prepare('INSERT INTO bug_reports(request_uid,fingerprint,title,actual,expected,page_path,order_reference,item_reference,priority,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid, fingerprint, ...values, actor.id, actor.name).lastInsertRowid);
      const report = read(id, actor);
      const eventId = event(report, actor, 'created', 'נפתח דיווח', 'new');
      attach(id, eventId, files);
      if (body.request_agent === '1') db.prepare('INSERT INTO fault_agent_jobs(report_id) VALUES(?)').run(id);
      return detail(id, actor);
    })();
  }
  function update(id, actor, body, uploads) {
    return db.transaction(() => {
      const report = read(id, actor);
      if (Number(body.version) !== report.version) fail(409, 'הדיווח עודכן בינתיים. יש לרענן לפני שמירת השינוי');
      const files = validateFiles(uploads);
      const next = body.status || report.status;
      const message = field(body.message, 6000);
      let resolution = report.resolution, reference = report.resolution_reference, handler = report.handler_name;
      if (next !== report.status) {
        const transitions = { new:['needs_info','in_progress','awaiting_confirmation'], needs_info:['new','in_progress','awaiting_confirmation'], in_progress:['needs_info','awaiting_confirmation'], awaiting_confirmation:['in_progress','closed'], closed:['in_progress'] };
        if (!transitions[report.status].includes(next)) fail(400, 'מעבר סטטוס לא תקין');
        if (!manager(actor) && !((next === 'closed' && report.status === 'awaiting_confirmation') || (next === 'in_progress' && ['closed','awaiting_confirmation'].includes(report.status)))) fail(403, 'רק מנהל יכול לעדכן את מצב הטיפול');
        if (['needs_info','in_progress','closed'].includes(next) && !message) fail(400, 'נא להסביר את עדכון הסטטוס');
        if (next === 'awaiting_confirmation') {
          resolution = field(body.resolution, 6000, true);
          reference = field(body.resolution_reference, 300);
          handler = field(body.handler_name, 100, true);
          if (!files.some(f => f.kind === 'after') && !reference) fail(400, 'יש לצרף תמונת תוצאה או אסמכתת בדיקה לתיקון');
        }
        if (next === 'closed' && (!resolution || (!reference && !db.prepare("SELECT 1 FROM bug_report_attachments WHERE report_id=? AND kind='after'").get(report.id)))) fail(400, 'אי אפשר לסגור ללא תיעוד תיקון');
      } else if (!message && !files.length) fail(400, 'נא לכתוב הודעה או לצרף תמונה');
      if (files.some(f => f.kind === 'after') && !(manager(actor) && next === 'awaiting_confirmation' && next !== report.status)) fail(403, 'תמונת תיקון מצורפת רק בהגשת תיקון לאישור');
      capacity(report.id, files);
      const eventId = event(report, actor, next === report.status ? 'comment' : 'status', message || 'תיקון הוגש לאישור', next, next === 'awaiting_confirmation' && next !== report.status ? resolution : '', next === 'awaiting_confirmation' ? reference : '', next === 'awaiting_confirmation' ? handler : '');
      attach(report.id, eventId, files);
      // A manual treatment takes ownership; a late agent callback must not overwrite it.
      if (next !== report.status) db.prepare("UPDATE fault_agent_jobs SET status='cancelled',lease_hash=NULL,lease_until=NULL,summary='הטיפול עודכן ידנית',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE report_id=? AND status IN ('queued','running')").run(report.id);
      db.prepare("UPDATE bug_reports SET status=?,resolution=?,resolution_reference=?,handler_name=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(next, resolution, reference, handler, report.id);
      return detail(report.id, actor);
    })();
  }
  function list(actor) {
    const rows = db.prepare(`SELECT id,title,priority,status,order_reference,item_reference,created_by_name,updated_at,version FROM bug_reports ${manager(actor) ? '' : 'WHERE created_by=?'} ORDER BY updated_at DESC,id DESC LIMIT 500`).all(...(manager(actor) ? [] : [actor.id]));
    const online = db.prepare("SELECT 1 FROM fault_agent_credentials WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at > ? LIMIT 1").get(new Date().toISOString(),new Date(Date.now()-90000).toISOString());
    return { reports: rows, can_manage: manager(actor), can_reset: actor.role === 'admin', agent_online: Boolean(online), limit: 500 };
  }
  function attachment(id, attachmentId, actor) {
    const report = read(id, actor);
    const file = db.prepare('SELECT * FROM bug_report_attachments WHERE id=? AND report_id=?').get(attachmentId, report.id);
    if (!file) fail(404, 'התמונה לא נמצאה');
    return file;
  }
  return { create, update, detail, list, attachment };
}
module.exports = { createBugReportsService, safePagePath, validateFiles };
