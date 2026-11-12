'use strict';
const { materialOnHand } = require('./materialBalance');

// B5A is deliberately a projection: this module performs SELECTs only.
const SUPPORTED = new Set(['coil', 'straight']);
const WARNING = 'Planning identity does not validate grade, standard, nominal length or catalog item.';
const kg = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const rounded = Number(Math.max(0, n).toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
};
const raw = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const key = (diameter, materialType) => `${Number(diameter)}|${materialType}`;
const validIdentity = row => Number.isFinite(Number(row.diameter)) && Number(row.diameter) > 0 && SUPPORTED.has(String(row.material_type));
const anomaly = (code, severity, source = {}) => ({ code, severity, ...source });
const sourceFields = ['requirement_id', 'raw_material_id', 'lot_id', 'allocation_plan_id', 'allocation_plan_line_id', 'allocation_line_id', 'consumption_event_id', 'consumption_event_line_id', 'inventory_reservation_id', 'reservation_id', 'receipt_id', 'receipt_line_id', 'purchase_order_id', 'order_id', 'item_id'];
const stableValue = value => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${stableValue(value[name])}`).join(',')}}`;
};
const compareValue = (left, right) => {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
};
const anomalySort = (left, right) => {
  let result = compareValue(left.code, right.code) || compareValue(left.entity_type ?? left.source_type, right.entity_type ?? right.source_type);
  if (result) return result;
  for (const field of sourceFields) {
    result = compareValue(left[field], right[field]);
    if (result) return result;
  }
  return compareValue(stableValue(left), stableValue(right));
};

