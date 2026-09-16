const router = require('express').Router();
const { createPortalAccessService } = require('../services/portalAccess');
const { createPortalInbox } = require('../services/portalInbox');

function required(name, value) {
  if (!value) throw new Error(`routes/portalAdmin missing dependency: ${name}`);
  return value;
}

module.exports = function createPortalAdminRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const auditLog = required('auditLog', deps.auditLog);
  const crypto = required('crypto', deps.crypto);
  const settingsService = required('settingsService', deps.settingsService);
  const PORT = required('PORT', deps.PORT);

  const portalAccess = createPortalAccessService({ db, crypto, settingsService, PORT });
  const inbox = createPortalInbox(db);
  router.get('/orders/:orderId/portal-source-documents', requireAnyRole(['office','manager','admin']), (req,res) => {
    const documents = db.prepare('SELECT id,original_name,mime_type,size_bytes,uploaded_at FROM customer_portal_order_documents WHERE order_id=? ORDER BY id').all(req.params.orderId);
    res.json({documents});
  });
  router.get('/orders/:orderId/portal-source-documents/:documentId/download', requireAnyRole(['office','manager','admin']), (req,res) => {
    const doc = db.prepare(`SELECT d.* FROM customer_portal_order_documents d JOIN orders o ON o.id=d.order_id AND o.customer_id=d.customer_id WHERE d.id=? AND d.order_id=?`).get(req.params.documentId,req.params.orderId);
    if (!doc) return res.status(404).json({error:'המסמך לא נמצא'});
    const match = /^data:([^;]+);base64,(.*)$/s.exec(doc.data_url || '');
    if (!match) return res.status(410).json({error:'תוכן המסמך אינו זמין'});
    res.set('Cache-Control','no-store');
    res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
    res.type(doc.mime_type || 'application/octet-stream').send(Buffer.from(match[2],'base64'));
  });
  router.get('/portal-requests', requireAnyRole(['office','manager','admin']), (req,res) => {
    const orders = inbox.list();
    res.json({ orders, pendingCount: orders.filter(o=>!o.handled_at).length, unreadCount: orders.filter(o=>o.unread).length });
  });
  router.patch('/portal-requests/:id', requireAnyRole(['office','manager','admin']), (req,res) => {
    const result = db.transaction(() => {
      const updated = inbox.update(Number(req.params.id), Number(req.auth?.sub || req.userId), req.body.action);
      if (updated.error) return updated;
      auditLog('order',Number(req.params.id),null,'portal_inbox_'+req.body.action,null,null,null,'טיפול בבקשת פורטל',req.userId || Number(req.auth?.sub),req.auth?.display_name || null);
      return updated;
    })();
    res.status(result.status || 200).json(result);
  });

  function requestPublicBaseUrl(req) {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
  }

  function portalTokenPayload(result) {
    const accessCode = String(result.token || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join('-') || '';
    return { token: result.token, accessCode, link: result.link, expiresAt: result.expiresAt };
  }

  // Generate / fetch portal token for a customer.
  router.get('/customers/:id/token', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    let c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'לא נמצא' });
    const result = portalAccess.portalAuthResponse(c, { baseUrl: requestPublicBaseUrl(req) });
    res.json(portalTokenPayload(result));
  });

  // Short-lived support session for a signed-in system administrator.
  router.get('/customers/:id/portal-preview', requireAnyRole(['admin']), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'לא נמצא' });
    const requestedUserId = req.query.portalUserId;
    if (requestedUserId !== undefined && !/^[1-9]\d*$/.test(String(requestedUserId))) {
      return res.status(400).json({ error: 'יש לבחור משתמש פורטל תקין' });
    }
    const portalUser = requestedUserId !== undefined
      ? db.prepare('SELECT * FROM portal_users WHERE id=? AND customer_id=? AND active=1').get(Number(requestedUserId), customer.id)
      : null;
    if (requestedUserId !== undefined && !portalUser) {
      return res.status(404).json({ error: 'לא נמצא משתמש פורטל פעיל עבור הלקוח' });
    }
    const preview = portalAccess.issueSupportPreviewToken(customer.id, req.userId || null, portalUser?.id || null);
    auditLog('customer', customer.id, null, 'portal_support_session_started', null, null, null, portalUser ? `כניסה בשם משתמש פורטל #${portalUser.id}` : 'כניסה ללא משתמש פורטל פעיל', req.userId || null, req.auth?.display_name || null);
    res.json({
      link: portalAccess.portalLink(preview.token, { baseUrl: requestPublicBaseUrl(req) }),
      expiresAt: preview.expiresAt,
      customer: { id: customer.id, name: customer.name },
      portalUser: portalUser ? { id: portalUser.id, name: portalUser.name, role: portalUser.role } : null,
      mode: 'assist',
      readOnly: false,
    });
  });

  router.post('/customers/:id/token/rotate', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    let c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const result = portalAccess.portalAuthResponse(c, { forceRotate: true, baseUrl: requestPublicBaseUrl(req) });
    auditLog('customer', c.id, null, 'portal_token_rotate', null, null, null, null, req.userId || null, null);
    res.json(portalTokenPayload(result));
  });

  router.post('/customers/:id/portal-password/reset', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const phone = portalAccess.normalizePortalPhone(req.body.phone || c.phone);
    if (!phone) return res.status(400).json({ error: 'אין טלפון ללקוח. עדכן טלפון לפני יצירת סיסמת פורטל.' });
    const user = portalAccess.findOrCreatePortalUser(c.id, phone, req.body.name || c.name);
    const temporaryPassword = portalAccess.generatePortalPassword();
    const result = portalAccess.setPortalPassword(user.id, temporaryPassword);
    if (!result.ok) return res.status(400).json({ error: result.error });
    auditLog('customer', c.id, null, 'portal_password_reset', null, null, null, null, req.userId || null, null);
    res.json({
      success: true,
      phone,
      userId: user.id,
      temporaryPassword,
      message: `שלום ${c.name || ''}, הכניסה לפורטל טנא: ${portalAccess.configuredBaseUrl(requestPublicBaseUrl(req))}/customer.html\nטלפון: ${phone}\nסיסמה זמנית: ${temporaryPassword}`
    });
  });

  router.delete('/customers/:id/token', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const c = db.prepare('SELECT id FROM customers WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE customers SET portal_token_revoked_at=CURRENT_TIMESTAMP WHERE id=?').run(c.id);
    auditLog('customer', c.id, null, 'portal_token_revoke', null, null, null, null, req.userId || null, null);
    res.json({ success: true });
  });

  router.patch('/customers/:id/pricing', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const { price_tier, discount_pct } = req.body;
    // BUG-26: validate discount is 0-100.
    const discountNum = Number(discount_pct ?? 0);
    if (isNaN(discountNum) || discountNum < 0 || discountNum > 100) {
      return res.status(400).json({ error: 'הנחה חייבת להיות בין 0 ל-100' });
    }
    db.prepare('UPDATE customers SET price_tier=?,discount_pct=? WHERE id=?')
      .run(price_tier, discountNum, req.params.id);
    res.json({ success: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "portal-admin",
  "label": "Portal Admin",
  "consumes": [
    {
      "table": "customers"
    }
  ],
  "produces": []
};
