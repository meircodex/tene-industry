const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/financeLedger missing dependency: ${name}`);
  return value;
}

module.exports = function createFinanceLedgerRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);

// ── CUSTOMER LEDGER ────────────────────────────────────────────

// GET /api/customers/:id/ledger
router.get('/customers/:id/ledger', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const customerId = Number(req.params.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'לקוח לא נמצא' });

  // All orders for this customer
  const orders = db.prepare(`
    SELECT o.*, oc.total_cost, oc.revenue, oc.gross_margin, oc.margin_pct, oc.tons_delivered
    FROM orders o
    LEFT JOIN order_costs oc ON o.id=oc.order_id
    WHERE o.customer_id=?
    ORDER BY o.created_at DESC
  `).all(customerId);

  // Credit info
  let credit = db.prepare('SELECT * FROM customer_credit WHERE customer_id=?').get(customerId);
  if (!credit) {
    // auto-create default
    db.prepare('INSERT OR IGNORE INTO customer_credit (customer_id,credit_limit,payment_terms) VALUES (?,?,?)')
      .run(customerId, 100000, 30);
    credit = db.prepare('SELECT * FROM customer_credit WHERE customer_id=?').get(customerId);
  }

  // Calculate open debt from unpaid invoices
  const openInvoices = db.prepare(`
    SELECT COALESCE(SUM(total),0) as total
    FROM invoices WHERE customer_id=? AND status NOT IN ('שולמה','ביטול')
  `).get(customerId);
  const open_debt = openInvoices ? openInvoices.total : 0;

  // WIP value (orders in production)
  const wipOrders = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(oc.total_cost),0) as val
    FROM orders o LEFT JOIN order_costs oc ON o.id=oc.order_id
    WHERE o.customer_id=? AND o.status IN ('בייצור','ממתין','מאושר')
  `).get(customerId);
  const wip_value = wipOrders ? wipOrders.val : 0;

  // Totals
  const totalRevenue  = orders.reduce((s, o) => s + (o.revenue || 0), 0);
  const totalCost     = orders.reduce((s, o) => s + (o.total_cost || 0), 0);
  const totalMargin   = totalRevenue - totalCost;
  const avgMarginPct  = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
  const totalTons     = orders.reduce((s, o) => s + (o.tons_delivered || 0), 0);

  // Update credit record
  db.prepare(`UPDATE customer_credit SET open_debt=?,wip_value=?,total_exposure=?,updated_at=datetime('now') WHERE customer_id=?`)
    .run(open_debt, wip_value, open_debt + wip_value, customerId);

  const total_exposure = open_debt + wip_value;
  const credit_available = Math.max(0, (credit.credit_limit || 0) - total_exposure);
  const credit_pct = credit.credit_limit > 0 ? (total_exposure / credit.credit_limit) * 100 : 0;
  const credit_alert = credit_pct >= 90 ? 'critical' : credit_pct >= 70 ? 'warning' : 'ok';

  res.json({
    customer,
    credit: { ...credit, open_debt, wip_value, total_exposure, credit_available, credit_pct, credit_alert },
    summary: { total_orders: orders.length, totalRevenue, totalCost, totalMargin, avgMarginPct, totalTons },
    orders
  });
});

// PATCH /api/customers/:id/credit
router.patch('/customers/:id/credit', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const { credit_limit, payment_terms, notes } = req.body ?? {};
  if (!Number.isFinite(credit_limit) || credit_limit < 0) {
    return res.status(400).json({ error: 'מסגרת האשראי חייבת להיות מספר שאינו שלילי' });
  }
  const result = db.prepare(`
    INSERT INTO customer_credit (customer_id,credit_limit,payment_terms,notes,updated_at)
    SELECT id,?,?,?,datetime('now') FROM customers WHERE id=?
    ON CONFLICT(customer_id) DO UPDATE SET
      credit_limit=excluded.credit_limit,
      payment_terms=excluded.payment_terms,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `).run(credit_limit, payment_terms || 30, notes || '', req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'לקוח לא נמצא' });
  res.json({ success: true });
});

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "finance-ledger",
  "label": "Finance Ledger",
  "consumes": [
    {
      "table": "customers"
    },
    {
      "table": "invoices"
    },
    {
      "table": "customer_credit"
    }
  ],
  "produces": []
};
