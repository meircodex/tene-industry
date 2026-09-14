'use strict';

const crypto = require('crypto');
const { effectiveProductionEvidence } = require('./orderCancellation');

const FACTORY_TIME_ZONE = 'Asia/Jerusalem';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function roundKg(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function localDateParts(value, timeZone = FACTORY_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid production timestamp');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts;
}

function israelDay(value = new Date()) {
  const parts = localDateParts(value);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function validDay(value) {
  if (!ISO_DAY.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function timezoneOffsetMs(utcMillis, timeZone = FACTORY_TIME_ZONE) {
  const parts = localDateParts(new Date(utcMillis), timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMillis;
}

function localMidnightUtc(day, timeZone = FACTORY_TIME_ZONE) {
  if (!validDay(day)) throw new Error('invalid production date');
  const [year, month, date] = day.split('-').map(Number);
  const initial = Date.UTC(year, month - 1, date, 0, 0, 0);
  let result = initial - timezoneOffsetMs(initial, timeZone);
  const refinedOffset = timezoneOffsetMs(result, timeZone);
  result = initial - refinedOffset;
  return new Date(result);
}

function nextDay(day) {
  if (!validDay(day)) throw new Error('invalid production date');
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

function utcSql(value) {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

function dayRange(day) {
  const start = localMidnightUtc(day);
  const end = localMidnightUtc(nextDay(day));
  return { start: utcSql(start), end: utcSql(end) };
}

function recordActualWeightChange(db, {
  itemId,
  orderId = null,
  beforeKg,
  afterKg,
  source,
  actorId = null,
  occurredAt = new Date(),
  metadata = {},
} = {}) {
  const normalizedItemId = Number(itemId);
  const before = Number(beforeKg);
  const after = Number(afterKg);
  if (!Number.isInteger(normalizedItemId) || normalizedItemId <= 0) throw new Error('invalid production item id');
  if (!Number.isFinite(after) || after < 0 || !Number.isFinite(before) || before < 0) throw new Error('invalid actual production weight');
  if (!String(source || '').trim()) throw new Error('invalid production source');
  const delta = roundKg(after - before);
  if (delta === 0) return null;

  const timestamp = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error('invalid production timestamp');
  const event = {
    event_uid: crypto.randomUUID(),
    item_id: normalizedItemId,
    order_id: Number.isInteger(Number(orderId)) && Number(orderId) > 0 ? Number(orderId) : null,
    source: String(source).trim(),
    before_weight_kg: roundKg(before),
    after_weight_kg: roundKg(after),
    delta_weight_kg: delta,
    production_day: israelDay(timestamp),
    occurred_at: timestamp.toISOString(),
    actor_id: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
    metadata_json: JSON.stringify(metadata || {}),
  };
  db.prepare(`
    INSERT INTO production_output_events
      (event_uid,item_id,order_id,source,before_weight_kg,after_weight_kg,delta_weight_kg,production_day,occurred_at,actor_id,metadata_json)
    VALUES
      (@event_uid,@item_id,@order_id,@source,@before_weight_kg,@after_weight_kg,@delta_weight_kg,@production_day,@occurred_at,@actor_id,@metadata_json)
  `).run(event);
  return event;
}

// Raw production events remain immutable audit evidence.  When a later
// historical reconciliation corrects the physical quantity, operational
// summaries project the same proportional effective weight without changing
// those original rows.  Rows without enough item quantity evidence retain
// their measured amount rather than inventing a conversion ratio.
function effectiveEvidenceWeight(db, itemId, recordedWeightKg) {
  const grossWeightKg = roundKg(recordedWeightKg);
  const item = db.prepare(`
    SELECT i.*,p.order_id AS pallet_order_id
    FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id
    WHERE i.id=?
  `).get(itemId);
  if (!item) return { recorded_weight_kg: grossWeightKg, effective_weight_kg: grossWeightKg, corrected: false };
  const truth = effectiveProductionEvidence(db, item);
  if (!(truth.corrected_produced_qty > 0) || !(truth.recorded_produced_qty > 0)) {
    return { recorded_weight_kg: grossWeightKg, effective_weight_kg: grossWeightKg, corrected: false };
  }
  return {
    recorded_weight_kg: grossWeightKg,
    effective_weight_kg: roundKg(grossWeightKg * truth.effective_produced_qty / truth.recorded_produced_qty),
    corrected: true,
  };
}

// Canonical per-card output evidence. Aggregates must be built from these
// rows so a dashboard number can always be traced back to its cards.
function getDailyProductionActualRows(db, day = israelDay()) {
  if (!validDay(day)) throw new Error('invalid production date');
  const { start, end } = dayRange(day);
  const rows = [];
  const accountedItemIds = new Set();

  const eventRows = db.prepare(`
    SELECT e.item_id, COALESCE(i.machine, '') AS machine, COALESCE(SUM(e.delta_weight_kg), 0) AS weight_kg, COUNT(*) AS event_count
    FROM production_output_events e
    LEFT JOIN items i ON i.id=e.item_id
    WHERE e.production_day=?
    GROUP BY e.item_id, COALESCE(i.machine, '')
  `).all(day);
  for (const row of eventRows) {
    const itemId = Number(row.item_id);
    const weight = effectiveEvidenceWeight(db, itemId, row.weight_kg);
    accountedItemIds.add(itemId);
    rows.push({ item_id: itemId, machine: row.machine || '', weight_kg: weight.effective_weight_kg, recorded_weight_kg: weight.recorded_weight_kg, corrected: weight.corrected, source: 'production_event', event_count: Number(row.event_count) || 0 });
  }

  // Before the ledger existed, the only reliable measured evidence is the saved
  // card-weight snapshot. It is intentionally never replaced with planned weight.
  const legacyCardRows = db.prepare(`
    SELECT w.item_id, COALESCE(i.machine, '') AS machine, COALESCE(SUM(w.actual_weight_kg), 0) AS weight_kg, COUNT(*) AS card_count
    FROM production_card_weights w
    JOIN items i ON i.id=w.item_id
    WHERE datetime(w.updated_at) >= datetime(?) AND datetime(w.updated_at) < datetime(?)
    GROUP BY w.item_id, COALESCE(i.machine, '')
  `).all(start, end);
  for (const row of legacyCardRows) {
    const itemId = Number(row.item_id);
    if (accountedItemIds.has(itemId)) continue;
    const weight = effectiveEvidenceWeight(db, itemId, row.weight_kg);
    accountedItemIds.add(itemId);
    rows.push({ item_id: itemId, machine: row.machine || '', weight_kg: weight.effective_weight_kg, recorded_weight_kg: weight.recorded_weight_kg, corrected: weight.corrected, source: 'legacy_card_snapshot', card_count: Number(row.card_count) || 0 });
  }

  // Some old worker cards saved an item-level actual weight without individual
  // production-card entries. Count that evidence only for its completion day.
  // If no measured weight exists, a completed item is reported at its saved
  // theoretical weight. This preserves historical production reporting while
  // keeping the estimate explicit in the source breakdown.
  const completedRows = db.prepare(`
    SELECT i.id AS item_id,
           COALESCE(i.machine, '') AS machine,
           i.actual_weight_kg AS actual_weight_kg,
           COALESCE(i.total_weight, 0) AS theoretical_weight_kg
    FROM items i
    WHERE i.status IN ('הושלם', 'סופק')
      AND datetime(i.completed_at) >= datetime(?) AND datetime(i.completed_at) < datetime(?)
  `).all(start, end);
  let unweighedCompletedItems = 0;
  for (const row of completedRows) {
    const itemId = Number(row.item_id);
    if (accountedItemIds.has(itemId)) continue;
    const actualWeightKg = Number(row.actual_weight_kg);
    const theoreticalWeightKg = Number(row.theoretical_weight_kg);
    if (Number.isFinite(actualWeightKg) && actualWeightKg > 0) {
      const weight = effectiveEvidenceWeight(db, itemId, actualWeightKg);
      accountedItemIds.add(itemId);
      rows.push({ item_id: itemId, machine: row.machine || '', weight_kg: weight.effective_weight_kg, recorded_weight_kg: weight.recorded_weight_kg, corrected: weight.corrected, source: 'completed_item_actual' });
    } else if (Number.isFinite(theoreticalWeightKg) && theoreticalWeightKg > 0) {
      const weight = effectiveEvidenceWeight(db, itemId, theoreticalWeightKg);
      accountedItemIds.add(itemId);
      rows.push({ item_id: itemId, machine: row.machine || '', weight_kg: weight.effective_weight_kg, recorded_weight_kg: weight.recorded_weight_kg, corrected: weight.corrected, source: 'completed_item_theoretical' });
    } else {
      unweighedCompletedItems += 1;
    }
  }

  return {
    date: day,
    rows: rows.map(row => ({ ...row, weight_kg: roundKg(row.weight_kg) })),
    accounted_item_count: accountedItemIds.size,
    unweighed_completed_items: unweighedCompletedItems,
  };
}

function getDailyProductionActuals(db, day = israelDay()) {
  const evidence = getDailyProductionActualRows(db, day);
  const rows = evidence.rows;
  const byMachine = new Map();
  const bySource = {
    production_event_kg: 0,
    legacy_card_snapshot_kg: 0,
    completed_item_actual_kg: 0,
    completed_item_theoretical_kg: 0,
  };
  let estimatedCompletedItems = 0;
  for (const row of rows) {
    const kg = Number(row.weight_kg) || 0;
    const machine = String(row.machine || '').trim() || 'unassigned';
    byMachine.set(machine, roundKg((byMachine.get(machine) || 0) + kg));
    if (row.source === 'production_event') bySource.production_event_kg = roundKg(bySource.production_event_kg + kg);
    if (row.source === 'legacy_card_snapshot') bySource.legacy_card_snapshot_kg = roundKg(bySource.legacy_card_snapshot_kg + kg);
    if (row.source === 'completed_item_actual') bySource.completed_item_actual_kg = roundKg(bySource.completed_item_actual_kg + kg);
    if (row.source === 'completed_item_theoretical') {
      bySource.completed_item_theoretical_kg = roundKg(bySource.completed_item_theoretical_kg + kg);
      estimatedCompletedItems += 1;
    }
  }
  const actualWeightKg = roundKg(rows.reduce((sum, row) => sum + (Number(row.weight_kg) || 0), 0));
  return {
    date: evidence.date,
    actual_weight_kg: actualWeightKg,
    actual_tons: roundKg(actualWeightKg / 1000),
    item_count: evidence.accounted_item_count,
    estimated_completed_items: estimatedCompletedItems,
    unweighed_completed_items: evidence.unweighed_completed_items,
    source_breakdown: bySource,
    machines: [...byMachine.entries()].map(([machine, weight_kg]) => ({ machine, weight_kg, tons: roundKg(weight_kg / 1000) }))
      .sort((a, b) => b.weight_kg - a.weight_kg || a.machine.localeCompare(b.machine)),
  };
}

function getProductionActualSeries(db, fromDay, toDay) {
  if (!validDay(fromDay) || !validDay(toDay) || fromDay > toDay) throw new Error('invalid production date range');
  const series = [];
  let day = fromDay;
  let safety = 0;
  while (day <= toDay) {
    if (++safety > 366) throw new Error('production date range too large');
    series.push(getDailyProductionActuals(db, day));
    day = nextDay(day);
  }
  return series;
}

module.exports = {
  FACTORY_TIME_ZONE,
  israelDay,
  validDay,
  dayRange,
  recordActualWeightChange,
  getDailyProductionActualRows,
  getDailyProductionActuals,
  getProductionActualSeries,
};
