'use strict';
const { materialOnHand } = require('./materialBalance');

const crypto = require('node:crypto');

class MaterialConsumptionError extends Error {
  constructor(code) { super(code); this.name = 'MaterialConsumptionError'; this.code = code; }
}
const fail = code => { throw new MaterialConsumptionError(code); };
const kg = value => Number(Number(value || 0).toFixed(3));
const positive = (value, code) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) fail(code); return kg(n); };
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');

function lifecycleV2Requirement(db, id, { open = false } = {}) {
  const requirement = db.prepare(`SELECT * FROM material_requirements_v2 WHERE id=?${open ? " AND status='open'" : ''}`).get(id);
  if (!requirement || Number(requirement.lifecycle_version) !== 2 || !['coil', 'straight'].includes(requirement.material_type)) fail('lifecycle_v2_requirement_required');
  const order = db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(requirement.order_id);
  if (!order || Number(order.inventory_lifecycle_version) !== 2) fail('lifecycle_v2_required');
  return requirement;
}

function normalizeReportLines(lines) {
  if (!Array.isArray(lines) || !lines.length) fail('consumption_lines_required');
  const seen = new Set();
  return lines.map(line => {
    const allocationPlanLineId = Number(line.allocation_plan_line_id ?? line.allocationPlanLineId);
    const rawMaterialId = Number(line.raw_material_id ?? line.rawMaterialId);
    if (!Number.isSafeInteger(allocationPlanLineId) || !Number.isSafeInteger(rawMaterialId) || seen.has(allocationPlanLineId)) fail('invalid_consumption_lines');
    seen.add(allocationPlanLineId);
    return { allocationPlanLineId, rawMaterialId, consumedKg: positive(line.consumed_kg ?? line.consumedKg, 'invalid_consumed_kg') };
  });
}

function auditReport(db, reportId, action, actorId, details) {
  db.prepare('INSERT INTO material_consumption_report_audit_v2 (report_id,action,actor_id,details_json) VALUES (?,?,?,?)')
    .run(reportId, action, actorId ?? null, JSON.stringify(details));
}

function createConsumptionReport(db, input = {}) {
  const requirement = lifecycleV2Requirement(db, Number(input.material_requirement_id ?? input.materialRequirementId), { open: true });
  const lines = normalizeReportLines(input.lines);
  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO material_consumption_reports_v2
      (report_uid,material_requirement_id,requirement_uid,order_id,item_id,notes,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(crypto.randomUUID(), requirement.id, requirement.requirement_uid, requirement.order_id,
      requirement.item_id, input.notes ?? null, input.created_by ?? input.createdBy ?? null);
    const insert = db.prepare(`INSERT INTO material_consumption_report_lines_v2
      (report_id,allocation_plan_id,allocation_plan_line_id,raw_material_id,consumed_kg)
      VALUES (?,(SELECT allocation_plan_id FROM allocation_plan_lines_v2 WHERE id=?),?,?,?)`);
    for (const line of lines) insert.run(result.lastInsertRowid, line.allocationPlanLineId, line.allocationPlanLineId, line.rawMaterialId, line.consumedKg);
    auditReport(db, result.lastInsertRowid, 'created', input.created_by ?? input.createdBy, { line_count: lines.length });
    return getConsumptionReport(db, result.lastInsertRowid);
  });
  return create.immediate();
}

function getConsumptionReport(db, id) {
  const report = db.prepare('SELECT * FROM material_consumption_reports_v2 WHERE id=?').get(Number(id));
  if (!report) return null;
  const lines = db.prepare('SELECT * FROM material_consumption_report_lines_v2 WHERE report_id=? ORDER BY id').all(report.id);
  return { ...report, lines };
}

function replaceDraftLines(db, reportId, lines) {
  db.prepare('DELETE FROM material_consumption_report_lines_v2 WHERE report_id=?').run(reportId);
  const insert = db.prepare(`INSERT INTO material_consumption_report_lines_v2
    (report_id,allocation_plan_id,allocation_plan_line_id,raw_material_id,consumed_kg)
    VALUES (?,(SELECT allocation_plan_id FROM allocation_plan_lines_v2 WHERE id=?),?,?,?)`);
  for (const line of lines) insert.run(reportId, line.allocationPlanLineId, line.allocationPlanLineId, line.rawMaterialId, line.consumedKg);
}