function projectMaterialCoverageV2(db) {
  const groups = new Map(); const global = [];
  const add = (diameter, materialType) => {
    const id = key(diameter, materialType);
    if (!groups.has(id)) groups.set(id, {
      diameter: Number(diameter), material_type: materialType,
      identity_scope: 'diameter_material_type', identity_is_partial: true, identity_warning: WARNING,
      requirements: [], demand: { remaining_required_kg: 0, allocated_remaining_kg: 0, unallocated_demand_kg: 0 },
      approved_inventory: { physical_kg: 0, active_v2_allocated_remaining_kg: 0, v2_free_approved_kg: 0, v2_candidate_cover_kg: 0, v2_gap_kg: 0 },
      legacy_reservations: { active_reserved_kg: 0, legacy_stock_overlap: false, conservative_free_kg: 0, conservative_candidate_cover_kg: 0, conservative_gap_kg: 0 },
      pending_receipts: { weight_kg: 0, receipt_count: 0, line_count: 0, counted_as_coverage: false, operational_state: 'pending_approval' },
      pending_verification: { weight_kg: 0, lot_count: 0, counted_as_coverage: false, operational_state: 'physically_received_unavailable' },
      legacy_purchase_orders: [], anomalies: [],
    });
    return groups.get(id);
  };
  const netForRequirement = db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) AS kg
    FROM material_consumption_event_lines_v2 l JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id WHERE e.material_requirement_id=?`);
  const activeLines = db.prepare(`SELECT l.id,l.allocated_kg FROM allocation_plan_lines_v2 l JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id
    WHERE p.material_requirement_id=? AND p.status='active' AND l.status='active' ORDER BY p.id,l.id`);
  const netForLine = db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) AS kg
    FROM material_consumption_event_lines_v2 l JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id WHERE l.allocation_plan_line_id=?`);

  const requirements = db.prepare(`SELECT r.* FROM material_requirements_v2 r
    JOIN orders o ON o.id=r.order_id
    WHERE r.status='open' AND o.inventory_lifecycle_version=2 ORDER BY r.order_id,r.item_id,r.id`).all();
  for (const r of requirements) {
    if (Number(r.lifecycle_version) !== 2 || !validIdentity(r)) { global.push(anomaly('invalid_requirement_identity', 'warning', { requirement_id: r.id })); continue; }
    const consumed = kg(netForRequirement.get(r.id).kg);
    const lines = activeLines.all(r.id);
    let allocated = 0; let allocatedConsumed = 0; const requirementAnomalies = [];
    for (const line of lines) {
      const used = kg(netForLine.get(line.id).kg); const amount = kg(line.allocated_kg);
      if (raw(netForLine.get(line.id).kg) > raw(line.allocated_kg)) requirementAnomalies.push(anomaly('allocation_consumed_exceeds_allocated', 'warning', { allocation_plan_line_id: line.id, requirement_id: r.id }));
      allocated += amount; allocatedConsumed += used;
    }
    const required = kg(r.required_kg); const remaining = kg(required - consumed); const allocatedRemaining = kg(allocated - allocatedConsumed); const unallocated = kg(remaining - allocatedRemaining);
    const row = { requirement_id: r.id, requirement_uid: r.requirement_uid, order_id: r.order_id, item_id: r.item_id, source_revision: r.source_revision ?? null, need_by_source: r.need_by_source ?? null, diameter: Number(r.diameter), material_type: r.material_type, required_kg: required, confirmed_consumed_kg: consumed, remaining_required_kg: remaining, active_allocated_kg: kg(allocated), allocated_consumed_kg: kg(allocatedConsumed), allocated_remaining_kg: allocatedRemaining, unallocated_demand_kg: unallocated, anomalies: requirementAnomalies };
    if (raw(netForRequirement.get(r.id).kg) > raw(r.required_kg)) row.anomalies.push(anomaly('requirement_overconsumed', 'warning', { requirement_id: r.id }));
    if (allocatedRemaining > remaining) row.anomalies.push(anomaly('allocation_exceeds_remaining_requirement', 'warning', { requirement_id: r.id }));
    row.anomalies.sort(anomalySort);
    const group = add(r.diameter, r.material_type); group.requirements.push(row);
    group.demand.remaining_required_kg += remaining; group.demand.allocated_remaining_kg += allocatedRemaining; group.demand.unallocated_demand_kg += unallocated;
  }

  const lots = db.prepare("SELECT * FROM raw_material WHERE active=1 AND material_type IN ('coil','straight') ORDER BY id").all();
  for (const lot of lots) {
    if (!validIdentity(lot)) continue; const group = add(lot.diameter, lot.material_type); const availableRaw = materialOnHand(lot);
    if (availableRaw < 0) group.anomalies.push(anomaly('negative_lot_available_weight', 'warning', { raw_material_id: lot.id, available_kg: availableRaw }));
    if (lot.verification_status === 'approved') {
      group.approved_inventory.physical_kg += kg(availableRaw);
      if (!lot.catalog_item_id || Number(lot.spec_exception) === 1) group.anomalies.push(anomaly('approved_lot_incomplete_spec', 'warning', { raw_material_id: lot.id }));
    } else if (lot.verification_status === 'pending_verification') { group.pending_verification.weight_kg += kg(availableRaw); group.pending_verification.lot_count += 1; }
  }
  const allocationRows = db.prepare(`SELECT l.id,l.raw_material_id,l.allocated_kg,r.diameter,r.material_type,req.status AS requirement_status
    FROM allocation_plan_lines_v2 l JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id JOIN raw_material r ON r.id=l.raw_material_id
    LEFT JOIN material_requirements_v2 req ON req.id=p.material_requirement_id WHERE p.status='active' AND l.status='active' ORDER BY p.id,l.id`).all();
  for (const line of allocationRows) {
    if (!validIdentity(line)) continue; const net = raw(netForLine.get(line.id).kg); const remaining = kg(raw(line.allocated_kg) - net); const group = add(line.diameter, line.material_type);
    group.approved_inventory.active_v2_allocated_remaining_kg += remaining;
    if (line.requirement_status === 'cancelled') group.anomalies.push(anomaly('cancelled_requirement_has_active_allocation', 'warning', { allocation_plan_line_id: line.id }));
  }
  const legacy = require('./inventoryItemCompletion').policy(db)
    ? require('./inventoryDemand').inventoryDemand(db).map(row=>({...row,reserved_kg:row.remaining_kg}))
    : db.prepare("SELECT * FROM inventory_reservations WHERE status='active' ORDER BY id").all();
  for (const row of legacy) {
    if (!validIdentity(row)) { global.push(anomaly('legacy_reservation_unclassified', 'warning', { inventory_reservation_id: row.id })); continue; }
    add(row.diameter, row.material_type).legacy_reservations.active_reserved_kg += kg(row.reserved_kg);
  }
  const drafts = db.prepare(`SELECT r.id AS receipt_id,l.* FROM pending_raw_material_receipts_v2 r JOIN pending_raw_material_receipt_lines_v2 l ON l.receipt_id=r.id WHERE r.status='draft' ORDER BY r.id,l.id`).all();
  const draftSets = new Map();
  for (const line of drafts) if (validIdentity(line)) { const group = add(line.diameter, line.material_type); group.pending_receipts.weight_kg += kg(line.weight_received); group.pending_receipts.line_count += 1; const id = key(line.diameter,line.material_type); if (!draftSets.has(id)) draftSets.set(id,new Set()); draftSets.get(id).add(line.receipt_id); }
  for (const [id, set] of draftSets) groups.get(id).pending_receipts.receipt_count = set.size;
  const pos = db.prepare("SELECT * FROM purchase_orders WHERE material_type IN ('coil','straight') ORDER BY id").all();
  for (const po of pos) if (validIdentity(po)) { const group = add(po.diameter, po.material_type); group.legacy_purchase_orders.push({ id: po.id, po_num: po.po_num, supplier_id: po.supplier_id ?? null, diameter: Number(po.diameter), material_type: po.material_type, quantity_ton: kg(po.quantity_ton), ordered_kg: kg(raw(po.quantity_ton) * 1000), received_weight: kg(po.received_weight), legacy_reported_remaining_kg: kg(raw(po.quantity_ton) * 1000 - raw(po.received_weight)), status: po.status ?? null, expected_date: po.expected_date ?? null, received_at: po.received_at ?? null, is_automatic_shortage: po.status === 'inventory_shortage', counted_as_coverage: false, reliability: 'legacy_unlinked' }); group.anomalies.push(anomaly('legacy_po_possible_overlap', 'info', { purchase_order_id: po.id })); }
  const result = [...groups.values()].sort((a,b) => a.diameter - b.diameter || (a.material_type === 'coil' ? -1 : 1));
  for (const g of result) {
    for (const section of [g.demand, g.approved_inventory, g.legacy_reservations, g.pending_receipts, g.pending_verification]) for (const [name,value] of Object.entries(section)) if (name.endsWith('_kg')) section[name] = kg(value);
    const inv = g.approved_inventory; inv.v2_free_approved_kg = kg(inv.physical_kg - inv.active_v2_allocated_remaining_kg); inv.v2_candidate_cover_kg = Math.min(g.demand.unallocated_demand_kg, inv.v2_free_approved_kg); inv.v2_gap_kg = kg(g.demand.unallocated_demand_kg - inv.v2_candidate_cover_kg);
    const legacySection = g.legacy_reservations; legacySection.legacy_stock_overlap = legacySection.active_reserved_kg > 0; legacySection.conservative_free_kg = kg(inv.v2_free_approved_kg - legacySection.active_reserved_kg); legacySection.conservative_candidate_cover_kg = Math.min(g.demand.unallocated_demand_kg, legacySection.conservative_free_kg); legacySection.conservative_gap_kg = kg(g.demand.unallocated_demand_kg - legacySection.conservative_candidate_cover_kg);
    if (legacySection.active_reserved_kg > inv.v2_free_approved_kg) g.anomalies.push(anomaly('legacy_reservation_exceeds_v2_free_stock', 'warning', { source_type: 'group', diameter: g.diameter, material_type: g.material_type }));
    g.anomalies.sort(anomalySort);
  }
  global.sort(anomalySort);
  return { projection: 'material_coverage_v2', mode: 'read_only', is_procurement_instruction: false, generated_at: new Date().toISOString(), identity_scope: 'diameter_material_type', identity_is_partial: true, groups: result, global_anomalies: global };
}

module.exports = { projectMaterialCoverageV2, anomalySort };
