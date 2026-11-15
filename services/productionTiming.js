'use strict';

// Read-only production timing projection.  The source of truth remains the
// production item timestamps and the canonical shape snapshot stored on each
// item; this service never changes an order, a card, or an item state.

const crypto = require('node:crypto');
const FACTORY_TIME_ZONE = 'Asia/Jerusalem';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WORK_START_MINUTE = 7 * 60;
const WORK_END_MINUTE = 18 * 60;
const LUNCH_START_MINUTE = 12 * 60;
const LUNCH_END_MINUTE = 12 * 60 + 45;
const factoryTimeCache = new Map();

function round(value, digits = 3) {
  const numeric = Number(value) || 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value || '').trim();
  if (!raw) return null;
  // SQLite CURRENT_TIMESTAMP is stored as UTC without its trailing Z.
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localParts(value, timeZone = FACTORY_TIME_ZONE) {
  const date = asDate(value);
  if (!date) return null;
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return values;
}

function israelDay(value) {
  const parts = localParts(value);
  if (!parts) return null;
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function validDay(value) {
  if (!ISO_DAY.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nextDay(day) {
  if (!validDay(day)) throw new Error('invalid production date');
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

function factoryLocalTimeUtc(day, minuteOfDay, timeZone = FACTORY_TIME_ZONE) {
  if (!validDay(day)) throw new Error('invalid production date');
  const cacheKey = `${timeZone}|${day}|${minuteOfDay}`;
  if(factoryTimeCache.has(cacheKey)) return new Date(factoryTimeCache.get(cacheKey));
  const [year, month, date] = day.split('-').map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wantedUtcLike = Date.UTC(year, month - 1, date, hour, minute, 0);
  let result = wantedUtcLike;
  // Two passes handle the Israeli daylight-saving offset at the target time.
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(result), timeZone);
    const actualUtcLike = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second || 0);
    result += wantedUtcLike - actualUtcLike;
  }
  if(factoryTimeCache.size >= 2048) factoryTimeCache.clear();
  factoryTimeCache.set(cacheKey,result);
  return new Date(result);
}

function overlapMinutes(start, end, otherStart, otherEnd) {
  const a = Math.max(start.getTime(), otherStart.getTime());
  const b = Math.min(end.getTime(), otherEnd.getTime());
  return b > a ? (b - a) / 60000 : 0;
}

function daySequence(start, end) {
  const first = israelDay(start);
  const last = israelDay(new Date(Math.max(start.getTime(), end.getTime() - 1)));
  if (!first || !last) return [];
  const days = [];
  let day = first;
  let safety = 0;
  while (day <= last) {
    if (++safety > 370) throw new Error('production timing range too large');
    days.push(day);
    day = nextDay(day);
  }
  return days;
}

function lunchIntervals(start, end) {
  return daySequence(start, end).map(day => ({
    start: factoryLocalTimeUtc(day, LUNCH_START_MINUTE),
    end: factoryLocalTimeUtc(day, LUNCH_END_MINUTE),
    kind: 'lunch',
  }));
}

function intervalIntersection(start, end, otherStart, otherEnd) {
  const a = Math.max(start.getTime(), otherStart.getTime());
  const b = Math.min(end.getTime(), otherEnd.getTime());
  return b > a ? { start: new Date(a), end: new Date(b) } : null;
}

function unionMinutes(intervals = []) {
  const clean = intervals
    .filter(interval => interval?.start instanceof Date && interval?.end instanceof Date && interval.end > interval.start)
    .map(interval => ({ start: interval.start.getTime(), end: interval.end.getTime() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current = null;
  for (const interval of clean) {
    if (!current || interval.start > current.end) {
      if (current) total += current.end - current.start;
      current = { ...interval };
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  if (current) total += current.end - current.start;
  return total / 60000;
}

function deductIntervals(start, end, stops = [], { workingDays = [0,1,2,3,4], fridayWorkDates = [] } = {}) {
  const outsideWork = daySequence(start,end).flatMap(day => {
    const weekday = new Date(day+'T12:00:00Z').getUTCDay();
    const midnight = factoryLocalTimeUtc(day,0), following = factoryLocalTimeUtc(nextDay(day),0);
    const isWorkingDay = workingDays.includes(weekday) || (weekday === 5 && fridayWorkDates.includes(day));
    const closingMinute = weekday === 5 ? 14 * 60 : WORK_END_MINUTE;
    const intervals = isWorkingDay
      ? [{start:midnight,end:factoryLocalTimeUtc(day,WORK_START_MINUTE)}, {start:factoryLocalTimeUtc(day,closingMinute),end:following}]
      : [{start:midnight,end:following}];
    return intervals.map(i=>intervalIntersection(start,end,i.start,i.end)).filter(Boolean);
  });
  const lunches = lunchIntervals(start, end)
    .map(interval => intervalIntersection(start, end, interval.start, interval.end))
    .filter(Boolean);
  const overlappingStops = stops
    .map(stop => intervalIntersection(start, end, stop.start, stop.end))
    .filter(Boolean);
  const outsideWorkMinutes = unionMinutes(outsideWork);
  const scheduledMinutes = unionMinutes([...outsideWork,...lunches]);
  const lunchMinutes = Math.max(0,scheduledMinutes-outsideWorkMinutes);
  const allDeductionMinutes = unionMinutes([...outsideWork,...lunches,...overlappingStops]);
  const documentedStopMinutes = Math.max(0,allDeductionMinutes-scheduledMinutes);
  return {
    outsideWorkMinutes: round(outsideWorkMinutes,3),
    lunchMinutes: round(lunchMinutes, 3),
    documentedStopMinutes: round(documentedStopMinutes, 3),
    deductedMinutes: round(allDeductionMinutes, 3),
  };
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (!value || typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positive(value, fallback = 0) {
  const numeric = numberOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : fallback;
}

function normaliseSegments(item = {}, snapshot = {}) {
  const fromItem = parseJson(item.segments, []);
  if (Array.isArray(fromItem) && fromItem.length) return fromItem;
  const generic = snapshot.machineOutput?.generic || {};
  const fromSnapshot = generic.segments || snapshot.data?.segments;
  if (Array.isArray(fromSnapshot) && fromSnapshot.length) return fromSnapshot;
  const sides = Array.isArray(snapshot.data?.sides) ? snapshot.data.sides : [];
  const angles = Array.isArray(snapshot.data?.angles) ? snapshot.data.angles : [];
  return sides.map((length, index) => ({
    length_mm: length,
    angle_deg: index < sides.length - 1 ? angles[index] : null,
  }));
}

function shapeProfile(item = {}) {
  const snapshot = parseJson(item.shape_snapshot_json, {}) || {};
  const generic = snapshot.machineOutput?.generic || {};
  const segments = normaliseSegments(item, snapshot).map(segment => ({
    length_mm: round(positive(segment?.length_mm ?? segment?.lengthMm ?? segment?.length), 3),
    angle_deg: numberOrNull(segment?.angle_deg ?? segment?.angleDeg ?? segment?.angle),
  })).filter(segment => segment.length_mm > 0);
  const bends = segments.slice(0, -1).filter(segment => {
    const angle = Number(segment.angle_deg);
    return Number.isFinite(angle) && Math.abs(angle) > 0.001 && Math.abs(Math.abs(angle) - 180) > 0.001;
  });
  const shapeType = String(snapshot.shapeType || generic.shapeType || item.shape_id || item.shape_name || 'unknown');
  const shapeName = String(snapshot.displayName || item.shape_name || shapeType || 'לא ידוע');
  const diameterMm = positive(item.diameter ?? snapshot.data?.diameterMm ?? snapshot.data?.diameter ?? generic.diameterMm ?? generic.diameter);
  const unitCutLengthMm = positive(item.total_length_mm ?? snapshot.calculated?.totalLengthMm ?? generic.totalLengthMm ?? generic.lengthMm);
  const fingerprintSource = {
    shapeType,
    diameterMm: round(diameterMm, 3),
    unitCutLengthMm: round(unitCutLengthMm, 3),
    segments,
    spiralDiameterMm: round(positive(item.spiral_diameter_mm ?? snapshot.data?.spiral?.diameterMm ?? generic.spiralDiameterMm), 3),
    spiralTurns: round(positive(item.spiral_turns ?? snapshot.data?.spiral?.turns ?? generic.spiralTurns), 3),
  };
  return {
    shapeType,
    shapeName,
    diameterMm,
    unitCutLengthMm,
    bendCount: bends.length,
    bendAngles: bends.map(segment => segment.angle_deg),
    segments,
    fingerprint: JSON.stringify(fingerprintSource),
  };
}

function itemProducedQuantity(item = {}) {
  const requested = positive(item.quantity, 1);
  const produced = numberOrNull(item.produced_qty);
  return produced !== null && produced > 0 ? Math.min(produced, requested) : requested;
}

function itemWeightKg(item = {}, producedQty) {
  const actual = numberOrNull(item.actual_weight_kg);
  if (actual !== null && actual >= 0) return { kg: actual, source: 'measured' };
  const total = positive(item.total_weight);
  const requested = positive(item.quantity, 1);
  return { kg: total * (producedQty / requested), source: 'theoretical' };
}

function machineDisplayName(item = {}, machineNames = new Map()) {
  const raw = String(item.machine || '').trim();
  const machineId = numberOrNull(item.machine_id);
  return raw || (machineId && machineNames.get(machineId)) || 'לא שויכה מכונה';
}

function stopIndex(db) {
  const machines = db.prepare('SELECT id,name,label FROM machines').all();
  const names = new Map(machines.map(machine => [Number(machine.id), String(machine.name || machine.label || machine.id)]));
  const byMachineId = new Map();
  const rows = db.prepare(`
    SELECT machine_id,reason_code,started_at,ended_at,duration_min
    FROM machine_stops
    WHERE started_at IS NOT NULL AND ended_at IS NOT NULL
  `).all();
  for (const row of rows) {
    const start = asDate(row.started_at);
    const end = asDate(row.ended_at);
    if (!start || !end || end <= start || !Number.isInteger(Number(row.machine_id))) continue;
    const entry = { start, end, reasonCode: String(row.reason_code || '').toUpperCase() };
    const key = Number(row.machine_id);
    if (!byMachineId.has(key)) byMachineId.set(key, []);
    byMachineId.get(key).push(entry);
  }
  return { machines, names, byMachineId };
}

function resolveMachineId(item, machines) {
  const direct = Number(item.machine_id);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const label = String(item.machine || '').trim();
  const match = machines.find(machine => String(machine.name || '') === label || String(machine.label || '') === label);
  return match ? Number(match.id) : null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function productionScanIndex(db) {
  const byItem = new Map(), fridayDates = new Set();
  const add = (itemId,raw,kind,source) => {
    const at=asDate(raw); if(!at) return;
    const day=israelDay(at);
    if(kind!=='reset' && new Date(day+'T12:00:00Z').getUTCDay()===5) fridayDates.add(day);
    if(!byItem.has(Number(itemId))) byItem.set(Number(itemId),[]);
    byItem.get(Number(itemId)).push({at,kind,source});
  };
  for(const row of db.prepare("SELECT item_id,action,scanned_at FROM scan_log WHERE action IN ('start','complete','close_prev') ORDER BY id").all())
    add(row.item_id,row.scanned_at,row.action==='start'?'start':'end','scan_log');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_card_activity'").get()) {
    for(const row of db.prepare("SELECT item_id,occurred_at,details_json FROM worker_card_activity WHERE action IN ('status_changed','updated') ORDER BY id").all()) {
      const details = parseJson(row.details_json,{}) || {};
      const kind=details.from_status===details.to_status?null:details.to_status==='ממתין'?'reset':details.to_status==='בייצור'?'start':details.to_status==='הושלם'&&!details.correction?'end':null;
      if(kind) add(row.item_id,row.occurred_at,kind,'worker_card_activity');
    }
  }
  for(const events of byItem.values()) events.sort((a,b)=>a.at-b.at);
  return {byItem,fridayWorkDates:[...fridayDates].sort()};
}
function scannedInterval(item, completedAt, index) {
  let start=null,end=null,source=null;
  for(const event of index.byItem.get(Number(item.id))||[]) {
    if(event.at.getTime()>completedAt.getTime()+1000) break;
    if(event.kind==='reset') { start=null;end=null;source=null; }
    if(event.kind==='start' && (!start || end)) { start=event.at;end=null;source=event.source; }
    if(event.kind==='end' && start && !end) end=event.at;
  }
  // Retain timestamp millisecond precision only when it agrees with the scan;
  // repeated completion reports must not extend a finished manufacturing cycle.
  const preciseStart=asDate(item.started_at);
  if(start && preciseStart && Math.abs(preciseStart-start)<1000) start=preciseStart;
  if(end && Math.abs(completedAt-end)<1000) end=completedAt;
  return {start,end:end||completedAt,source,endSource:end?'scan':'item_timestamp'};
}

function reportProductionTiming(db, { fromDate, toDate, workingDays } = {}) {
  if (!validDay(fromDate) || !validDay(toDate) || fromDate > toDate) throw new Error('invalid production date range');
  const stopData = stopIndex(db);
  const scans = productionScanIndex(db);
  const {fridayWorkDates} = scans;
  const rows = db.prepare(`
    SELECT i.*, COALESCE(i.order_id, p.order_id) AS report_order_id,
           o.order_num AS report_order_num, c.name AS report_customer_name
    FROM items i
    LEFT JOIN pallets p ON p.id=i.pallet_id
    LEFT JOIN orders o ON o.id=COALESCE(i.order_id,p.order_id)
    LEFT JOIN customers c ON c.id=o.customer_id
    ORDER BY datetime(i.completed_at), i.id
  `).all();

  const approvedOutsidePeriod=new Set(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_timing_reviews'").get()
    ? db.prepare("SELECT item_id FROM production_timing_reviews WHERE decision='include'").all().map(r=>r.item_id):[]);
  const allItems = [];
  for (const item of rows) {
    const recordedCompletion = asDate(item.completed_at);
    if (!recordedCompletion) continue;
    const scan = scannedInterval(item,recordedCompletion,scans);
    const completedAt = scan.end;
    const productionDay = israelDay(completedAt);
    if (!productionDay) continue;
    if((productionDay<fromDate||productionDay>toDate)&&!approvedOutsidePeriod.has(item.id)) continue;
    const startedAt = scan.start;
    const profile = shapeProfile(item);
    const machineId = resolveMachineId(item, stopData.machines);
    const machine = machineDisplayName(item, stopData.names);
    const quantity = itemProducedQuantity(item);
    const weight = itemWeightKg(item, quantity);
    const base = {
      item_id: Number(item.id),
      order_id: Number(item.report_order_id) || null,
      order_num: item.report_order_num || null,
      customer_name: item.report_customer_name || null,
      machine_id: machineId,
      machine,
      production_day: productionDay,
      geometry_revision: crypto.createHash('sha256').update(JSON.stringify([item.shape_snapshot_json||null,item.segments||null])).digest('hex'),
      timing_source: scan.source,
      timing_end_source: scan.endSource,
      recorded_started_at: item.started_at || null,
      recorded_completed_at: item.completed_at,
      started_at: startedAt ? startedAt.toISOString() : null,
      completed_at: completedAt.toISOString(),
      quantity,
      weight_kg: round(weight.kg, 3),
      weight_source: weight.source,
      ...profile,
    };
    if (!startedAt) {
      allItems.push({ ...base, measurement_status: 'missing_start', measurement_reason: item.started_at ? 'יש זמן התחלה אך אין תיעוד סריקת התחלה' : 'לא נרשמה סריקת התחלת ייצור', gross_minutes: null, net_minutes: null, cut_length_mm: null, meters_per_min: null, kg_per_min: null, bends_per_min: null });
      continue;
    }
    if (completedAt <= startedAt || completedAt-startedAt > 370*86400000) {
      allItems.push({ ...base, measurement_status: 'invalid_range', measurement_reason: completedAt<=startedAt?'סיום קודם להתחלה':'משך מדידה ארוך משנה דורש בירור', gross_minutes: null, net_minutes: null, cut_length_mm: null, meters_per_min: null, kg_per_min: null, bends_per_min: null });
      continue;
    }
    const stops = machineId ? (stopData.byMachineId.get(machineId) || []) : [];
    const deductions = deductIntervals(startedAt, completedAt, stops, {workingDays,fridayWorkDates});
    const grossMinutes = (completedAt - startedAt) / 60000;
    const netMinutes = Math.max(0, grossMinutes - deductions.deductedMinutes);
    const cutLengthMm = profile.unitCutLengthMm * quantity;
    const bends = profile.bendCount * quantity;
    allItems.push({
      ...base,
      measurement_status: netMinutes > 0 ? 'measured' : 'zero_net_time',
      measurement_reason: netMinutes > 0 ? null : 'אין זמן ייצור נטו לאחר ניכויים',
      gross_minutes: round(grossMinutes, 3),
      outside_work_minutes: deductions.outsideWorkMinutes,
      lunch_minutes: deductions.lunchMinutes,
      documented_stop_minutes: deductions.documentedStopMinutes,
      net_minutes: round(netMinutes, 3),
      net_minutes_exact: netMinutes,
      cut_length_mm: round(cutLengthMm, 3),
      total_bends: bends,
      meters_per_min: netMinutes > 0 ? round(cutLengthMm / 1000 / netMinutes, 4) : null,
      kg_per_min: netMinutes > 0 ? round(weight.kg / netMinutes, 4) : null,
      bends_per_min: netMinutes > 0 && bends > 0 ? round(bends / netMinutes, 4) : null,
    });
  }

  const reliability=require('./productionTimingReliability');
  reliability.classify(db,allItems);
  const items=allItems.filter(item=>item.production_day>=fromDate&&item.production_day<=toDate);
  const measured = items.filter(item => item.included_in_statistics);
  const recipes = new Map();
  for (const item of measured) {
    const key = `${item.machine}|${item.fingerprint}`;
    if (!recipes.has(key)) recipes.set(key, []);
    recipes.get(key).push(item);
  }
  for (const list of recipes.values()) {
    const baseline = list.length >= 5 ? median(list.map(item => item.net_minutes / Math.max(1, item.quantity))) : null;
    for (const item of list) {
      const unitMinutes = item.net_minutes / Math.max(1, item.quantity);
      item.recipe_sample_count = list.length;
      item.recipe_median_min_per_unit = baseline === null ? null : round(baseline, 3);
      item.slowdown_pct = baseline && baseline > 0 ? round(((unitMinutes - baseline) / baseline) * 100, 1) : null;
      item.speed_status = item.slowdown_pct === null ? 'insufficient_history'
        : item.slowdown_pct >= 50 ? 'slow'
          : item.slowdown_pct >= 25 ? 'watch'
            : 'normal';
    }
  }

  const transitions = [];
  const byMachine = new Map();
  for (const item of items) {
    if (!item.machine_id) continue;
    if (!byMachine.has(item.machine_id)) byMachine.set(item.machine_id, []);
    byMachine.get(item.machine_id).push(item);
  }
  for (const [machineId, machineItems] of byMachine.entries()) {
    const ordered = [...machineItems].sort((a, b) => Date.parse(a.started_at||a.completed_at) - Date.parse(b.started_at||b.completed_at) || a.item_id - b.item_id);
    const stops = stopData.byMachineId.get(machineId) || [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if(!previous.included_in_statistics||!current.included_in_statistics) continue;
      const start = asDate(previous.completed_at);
      const end = asDate(current.started_at);
      if (!start || !end) continue;
      if (end <= start) {
        transitions.push({ machine_id: machineId, machine: current.machine, previous_item_id: previous.item_id, item_id: current.item_id, gap_status: 'overlap', overlap_minutes: round((start - end) / 60000, 3), gross_gap_minutes: 0, lunch_minutes: 0, documented_stop_minutes: 0, coil_load_minutes: 0, transition_minutes: 0 });
        continue;
      }
      const deductions = deductIntervals(start, end, stops, {workingDays,fridayWorkDates});
      const coilIntervals = stops.filter(stop => stop.reasonCode === 'COIL_LOAD')
        .map(stop => intervalIntersection(start, end, stop.start, stop.end)).filter(Boolean);
      const coilMinutes = unionMinutes(coilIntervals);
      const grossGap = (end - start) / 60000;
      transitions.push({
        machine_id: machineId,
        machine: current.machine,
        previous_item_id: previous.item_id,
        previous_order_num: previous.order_num,
        previous_shape_name: previous.shapeName,
        item_id: current.item_id,
        order_num: current.order_num,
        shape_name: current.shapeName,
        gross_gap_minutes: round(grossGap, 3),
        outside_work_minutes: deductions.outsideWorkMinutes,
        lunch_minutes: deductions.lunchMinutes,
        documented_stop_minutes: deductions.documentedStopMinutes,
        coil_load_minutes: round(coilMinutes, 3),
        transition_minutes: round(Math.max(0, grossGap - deductions.deductedMinutes), 3),
        gap_status: 'measured',
      });
    }
  }

  const machineSummaries = new Map();
  const orderSummaries = new Map();
  // The daily/diameter projection is deliberately built from every completed
  // card, including cards whose timing is incomplete. This keeps the daily
  // production quantity and weight truthful while keeping pace metrics limited
  // to the subset with a valid measured duration.
  const dailyDiameterSummaries = new Map();
  const dailyDiameterKeyByItemId = new Map();
  for (const item of items) {
    const diameter = Number.isFinite(Number(item.diameterMm)) && Number(item.diameterMm) > 0
      ? Number(item.diameterMm)
      : null;
    const key = `${item.production_day}|${diameter === null ? 'unknown' : diameter}`;
    const current = dailyDiameterSummaries.get(key) || {
      date: item.production_day,
      diameter_mm: diameter,
      completed_cards: 0,
      measured_cards: 0,
      unmeasured_cards: 0,
      quantity: 0,
      cut_length_mm: 0,
      missing_cut_length_cards: 0,
      weight_kg: 0,
      measured_weight_kg: 0,
      estimated_weight_kg: 0,
      measured_weight_cards: 0,
      estimated_weight_cards: 0,
      net_minutes: 0,
      measured_cut_length_mm: 0,
      timed_weight_kg: 0,
      coil_load_minutes: 0,
    };
    current.completed_cards += 1;
    current.quantity += item.quantity;
    current.weight_kg += item.weight_kg;
    if (item.weight_source === 'measured') {
      current.measured_weight_kg += item.weight_kg;
      current.measured_weight_cards += 1;
    } else {
      current.estimated_weight_kg += item.weight_kg;
      current.estimated_weight_cards += 1;
    }

    const cardCutLength = Number(item.unitCutLengthMm) > 0
      ? Number(item.unitCutLengthMm) * item.quantity
      : null;
    if (cardCutLength === null) current.missing_cut_length_cards += 1;
    else current.cut_length_mm += cardCutLength;

    if (item.included_in_statistics) {
      current.measured_cards += 1;
      current.net_minutes += item.net_minutes_exact ?? item.net_minutes;
      current.gross_minutes = (current.gross_minutes || 0) + item.gross_minutes;
      current.outside_work_minutes = (current.outside_work_minutes || 0) + item.outside_work_minutes;
      current.measured_cut_length_mm += item.cut_length_mm;
      current.timed_weight_kg += item.weight_kg;
    } else {
      current.unmeasured_cards += 1;
    }
    dailyDiameterSummaries.set(key, current);
    dailyDiameterKeyByItemId.set(item.item_id, key);
  }
  for (const item of measured) {
    const key = item.machine;
    const current = machineSummaries.get(key) || {
      machine: key, measured_cards: 0, unmeasured_cards: 0, net_minutes: 0, lunch_minutes: 0,
      documented_stop_minutes: 0, cut_length_mm: 0, weight_kg: 0, measured_weight_kg: 0,
      estimated_weight_kg: 0, total_bends: 0, transition_minutes: 0, coil_load_minutes: 0,
    };
    current.measured_cards += 1;
    current.timed_weight_kg = (current.timed_weight_kg || 0) + item.weight_kg;
    current.timed_cut_length_mm = (current.timed_cut_length_mm || 0) + item.cut_length_mm;
    current.net_minutes += item.net_minutes_exact ?? item.net_minutes;
    current.gross_minutes = (current.gross_minutes || 0) + item.gross_minutes;
    current.outside_work_minutes = (current.outside_work_minutes || 0) + item.outside_work_minutes;
    current.lunch_minutes += item.lunch_minutes;
    current.documented_stop_minutes += item.documented_stop_minutes;
    current.cut_length_mm += item.cut_length_mm;
    current.weight_kg += item.weight_kg;
    current.total_bends += item.total_bends;
    if (item.weight_source === 'measured') current.measured_weight_kg += item.weight_kg;
    else current.estimated_weight_kg += item.weight_kg;
    machineSummaries.set(key, current);

    const orderKey = item.order_id ? `order:${item.order_id}` : `unlinked:${item.item_id}`;
    const order = orderSummaries.get(orderKey) || {
      order_id: item.order_id,
      order_num: item.order_num || 'ללא הזמנה',
      measured_cards: 0,
      unmeasured_cards: 0,
      net_minutes: 0,
      lunch_minutes: 0,
      documented_stop_minutes: 0,
      cut_length_mm: 0,
      weight_kg: 0,
      profiles: new Set(),
    };
    order.measured_cards += 1;
    order.timed_weight_kg = (order.timed_weight_kg || 0) + item.weight_kg;
    order.timed_cut_length_mm = (order.timed_cut_length_mm || 0) + item.cut_length_mm;
    order.net_minutes += item.net_minutes_exact ?? item.net_minutes;
    order.gross_minutes = (order.gross_minutes || 0) + item.gross_minutes;
    order.outside_work_minutes = (order.outside_work_minutes || 0) + item.outside_work_minutes;
    order.lunch_minutes += item.lunch_minutes;
    order.documented_stop_minutes += item.documented_stop_minutes;
    order.cut_length_mm += item.cut_length_mm;
    order.weight_kg += item.weight_kg;
    order.profiles.add(`${item.shapeName} · Ø${item.diameterMm} מ״מ`);
    orderSummaries.set(orderKey, order);
  }
  for (const item of items.filter(item => !item.included_in_statistics)) {
    const key = item.machine;
    const current = machineSummaries.get(key) || {
      machine: key, measured_cards: 0, unmeasured_cards: 0, net_minutes: 0, lunch_minutes: 0,
      documented_stop_minutes: 0, cut_length_mm: 0, weight_kg: 0, measured_weight_kg: 0,
      estimated_weight_kg: 0, total_bends: 0, transition_minutes: 0, coil_load_minutes: 0,
    };
    current.unmeasured_cards += 1;
    current.weight_kg += item.weight_kg;
    current.cut_length_mm += item.unitCutLengthMm * item.quantity;
    if (item.weight_source === 'measured') current.measured_weight_kg += item.weight_kg;
    else current.estimated_weight_kg += item.weight_kg;
    machineSummaries.set(key, current);

    const orderKey = item.order_id ? `order:${item.order_id}` : `unlinked:${item.item_id}`;
    const order = orderSummaries.get(orderKey) || {
      order_id: item.order_id,
      order_num: item.order_num || 'ללא הזמנה',
      measured_cards: 0,
      unmeasured_cards: 0,
      net_minutes: 0,
      lunch_minutes: 0,
      documented_stop_minutes: 0,
      cut_length_mm: 0,
      weight_kg: 0,
      profiles: new Set(),
    };
    order.unmeasured_cards += 1;
    order.weight_kg += item.weight_kg;
    order.cut_length_mm += item.unitCutLengthMm * item.quantity;
    order.profiles.add(`${item.shapeName} · Ø${item.diameterMm} מ״מ`);
    orderSummaries.set(orderKey, order);
  }
  for (const transition of transitions) {
    if (transition.gap_status !== 'measured') continue;
    const current = machineSummaries.get(transition.machine);
    if (current) {
      current.transition_minutes += transition.transition_minutes;
      current.coil_load_minutes += transition.coil_load_minutes;
    }
    // A coil-load interval belongs to the card that follows the interval.
    // That makes day/diameter totals traceable without changing any source
    // production record.
    const daily = dailyDiameterSummaries.get(dailyDiameterKeyByItemId.get(transition.item_id));
    if (daily) daily.coil_load_minutes += transition.coil_load_minutes;
  }
  const machines = [...machineSummaries.values()].map(row => ({
    ...row,
    net_minutes: round(row.net_minutes, 3),
    avg_card_minutes: row.measured_cards > 0 ? round(row.net_minutes / row.measured_cards,3) : null,
    gross_minutes: round(row.gross_minutes,3),
    outside_work_minutes: round(row.outside_work_minutes,3),
    lunch_minutes: round(row.lunch_minutes, 3),
    documented_stop_minutes: round(row.documented_stop_minutes, 3),
    cut_length_mm: round(row.cut_length_mm, 3),
    weight_kg: round(row.weight_kg, 3),
    measured_weight_kg: round(row.measured_weight_kg, 3),
    estimated_weight_kg: round(row.estimated_weight_kg, 3),
    transition_minutes: round(row.transition_minutes, 3),
    coil_load_minutes: round(row.coil_load_minutes, 3),
    meters_per_min: row.net_minutes > 0 ? round((row.timed_cut_length_mm || 0) / 1000 / row.net_minutes, 4) : null,
    kg_per_min: row.net_minutes > 0 ? round((row.timed_weight_kg || 0) / row.net_minutes, 4) : null,
    bends_per_min: row.net_minutes > 0 && row.total_bends > 0 ? round(row.total_bends / row.net_minutes, 4) : null,
  })).sort((a, b) => b.net_minutes - a.net_minutes || a.machine.localeCompare(b.machine, 'he'));

  const recipeSummaries = [...recipes.values()].map(list => {
    const first = list[0];
    const netMinutes = list.reduce((sum, item) => sum + (item.net_minutes_exact ?? item.net_minutes), 0);
    const cutLengthMm = list.reduce((sum, item) => sum + item.cut_length_mm, 0);
    const weightKg = list.reduce((sum, item) => sum + item.weight_kg, 0);
    const bends = list.reduce((sum, item) => sum + item.total_bends, 0);
    return {
      machine: first.machine,
      shape_name: first.shapeName,
      shape_type: first.shapeType,
      diameter_mm: first.diameterMm,
      unit_cut_length_mm: first.unitCutLengthMm,
      bend_count: first.bendCount,
      bend_angles: first.bendAngles,
      sample_count: list.length,
      net_minutes: round(netMinutes, 3),
      cut_length_mm: round(cutLengthMm, 3),
      weight_kg: round(weightKg, 3),
      meters_per_min: netMinutes > 0 ? round(cutLengthMm / 1000 / netMinutes, 4) : null,
      kg_per_min: netMinutes > 0 ? round(weightKg / netMinutes, 4) : null,
      bends_per_min: netMinutes > 0 && bends > 0 ? round(bends / netMinutes, 4) : null,
      median_min_per_unit: list.length >= 5 ? round(median(list.map(item => item.net_minutes / Math.max(1, item.quantity)), 3), 3) : null,
    };
  }).sort((a, b) => b.net_minutes - a.net_minutes || a.machine.localeCompare(b.machine, 'he'));

  const orders = [...orderSummaries.values()].map(order => ({
    ...order,
    profiles: [...order.profiles].sort((a, b) => a.localeCompare(b, 'he')),
    net_minutes: round(order.net_minutes, 3),
    gross_minutes: round(order.gross_minutes,3),
    outside_work_minutes: round(order.outside_work_minutes,3),
    lunch_minutes: round(order.lunch_minutes, 3),
    documented_stop_minutes: round(order.documented_stop_minutes, 3),
    cut_length_mm: round(order.cut_length_mm, 3),
    weight_kg: round(order.weight_kg, 3),
    meters_per_min: order.net_minutes > 0 ? round((order.timed_cut_length_mm || 0) / 1000 / order.net_minutes, 4) : null,
    kg_per_min: order.net_minutes > 0 ? round((order.timed_weight_kg || 0) / order.net_minutes, 4) : null,
  })).sort((a, b) => b.net_minutes - a.net_minutes || String(a.order_num).localeCompare(String(b.order_num), 'he'));

  const daily_diameters = [...dailyDiameterSummaries.values()].map(row => ({
    ...row,
    quantity: round(row.quantity, 3),
    cut_length_mm: round(row.cut_length_mm, 3),
    weight_kg: round(row.weight_kg, 3),
    measured_weight_kg: round(row.measured_weight_kg, 3),
    estimated_weight_kg: round(row.estimated_weight_kg, 3),
    net_minutes: round(row.net_minutes, 3),
    measured_cut_length_mm: round(row.measured_cut_length_mm, 3),
    timed_weight_kg: round(row.timed_weight_kg, 3),
    coil_load_minutes: round(row.coil_load_minutes, 3),
    meters_per_min: row.net_minutes > 0 ? round(row.measured_cut_length_mm / 1000 / row.net_minutes, 4) : null,
    kg_per_min: row.net_minutes > 0 ? round(row.timed_weight_kg / row.net_minutes, 4) : null,
    weight_source: row.measured_weight_cards && row.estimated_weight_cards
      ? 'mixed'
      : row.estimated_weight_cards ? 'theoretical' : 'measured',
  })).sort((a, b) => String(b.date).localeCompare(String(a.date))
    || (a.diameter_mm === null ? 1 : b.diameter_mm === null ? -1 : a.diameter_mm - b.diameter_mm));

  const materials=reliability.materialIndex(db);
  return {
    period: { from: fromDate, to: toDate, time_zone: FACTORY_TIME_ZONE, work: {start:'07:00',end:'18:00',working_days:workingDays||[0,1,2,3,4],friday_end:'14:00',friday_work_dates:fridayWorkDates.filter(day=>day>=fromDate&&day<=toDate),friday_policy:'production_scans_only'}, lunch: { start: '12:00', end: '12:45' } },
    cards: items.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)) || b.item_id - a.item_id),
    orders,
    machines,
    recipes: recipeSummaries,
    daily_diameters,
    transitions: transitions.sort((a, b) => b.transition_minutes - a.transition_minutes || b.item_id - a.item_id),
    daily_scan_activity: require('./productionDailyScanActivity').dailyScanActivity({records:rows,scans,completedCards:items,fromDate,toDate,dayOf:israelDay,parseDate:asDate,materialOf:item=>materials.get(Number(item.id))||null,
      machineOf:item=>({id:resolveMachineId(item,stopData.machines),name:(item.machine_id&&stopData.names.get(Number(item.machine_id)))||machineDisplayName(item,stopData.names)})}),
    reliability_policy: reliability.POLICY,
    data_quality: {
      reliable_cards:items.filter(c=>c.reliability_status==='reliable').length,
      review_cards:items.filter(c=>c.reliability_status==='review').length,
      unreliable_cards:items.filter(c=>c.reliability_status==='unreliable').length,
      completed_cards: items.length,
      measured_cards: measured.length,
      unmeasured_cards: items.length - measured.length,
      transition_count: transitions.filter(row => row.gap_status === 'measured').length,
      overlap_anomalies: transitions.filter(row => row.gap_status === 'overlap').length,
    },
  };
}

module.exports = {
  FACTORY_TIME_ZONE,
  WORK_START_MINUTE,
  WORK_END_MINUTE,
  LUNCH_START_MINUTE,
  LUNCH_END_MINUTE,
  asDate,
  israelDay,
  validDay,
  factoryLocalTimeUtc,
  lunchIntervals,
  unionMinutes,
  deductIntervals,
  shapeProfile,
  reportProductionTiming,
};
