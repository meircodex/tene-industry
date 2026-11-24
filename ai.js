// AI module – production time prediction + waste analysis
// Uses historical scan_log + items data for learning
// No external API needed – simple statistical model from DB data

let _db = null;

function init(db) { _db = db; }

// ── Production time prediction ────────────────────────────────────
// Returns: { estimatedMinutes, confidence, breakdown }
function predictProductionTime(items) {
  if (!_db) return { estimatedMinutes: 0, confidence: 0, breakdown: [] };

  const breakdown = items.map(item => {
    const avgRow = _db.prepare(`
      SELECT AVG(
        (JULIANDAY(completed_at) - JULIANDAY(started_at)) * 24 * 60
      ) as avg_min, AVG(quantity) as avg_qty, COUNT(*) as sample_count
      FROM items
      WHERE status = 'הושלם'
        AND completed_at IS NOT NULL AND started_at IS NOT NULL
        AND ABS(diameter - ?) < 1
        AND machine = ?
    `).get(item.diameter, item.machine);

    let estMinutes;
    let confidence = 0;

    if (avgRow?.avg_min && avgRow.sample_count >= 3) {
      // Scale by quantity ratio
      const qtyFactor = avgRow.avg_qty > 0 ? (item.production_qty || item.quantity) / avgRow.avg_qty : 1;
      estMinutes = avgRow.avg_min * qtyFactor;
      confidence = Math.min(avgRow.sample_count / 20, 1); // up to 100% at 20 samples
    } else {
      // Fallback: rule-based estimate
      // Base rate: ~1 min per 10 units + 0.5 min per bend
      const segs = tryParseJSON(item.segments, []);
      const bends = Array.isArray(segs) ? Math.max(0, segs.length - 1) : 0;
      const baseRate = item.diameter <= 12 ? 0.08 : item.diameter <= 20 ? 0.12 : 0.18; // min per unit
      estMinutes = (item.production_qty || item.quantity) * baseRate + bends * 0.5 + 2;
      confidence = 0.3; // low confidence for rule-based
    }

    return {
      itemId:          item.id,
      shapeName:       item.shape_name,
      diameter:        item.diameter,
      machine:         item.machine,
      quantity:        item.quantity,
      estimatedMinutes: Math.round(estMinutes * 10) / 10,
      confidence:      Math.round(confidence * 100),
    };
  });

  const totalMinutes = breakdown.reduce((s, b) => s + b.estimatedMinutes, 0);
  const avgConfidence = breakdown.length > 0
    ? breakdown.reduce((s, b) => s + b.confidence, 0) / breakdown.length
    : 0;

  return { estimatedMinutes: Math.round(totalMinutes), confidence: Math.round(avgConfidence), breakdown };
}

// ── Delivery feasibility check ────────────────────────────────────
// Returns: { feasible, estimatedCompletionTime, hoursUntilDeadline, warning }
function checkDeliveryFeasibility(order, items) {
  if (!_db || !order.delivery_date) return { feasible: true, warning: null };

  const deadline      = new Date(`${order.delivery_date}T18:00:00`);
  const now           = new Date();
  const hoursUntil    = (deadline - now) / 3600000;
  const prediction    = predictProductionTime(items);
  const estHours      = prediction.estimatedMinutes / 60;

  // Add 20% buffer for setup, QC, loading
  const estWithBuffer = estHours * 1.2;
  const feasible      = estWithBuffer < hoursUntil;

  let warning = null;
  if (!feasible) {
    warning = `הזמנה עלולה לא להספיק! צפי ייצור: ${prediction.estimatedMinutes} דק' – נשאר רק ${Math.round(hoursUntil * 60)} דק'`;
  } else if (hoursUntil < estWithBuffer * 1.5) {
    warning = `הזמנה בגבול – צפי ייצור: ${prediction.estimatedMinutes} דק'`;
  }

  return {
    feasible,
    estimatedMinutes: prediction.estimatedMinutes,
    hoursUntilDeadline: Math.round(hoursUntil * 10) / 10,
    confidence: prediction.confidence,
    warning,
  };
}

// ── Waste pattern analysis ────────────────────────────────────────
function analyzeWastePatterns() {
  if (!_db) return [];

  return _db.prepare(`
    SELECT
      machine,
      CAST(diameter AS INTEGER) as diameter,
      COUNT(*) as item_count,
      SUM(quantity) as total_ordered,
      SUM(actual_waste) as total_waste,
      ROUND(100.0 * SUM(actual_waste) / MAX(SUM(quantity), 1), 1) as waste_pct,
      AVG(
        CASE WHEN quantity > 0 THEN 100.0 * actual_waste / quantity ELSE 0 END
      ) as avg_waste_pct_per_item
    FROM items
    WHERE status = 'הושלם' AND actual_waste >= 0
    GROUP BY machine, CAST(diameter AS INTEGER)
    HAVING item_count >= 2
    ORDER BY waste_pct DESC
  `).all();
}

// ── Machine efficiency ────────────────────────────────────────────
function getMachineEfficiency(days = 7) {
  if (!_db) return [];

  const since = new Date(Date.now() - days * 86400000).toISOString();
  return _db.prepare(`
    SELECT
      machine,
      COUNT(*) as completed_items,
      SUM(quantity) as total_units,
      SUM(total_weight) as total_weight_kg,
      ROUND(AVG(
        CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL THEN
          (JULIANDAY(completed_at) - JULIANDAY(started_at)) * 24 * 60
        ELSE NULL END
      ), 1) as avg_cycle_min,
      ROUND(100.0 * SUM(actual_waste) / MAX(SUM(quantity), 1), 1) as waste_pct
    FROM items
    WHERE status = 'הושלם' AND JULIANDAY(completed_at) >= JULIANDAY(?)
    GROUP BY machine
    ORDER BY machine
  `).all(since);
}

function tryParseJSON(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = { init, predictProductionTime, checkDeliveryFeasibility, analyzeWastePatterns, getMachineEfficiency };