function updateConsumptionReport(db, input = {}) {
  const reportId = Number(input.report_id ?? input.reportId);
  const lines = normalizeReportLines(input.lines);
  const update = db.transaction(() => {
    const report = db.prepare("SELECT * FROM material_consumption_reports_v2 WHERE id=? AND status='draft'").get(reportId);
    if (!report) fail('draft_consumption_report_required');
    lifecycleV2Requirement(db, report.material_requirement_id, { open: true });
    replaceDraftLines(db, report.id, lines);
    db.prepare('UPDATE material_consumption_reports_v2 SET notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.notes ?? report.notes, report.id);
    auditReport(db, report.id, 'updated', input.updated_by ?? input.updatedBy, { line_count: lines.length });
    return getConsumptionReport(db, report.id);
  });
  return update.immediate();
}

function cancelConsumptionReport(db, input = {}) {
  const reportId = Number(input.report_id ?? input.reportId);
  const cancel = db.transaction(() => {
    const report = db.prepare("SELECT * FROM material_consumption_reports_v2 WHERE id=? AND status='draft'").get(reportId);
    if (!report) fail('draft_consumption_report_required');
    db.prepare("UPDATE material_consumption_reports_v2 SET status='cancelled',cancelled_by=?,cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(input.cancelled_by ?? input.cancelledBy ?? null, report.id);
    auditReport(db, report.id, 'cancelled', input.cancelled_by ?? input.cancelledBy, { reason: input.reason ?? null });
    return getConsumptionReport(db, report.id);
  });
  return cancel.immediate();
}

function consumedForAllocationLine(db, lineId) {
  return kg(db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) AS total
    FROM material_consumption_event_lines_v2 l JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id
    WHERE l.allocation_plan_line_id=?`).get(lineId).total);
}

function validateApprovalLine(db, report, line) {
  const allocation = db.prepare(`SELECT l.*,p.status AS plan_status,p.material_requirement_id,r.active,r.verification_status,
      r.weight_received,r.weight_used,r.weight_scrapped,r.stock_adjustment_kg
    FROM allocation_plan_lines_v2 l JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id
    JOIN raw_material r ON r.id=l.raw_material_id WHERE l.id=?`).get(line.allocation_plan_line_id);
  if (!allocation || allocation.raw_material_id !== line.raw_material_id || allocation.material_requirement_id !== report.material_requirement_id
    || allocation.status !== 'active' || allocation.plan_status !== 'active' || Number(allocation.active) !== 1
    || String(allocation.verification_status || 'approved') !== 'approved') fail('invalid_consumption_allocation');
  const allocationFree = kg(Number(allocation.allocated_kg) - consumedForAllocationLine(db, allocation.id));
  const lotFree = kg(materialOnHand(allocation));
  if (line.consumed_kg > allocationFree) fail('consumption_exceeds_allocation');
  if (line.consumed_kg > lotFree) fail('consumption_exceeds_lot');
  return allocation;
}

function approveConsumptionReport(db, input = {}) {
  const reportId = Number(input.report_id ?? input.reportId);
  const idempotencyKey = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim();
  if (!idempotencyKey) fail('idempotency_key_required');
  const payloadFingerprint = fingerprint({ operation: 'approve', report_id: reportId });
  const approve = db.transaction(() => {
    const replay = db.prepare('SELECT * FROM material_consumption_events_v2 WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) {
      if (replay.payload_fingerprint !== payloadFingerprint) fail('idempotency_key_conflict');
      return getConsumptionEvent(db, replay.id);
    }
    const report = db.prepare("SELECT * FROM material_consumption_reports_v2 WHERE id=? AND status='draft'").get(reportId);
    if (!report) fail('draft_consumption_report_required');
    lifecycleV2Requirement(db, report.material_requirement_id, { open: true });
    const completion=require('./inventoryItemCompletion');
    if(completion.policy(db)) {
      const reason=completion.eligibility(db,completion.itemRecord(db,report.item_id));
      if(reason)fail(`item_consumption_${reason}`);
    }
    const lines = db.prepare('SELECT * FROM material_consumption_report_lines_v2 WHERE report_id=? ORDER BY id').all(report.id);
    if (!lines.length) fail('consumption_lines_required');
    const allocations = lines.map(line => ({ line, allocation: validateApprovalLine(db, report, line) }));
    const result = db.prepare(`INSERT INTO material_consumption_events_v2
      (event_uid,event_type,idempotency_key,payload_fingerprint,report_id,material_requirement_id,requirement_uid,order_id,item_id,approved_by)
      VALUES (?, 'consumption', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), idempotencyKey, payloadFingerprint, report.id, report.material_requirement_id, report.requirement_uid, report.order_id, report.item_id, input.approved_by ?? input.approvedBy);
    const insertLine = db.prepare(`INSERT INTO material_consumption_event_lines_v2
      (consumption_event_id,allocation_plan_id,allocation_plan_line_id,raw_material_id,consumed_kg) VALUES (?,?,?,?,?)`);
    const updateLot = db.prepare('UPDATE raw_material SET weight_used=ROUND(weight_used + ?,3) WHERE id=?');
    for (const { line, allocation } of allocations) { insertLine.run(result.lastInsertRowid, allocation.allocation_plan_id, allocation.id, line.raw_material_id, line.consumed_kg); updateLot.run(line.consumed_kg, line.raw_material_id); }
    db.prepare("UPDATE material_consumption_reports_v2 SET status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(report.id);
    auditReport(db, report.id, 'approved', input.approved_by ?? input.approvedBy, { event_id: result.lastInsertRowid });
    return getConsumptionEvent(db, result.lastInsertRowid);
  });
  return approve.immediate();
}

