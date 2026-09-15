'use strict';

const router = require('express').Router();
const { createPortalAccessService } = require('../services/portalAccess');

function required(name, value) { if (!value) throw new Error(`routes/portalDocuments missing dependency: ${name}`); return value; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

module.exports = function createPortalDocumentsRouter(deps) {
  const db = required('db', deps.db);
  const settingsService = required('settingsService', deps.settingsService);
  const customerPortalActionLimiter = required('customerPortalActionLimiter', deps.customerPortalActionLimiter);
  const portalAccess = createPortalAccessService({ db, crypto: require('crypto'), settingsService, PORT: deps.PORT || 3000 });

  function session(token) {
    const raw = portalAccess.resolvePortalSession(String(token || ''));
    if (!raw) return null;
    const ctx = portalAccess.portalContext(raw.customer, raw.user);
    return { ...raw, caps: ctx.caps, portal: ctx };
  }
  function orderFor(s, id) {
    if (!s) return null;
    const access = s.user
      ? `o.customer_id=? AND o.id=? AND (o.site_id IN (SELECT site_id FROM customer_site_users WHERE customer_id=? AND portal_user_id=?) OR o.site_id=?)`
      : 'o.customer_id=? AND o.id=?';
    const params = s.user ? [s.customer.id, id, s.customer.id, s.user.id, s.user.default_site_id || 0] : [s.customer.id, id];
    return db.prepare(`SELECT o.id,o.order_num,o.customer_id,o.site_id,o.status,o.delivery_date,o.delivery_address,o.delivery_time,cs.name AS site_name FROM orders o LEFT JOIN customer_sites cs ON cs.id=o.site_id WHERE ${access}`).get(...params);
  }
  function allowedDocuments(s, order) {
    const docs = [];
    if (s.caps.canViewInvoices) {
      const invoices = db.prepare(`SELECT id,'invoice' AS type,invoice_num AS number,issue_date AS issued_at,total,paid_amount,status,order_id,items_json FROM invoices WHERE customer_id=? AND order_id=? ORDER BY issue_date DESC,id DESC`).all(order.customer_id, order.id);
      for (const row of invoices) {
        let items;
        try { items = JSON.parse(row.items_json || '[]'); } catch { continue; }
        if (!Array.isArray(items)) continue;
        const linked = [row.order_id, ...items.map(item => item?.order_id)].filter(id => id != null);
        if (linked.some(id => !orderFor(s, id))) continue;
        const { order_id, items_json, ...summary } = row;
        docs.push({ ...summary, title: 'חשבונית — סיכום, לא מסמך מקור' });
      }
    }
    if (s.caps.canViewDeliveryNotes) {
      const notes = db.prepare(`SELECT DISTINCT d.id,'delivery_note' AS type,d.note_num AS number,d.issued_at,d.delivered_at,d.total_weight,d.customer_id,d.order_id FROM delivery_notes d LEFT JOIN delivery_note_orders dn ON dn.delivery_note_id=d.id WHERE d.customer_id=? AND (d.order_id=? OR dn.order_id=?) ORDER BY d.issued_at DESC,d.id DESC`).all(order.customer_id, order.id, order.id);
      notes.forEach(row => {
        const linked = [row.order_id, ...db.prepare('SELECT order_id FROM delivery_note_orders WHERE delivery_note_id=?').all(row.id).map(x => x.order_id)].filter(id => id != null);
        if (row.id && linked.length && linked.some(orderId => !orderFor(s, orderId))) return;
        const { order_id, ...summary } = row;
        docs.push({ ...summary, title: 'תעודת משלוח — סיכום, לא מסמך מקור' });
      });
    }
    return docs;
  }
  router.get('/c/orders/:orderId/documents', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const order = orderFor(s, req.params.orderId);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    res.set('Cache-Control', 'no-store');
    res.json({ order: { id: order.id, order_num: order.order_num }, documents: allowedDocuments(s, order) });
  });
  router.get('/c/orders/:orderId/documents/:type/:documentId', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).send('לא מורשה');
    const order = orderFor(s, req.params.orderId);
    if (!order) return res.status(404).send('לא נמצא');
    const type = req.params.type;
    const doc = allowedDocuments(s, order).find(row => row.type === type && Number(row.id) === Number(req.params.documentId));
    if (!doc) return res.status(404).send('לא נמצא');
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${esc(doc.title)} ${esc(doc.number)}</title><style>body{font:16px Arial;max-width:760px;margin:30px auto}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:8px}</style><h1>${esc(doc.title)} ${esc(doc.number)}</h1><p>מסמך עבור הזמנה ${esc(order.order_num)} בלבד</p><table>${Object.entries(doc).filter(([key]) => !['id','type','title'].includes(key) && key !== 'customer_id').map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('')}</table></html>`);
  });
  return router;
};

module.exports.manifest = { screens: [], access: { default: 'hidden', roles: { admin: 'edit' } }, id: 'portal-documents', label: 'Portal Documents', consumes: [{ table: 'orders' }, { table: 'invoices' }, { table: 'delivery_notes' }, { table: 'delivery_note_orders' }], produces: [] };
