const router = require('express').Router();
const { itemShapeMetrics } = require('../services/shapeSnapshot');

function required(name, value) {
  if (!value) throw new Error(`routes/financeCosts missing dependency: ${name}`);
  return value;
}

module.exports = function createFinanceCostsRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireRole = required('requireRole', deps.requireRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const industry = required('industry', deps.industry);
  const settingsService = required('settingsService', deps.settingsService);

// ── ORDER COSTS ────────────────────────────────────────────
const STANDARD_LENGTHS_MM = [6000, 12000];

function detectPriceCategory(item) {
  // If manually set (not 'auto'), respect it
  if (item.price_category && item.price_category !== 'auto') return item.price_category;

  const segs = (() => { try { return JSON.parse(item.segments || '[]'); } catch(e) { return []; } })();
  const snapshotMetrics = itemShapeMetrics(item);
  const isStraight = segs.length <= 1;

  if (isStraight) {
    const lenMm = snapshotMetrics.totalLengthMm || item.total_length_mm || 0;
    const isStandard = STANDARD_LENGTHS_MM.some(l => Math.abs(lenMm - l) < 10);
    return isStandard ? 'straight_standard' : 'straight_cut';
  }
  return 'bent';
}

function getLatestSteelPrice() {
  let row = db.prepare(
    'SELECT price_per_ton FROM steel_price_history ORDER BY effective_date DESC, id DESC LIMIT 1'
  ).get();
  if (!row) row = db.prepare(
    'SELECT price_per_ton FROM steel_prices ORDER BY effective_date DESC, id DESC LIMIT 1'
  ).get();
  return row ? row.price_per_ton : 3800;
}

function itemFinanceMetrics(item, industry) {
  const metrics = itemShapeMetrics(item);
  const totalLengthMm = metrics.totalLengthMm || Number(item.total_length_mm || 0) || 0;
  const totalWeightKg = metrics.totalWeightKg
    || (industry.weightPerUnit({ diameter: item.diameter, total_length_mm: totalLengthMm }) * (item.quantity || 1));
  return { totalLengthMm, totalWeightKg };
}

function calculateOrderCost(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return null;

  const pallets = db.prepare('SELECT * FROM pallets WHERE order_id=?').all(orderId);
  pallets.forEach(p => { p.items = db.prepare('SELECT * FROM items WHERE pallet_id=?').all(p.id); });
  const allItems = pallets.flatMap(p => p.items);

  const pricePerTon = getLatestSteelPrice();
  const hasSteelHistory = !!db.prepare('SELECT 1 FROM steel_price_history LIMIT 1').get();

  // Total weight: prefer Shape V2 calculated values, then legacy item/order fields.
  const itemsWeightKg = allItems.reduce((sum, item) => sum + itemFinanceMetrics(item, industry).totalWeightKg, 0);
  let totalWeightKg = itemsWeightKg > 0 ? itemsWeightKg : (order.total_weight || 0);

  const material_cost = (totalWeightKg / 1000) * pricePerTon;

  // Labor cost: base rate × (1 + bends complexity factor)
  const laborBasePerTon = settingsService.getNum('LABOR_COST_PER_HOUR', 120) * 8;
  const avgBends = allItems.length > 0
    ? allItems.reduce((s, it) => {
        const segs = (() => { try { return JSON.parse(it.segments || '[]'); } catch(e) { return []; } })();
        return s + Math.max(0, segs.length - 1);
      }, 0) / allItems.length
    : 3;
  const laborRatePerTon = laborBasePerTon + (avgBends * 40);
  const labor_cost = (totalWeightKg / 1000) * laborRatePerTon;

  // Machine cost
  const machine_cost = (totalWeightKg / 1000) * settingsService.getNum('MACHINE_COST_PER_TON', 80);

  // Scrap/waste cost
  const scrapPct   = settingsService.getNum('SCRAP_COST_PCT', 3) / 100;
  const scrap_cost = material_cost * scrapPct;

  // Overhead
  const overheadFactor = settingsService.getNum('OVERHEAD_COST_FACTOR', 0.15);
  const directCosts    = material_cost + labor_cost + machine_cost + scrap_cost;
  const overhead_cost  = directCosts * overheadFactor;
  const total_cost     = directCosts + overhead_cost;

  // Revenue: calculate from customer price book
  // Price book has range-based material prices (per kg) + separate processing fees (cutting, bending per kg)
  // Fall back to billed_amount (actual Priority invoice) if available
  let revenue = 0;
  let revenue_source = 'none';
  if (order.customer_id) {
    const book = db.prepare(`
      SELECT b.id FROM pricing_price_books b
      WHERE b.customer_id=? AND b.status='active'
      ORDER BY b.updated_at DESC LIMIT 1
    `).get(order.customer_id);
    if (book) {
      // Get all active per-kg items from the price book
      const bookItems = db.prepare(`
        SELECT sku, description, diameter, price_before_vat, unit, category
        FROM pricing_price_items
        WHERE price_book_id=? AND active=1 AND price_before_vat > 0
        ORDER BY sort_order, id
      `).all(book.id);

      // Helper: find base material price for a given diameter
      // Price book uses diameter ranges — match by: exact diameter field, or find smallest price that covers the diameter
      function materialPriceForDiameter(d) {
        // First: try exact diameter match
        const exact = bookItems.find(i => i.unit === 'kg' && i.diameter === d);
        if (exact) return exact.price_before_vat;
        // Second: look for range item whose description includes this diameter
        // Items like "8-25 מ"מ" match diameters 8..25, "28-36 מ"מ" match 28..36
        for (const i of bookItems) {
          if (i.unit !== 'kg') continue;
          const m = String(i.description || i.sku || '').match(/(\d+)-(\d+)/);
          if (m && d >= Number(m[1]) && d <= Number(m[2])) return i.price_before_vat;
        }
        // Third: fallback to cheapest per-kg material item (exclude processing/delivery)
        const materialItems = bookItems.filter(i => i.unit === 'kg' && i.price_before_vat > 0);
        if (materialItems.length) return Math.min(...materialItems.map(i => i.price_before_vat));
        return 0;
      }

      // Processing fees per kg from price book
      const cuttingItem  = bookItems.find(i => i.unit === 'kg' && /חית/.test(i.description || i.sku || ''));
      const bendingItem  = bookItems.find(i => i.unit === 'kg' && /כיפ/.test(i.description || i.sku || ''));
      const cuttingPrice = cuttingItem ? cuttingItem.price_before_vat : 0;
      const bendingPrice = bendingItem ? bendingItem.price_before_vat : 0;

      // Per-unit items (חישוקים, כסאות, ציפורים) — unit='יח' or 'pcs'
      const perUnitItems = bookItems.filter(i => i.unit === 'יח' || i.unit === 'pcs' || i.unit === 'unit');

      let bookRevenue = 0;
      if (allItems.length > 0) {
        allItems.forEach(it => {
          const w = itemFinanceMetrics(it, industry).totalWeightKg;
          const cat = detectPriceCategory(it);

          if (cat === 'per_unit') {
            // Find matching per-unit price by description/sku match on shape_name or struct_element
            const label = (it.shape_name || it.struct_element || '').toLowerCase();
            const puItem = perUnitItems.find(p => {
              const desc = (p.description || p.sku || '').toLowerCase();
              return desc.includes('חישוק') && label.includes('חישוק')
                || desc.includes('כסא') && label.includes('כסא')
                || desc.includes('ציפור') && label.includes('ציפור');
            }) || perUnitItems[0];
            if (puItem) bookRevenue += (it.quantity || 1) * puItem.price_before_vat;
          } else {
            const matPrice = materialPriceForDiameter(it.diameter || 0);
            // straight_standard = material only (bar sold by kg, no cutting)
            // straight_cut      = material + cutting
            // bent              = material + cutting + bending
            const processingPrice = cat === 'straight_standard' ? 0
              : cat === 'straight_cut' ? cuttingPrice
              : cuttingPrice + bendingPrice; // bent
            bookRevenue += w * (matPrice + processingPrice);
          }
        });
      } else if (totalWeightKg > 0) {
        const basePrice = Math.min(...bookItems.filter(i => i.unit === 'kg' && i.price_before_vat > 0).map(i => i.price_before_vat).filter(Boolean));
        bookRevenue = totalWeightKg * (isFinite(basePrice) ? basePrice : 0);
      }

      if (bookRevenue > 0) {
        revenue = bookRevenue;
        revenue_source = 'price_book';
      }
    }
  }
  // Override with actual billed amount if recorded (actual Priority invoice — most accurate)
  const billing = db.prepare('SELECT billed_amount FROM order_billing WHERE order_id=?').get(orderId);
  if (billing && billing.billed_amount > 0) {
    revenue = billing.billed_amount;
    revenue_source = 'billed';
  }

  const gross_margin = revenue - total_cost;
  const margin_pct   = revenue > 0 ? (gross_margin / revenue) * 100 : null;
  const tons_delivered = totalWeightKg / 1000;
  const cost_per_ton   = tons_delivered > 0 ? total_cost / tons_delivered : 0;

  const confidence = hasSteelHistory ? 'high' : 'low';

  return {
    order_id: orderId, material_cost, labor_cost, machine_cost,
    scrap_cost, overhead_cost, total_cost, revenue, revenue_source,
    gross_margin, margin_pct, tons_delivered, cost_per_ton, confidence
  };
}

// GET /api/orders/:id/costs
router.get('/orders/:id/costs', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const orderId = Number(req.params.id);
  let existing = db.prepare('SELECT * FROM order_costs WHERE order_id=?').get(orderId);
  if (!existing) {
    const calc = calculateOrderCost(orderId);
    if (!calc) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    db.prepare(`INSERT OR REPLACE INTO order_costs
      (order_id,material_cost,labor_cost,machine_cost,scrap_cost,overhead_cost,
       total_cost,revenue,gross_margin,margin_pct,tons_delivered,cost_per_ton,confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(calc.order_id, calc.material_cost, calc.labor_cost, calc.machine_cost,
           calc.scrap_cost, calc.overhead_cost, calc.total_cost, calc.revenue,
           calc.gross_margin, calc.margin_pct, calc.tons_delivered, calc.cost_per_ton, calc.confidence);
    existing = db.prepare('SELECT * FROM order_costs WHERE order_id=?').get(orderId);
  }
  res.json(existing);
});

// POST /api/orders/:id/costs/recalculate
router.post('/orders/:id/costs/recalculate', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const orderId = Number(req.params.id);
  const locked = db.prepare('SELECT locked FROM order_costs WHERE order_id=?').get(orderId);
  if (locked && locked.locked) return res.status(403).json({ error: 'עלויות נעולות – נדרש מנהל לביטול הנעילה' });

  const calc = calculateOrderCost(orderId);
  if (!calc) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

  // Snapshot before overwrite
  const prev = db.prepare('SELECT * FROM order_costs WHERE order_id=?').get(orderId);
  if (prev) {
    db.prepare('INSERT INTO cost_snapshots (order_id,snapshot,reason,created_by) VALUES (?,?,?,?)')
      .run(orderId, JSON.stringify(prev), req.body.reason || 'חישוב מחדש', req.headers['x-user'] || 'system');
  }

  db.prepare(`INSERT OR REPLACE INTO order_costs
    (order_id,material_cost,labor_cost,machine_cost,scrap_cost,overhead_cost,
     total_cost,revenue,gross_margin,margin_pct,tons_delivered,cost_per_ton,confidence,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(calc.order_id, calc.material_cost, calc.labor_cost, calc.machine_cost,
         calc.scrap_cost, calc.overhead_cost, calc.total_cost, calc.revenue,
         calc.gross_margin, calc.margin_pct, calc.tons_delivered, calc.cost_per_ton, calc.confidence);

  wsBroadcast('cost_update', { orderId, margin_pct: calc.margin_pct, gross_margin: calc.gross_margin });
  res.json({ ...calc, recalculated: true });
});

// PATCH /api/orders/:id/costs/lock
router.patch('/orders/:id/costs/lock', requireRole('manager'), (req, res) => {
  const { lock, reason } = req.body;
  const user = req.headers['x-user'] || 'מנהל';
  const update = db.prepare(`UPDATE order_costs SET locked=?,locked_by=?,locked_at=datetime('now'),notes=? WHERE order_id=?`)
    .run(lock ? 1 : 0, lock ? user : null, reason || '', req.params.id);
  if (!update.changes) return res.status(404).json({ error: 'לא נמצאו עלויות להזמנה' });
  db.prepare('INSERT INTO financial_events (event_type,entity_type,entity_id,description,created_by) VALUES (?,?,?,?,?)')
    .run(lock ? 'cost_locked' : 'cost_unlocked', 'order', Number(req.params.id), reason || '', user);
  res.json({ success: true, locked: !!lock });
});

// GET /api/orders/:id/costs/snapshots
router.get('/orders/:id/costs/snapshots', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const snaps = db.prepare('SELECT * FROM cost_snapshots WHERE order_id=? ORDER BY created_at DESC LIMIT 20')
    .all(req.params.id);
  res.json(snaps.map(s => ({ ...s, snapshot: JSON.parse(s.snapshot) })));
});

// PATCH /api/orders/:id/costs/billing — record actual billed amount from Priority
router.patch('/orders/:id/costs/billing', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT id, order_num FROM orders WHERE id=?').get(orderId);
  if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  const costs = db.prepare('SELECT locked FROM order_costs WHERE order_id=?').get(orderId);
  if (costs?.locked) return res.status(403).json({ error: 'עלויות נעולות – נדרש מנהל לביטול הנעילה' });

  const { billed_amount, billed_date, priority_invoice_ref, billing_notes } = req.body;
  if (billed_amount === undefined || billed_amount === null) {
    return res.status(400).json({ error: 'billed_amount נדרש' });
  }
  const user = req.auth?.display_name || req.auth?.sub || 'system';

  db.prepare(`
    INSERT INTO order_billing (order_id, order_num, billed_amount, billed_date, priority_invoice_ref, billing_notes, billed_by, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      billed_amount=excluded.billed_amount,
      billed_date=excluded.billed_date,
      priority_invoice_ref=excluded.priority_invoice_ref,
      billing_notes=excluded.billing_notes,
      billed_by=excluded.billed_by,
      updated_at=datetime('now')
  `).run(orderId, order.order_num, Number(billed_amount), billed_date || null, priority_invoice_ref || '', billing_notes || '', user);

  // Re-calculate costs with updated revenue
  const calc = calculateOrderCost(orderId);
  db.prepare(`INSERT OR REPLACE INTO order_costs
    (order_id,material_cost,labor_cost,machine_cost,scrap_cost,overhead_cost,
     total_cost,revenue,gross_margin,margin_pct,tons_delivered,cost_per_ton,confidence,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(calc.order_id, calc.material_cost, calc.labor_cost, calc.machine_cost,
         calc.scrap_cost, calc.overhead_cost, calc.total_cost, calc.revenue,
         calc.gross_margin, calc.margin_pct, calc.tons_delivered, calc.cost_per_ton, calc.confidence);

  wsBroadcast('cost_update', { orderId, margin_pct: calc.margin_pct, gross_margin: calc.gross_margin });
  res.json({ success: true, billing: { billed_amount, billed_date, priority_invoice_ref }, costs: calc });
});

// GET /api/orders/:id/costs/billing — get billing record
router.get('/orders/:id/costs/billing', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const billing = db.prepare('SELECT * FROM order_billing WHERE order_id=?').get(req.params.id);
  res.json(billing || null);
});

// GET /api/profitability — summary across all orders
router.get('/profitability', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const { from, to, customer_id, status } = req.query;
  let where = ['1=1'];
  const params = [];
  if (from)        { where.push("o.created_at >= ?"); params.push(from); }
  if (to)          { where.push("o.created_at <= ?"); params.push(to + ' 23:59:59'); }
  if (customer_id) { where.push("o.customer_id = ?"); params.push(Number(customer_id)); }
  if (status)      { where.push("o.status = ?"); params.push(status); }

  const rows = db.prepare(`
    SELECT
      o.id, o.order_num, o.status, o.created_at, o.total_weight,
      o.customer_id,
      c.name AS customer_name,
      oc.material_cost, oc.labor_cost, oc.machine_cost, oc.scrap_cost,
      oc.overhead_cost, oc.total_cost, oc.revenue, oc.gross_margin,
      oc.margin_pct, oc.tons_delivered, oc.cost_per_ton, oc.confidence,
      oc.locked, oc.updated_at AS costs_updated_at,
      ob.billed_amount, ob.billed_date, ob.priority_invoice_ref
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    LEFT JOIN order_billing ob ON ob.order_id = o.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.created_at DESC
    LIMIT 500
  `).all(...params);

  // Summary totals
  const billed = rows.filter(r => r.billed_amount > 0);
  const summary = {
    total_orders: rows.length,
    billed_orders: billed.length,
    total_revenue: billed.reduce((s, r) => s + (r.billed_amount || 0), 0),
    total_cost: rows.reduce((s, r) => s + (r.total_cost || 0), 0),
    total_gross_margin: billed.reduce((s, r) => s + (r.gross_margin || 0), 0),
    total_weight_tons: rows.reduce((s, r) => s + (r.tons_delivered || r.total_weight / 1000 || 0), 0),
    avg_margin_pct: billed.length > 0
      ? billed.reduce((s, r) => s + (r.margin_pct || 0), 0) / billed.length
      : null,
  };

  res.json({ summary, orders: rows });
});

// GET /api/profitability/by-customer
router.get('/profitability/by-customer', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const { from, to } = req.query;
  let where = ['1=1'];
  const params = [];
  if (from) { where.push("o.created_at >= ?"); params.push(from); }
  if (to)   { where.push("o.created_at <= ?"); params.push(to + ' 23:59:59'); }

  const rows = db.prepare(`
    SELECT
      o.customer_id,
      c.name AS customer_name,
      COUNT(o.id) AS order_count,
      SUM(ob.billed_amount) AS total_revenue,
      SUM(oc.total_cost) AS total_cost,
      SUM(oc.gross_margin) AS total_margin,
      SUM(oc.tons_delivered) AS total_tons,
      AVG(oc.margin_pct) AS avg_margin_pct
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    LEFT JOIN order_billing ob ON ob.order_id = o.id
    WHERE ${where.join(' AND ')}
    GROUP BY o.customer_id
    ORDER BY total_revenue DESC NULLS LAST
  `).all(...params);

  res.json(rows);
});

// GET /api/steel-prices — list current steel prices
router.get('/steel-prices', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const rows = db.prepare(`
    SELECT h1.id, NULLIF(h1.diameter, 0) AS diameter, h1.price_per_ton, h1.supplier_id,
      h1.effective_date, h1.notes, h1.created_by, h1.created_at
    FROM steel_price_history h1
    WHERE h1.id = (
      SELECT h2.id FROM steel_price_history h2
      WHERE NULLIF(h2.diameter, 0) IS NULLIF(h1.diameter, 0)
      ORDER BY h2.effective_date DESC, h2.id DESC LIMIT 1
    )
    ORDER BY diameter ASC NULLS LAST
  `).all();
  res.json(rows);
});

// POST /api/steel-prices — add new steel price
router.post('/steel-prices', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
  const { diameter, price_per_ton, effective_date, notes } = req.body;
  const price = Number(price_per_ton);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'מחיר לא תקין' });
  // The history schema requires a diameter. Store the general price as zero.
  const storedDiameter = diameter == null || diameter === '' ? 0 : Number(diameter);
  if (!Number.isFinite(storedDiameter) || storedDiameter < 0) return res.status(400).json({ error: 'קוטר לא תקין' });
  const user = req.auth?.sub || null;
  const result = db.prepare(`
    INSERT INTO steel_price_history (diameter, price_per_ton, effective_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(storedDiameter, price, effective_date || new Date().toISOString().slice(0,10), notes || '', user);
  res.json({ id: result.lastInsertRowid, success: true });
});

  return router;
};

module.exports.manifest = {
  screens: [{ path: '/profitability.html', label: 'ריווחיות', roles: ['finance', 'manager', 'admin'] }],
  access: { default: 'hidden', roles: { finance: 'view', manager: 'view', admin: 'edit' } },
  id: 'finance-costs',
  label: 'עלויות ומרווח',
  consumes: [{ table: 'orders' }, { table: 'items' }, { table: 'steel_price_history' }, { table: 'order_billing' }],
  produces: [{ event: 'cost_update' }, { table: 'order_costs' }, { table: 'order_billing' }],
};
