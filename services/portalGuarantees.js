'use strict';
function status(row, now = new Date()) {
  if (row.status === 'approved' && row.valid_until && row.valid_until < now.toLocaleDateString('en-CA', {timeZone:'Asia/Jerusalem'})) return 'expired';
  return row.status || 'uploaded_pending_review';
}
function list(db, { customerId = null, statusFilter = null } = {}) {
  const rows = db.prepare(`SELECT id,customer_id,portal_user_id,original_name,file_name,mime_type,size_bytes,status,notes,uploaded_at,reviewed_at,reviewed_by,valid_until,reviewed_by_user_id FROM customer_guarantee_documents ${customerId ? 'WHERE customer_id=?' : ''} ORDER BY uploaded_at DESC,id DESC`).all(...(customerId ? [customerId] : []));
  return rows.map(row => ({ ...row, computed_status: status(row) })).filter(row => !statusFilter || row.computed_status === statusFilter);
}
function get(db, id) { const row = db.prepare('SELECT * FROM customer_guarantee_documents WHERE id=?').get(id); return row ? { ...row, computed_status: status(row) } : null; }
module.exports = { status, list, get };
