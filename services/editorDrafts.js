'use strict';

// Orders owns editor snapshots. These never create orders, reserve stock or
// run the order-preview materializer. Existing direct-draft storage is reused.
const { randomUUID } = require('node:crypto');
const { ensureOperationSchema } = require('../db/orderOperationsSchema');
const SOURCE = 'new-order-editor-v2';
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
function createEditorDraftService(db) {
  ensureOperationSchema(db);
  const rowFor = id => db.prepare('SELECT * FROM direct_order_drafts WHERE source_system=? AND external_id=?').get(SOURCE, id);
  const validId = id => { if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(id || ''))) fail('מזהה הטיוטה אינו תקין'); return String(id); };
  const view = row => ({ ...JSON.parse(row.payload_json), draftId: row.external_id, serverVersion: row.version,
    status: row.status === 'draft' ? 'active' : row.status, orderId: row.order_id || null });
  function audit(row, action, actor) {
    db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,notes,user_id,user_name) VALUES(?,?,?,?,?,?,?)')
      .run('order_draft', row.id, row.external_id, action, JSON.stringify({ version: row.version, orderId: row.order_id }), actor.id || null, actor.name || null);
  }
  function save(id, body, actor) {
    validId(id);
    const record = body?.record;
    if (!record || record.draftId !== id || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) fail('חסרים נתוני הטיוטה לשמירה');
    if (!Array.isArray(record.payload.pallets) || record.payload.pallets.length > 100 || record.payload.pallets.some(p => !Array.isArray(p.items)) || record.payload.pallets.reduce((n,p) => n+p.items.length,0) > 1000) fail('טיוטה יכולה להכיל עד 100 משטחים ו־1,000 פריטים');
    const data = { ...record }; delete data.serverVersion; delete data.syncPending; delete data.syncError; delete data.orderId;
    data.status = 'active';
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 2000000) fail('הטיוטה גדולה מדי לשמירה. ניתן לשמור עד 2 מגה־בייט', 413);
    return db.transaction(() => {
      const old = rowFor(id);
      if (old) {
        if (old.status !== 'draft') fail('הטיוטה כבר נסגרה. רענן את רשימת הטיוטות לפני המשך העבודה', 409);
        if (old.payload_json === json) return view(old);
        if (Number(body.version || 0) !== old.version) fail('הטיוטה נערכה בחלון אחר. השינויים שלך שמורים במחשב זה; פתיחת רשימת הטיוטות תשמור אותם כטיוטה נפרדת', 409);
        db.prepare('UPDATE direct_order_drafts SET payload_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(json, old.id);
      } else {
        if (Number(body.version || 0) !== 0) fail('הטיוטה אינה קיימת במערכת; העותק המקומי נשמר במחשב', 409);
        db.prepare('INSERT INTO direct_order_drafts(request_uid,source_system,external_id,payload_json,created_by) VALUES(?,?,?,?,?)').run(randomUUID(), SOURCE, id, json, String(actor.id));
      }
      const row = rowFor(id); audit(row, 'editor_draft_saved', actor); return view(row);
    })();
  }
  function close(id, body, actor) {
    validId(id);
    return db.transaction(() => {
      const row = rowFor(id);
      if (!row) fail('הטיוטה לא נמצאה במערכת', 404);
      const status = body?.orderId ? 'submitted' : 'deleted';
      if (row.status === status && Number(row.order_id || 0) === Number(body?.orderId || 0)) return view(row);
      if (row.status !== 'draft' || Number(body?.version) !== row.version) fail('הטיוטה השתנתה בחלון אחר; פתח מחדש את הרשימה לפני סגירתה', 409);
      if (status === 'submitted' && !db.prepare('SELECT 1 FROM orders WHERE id=? AND deleted_at IS NULL').get(Number(body.orderId))) fail('לא ניתן לסגור טיוטה לפני שההזמנה נשמרה במערכת');
      db.prepare('UPDATE direct_order_drafts SET status=?,order_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, body?.orderId ? Number(body.orderId) : null, row.id);
      const updated = rowFor(id); audit(updated, 'editor_draft_' + status, actor); return view(updated);
    })();
  }
  function list(before = 0) {
    const cursor = Number(before || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail('סמן הדפדוף של הטיוטות אינו תקין');
    const rows = db.prepare('SELECT * FROM direct_order_drafts WHERE source_system=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 201').all(SOURCE, cursor, cursor);
    return { drafts: rows.slice(0,200).map(view), nextCursor: rows.length > 200 ? rows[199].id : null };
  }
  return { save, close, list };
}
module.exports = { createEditorDraftService };
