'use strict';

// Only recorded invoices linked wholly to authorized orders are exposed.
// Never turn a quote/order value into a receivable or infer a due date.
function portalInvoices(db, { customerId, siteIds = [], siteId = null } = {}) {
  const allowed = new Set(siteIds.map(Number));
  if (siteId != null && !allowed.has(Number(siteId))) return [];
  const orders = new Map(db.prepare('SELECT id,order_num,site_id FROM orders WHERE customer_id=?').all(customerId).map(o => [o.id, o]));
  const sites = new Map(db.prepare('SELECT id,name FROM customer_sites WHERE customer_id=?').all(customerId).map(s => [s.id, s.name]));
  const invoices = db.prepare(`SELECT id,invoice_num,invoice_type,order_id,items_json,total,paid_amount,status,due_date,issue_date
    FROM invoices WHERE customer_id=? AND invoice_type IN ('tax_invoice','tax_invoice_receipt') AND status NOT IN ('ביטול','בוטלה','cancelled','draft','טיוטה')`).all(customerId);
  return invoices.flatMap(invoice => {
    let items;
    try { items = JSON.parse(invoice.items_json || '[]'); } catch { return []; }
    const ids = [...new Set([invoice.order_id, ...(Array.isArray(items) ? items.map(i => i.order_id) : [])].map(Number).filter(id => id > 0))];
    // A consolidated invoice is not split arbitrarily across site permissions.
    if (!ids.length || ids.some(id => !orders.has(id) || !allowed.has(Number(orders.get(id).site_id)))) return [];
    if (siteId != null && ids.some(id => Number(orders.get(id).site_id) !== Number(siteId))) return [];
    const balance = Math.max(0, Math.round((Number(invoice.total || 0) - Number(invoice.paid_amount || 0)) * 100) / 100);
    return [{
      id: invoice.id, invoiceNum: invoice.invoice_num, source: 'invoice',
      orderId: ids.length === 1 ? ids[0] : null,
      orderNum: ids.map(id => orders.get(id).order_num).join(', '),
      siteId: ids.length === 1 ? orders.get(ids[0]).site_id : null,
      siteName: [...new Set(ids.map(id => sites.get(orders.get(id).site_id) || ''))].join(', '),
      dueDate: invoice.due_date || null, issueDate: invoice.issue_date,
      total: Number(invoice.total || 0), paidAmount: Number(invoice.paid_amount || 0),
      amount: invoice.status === 'שולמה' ? 0 : balance,
    }];
  });
}

module.exports = { portalInvoices };
