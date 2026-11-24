const router = require('express').Router();
const { linkInvoiceToOrders } = require('../services/customerBilling');

function required(name, value) {
  if (!value) throw new Error(`routes/financeInvoices missing dependency: ${name}`);
  return value;
}

module.exports = function createFinanceInvoicesRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  router.get('/invoices', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const { customer_id, status, order_id } = req.query;
    const wheres = [], params = [];
    if (customer_id) { wheres.push('i.customer_id=?'); params.push(customer_id); }
    if (status) { wheres.push('i.status=?'); params.push(status); }
    if (order_id) { wheres.push('i.order_id=?'); params.push(order_id); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const rows = db.prepare(`SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id ${where} ORDER BY i.created_at DESC LIMIT 100`).all(...params);
    res.json(rows);
  });

  router.post('/invoices', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const { order_id, customer_id, items_json, subtotal, vat_rate, notes, invoice_type } = req.body;
    const year = new Date().getFullYear();
    const seq = db.prepare("SELECT COUNT(*)+1 as n FROM invoices WHERE invoice_num LIKE ?").get(`INV-${year}-%`).n;
    const invoice_num = `INV-${year}-${String(seq).padStart(5,'0')}`;
    const vat = vat_rate ?? 0.18;
    const sub = subtotal || 0;
    const vatAmount = sub * vat;
    const total = sub + vatAmount;
    const order = order_id ? db.prepare('SELECT order_num,customer_id FROM orders WHERE id=?').get(order_id) : null;
    const cust = (customer_id || order?.customer_id) ? db.prepare('SELECT name,tax_id FROM customers WHERE id=?').get(customer_id || order?.customer_id) : null;
    const r = db.prepare(`INSERT INTO invoices (invoice_num,invoice_type,order_id,order_num,customer_id,customer_name,customer_vat_id,issue_date,items_json,subtotal,vat_rate,vat_amount,total,notes,created_by)
      VALUES (?,?,?,?,?,?,?,date('now'),?,?,?,?,?,?,?)`)
      .run(invoice_num, invoice_type||'tax_invoice', order_id||null, order?.order_num||null,
        customer_id||order?.customer_id||null, cust?.name||null, cust?.tax_id||null,
        JSON.stringify(items_json||[]), sub, vat, vatAmount, total, notes||null, req.auth.sub || null);
    wsBroadcast('new_invoice', { id: r.lastInsertRowid, invoice_num, total });
    res.json({ id: r.lastInsertRowid, invoice_num, total });
  });

  router.post('/invoices/:id/link-orders', requireAnyRole(['finance', 'manager', 'admin']), (req, res, next) => {
    try {
      const result = linkInvoiceToOrders(db, {
        invoice_id: req.params.id,
        order_ids: req.body?.order_ids,
      });
      res.json(result);
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({
          error: err.message,
          rejectedOrderIds: err.rejectedOrderIds || [],
        });
      }
      return next(err);
    }
  });
  router.patch('/invoices/:id/pay', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => { // BUG-36: cannot pay cancelled invoice
    const { paid_amount, payment_method, payment_ref } = req.body ?? {};
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
    if (inv.status === 'ביטול') return res.status(409).json({ error: 'לא ניתן לשלם חשבונית מבוטלת' });
    if (!Number.isFinite(paid_amount) || paid_amount <= 0) {
      return res.status(400).json({ error: 'סכום התשלום חייב להיות מספר גדול מאפס' });
    }
    const newPaid = (inv.paid_amount || 0) + paid_amount;
    const status = newPaid >= inv.total ? 'שולמה' : 'חלקית';
    db.prepare('UPDATE invoices SET paid_amount=?,status=?,payment_method=COALESCE(?,payment_method),payment_ref=COALESCE(?,payment_ref) WHERE id=?')
      .run(newPaid, status, payment_method||null, payment_ref||null, req.params.id);
    res.json({ ok: true, status, paid_amount: newPaid });
  });

  router.patch('/invoices/:id/cancel', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const result = db.prepare("UPDATE invoices SET status='ביטול' WHERE id=? AND status IS NOT 'שולמה'")
      .run(req.params.id);
    if (!result.changes) {
      const exists = db.prepare('SELECT 1 FROM invoices WHERE id=?').get(req.params.id);
      if (!exists) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
      return res.status(409).json({ error: 'לא ניתן לבטל חשבונית ששולמה' });
    }
    res.json({ ok: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'finance-invoices',
  label: 'חשבוניות',
  consumes: [{ table: 'orders' }, { table: 'customers' }],
  produces: [{ event: 'new_invoice' }],
};
