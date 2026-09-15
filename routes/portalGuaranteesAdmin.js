'use strict';
const express = require('express');
const guarantees = require('../services/portalGuarantees');
module.exports = function createPortalGuaranteesAdmin({ db, requireAnyRole, auditLog }) {
  const router = express.Router();
  router.get('/portal/guarantees', requireAnyRole(['office','finance','manager','admin']), (req,res) => {
    res.set('Cache-Control','no-store').json({ canReview:['finance','manager','admin'].includes(req.auth?.role), documents: guarantees.list(db, { customerId: req.query.customerId ? Number(req.query.customerId) : null, statusFilter: req.query.status || null }) });
  });
  router.get('/portal/guarantees/:id/download', requireAnyRole(['office','finance','manager','admin']), (req,res) => {
    const row = guarantees.get(db, req.params.id); if (!row) return res.status(404).send('לא נמצא');
    const match = /^data:([^;]+);base64,(.*)$/s.exec(row.data_url || ''); if (!match) return res.status(410).send('הקובץ אינו זמין');
    res.set('Cache-Control','no-store'); res.type(row.mime_type || match[1]); res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`); res.send(Buffer.from(match[2],'base64'));
  });
  router.patch('/portal/guarantees/:id', requireAnyRole(['finance','manager','admin']), (req,res) => {
    const next = String(req.body.status || '').trim(); if (!['approved','rejected','revoked'].includes(next)) return res.status(400).json({ error:'invalid_guarantee_status' });
    const validUntil = req.body.valid_until || req.body.validUntil || null;
    if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || Number.isNaN(new Date(validUntil).getTime()))) return res.status(400).json({ error:'invalid_valid_until' });
    if (validUntil && new Date(validUntil).toISOString().slice(0,10) !== validUntil) return res.status(400).json({error:'תאריך אינו תקין'});
    if (next === 'approved' && (!validUntil || validUntil < new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'}))) return res.status(400).json({error:'לאישור ערבות יש לציין תוקף שאינו בעבר'});
    if (next !== 'approved' && !String(req.body.notes || '').trim()) return res.status(400).json({error:'יש לציין נימוק להחלטה'});
    const row = guarantees.get(db, req.params.id); if (!row) return res.status(404).json({ error:'not_found' });
    db.transaction(()=>{
      db.prepare('UPDATE customer_guarantee_documents SET status=?,notes=COALESCE(?,notes),valid_until=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,reviewed_by_user_id=? WHERE id=?').run(next, req.body.notes || null, validUntil || row.valid_until, req.auth?.display_name || req.auth?.sub || null, req.auth?.sub || null, row.id);
      auditLog('customer_guarantee_document', row.id, null, 'guarantee_review', 'status', row.status, next, req.body.notes || null, req.auth?.sub || null, req.auth?.display_name || null);
    })();
    res.json({success:true,id:row.id,status:next});
  });
  return router;
};
module.exports.manifest = { id:'portal-guarantees-admin', label:'Portal Guarantee Review', screens:[], access:{default:'hidden',roles:{admin:'edit',manager:'edit',finance:'edit',office:'read'}}, consumes:[{table:'customer_guarantee_documents'}], produces:[] };