function getConsumptionEvent(db, id) {
  const event = db.prepare('SELECT * FROM material_consumption_events_v2 WHERE id=?').get(Number(id));
  if (!event) return null;
  const lines = db.prepare('SELECT * FROM material_consumption_event_lines_v2 WHERE consumption_event_id=? ORDER BY id').all(event.id);
  if (event.event_type !== 'consumption') return { ...event, lines };
  const reversedKg = kg(db.prepare(`SELECT COALESCE(SUM(r.consumed_kg),0) AS total FROM material_consumption_event_lines_v2 r
    JOIN material_consumption_events_v2 e ON e.id=r.consumption_event_id WHERE r.original_event_line_id IN (SELECT id FROM material_consumption_event_lines_v2 WHERE consumption_event_id=?) AND e.event_type='reversal'`).get(event.id).total);
  const consumedKg = kg(lines.reduce((sum, line) => sum + Number(line.consumed_kg), 0));
  return { ...event, lines, consumed_kg: consumedKg, reversed_kg: reversedKg, reversal_status: reversedKg <= 0 ? 'not_reversed' : (reversedKg >= consumedKg ? 'fully_reversed' : 'partially_reversed') };
}

function listConsumptionEvents(db, { material_requirement_id, item_id } = {}) {
  const clauses = []; const params = [];
  if (material_requirement_id !== undefined) { clauses.push('material_requirement_id=?'); params.push(Number(material_requirement_id)); }
  if (item_id !== undefined) { clauses.push('item_id=?'); params.push(Number(item_id)); }
  if (!clauses.length) fail('requirement_or_item_required');
  return db.prepare(`SELECT id FROM material_consumption_events_v2 WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...params).map(row => getConsumptionEvent(db, row.id));
}

function reverseConsumptionEvent(db, input = {}) {
  const originalEventId = Number(input.original_event_id ?? input.originalEventId);
  const idempotencyKey = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim();
  const lines = normalizeReportLines((input.lines || []).map(line => ({ ...line, allocation_plan_line_id: line.original_event_line_id ?? line.originalEventLineId })));
  if (!idempotencyKey) fail('idempotency_key_required');
  const payloadFingerprint = fingerprint({ operation: 'reverse', original_event_id: originalEventId, lines });
  const reverse = db.transaction(() => {
    const replay = db.prepare('SELECT * FROM material_consumption_events_v2 WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) { if (replay.payload_fingerprint !== payloadFingerprint) fail('idempotency_key_conflict'); return getConsumptionEvent(db, replay.id); }
    const original = db.prepare("SELECT * FROM material_consumption_events_v2 WHERE id=? AND event_type='consumption'").get(originalEventId);
    if (!original) fail('consumption_event_required');
    lifecycleV2Requirement(db, original.material_requirement_id);
    const originalLines = new Map(db.prepare('SELECT * FROM material_consumption_event_lines_v2 WHERE consumption_event_id=?').all(original.id).map(row => [row.id, row]));
    const resolved = lines.map(line => {
      const source = originalLines.get(line.allocationPlanLineId);
      if (!source || source.raw_material_id !== line.rawMaterialId) fail('invalid_reversal_line');
      const reversed = kg(db.prepare(`SELECT COALESCE(SUM(l.consumed_kg),0) AS total FROM material_consumption_event_lines_v2 l
        JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id WHERE l.original_event_line_id=? AND e.event_type='reversal'`).get(source.id).total);
      if (line.consumedKg > kg(Number(source.consumed_kg) - reversed)) fail('reversal_exceeds_consumption');
      return { source, consumedKg: line.consumedKg };
    });
    const result = db.prepare(`INSERT INTO material_consumption_events_v2
      (event_uid,event_type,idempotency_key,payload_fingerprint,original_event_id,material_requirement_id,requirement_uid,order_id,item_id,approved_by,reason)
      VALUES (?, 'reversal', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), idempotencyKey, payloadFingerprint, original.id, original.material_requirement_id, original.requirement_uid, original.order_id, original.item_id, input.reversed_by ?? input.reversedBy, input.reason ?? null);
    const insert = db.prepare(`INSERT INTO material_consumption_event_lines_v2
      (consumption_event_id,original_event_line_id,allocation_plan_id,allocation_plan_line_id,raw_material_id,consumed_kg) VALUES (?,?,?,?,?,?)`);
    const update = db.prepare('UPDATE raw_material SET weight_used=ROUND(weight_used - ?,3) WHERE id=? AND weight_used>=?');
    for (const row of resolved) { insert.run(result.lastInsertRowid, row.source.id, row.source.allocation_plan_id, row.source.allocation_plan_line_id, row.source.raw_material_id, row.consumedKg); if (!update.run(row.consumedKg, row.source.raw_material_id, row.consumedKg).changes) fail('reversal_exceeds_lot_usage'); }
    return getConsumptionEvent(db, result.lastInsertRowid);
  });
  return reverse.immediate();
}

module.exports = { MaterialConsumptionError, createConsumptionReport, updateConsumptionReport, cancelConsumptionReport, approveConsumptionReport, reverseConsumptionEvent, getConsumptionReport, getConsumptionEvent, listConsumptionEvents, consumedForAllocationLine };
