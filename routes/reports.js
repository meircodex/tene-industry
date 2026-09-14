const router = require('express').Router();
const { itemShapeMetrics, isShapeDataContractV2 } = require('../services/shapeSnapshot');
const { reportProductionTiming } = require('../services/productionTiming');
const { effectiveProductionQuantity } = require('../services/orderCancellation');

function roundMetric(value, digits = 3) {
  const numeric = Number(value) || 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function reportItemRows(db, whereSql = '1=1', params = []) {
  return db.prepare(`
    SELECT i.*,
           o.id as report_order_id,
           o.order_num as report_order_num,
           o.created_at as report_order_created_at,
           o.customer_id as report_customer_id,
           c.name as report_customer_name
    FROM items i
    LEFT JOIN pallets p ON p.id = i.pallet_id
    LEFT JOIN orders o ON o.id = COALESCE(i.order_id, p.order_id)
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${whereSql}
  `).all(...params);
}

function itemReportMetrics(item) {
  const metrics = itemShapeMetrics(item);
  return {
    quantity: metrics.quantity || 1,
    totalLengthMm: Number(metrics.totalLengthMm) || 0,
    totalWeightKg: Number(metrics.totalWeightKg) || 0,
  };
}

function sumShapeWeight(rows) {
  return roundMetric(rows.reduce((sum, row) => sum + itemReportMetrics(row).totalWeightKg, 0));
}


function reportSnapshotValue(item = {}) {
  return item.shapeSnapshot
    ?? item.shape_snapshot
    ?? item.shapeData
    ?? item.shape_data
    ?? item.shapeContract
    ?? item.shape_contract
    ?? item.shape_snapshot_json
    ?? null;
}

function itemHasShapeV2(item) {
  return isShapeDataContractV2(reportSnapshotValue(item));
}

function reportPeriod(query = {}, defaultDays = 30) {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().split('T')[0];
  const fallbackFrom = new Date(Date.now() - defaultDays * 86400000).toISOString().split('T')[0];
  const fromDate = query.from || fallbackFrom;
  const toDate = query.to || today;
  if (!isoDay.test(fromDate) || !isoDay.test(toDate)) return { error: 'invalid_date_range' };
  if (fromDate > toDate) return { error: 'invalid_date_order' };
  return { fromDate, toDate };
}

function parseReportJson(value) {
  if (!value || typeof value === 'object') return value && typeof value === 'object' ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function reportDataQuality(db, fromDate, toDate) {
  const rows = reportItemRows(db, 'DATE(o.created_at) BETWEEN ? AND ?', [fromDate, toDate]);
  const shapeV2Items = rows.filter(itemHasShapeV2).length;
  const itemsWithWeight = rows.filter(row => itemReportMetrics(row).totalWeightKg > 0).length;
  return {
    item_count: rows.length,
    shape_v2_item_count: shapeV2Items,
    items_with_weight: itemsWithWeight,
    shape_v2_coverage_pct: rows.length ? roundMetric((shapeV2Items / rows.length) * 100, 1) : 0,
    weight_coverage_pct: rows.length ? roundMetric((itemsWithWeight / rows.length) * 100, 1) : 0,
  };
}

function periodWasteRows(db, fromDate, toDate, doneStatus) {
  const rows = reportItemRows(db, 'DATE(i.completed_at) BETWEEN ? AND ? AND i.status = ?', [fromDate, toDate, doneStatus]);
  const groups = new Map();
  for (const row of rows) {
    const key = [row.machine || '', row.diameter || '', row.shape_name || ''].join('|');
    const current = groups.get(key) || {
      machine: row.machine || '',
      diameter: row.diameter || '',
      shape_name: row.shape_name || '',
      total_waste: 0,
      total_ordered: 0,
      total_length_mm: 0,
      total_weight_kg: 0,
      item_count: 0,
      shape_v2_item_count: 0,
    };
    const metrics = itemReportMetrics(row);
    current.total_waste += Number(row.actual_waste) || 0;
    current.total_ordered += Number(row.quantity) || metrics.quantity || 1;
    current.total_length_mm += metrics.totalLengthMm;
    current.total_weight_kg += metrics.totalWeightKg;
    current.item_count += 1;
    if (itemHasShapeV2(row)) current.shape_v2_item_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(row => ({
      machine: row.machine,
      diameter: row.diameter,
      shape_name: row.shape_name,
      total_waste: roundMetric(row.total_waste),
      total_ordered: roundMetric(row.total_ordered),
      waste_pct: row.total_length_mm > 0
        ? roundMetric((row.total_waste / row.total_length_mm) * 100, 1)
        : (row.total_ordered > 0 ? roundMetric((row.total_waste / row.total_ordered) * 100, 1) : 0),
      item_count: row.item_count,
      total_weight_kg: roundMetric(row.total_weight_kg),
      shape_v2_item_count: row.shape_v2_item_count,
    }))
    .sort((a, b) => b.waste_pct - a.waste_pct);
}

function machineEfficiencyByPeriod(db, fromDate, toDate, doneStatus) {
  const rows = reportItemRows(db, 'DATE(i.completed_at) BETWEEN ? AND ? AND i.status = ?', [fromDate, toDate, doneStatus]);
  const groups = new Map();
  for (const row of rows) {
    const key = row.machine || 'unassigned';
    const current = groups.get(key) || {
      machine: key,
      completed_items: 0,
      total_units: 0,
      total_weight_kg: 0,
      total_waste: 0,
      total_length_mm: 0,
      shape_v2_item_count: 0,
    };
    const metrics = itemReportMetrics(row);
    current.completed_items += 1;
    current.total_units += effectiveProductionQuantity(db, row) || 0;
    current.total_weight_kg += metrics.totalWeightKg;
    current.total_waste += Number(row.actual_waste) || 0;
    current.total_length_mm += metrics.totalLengthMm;
    if (itemHasShapeV2(row)) current.shape_v2_item_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(row => ({
      machine: row.machine,
      completed_items: row.completed_items,
      total_units: roundMetric(row.total_units),
      total_weight_kg: roundMetric(row.total_weight_kg),
      waste_pct: row.total_length_mm > 0 ? roundMetric((row.total_waste / row.total_length_mm) * 100, 1) : 0,
      avg_cycle_min: null,
      shape_v2_item_count: row.shape_v2_item_count,
    }))
    .sort((a, b) => b.total_weight_kg - a.total_weight_kg);
}

function orderWeightsById(db, orderIds) {
  const ids = [...new Set(orderIds.map(id => Number(id)).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = reportItemRows(db, `o.id IN (${placeholders})`, ids);
  const weights = new Map(ids.map(id => [id, { itemCount: 0, totalWeightKg: 0 }]));
  for (const row of rows) {
    if (!row.report_order_id) continue;
    const current = weights.get(row.report_order_id) || { itemCount: 0, totalWeightKg: 0 };
    current.itemCount += 1;
    current.totalWeightKg += itemReportMetrics(row).totalWeightKg;
    weights.set(row.report_order_id, current);
  }
  return weights;
}

function orderCreatedWeightByDate(db, fromDate, toDate) {
  const orderRows = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(total_weight), 0) as legacy_weight
    FROM orders
    WHERE DATE(created_at) BETWEEN ? AND ?
    GROUP BY DATE(created_at)
    ORDER BY date
  `).all(fromDate, toDate);
  const itemRows = reportItemRows(db, 'DATE(o.created_at) BETWEEN ? AND ?', [fromDate, toDate]);
  const byDate = new Map(orderRows.map(row => [row.date, {
    date: row.date,
    count: row.count || 0,
    weight: 0,
    itemCount: 0,
    legacyWeight: Number(row.legacy_weight) || 0,
  }]));
  for (const item of itemRows) {
    const date = String(item.report_order_created_at || '').slice(0, 10);
    if (!date) continue;
    const current = byDate.get(date) || { date, count: 0, weight: 0, itemCount: 0, legacyWeight: 0 };
    current.weight += itemReportMetrics(item).totalWeightKg;
    current.itemCount += 1;
    byDate.set(date, current);
  }
  return [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(row => ({
      date: row.date,
      count: row.count,
      weight: roundMetric(row.itemCount > 0 ? row.weight : row.legacyWeight),
      shape_v2_item_count: row.itemCount,
    }));
}

function shapeWeightForOrdersCreatedBetween(db, fromDate, toDate) {
  const rows = orderCreatedWeightByDate(db, fromDate, toDate);
  return roundMetric(rows.reduce((sum, row) => sum + (Number(row.weight) || 0), 0));
}

function dashboardOrdersCreatedInRange(db, start, end, completedStatus) {
  const orderSummary = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN status=? THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(total_weight), 0) AS legacy_weight
    FROM orders
    WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(completedStatus, start, end);
  const itemRows = reportItemRows(
    db,
    'datetime(o.created_at) >= datetime(?) AND datetime(o.created_at) < datetime(?)',
    [start, end]
  );
  return {
    count: Number(orderSummary.count) || 0,
    completedCount: Number(orderSummary.completed_count) || 0,
    totalWeight: itemRows.length > 0
      ? sumShapeWeight(itemRows)
      : roundMetric(orderSummary.legacy_weight),
  };
}

function topCustomersByShapeWeight(db, fromDate, toDate, limit = 10) {
  const legacyRows = db.prepare(`
    SELECT c.id as customer_id, c.name, COUNT(o.id) as order_count,
           COALESCE(SUM(o.billing_weight), SUM(o.total_weight), 0) as legacy_weight
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
    GROUP BY o.customer_id, c.name
  `).all(fromDate, toDate);
  const groups = new Map(legacyRows.map(row => [row.customer_id || `name:${row.name || ''}`, {
    customer_id: row.customer_id,
    name: row.name || '',
    order_count: row.order_count || 0,
    total_weight: 0,
    legacy_weight: Number(row.legacy_weight) || 0,
    shape_v2_item_count: 0,
  }]));
  const itemRows = reportItemRows(db, 'DATE(o.created_at) BETWEEN ? AND ?', [fromDate, toDate]);
  for (const item of itemRows) {
    const key = item.report_customer_id || `name:${item.report_customer_name || ''}`;
    const current = groups.get(key) || {
      customer_id: item.report_customer_id,
      name: item.report_customer_name || '',
      order_count: 0,
      total_weight: 0,
      legacy_weight: 0,
      shape_v2_item_count: 0,
    };
    current.total_weight += itemReportMetrics(item).totalWeightKg;
    current.shape_v2_item_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(row => ({
      name: row.name,
      order_count: row.order_count,
      total_weight: roundMetric(row.shape_v2_item_count > 0 ? row.total_weight : row.legacy_weight),
      shape_v2_item_count: row.shape_v2_item_count,
    }))
    .sort((a, b) => b.total_weight - a.total_weight)
    .slice(0, limit);
}

function wasteSummaryByDiameter(db, fromDate, toDate) {
  const rows = reportItemRows(db, 'DATE(o.created_at) BETWEEN ? AND ? AND i.actual_waste > 0', [fromDate, toDate]);
  const groups = new Map();
  for (const row of rows) {
    const diameter = row.diameter || '';
    const current = groups.get(diameter) || {
      diameter,
      items_produced: 0,
      net_weight: 0,
      actual_waste_g: 0,
      total_length_mm: 0,
      shape_v2_item_count: 0,
    };
    const metrics = itemReportMetrics(row);
    current.items_produced += Number(row.quantity) || metrics.quantity || 1;
    current.net_weight += metrics.totalWeightKg;
    current.actual_waste_g += Number(row.actual_waste) || 0;
    current.total_length_mm += metrics.totalLengthMm;
    current.shape_v2_item_count += 1;
    groups.set(diameter, current);
  }
  return [...groups.values()]
    .sort((a, b) => Number(a.diameter) - Number(b.diameter))
    .map(row => ({
      diameter: row.diameter,
      items_produced: row.items_produced,
      net_weight: roundMetric(row.net_weight),
      actual_waste_g: roundMetric(row.actual_waste_g),
      waste_pct: row.total_length_mm > 0 ? roundMetric((row.actual_waste_g / row.total_length_mm) * 100, 2) : 0,
      shape_v2_item_count: row.shape_v2_item_count,
    }));
}

function topWasteRows(db, fromDate, toDate) {
  return reportItemRows(db, 'DATE(o.created_at) BETWEEN ? AND ? AND i.actual_waste > 0', [fromDate, toDate])
    .map(row => ({
      order_num: row.report_order_num,
      diameter: row.diameter,
      actual_waste: row.actual_waste,
      weight: roundMetric(itemReportMetrics(row).totalWeightKg),
      shape_name: row.shape_name,
    }))
    .sort((a, b) => (Number(b.actual_waste) || 0) - (Number(a.actual_waste) || 0))
    .slice(0, 20);
}

function monthlyCustomerKpi(db, fromDate, limit = 5) {
  const revenueRows = db.prepare(`
    SELECT c.id as customer_id, c.name, COUNT(o.id) as orders,
           COALESCE(SUM(CASE WHEN o.sale_price > 0 THEN o.sale_price ELSE 0 END), 0) as revenue,
           COALESCE(SUM(o.total_weight), 0) as legacy_weight
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE DATE(o.created_at) >= ?
    GROUP BY c.id, c.name
  `).all(fromDate);
  const groups = new Map(revenueRows.map(row => [row.customer_id, {
    customer_id: row.customer_id,
    name: row.name,
    orders: row.orders || 0,
    revenue: Number(row.revenue) || 0,
    total_weight_kg: 0,
    legacy_weight: Number(row.legacy_weight) || 0,
    shape_v2_item_count: 0,
  }]));
  const itemRows = reportItemRows(db, 'DATE(o.created_at) >= ?', [fromDate]);
  for (const item of itemRows) {
    const key = item.report_customer_id;
    if (!key) continue;
    const current = groups.get(key) || {
      customer_id: key,
      name: item.report_customer_name || '',
      orders: 0,
      revenue: 0,
      total_weight_kg: 0,
      legacy_weight: 0,
      shape_v2_item_count: 0,
    };
    current.total_weight_kg += itemReportMetrics(item).totalWeightKg;
    current.shape_v2_item_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(row => ({
      name: row.name,
      orders: row.orders,
      total_weight_kg: roundMetric(row.shape_v2_item_count > 0 ? row.total_weight_kg : row.legacy_weight),
      revenue: roundMetric(row.revenue, 2),
      shape_v2_item_count: row.shape_v2_item_count,
    }))
    .sort((a, b) => b.total_weight_kg - a.total_weight_kg)
    .slice(0, limit);
}

function required(name, value) {
  if (!value) throw new Error(`routes/reports missing dependency: ${name}`);
  return value;
}

module.exports = function createReportsRouter(deps) {
  const db = required('db', deps.db);
  const requireRole = required('requireRole', deps.requireRole);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const statusContracts = required('statusContracts', deps.statusContracts);
  const productionActuals = required('productionActuals', deps.productionActuals);

  function parsedSegments(value) {
    if (!value) return [];
    try {
      const segments = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(segments)) return [];
      return segments.map(segment => {
        const lengthMm = Number(segment?.length_mm ?? segment?.lengthMm ?? segment?.length);
        const angleDeg = Number(segment?.angle_deg ?? segment?.angleDeg ?? segment?.angle);
        return {
          length_mm: Number.isFinite(lengthMm) && lengthMm > 0 ? roundMetric(lengthMm) : null,
          angle_deg: Number.isFinite(angleDeg) ? roundMetric(angleDeg) : null,
        };
      }).filter(segment => segment.length_mm !== null || segment.angle_deg !== null);
    } catch {
      return [];
    }
  }

  function dashboardCardDto(item, outputEvidence = null) {
    const metrics = itemReportMetrics(item);
    const theoreticalWeightKg = Number(metrics.totalWeightKg);
    const hasTheoreticalWeight = Number.isFinite(theoreticalWeightKg) && theoreticalWeightKg > 0;
    const outputKg = outputEvidence && Number.isFinite(Number(outputEvidence.weight_kg))
      ? roundMetric(outputEvidence.weight_kg)
      : null;
    const actualWeightKg = Number(item.actual_weight_kg);
    const fallbackWeightKg = Number.isFinite(actualWeightKg) && actualWeightKg >= 0
      ? roundMetric(actualWeightKg)
      : hasTheoreticalWeight ? roundMetric(theoreticalWeightKg) : null;
    return {
      kind: 'card',
      item_id: Number(item.id),
      order_id: Number(item.report_order_id) || null,
      order_num: item.report_order_num || 'ללא הזמנה',
      customer_name: item.report_customer_name || null,
      order_status: item.order_status || null,
      status: item.status || null,
      shape_name: item.shape_name || item.shape_id || 'פריט ייצור',
      diameter_mm: Number(item.diameter) || null,
      quantity: metrics.quantity,
      produced_quantity: effectiveProductionQuantity(db, item),
      total_length_mm: Number.isFinite(Number(metrics.totalLengthMm)) && Number(metrics.totalLengthMm) > 0 ? roundMetric(metrics.totalLengthMm) : null,
      theoretical_weight_kg: hasTheoreticalWeight ? roundMetric(theoreticalWeightKg) : null,
      display_weight_kg: outputKg ?? fallbackWeightKg,
      weight_source: outputEvidence?.source || (Number.isFinite(actualWeightKg) && actualWeightKg >= 0 ? 'current_item_actual' : hasTheoreticalWeight ? 'theoretical' : null),
      actual_waste: Number.isFinite(Number(item.actual_waste)) ? roundMetric(item.actual_waste) : null,
      machine: item.machine || null,
      completed_at: item.completed_at || null,
      geometry: parsedSegments(item.segments),
      order_url: Number(item.report_order_id) > 0 ? `/orders.html?id=${Number(item.report_order_id)}` : null,
    };
  }

  function dashboardOrderDto(order) {
    return {
      kind: 'order',
      order_id: Number(order.id),
      order_num: order.order_num || `#${order.id}`,
      customer_name: order.customer_name || null,
      status: order.status || null,
      priority: order.priority || null,
      delivery_date: order.delivery_date || null,
      display_weight_kg: Number.isFinite(Number(order.billing_weight)) && Number(order.billing_weight) > 0
        ? roundMetric(order.billing_weight)
        : Number.isFinite(Number(order.total_weight)) ? roundMetric(order.total_weight) : null,
    };
  }

  function dashboardCardSummary(cards) {
    return {
      card_count: cards.length,
      quantity: roundMetric(cards.reduce((sum, card) => sum + (Number(card.quantity) || 0), 0)),
      displayed_weight_kg: roundMetric(cards.reduce((sum, card) => sum + (Number(card.display_weight_kg) || 0), 0)),
      theoretical_weight_kg: roundMetric(cards.reduce((sum, card) => sum + (Number(card.theoretical_weight_kg) || 0), 0)),
    };
  }

  function dashboardOrders(whereSql, params = []) {
    return db.prepare(`
      SELECT o.*, c.name AS customer_name
      FROM orders o
      LEFT JOIN customers c ON c.id=o.customer_id
      WHERE ${whereSql}
      ORDER BY o.delivery_date ASC, o.created_at DESC, o.id DESC
      LIMIT 250
    `).all(...params);
  }

  function dashboardCards(whereSql, params = []) {
    return reportItemRows(db, whereSql, params)
      .map(item => dashboardCardDto(item))
      .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')) || b.item_id - a.item_id);
  }

  router.get('/dashboard/drilldown', requireRole('viewer'), (req, res) => {
    const metric = String(req.query.metric || '').trim();
    const today = productionActuals.israelDay();
    const todayRange = productionActuals.dayRange(today);
    const doneStatus = statusContracts.ITEM_STATUS.DONE;
    const queueOrderStatuses = [
      statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION,
      statusContracts.ORDER_STATUS.PRODUCTION_QUEUE,
      statusContracts.ORDER_STATUS.IN_PRODUCTION,
    ];
    const response = (title, subtitle, entries, summary = {}) => res.json({
      metric,
      title,
      subtitle,
      entries,
      summary,
    });

    if (metric === 'produced_today') {
      const evidence = productionActuals.getDailyProductionActualRows(db, today);
      const evidenceByItem = new Map(evidence.rows.map(row => [Number(row.item_id), row]));
      const ids = [...evidenceByItem.keys()].filter(id => Number.isInteger(id) && id > 0);
      const itemsById = new Map(ids.length
        ? reportItemRows(db, `i.id IN (${ids.map(() => '?').join(',')})`, ids).map(item => [Number(item.id), item])
        : []);
      const cards = evidence.rows.map(row => itemsById.get(Number(row.item_id)))
        .filter(Boolean)
        .map(item => dashboardCardDto(item, evidenceByItem.get(Number(item.id))));
      return response('יוצר בפועל היום', 'כל משקל מגיע מרישום ייצור, משקל כרטיס שמור או משקל תאורטי מסומן.', cards, {
        ...dashboardCardSummary(cards),
        ledger_weight_kg: roundMetric(evidence.rows.reduce((sum, row) => sum + (Number(row.weight_kg) || 0), 0)),
        unresolved_evidence_count: evidence.rows.length - cards.length,
        unweighed_completed_items: evidence.unweighed_completed_items,
      });
    }

    if (metric === 'done_today') {
      const cards = dashboardCards('datetime(i.completed_at) >= datetime(?) AND datetime(i.completed_at) < datetime(?) AND i.status=?', [todayRange.start, todayRange.end, doneStatus]);
      return response('כרטיסים שהושלמו היום', 'כרטיסים שהושלמו היום; כרטיס ללא משקל מסומן כך ואינו מקבל משקל מומצא.', cards, dashboardCardSummary(cards));
    }

    if (metric === 'in_production') {
      const cards = dashboardCards('i.status=?', [statusContracts.ITEM_STATUS.IN_PRODUCTION]);
      return response('כרטיסים בייצור כעת', 'מצב הכרטיסים הפעילים לפי מקור הנתונים של תור הייצור.', cards, dashboardCardSummary(cards));
    }

    if (metric === 'queue') {
      const cards = dashboardCards(`i.status IN ('ממתין','בייצור') AND o.status IN (${queueOrderStatuses.map(() => '?').join(',')})`, queueOrderStatuses);
      return response('כרטיסיות בתור הייצור', 'כל כרטיס ניתן לפתיחה לפרטי צורה, כמות, משקל והזמנה.', cards, dashboardCardSummary(cards));
    }

    if (metric === 'waste_today') {
      const cards = dashboardCards('datetime(i.completed_at) >= datetime(?) AND datetime(i.completed_at) < datetime(?) AND i.status=? AND COALESCE(i.actual_waste,0)>0', [todayRange.start, todayRange.end, doneStatus]);
      return response('כרטיסים עם פחת היום', 'פחת שמור בפועל בכרטיס; אין חישוב או הערכה חדשה במסך הפירוט.', cards, {
        ...dashboardCardSummary(cards),
        actual_waste: roundMetric(cards.reduce((sum, card) => sum + (Number(card.actual_waste) || 0), 0)),
      });
    }

    if (metric === 'shortage') {
      const diameter = Number(req.query.diameter);
      if (!Number.isFinite(diameter) || diameter <= 0 || diameter > 200) return res.status(400).json({ error: 'invalid_shortage_diameter' });
      const cards = dashboardCards(`i.diameter=? AND i.status IN ('ממתין','בייצור') AND o.status IN (${queueOrderStatuses.map(() => '?').join(',')})`, [diameter, ...queueOrderStatuses]);
      return response(`כרטיסים מושפעים מחוסר Ø${diameter}`, 'אלה הכרטיסים הפעילים בקוטר שנבחר; מצב המלאי עצמו נשאר במודול המלאי.', cards, dashboardCardSummary(cards));
    }

    if (metric === 'pending_approval') {
      const orders = dashboardOrders('o.status=?', [statusContracts.ORDER_STATUS.PENDING_APPROVAL]).map(dashboardOrderDto);
      return response('הזמנות ממתינות לאישור', 'לחיצה על הזמנה מציגה את הכרטיסים והפריטים שבה.', orders, { order_count: orders.length });
    }

    if (metric === 'urgent_open') {
      const orders = dashboardOrders('o.priority=? AND o.status NOT IN (?,?)', ['דחוף', statusContracts.ORDER_STATUS.DELIVERED_CONFIRMED, statusContracts.ORDER_STATUS.CANCELLED]).map(dashboardOrderDto);
      return response('הזמנות דחופות פתוחות', 'לחיצה על הזמנה מציגה את הכרטיסים והפריטים שבה.', orders, { order_count: orders.length });
    }

    if (metric === 'deliveries_today') {
      const orders = dashboardOrders('DATE(o.delivery_date)=?', [today]).map(dashboardOrderDto);
      return response('אספקות היום', 'לחיצה על הזמנה מציגה את הכרטיסים והפריטים שמרכיבים אותה.', orders, { order_count: orders.length, displayed_weight_kg: roundMetric(orders.reduce((sum, order) => sum + (Number(order.display_weight_kg) || 0), 0)) });
    }

    if (metric === 'order') {
      const orderId = Number(req.query.order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
      const order = dashboardOrders('o.id=?', [orderId])[0];
      if (!order) return res.status(404).json({ error: 'order_not_found' });
      const cards = dashboardCards('COALESCE(i.order_id,p.order_id)=?', [orderId]);
      return response(`הזמנה ${order.order_num || `#${order.id}`}`, 'לחיצה על כרטיס מציגה את כל הנתונים השמורים שלו.', cards, { ...dashboardCardSummary(cards), order: dashboardOrderDto(order) });
    }

    if (metric === 'card') {
      const itemId = Number(req.query.item_id);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'invalid_item_id' });
      const item = reportItemRows(db, 'i.id=?', [itemId])[0];
      if (!item) return res.status(404).json({ error: 'item_not_found' });
      return response(`כרטיס ${item.id}`, 'פרטי הכרטיס נשמרים כפי שהם; ניתן לפתוח גם את ההזמנה המלאה.', [dashboardCardDto(item)], dashboardCardSummary([dashboardCardDto(item)]));
    }

    return res.status(400).json({ error: 'invalid_dashboard_drilldown_metric' });
  });

  router.get('/dashboard', requireRole('viewer'), (req, res) => {
    const today = productionActuals.israelDay();
    const todayRange = productionActuals.dayRange(today);
    const productionActual = productionActuals.getDailyProductionActuals(db, today);
    const doneItemStatus = statusContracts.ITEM_STATUS.DONE;
    const completedOrderStatus = statusContracts.ORDER_STATUS.DONE_WAITING_PICKUP;
    const ordersCreatedToday = dashboardOrdersCreatedInRange(
      db,
      todayRange.start,
      todayRange.end,
      completedOrderStatus
    );
    const wasteData = db.prepare(`
      SELECT SUM(actual_waste) as totalWaste, SUM(quantity) as totalQty,
             COUNT(*) as completedItems
      FROM items
      WHERE datetime(completed_at) >= datetime(?) AND datetime(completed_at) < datetime(?) AND status=?
    `).get(todayRange.start, todayRange.end, doneItemStatus);

    const completedItemsToday = db.prepare(`
      SELECT * FROM items
      WHERE datetime(completed_at) >= datetime(?) AND datetime(completed_at) < datetime(?) AND status=?
    `).all(todayRange.start, todayRange.end, doneItemStatus);
    const producedWeightToday = productionActual.actual_weight_kg;
    const productionToday = {
      completedItems: completedItemsToday.length,
      producedWeightToday,
      producedTonsToday: producedWeightToday / 1000,
    };

    const wasteByMachine = db.prepare(`
      SELECT i.machine, SUM(i.actual_waste) as waste, SUM(i.quantity) as qty
      FROM items i
      WHERE datetime(i.completed_at) >= datetime(?) AND datetime(i.completed_at) < datetime(?) AND i.status=?
      GROUP BY i.machine
    `).all(todayRange.start, todayRange.end, doneItemStatus);

    res.json({
      ordersToday:      ordersCreatedToday.count,
      completedOrdersToday: ordersCreatedToday.completedCount,
      completedToday:   productionToday.completedItems || 0,
      inProduction:     db.prepare("SELECT COUNT(*) as c FROM orders WHERE status=?").get(statusContracts.ORDER_STATUS.IN_PRODUCTION).c,
      pending:          db.prepare("SELECT COUNT(*) as c FROM orders WHERE status=?").get(statusContracts.ORDER_STATUS.PENDING_APPROVAL).c,
      portalAwaitingCustomerApproval: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status=? AND portal_order=1").get(statusContracts.ORDER_STATUS.CUSTOMER_PENDING_APPROVAL).c,
      urgentOpen:       db.prepare("SELECT COUNT(*) as c FROM orders WHERE priority='דחוף' AND status NOT IN (?,?)").get(statusContracts.ORDER_STATUS.DELIVERED_CONFIRMED, statusContracts.ORDER_STATUS.CANCELLED).c,
      totalWeightToday: ordersCreatedToday.totalWeight,
      producedWeightToday: productionToday.producedWeightToday || 0,
      producedTonsToday: Math.round((productionToday.producedTonsToday || 0) * 10) / 10,
      productionActualDate: today,
      productionActualSources: productionActual.source_breakdown,
      estimatedCompletedItems: productionActual.estimated_completed_items,
      unweighedCompletedItems: productionActual.unweighed_completed_items,
      itemsInProduction:db.prepare("SELECT COUNT(*) as c FROM items WHERE status=?").get(statusContracts.ITEM_STATUS.IN_PRODUCTION).c,
      itemsDone:        productionToday.completedItems || 0,
      wasteAvgPct:      wasteData.totalQty > 0 ? ((wasteData.totalWaste / wasteData.totalQty) * 100).toFixed(1) : '0',
      wasteByMachine,
      recentOrders:     db.prepare(`SELECT o.*,c.name as customer_name FROM orders o LEFT JOIN customers c ON o.customer_id=c.id ORDER BY o.created_at DESC LIMIT 10`).all(),
      machines:         db.prepare('SELECT * FROM machines ORDER BY id').all(),
    });
  });



  router.get('/reports/summary', requireAnyRole(['office', 'finance', 'manager', 'admin']), (req, res) => {
    const period = reportPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const { fromDate, toDate } = period;
    const doneItemStatus = statusContracts.ITEM_STATUS.DONE;

    res.json({
      period: { from: fromDate, to: toDate },
      dataQuality: reportDataQuality(db, fromDate, toDate),
      orders: orderCreatedWeightByDate(db, fromDate, toDate),
      production: productionActuals.getProductionActualSeries(db, fromDate, toDate),
      byStatus: db.prepare(`
        SELECT status, COUNT(*) as count FROM orders
        WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY status
      `).all(fromDate, toDate),
      waste: periodWasteRows(db, fromDate, toDate, doneItemStatus),
      machineEfficiency: machineEfficiencyByPeriod(db, fromDate, toDate, doneItemStatus),
      topCustomers: topCustomersByShapeWeight(db, fromDate, toDate),
    });
  });

  // Timing is a separate, read-only projection.  Keeping it out of the
  // summary payload lets the dashboard stay fast while the timing report can
  // include the per-card timeline, recipe metrics and card-to-card gaps.
  router.get('/reports/production-timing', requireAnyRole(['office', 'finance', 'manager', 'admin']), (req, res) => {
    const period = reportPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    try {
      return res.json(reportProductionTiming(db, period));
    } catch (error) {
      return res.status(400).json({ error: error.message === 'invalid production date range' ? 'invalid_date_range' : 'production_timing_unavailable' });
    }
  });

  router.get('/reports/worker-card-activity', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const period = reportPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const workerIdText = String(req.query.worker_id || '').trim();
    const workerId = workerIdText ? Number(workerIdText) : null;
    if (workerIdText && (!Number.isInteger(workerId) || workerId <= 0)) return res.status(400).json({ error: 'invalid_worker_id' });
    const params = [period.fromDate, period.toDate];
    const where = ['DATE(a.occurred_at) BETWEEN ? AND ?'];
    if (workerId) {
      where.push('a.actor_user_id=?');
      params.push(workerId);
    }
    const whereSql = where.join(' AND ');
    const rows = db.prepare(`
      SELECT a.id,a.item_id,a.order_id,a.order_num,a.card_token,a.action,a.actor_user_id,
             COALESCE(NULLIF(a.actor_name,''),u.display_name,u.username,'לא ידוע') AS actor_name,
             a.device_enrollment_id,a.device_name,a.details_json,a.occurred_at,
             i.shape_name,i.diameter
      FROM worker_card_activity a
      LEFT JOIN users u ON u.id=a.actor_user_id
      LEFT JOIN items i ON i.id=a.item_id
      WHERE ${whereSql}
      ORDER BY datetime(a.occurred_at) DESC, a.id DESC
      LIMIT 500
    `).all(...params).map(row => ({ ...row, details: parseReportJson(row.details_json) }));
    const workers = db.prepare(`
      SELECT a.actor_user_id AS id,COALESCE(NULLIF(a.actor_name,''),u.display_name,u.username,'לא ידוע') AS name,
             COUNT(*) AS activity_count
      FROM worker_card_activity a
      LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE DATE(a.occurred_at) BETWEEN ? AND ?
      GROUP BY a.actor_user_id,name
      ORDER BY name COLLATE NOCASE
    `).all(period.fromDate, period.toDate);
    res.json({ period: { from: period.fromDate, to: period.toDate }, rows, workers });
  });


  router.get('/reports/waste', requireAnyRole(['production', 'office', 'finance', 'manager', 'admin']), (req, res) => {
    const period = reportPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const { fromDate, toDate } = period;
    res.json(periodWasteRows(db, fromDate, toDate, statusContracts.ITEM_STATUS.DONE));
  });

  router.get('/waste/summary', requireAnyRole(['production', 'office', 'finance', 'manager', 'admin']), (req, res) => {
    const period = reportPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const { fromDate, toDate } = period;
    res.json({
      period: { from: fromDate, to: toDate },
      dataQuality: reportDataQuality(db, fromDate, toDate),
      byDiameter: wasteSummaryByDiameter(db, fromDate, toDate),
      topWaste: topWasteRows(db, fromDate, toDate),
      rawMaterial: db.prepare('SELECT diameter,SUM(weight_scrapped) as total_scrapped,SUM(weight_received) as total_received,ROUND(100.0*SUM(weight_scrapped)/NULLIF(SUM(weight_received),0),1) as scrap_pct FROM raw_material GROUP BY diameter ORDER BY diameter').all(),
    });
  });


  router.get('/kpi/monthly', requireAnyRole(['office', 'finance', 'manager', 'admin']), (req, res) => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().slice(0,10);
    const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0,10);

    const cur = db.prepare(`
      SELECT
        COUNT(DISTINCT o.id) as order_count,
        0 as total_weight_kg,
        COALESCE(SUM(CASE WHEN o.sale_price>0 THEN o.sale_price ELSE 0 END),0) as revenue,
        COALESCE(SUM(CASE WHEN o.cost_material>0 THEN o.cost_material ELSE 0 END),0) as cost_material,
        COALESCE(SUM(CASE WHEN o.cost_labor>0 THEN o.cost_labor ELSE 0 END),0) as cost_labor,
        SUM(CASE WHEN o.status=? OR o.status=? THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN o.status=? THEN 1 ELSE 0 END) as in_production,
        SUM(CASE WHEN o.status=? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN o.priority=? AND o.status NOT IN (?,?) THEN 1 ELSE 0 END) as urgent_open
      FROM orders o
      WHERE DATE(o.created_at) >= ?
    `).get(
      statusContracts.ORDER_STATUS.DONE_WAITING_PICKUP,
      statusContracts.ORDER_STATUS.DELIVERED_CONFIRMED,
      statusContracts.ORDER_STATUS.IN_PRODUCTION,
      statusContracts.ORDER_STATUS.PENDING_APPROVAL,
      '\u05d3\u05d7\u05d5\u05e3',
      statusContracts.ORDER_STATUS.DONE_WAITING_PICKUP,
      statusContracts.ORDER_STATUS.DELIVERED_CONFIRMED,
      monthStart
    );

    const prev = db.prepare(`
      SELECT
        COUNT(DISTINCT o.id) as order_count,
        0 as total_weight_kg,
        COALESCE(SUM(CASE WHEN o.sale_price>0 THEN o.sale_price ELSE 0 END),0) as revenue
      FROM orders o
      WHERE DATE(o.created_at) BETWEEN ? AND ?
    `).get(prevMonthStart, prevMonthEnd);

    cur.total_weight_kg = shapeWeightForOrdersCreatedBetween(db, monthStart, new Date().toISOString().slice(0, 10));
    prev.total_weight_kg = shapeWeightForOrdersCreatedBetween(db, prevMonthStart, prevMonthEnd);

    const topCustomers = monthlyCustomerKpi(db, monthStart);

    const tonsMonth = (cur.total_weight_kg || 0) / 1000;
    const revenue   = cur.revenue || 0;
    const cost      = (cur.cost_material || 0) + (cur.cost_labor || 0);
    const margin    = revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : null;

    res.json({
      month: now.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
      current: { ...cur, tons: Math.round(tonsMonth * 10) / 10, revenue, cost, margin },
      prev: { ...prev, tons: Math.round((prev.total_weight_kg||0) / 100) / 10 },
      topCustomers,
      dataQuality: reportDataQuality(db, monthStart, new Date().toISOString().slice(0, 10))
    });
  });



  function toCSV(rows, cols) {
    const header = cols.map(c => c.label).join(',');
    const lines = rows.map(r => cols.map(c => {
      const v = r[c.key] ?? '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    }).join(','));
    return '﻿' + [header, ...lines].join('\r\n'); // BOM for Hebrew Excel
  }

  router.get('/export/orders', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT o.id, o.order_num, c.name as customer, o.delivery_date, o.status, o.total_weight,
             o.priority, o.channel, o.created_at
      FROM orders o LEFT JOIN customers c ON o.customer_id=c.id
      ORDER BY o.created_at DESC LIMIT 5000
    `).all();
    const weights = orderWeightsById(db, rows.map(row => row.id));
    for (const row of rows) {
      const shapeWeight = weights.get(row.id);
      if (shapeWeight && shapeWeight.itemCount > 0) row.total_weight = roundMetric(shapeWeight.totalWeightKg);
      delete row.id;
    }
    const cols = [
      { key:'order_num',    label:'מספר הזמנה' },
      { key:'customer',     label:'לקוח' },
      { key:'delivery_date',label:'תאריך אספקה' },
      { key:'status',       label:'סטטוס' },
      { key:'total_weight', label:'משקל (ק"ג)' },
      { key:'priority',     label:'עדיפות' },
      { key:'channel',      label:'ערוץ' },
      { key:'created_at',   label:'נוצרה' },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(toCSV(rows, cols));
  });

  router.get('/export/packages', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT pk.package_code, pk.order_num, pk.status, pk.weight, pk.diameter, pk.zone, pk.packed_at, pk.shipped_at
      FROM packages pk ORDER BY pk.packed_at DESC LIMIT 5000
    `).all();
    const cols = [
      { key:'package_code', label:'קוד חבילה' },
      { key:'order_num',    label:'מספר הזמנה' },
      { key:'status',       label:'סטטוס' },
      { key:'weight',       label:'משקל (ק"ג)' },
      { key:'diameter',     label:'קוטר' },
      { key:'zone',         label:'אזור מחסן' },
      { key:'packed_at',    label:'תאריך אריזה' },
      { key:'shipped_at',   label:'תאריך משלוח' },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="packages.csv"');
    res.send(toCSV(rows, cols));
  });

  router.get('/export/inventory', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT r.material_type, r.diameter, s.name as supplier, r.lot_number, r.certificate_num,
             r.grade, r.received_date, r.weight_received, r.weight_used, r.warehouse_loc
      FROM raw_material r LEFT JOIN suppliers s ON r.supplier_id=s.id
      ORDER BY r.received_date DESC LIMIT 5000
    `).all();
    const cols = [
      { key:'material_type',   label:'סוג חומר' },
      { key:'diameter',        label:'קוטר (mm)' },
      { key:'supplier',        label:'ספק' },
      { key:'lot_number',      label:'מספר אצווה' },
      { key:'certificate_num', label:'תעודת חומר' },
      { key:'grade',           label:'איכות פלדה' },
      { key:'received_date',   label:'תאריך קבלה' },
      { key:'weight_received', label:'משקל שהתקבל (ק"ג)' },
      { key:'weight_used',     label:'משקל שנצרך (ק"ג)' },
      { key:'warehouse_loc',   label:'מיקום במחסן' },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(toCSV(rows, cols));
  });



  // Convert parsed BVBS data to an IronBend order


  return router;
};

module.exports.manifest = {
  id: 'reports',
  label: 'דוחות',
  screens: [
    { id: 'reports',  path: '/reports.html',  label: 'דוחות',    icon: '📈', group: 'בקרה' },
    { id: 'warroom',  path: '/warroom.html',   label: 'War Room', icon: '🚨', group: 'בקרה' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', finance: 'read', quality: 'read', maintenance: 'read' },
  },
  consumes: [{ table: 'orders' }, { table: 'items' }, { table: 'invoices' }],
  produces: [],
};
