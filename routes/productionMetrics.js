const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/productionMetrics missing dependency: ${name}`);
  return value;
}

module.exports = function createProductionMetricsRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireRole = required('requireRole', deps.requireRole);
  const statusContracts = required('statusContracts', deps.statusContracts);
  const productionActuals = required('productionActuals', deps.productionActuals);

  function selectedDay(req, res) {
    const day = String(req.query?.date ?? productionActuals.israelDay()).trim();
    if (!productionActuals.validDay(day)) {
      res.status(400).json({ error: 'invalid_production_date' });
      return null;
    }
    return day;
  }

  router.get('/kpi/tons-today', requireRole('viewer'), (req, res) => {
    const day = selectedDay(req, res);
    if (!day) return;
    const actual = productionActuals.getDailyProductionActuals(db, day);
    res.json({
      tons: Math.round((actual.actual_tons || 0) * 10) / 10,
      actual_weight_kg: actual.actual_weight_kg,
      item_count: actual.item_count,
      estimated_completed_items: actual.estimated_completed_items,
      unweighed_completed_items: actual.unweighed_completed_items,
      source_breakdown: actual.source_breakdown,
      date: day,
    });
  });

  router.get('/machines/oee', requireAnyRole(['production', 'maintenance', 'manager', 'admin']), (req, res) => {
    const today = selectedDay(req, res);
    if (!today) return;
    const actualByMachine = new Map(productionActuals.getDailyProductionActuals(db, today).machines.map(row => [row.machine, row]));
    const machines = db.prepare('SELECT * FROM machines WHERE retired_at IS NULL').all();
    const result = machines.map(m => {
      const stopMins = db.prepare(
        `SELECT COALESCE(SUM(duration_min),0) as mins FROM machine_stops WHERE machine_id=? AND DATE(started_at)=?`
      ).get(m.id, today).mins;

      // Performance: produced pieces vs. theoretical (rough estimate)
      const pieces = db.prepare(
        `SELECT COALESCE(SUM(quantity),0) as q FROM items WHERE machine=? AND DATE(completed_at)=?`
      ).get(m.name, today).q;

      // Prefer measured output; completed items without a measurement use their
      // saved theoretical weight and are exposed separately as estimates.
      const tonsToday = Number(actualByMachine.get(m.name)?.tons) || 0;

      // OEE requires a planned calendar, ideal cycle standard and machine-specific
      // quality data. A constant performance factor must never imply 100% OEE.
      return { ...m, availability:null, quality:null, oee:null,
        measurement_status:'insufficient_data', measurement_reason:'חסרים זמני תקן ותוכנית עבודה לחישוב OEE',
        pieces_today:pieces, tons_today:tonsToday, downtime_min:stopMins };
    });
    res.json(result);
  });

  router.get('/kpi/shift-summary', requireAnyRole(['production', 'office', 'manager', 'admin']), (req, res) => {
    const today = selectedDay(req, res);
    if (!today) return;
    const now = new Date();
    const h = now.getHours();
    let shiftType = h >= 6 && h < 14 ? 'morning' : h >= 14 && h < 22 ? 'afternoon' : 'night';

    const activeShifts = db.prepare(`
      SELECT s.*, u.display_name as operator_name, m.name as machine_name
      FROM shifts s
      LEFT JOIN users u ON s.operator_id = u.id
      LEFT JOIN machines m ON s.machine_id = m.id
      WHERE s.date = ? AND s.ended_at IS NULL
    `).all(today);

    const itemsInProd = db.prepare(`
      SELECT i.id, i.diameter, i.quantity, i.produced_qty,
        COALESCE(i.total_weight, 0) as weight, i.status, i.machine,
        o.order_num,
        c.name as customer_name,
        COALESCE(m.name, i.machine) as machine_name
      FROM items i
      LEFT JOIN pallets p ON i.pallet_id = p.id
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN machines m ON i.machine_id = m.id
      WHERE i.status IN (?,?)
      ORDER BY i.started_at DESC
      LIMIT 20
    `).all(statusContracts.ITEM_STATUS.IN_PRODUCTION, statusContracts.ITEM_STATUS.WAITING);

    const todayActual = productionActuals.getDailyProductionActuals(db, today);

    const stops = db.prepare(`
      SELECT ms.*, dr.label as reason_label, m.name as machine_name
      FROM machine_stops ms
      LEFT JOIN downtime_reasons dr ON ms.reason_code = dr.code
      LEFT JOIN machines m ON ms.machine_id = m.id
      WHERE DATE(ms.started_at) = ? AND ms.ended_at IS NULL
    `).all(today);

    res.json({
      shiftType,
      activeShifts,
      itemsInProd,
      todayTons: Math.round((todayActual.actual_tons || 0) * 10) / 10,
      todayActualWeightKg: todayActual.actual_weight_kg,
      estimatedCompletedItems: todayActual.estimated_completed_items,
      unweighedCompletedItems: todayActual.unweighed_completed_items,
      activeStops: stops
    });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "production-metrics",
  "label": "Production Metrics",
  "consumes": [
    {
      "table": "machines"
    },
    {
      "table": "production_logs"
    }
  ],
  "produces": []
};
