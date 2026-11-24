const router = require('express').Router();

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/search missing dependency: ${name}`);
  return value;
}

module.exports = function createSearchRouter(deps) {
  const db = required('db', deps.db);
  const requireRole = required('requireRole', deps.requireRole);

  router.get('/search', requireRole('viewer'), (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;
    const results = [];

    // Rank exact references before each query's limit so partial matches cannot crowd them out.
    // Orders
    const orders = db.prepare(`
      SELECT 'order' as type, o.id, o.order_num as ref, c.name as label,
             o.status, o.created_at as ts
      FROM orders o LEFT JOIN customers c ON o.customer_id=c.id
      WHERE o.order_num LIKE ? OR c.name LIKE ? OR o.delivery_address LIKE ?
      ORDER BY (ref = ? COLLATE NOCASE) DESC
      LIMIT 5
    `).all(like, like, like, q);
    results.push(...orders.map(r => ({ ...r, url: `/orders.html?id=${r.id}`, icon: '📋' })));

    // Customers
    const customers = db.prepare(`
      SELECT 'customer' as type, c.id, c.name as ref, c.phone as label, c.created_at as ts
      FROM customers c WHERE c.name LIKE ? OR c.phone LIKE ? OR c.priority_id LIKE ?
      ORDER BY (ref = ? COLLATE NOCASE) DESC
      LIMIT 5
    `).all(like, like, like, q);
    results.push(...customers.map(r => ({ ...r, url: `/admin.html?tab=customers&id=${r.id}`, icon: '👤' })));

    // Packages
    const packages = db.prepare(`
      SELECT 'package' as type, id, package_code as ref, order_num as label, status, packed_at as ts
      FROM packages WHERE package_code LIKE ? OR order_num LIKE ? OR zone LIKE ?
      ORDER BY (ref = ? COLLATE NOCASE) DESC
      LIMIT 4
    `).all(like, like, like, q);
    results.push(...packages.map(r => ({ ...r, url: `/warehouse.html?pkg=${r.id}`, icon: '📦' })));

    // Raw material / inventory
    const rawmat = db.prepare(`
      SELECT 'inventory' as type, id, lot_number as ref, diameter||'mm ' ||material_type as label, created_at as ts
      FROM raw_material WHERE lot_number LIKE ? OR certificate_num LIKE ? OR notes LIKE ?
      ORDER BY (ref = ? COLLATE NOCASE) DESC
      LIMIT 4
    `).all(like, like, like, q);
    results.push(...rawmat.map(r => ({ ...r, url: `/inventory.html`, icon: '🗄️' })));

    // Incidents
    const incidents = db.prepare(`
      SELECT 'incident' as type, id, title as ref, status as label, created_at as ts
      FROM incidents WHERE title LIKE ? OR description LIKE ?
      ORDER BY (ref = ? COLLATE NOCASE) DESC
      LIMIT 3
    `).all(like, like, q);
    results.push(...incidents.map(r => ({ ...r, url: `/warroom.html`, icon: '🚨' })));

    // Bring exact references to the front of the combined results.
    results.sort((a, b) => {
      const aExact = a.ref?.toLowerCase() === q.toLowerCase() ? 1 : 0;
      const bExact = b.ref?.toLowerCase() === q.toLowerCase() ? 1 : 0;
      return bExact - aExact;
    });

    res.json({ results: results.slice(0, 15), query: q });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "search",
  "label": "Search",
  "consumes": [
    {
      "table": "orders"
    },
    {
      "table": "customers"
    },
    {
      "table": "items"
    }
  ],
  "produces": []
};
