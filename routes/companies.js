const router = require('express').Router();

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/companies missing dependency: ${name}`);
  return value;
}

module.exports = function createCompaniesRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);

  router.get('/companies', requireAnyRole(['office', 'finance', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare('SELECT * FROM companies WHERE active=1 ORDER BY id').all());
  });

  router.post('/companies', requireAnyRole(['manager', 'admin']), (req, res) => {
    const { name, short_name, ownership_pct, erp_type, color } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'שם החברה חובה' });
    }
    const r = db.prepare(
      'INSERT INTO companies (name, short_name, ownership_pct, erp_type, color) VALUES (?,?,?,?,?)'
    ).run(name, short_name || name, ownership_pct ?? 100, erp_type || 'none', color || '#e07b39');
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/companies/:id', requireAnyRole(['manager', 'admin']), (req, res) => {
    const { name, short_name, ownership_pct, erp_type, color } = req.body || {};
    const r = db.prepare(
      'UPDATE companies SET name=COALESCE(?,name), short_name=COALESCE(?,short_name), ownership_pct=COALESCE(?,ownership_pct), erp_type=COALESCE(?,erp_type), color=COALESCE(?,color) WHERE id=?'
    ).run(name, short_name, ownership_pct, erp_type, color, req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'החברה לא נמצאה' });
    res.json({ success: true });
  });

  router.get('/holdings', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const companies = db.prepare('SELECT * FROM companies WHERE active=1').all();

    const rows = companies.map(co => {
      const pct = co.ownership_pct / 100;
      const ordersToday    = db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at)=? AND company_id=?").get(today, co.id).c;
      const weightToday    = db.prepare("SELECT COALESCE(SUM(total_weight),0) as w FROM orders WHERE DATE(created_at)=? AND company_id=?").get(today, co.id).w;
      const inProduction   = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='בייצור' AND company_id=?").get(co.id).c;
      const completedToday = db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at)=? AND status='הושלם – ממתין לאיסוף' AND company_id=?").get(today, co.id).c;
      const pending        = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='ממתינה לאישור' AND company_id=?").get(co.id).c;
      const urgentOpen     = db.prepare("SELECT COUNT(*) as c FROM orders WHERE priority='דחוף' AND status NOT IN ('סופק – אושר','בוטל') AND company_id=?").get(co.id).c;

      // Last 30 days revenue estimate (billing_weight as proxy)
      const revenueProxy = db.prepare(
        "SELECT COALESCE(SUM(billing_weight),0) as r FROM orders WHERE DATE(created_at) >= date('now','-30 days') AND company_id=?"
      ).get(co.id).r;

      return {
        ...co,
        ordersToday,
        weightToday,
        inProduction,
        completedToday,
        pending,
        urgentOpen,
        revenueProxy,
        // Weighted values (ownership %)
        weighted: {
          ordersToday:    ordersToday * pct,
          weightToday:    weightToday * pct,
          inProduction:   inProduction * pct,
          completedToday: completedToday * pct,
          urgentOpen:     urgentOpen * pct,
          revenueProxy:   revenueProxy * pct,
        }
      };
    });

    // Consolidated totals
    const consolidated = {
      ordersToday:    rows.reduce((s,r) => s + r.weighted.ordersToday, 0),
      weightToday:    rows.reduce((s,r) => s + r.weighted.weightToday, 0),
      inProduction:   rows.reduce((s,r) => s + r.weighted.inProduction, 0),
      completedToday: rows.reduce((s,r) => s + r.weighted.completedToday, 0),
      urgentOpen:     rows.reduce((s,r) => s + r.weighted.urgentOpen, 0),
      revenueProxy:   rows.reduce((s,r) => s + r.weighted.revenueProxy, 0),
    };

    res.json({ companies: rows, consolidated });
  });

  return router;
};

module.exports.manifest = {
  id: 'companies',
  label: 'חברות ואחזקות',
  screens: [
    { id: 'projects',  path: '/projects.html',  label: 'פרויקטים', icon: '🏗️', group: 'ניהול' },
    { id: 'holdings',  path: '/holdings.html',   label: 'אחזקות',   icon: '🏢', group: 'ניהול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', finance: 'read', sales: 'read' },
  },
  consumes: [{ table: 'companies' }, { table: 'holdings' }],
  produces: [],
};
