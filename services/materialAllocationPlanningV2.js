'use strict';
const { materialOnHand } = require('./materialBalance');

const crypto = require('node:crypto');

const SUPPORTED_MATERIAL_TYPES = new Set(['coil', 'straight']);

class MaterialAllocationPlanningError extends Error {
  constructor(code, message = code) { super(message); this.name = 'MaterialAllocationPlanningError'; this.code = code; }
}
const fail = code => { throw new MaterialAllocationPlanningError(code); };
const kg = value => Number(Number(value || 0).toFixed(3));
const positive = (value, code) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) fail(code); return kg(n); };
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');

function activeRequirement(db, id) {
  const requirement = db.prepare(`SELECT * FROM material_requirements_v2 WHERE id=? AND status='open'`).get(id);
  if (!requirement) fail('open_material_requirement_required');
  if (Number(requirement.lifecycle_version) !== 2 || !SUPPORTED_MATERIAL_TYPES.has(requirement.material_type)) fail('unsupported_requirement');
  const order = db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(requirement.order_id);
  if (!order || Number(order.inventory_lifecycle_version) !== 2) fail('lifecycle_v2_required');
  return requirement;
}

function lifecycleV2Requirement(db, id) {
  const requirement = db.prepare('SELECT * FROM material_requirements_v2 WHERE id=?').get(id);
  if (!requirement || Number(requirement.lifecycle_version) !== 2 || !SUPPORTED_MATERIAL_TYPES.has(requirement.material_type)) fail('lifecycle_v2_requirement_required');
  const order = db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(requirement.order_id);
  if (!order || Number(order.inventory_lifecycle_version) !== 2) fail('lifecycle_v2_required');
  return requirement;
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) fail('allocation_lines_required');
  const seen = new Set();
  return lines.map((line, index) => {
    const rawMaterialId = Number(line.raw_material_id ?? line.rawMaterialId);
    if (!Number.isSafeInteger(rawMaterialId) || rawMaterialId <= 0 || seen.has(rawMaterialId)) fail('invalid_allocation_lines');
    seen.add(rawMaterialId);
    return { rawMaterialId, allocatedKg: positive(line.allocated_kg ?? line.allocatedKg, 'invalid_allocated_kg'), sequence: index + 1 };
  });
}

function activeAllocatedForLot(db, rawMaterialId) {
  const lines = db.prepare(`SELECT l.id,l.allocated_kg FROM allocation_plan_lines_v2 l JOIN allocation_plans_v2 p ON p.id=l.allocation_plan_id
    WHERE l.raw_material_id=? AND l.status='active' AND p.status='active'`).all(rawMaterialId);
  return kg(lines.reduce((total, line) => total + Math.max(0, Number(line.allocated_kg) - consumedForAllocationLine(db, line.id)), 0));
}

function suggestionRows(db, requirement) {
  return db.prepare(`SELECT r.*
    FROM raw_material r
    WHERE r.active=1 AND COALESCE(r.verification_status,'approved')='approved'
      AND r.diameter=? AND COALESCE(r.material_type,'coil')=?
    ORDER BY date(COALESCE(r.received_date,r.created_at)) ASC, r.id ASC`).all(requirement.diameter, requirement.material_type);
}

function suggestFifoLots(db, { material_requirement_id }) {
  const requirement = activeRequirement(db, Number(material_requirement_id));
  let remaining = kg(requirement.required_kg);
  const lines = [];
  for (const row of suggestionRows(db, requirement)) {
    const free = kg(materialOnHand(row) - activeAllocatedForLot(db, row.id));
    const allocatedKg = kg(Math.min(Math.max(0, free), remaining));
    if (allocatedKg > 0) lines.push({ raw_material_id: row.id, allocated_kg: allocatedKg });
    remaining = kg(Math.max(0, remaining - allocatedKg));
  }
  return { material_requirement_id: requirement.id, requirement_uid: requirement.requirement_uid, required_kg: kg(requirement.required_kg), lines, uncovered_kg: remaining };
}

function confirmAllocationPlan(db, input = {}) {
  const requirementId = Number(input.material_requirement_id ?? input.materialRequirementId);
  const idempotencyKey = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim();
  if (!Number.isSafeInteger(requirementId) || requirementId <= 0 || !idempotencyKey) fail('idempotency_key_required');
  const lines = normalizeLines(input.lines || []);
  const payload = { material_requirement_id: requirementId, lines: lines.map(({ rawMaterialId, allocatedKg }) => ({ rawMaterialId, allocatedKg })) };
  const payloadFingerprint = fingerprint(payload);
  const create = db.transaction(payloadInput => {
    const replay = db.prepare('SELECT * FROM allocation_plans_v2 WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) {
      if (replay.payload_fingerprint !== payloadFingerprint) fail('idempotency_key_conflict');
      return getAllocationPlan(db, replay.id);
    }
    const requirement = activeRequirement(db, requirementId);
    const total = kg(lines.reduce((sum, line) => sum + line.allocatedKg, 0));
    if (total > kg(requirement.required_kg)) fail('allocation_exceeds_requirement');
    for (const line of lines) {
      const lot = db.prepare(`SELECT * FROM raw_material WHERE id=? AND active=1
        AND COALESCE(verification_status,'approved')='approved'`).get(line.rawMaterialId);
      if (!lot || Number(lot.diameter) !== Number(requirement.diameter) || String(lot.material_type || 'coil') !== requirement.material_type) fail('invalid_allocation_lot');
      const free = kg(materialOnHand(lot) - activeAllocatedForLot(db, lot.id));
      if (line.allocatedKg > free) fail('over_allocation');
    }
    const result = db.prepare(`INSERT INTO allocation_plans_v2
      (plan_uid,idempotency_key,payload_fingerprint,material_requirement_id,requirement_uid,required_kg,source_revision,spec_diameter,spec_material_type,planned_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), idempotencyKey, payloadFingerprint, requirement.id,
      requirement.requirement_uid, kg(requirement.required_kg), requirement.source_revision ?? null, requirement.diameter,
      requirement.material_type, input.planned_by ?? input.plannedBy ?? null);
    const insertLine = db.prepare(`INSERT INTO allocation_plan_lines_v2
      (allocation_plan_id,raw_material_id,allocated_kg,allocation_sequence) VALUES (?,?,?,?)`);
    for (const line of lines) insertLine.run(result.lastInsertRowid, line.rawMaterialId, line.allocatedKg, line.sequence);
    return getAllocationPlan(db, result.lastInsertRowid);
  });
  try {
    return create.immediate(payload);
  } catch (error) {
    if (/idx_allocation_plans_v2_one_active_requirement|allocation_plans_v2\.material_requirement_id/i.test(String(error.message))) fail('active_allocation_plan_exists');
    throw error;
  }
}

function getAllocationPlan(db, planId) {
  const plan = db.prepare('SELECT * FROM allocation_plans_v2 WHERE id=?').get(planId);
  if (!plan) return null;
  const lines = db.prepare(`SELECT raw_material_id,allocated_kg,status,allocation_sequence FROM allocation_plan_lines_v2
    WHERE allocation_plan_id=? ORDER BY allocation_sequence`).all(planId);
  const activeKg = kg(lines.filter(line => line.status === 'active').reduce((sum, line) => sum + Number(line.allocated_kg), 0));
  return { ...plan, lines, uncovered_kg: kg(Number(plan.required_kg) - activeKg) };
}

function releaseAllocationPlan(db, { allocation_plan_id, released_by, reason = 'released' } = {}) {
  const planId = Number(allocation_plan_id);
  const release = db.transaction(() => {
    const plan = db.prepare("SELECT * FROM allocation_plans_v2 WHERE id=? AND status='active'").get(planId);
    if (!plan) fail('active_allocation_plan_required');
    if (planHasConsumedLines(db, plan.id)) fail('allocation_has_confirmed_consumption');
    db.prepare("UPDATE allocation_plan_lines_v2 SET status='released',released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE allocation_plan_id=? AND status='active'").run(planId);
    db.prepare("UPDATE allocation_plans_v2 SET status='released',released_by=?,released_at=CURRENT_TIMESTAMP,release_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(released_by ?? null, reason, planId);
    return getAllocationPlan(db, planId);
  });
  return release.immediate();
}

function activePlanForRequirement(db, requirementId) {
  return db.prepare("SELECT * FROM allocation_plans_v2 WHERE material_requirement_id=? AND status='active'").get(requirementId);
}

function releaseAllLines(db, planId) {
  if (planHasConsumedLines(db, planId)) fail('allocation_has_confirmed_consumption');
  db.prepare("UPDATE allocation_plan_lines_v2 SET status='released',released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE allocation_plan_id=? AND status='active'").run(planId);
}

function insertReconciliationEvent(db, planId, idempotencyKey, payloadFingerprint, actorId, details) {
  db.prepare(`INSERT INTO allocation_plan_events_v2
    (allocation_plan_id,event_type,idempotency_key,payload_fingerprint,actor_id,details_json)
    VALUES (?, 'reconciled', ?, ?, ?, ?)`).run(planId, idempotencyKey, payloadFingerprint, actorId ?? null, JSON.stringify(details));
}

function reconcileAllocationPlan(db, input = {}) {
  const requirementId = Number(input.material_requirement_id ?? input.materialRequirementId);
  const idempotencyKey = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim();
  if (!Number.isSafeInteger(requirementId) || requirementId <= 0 || !idempotencyKey) fail('idempotency_key_required');
  const payload = { material_requirement_id: requirementId, operation: 'reconcile' };
  const payloadFingerprint = fingerprint(payload);
  const reconcile = db.transaction(() => {
    const replay = db.prepare('SELECT * FROM allocation_plan_events_v2 WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) {
      if (replay.payload_fingerprint !== payloadFingerprint) fail('idempotency_key_conflict');
      return getAllocationPlan(db, replay.allocation_plan_id);
    }
    const requirement = lifecycleV2Requirement(db, requirementId);
    const plan = activePlanForRequirement(db, requirementId);
    if (!plan) fail('active_allocation_plan_required');
    let action = 'preserved';
    if (requirement.status === 'cancelled') {
      releaseAllLines(db, plan.id);
      db.prepare("UPDATE allocation_plans_v2 SET status='cancelled',released_by=?,released_at=CURRENT_TIMESTAMP,release_reason='requirement_cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(input.reconciled_by ?? input.reconciledBy ?? null, plan.id);
      action = 'cancelled';
    } else if (requirement.status !== 'open' || ((plan.spec_diameter !== null && plan.spec_material_type !== null)
      && (Number(plan.spec_diameter) !== Number(requirement.diameter) || String(plan.spec_material_type) !== String(requirement.material_type)))) {
      releaseAllLines(db, plan.id);
      db.prepare("UPDATE allocation_plans_v2 SET status='superseded',released_by=?,released_at=CURRENT_TIMESTAMP,release_reason='requirement_specification_changed',updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(input.reconciled_by ?? input.reconciledBy ?? null, plan.id);
      action = 'superseded';
    } else {
      let excess = kg(activeAllocatedForPlan(db, plan.id) - Number(requirement.required_kg));
      if (excess > 0) {
        const lines = db.prepare("SELECT * FROM allocation_plan_lines_v2 WHERE allocation_plan_id=? AND status='active' ORDER BY allocation_sequence DESC, id DESC").all(plan.id);
        for (const line of lines) {
          if (excess <= 0) break;
          const allocatedKg = kg(line.allocated_kg);
          const consumedKg = consumedForAllocationLine(db, line.id);
          const releasableKg = kg(allocatedKg - consumedKg);
          if (releasableKg <= 0) continue;
          if (releasableKg <= excess && consumedKg === 0) {
            db.prepare("UPDATE allocation_plan_lines_v2 SET status='released',released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.id);
            excess = kg(excess - releasableKg);
          } else {
            const reduction = Math.min(releasableKg, excess);
            db.prepare('UPDATE allocation_plan_lines_v2 SET allocated_kg=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(kg(allocatedKg - reduction), line.id);
            excess = kg(excess - reduction);
          }
        }
        if (excess > 0) fail('requirement_below_consumed_allocation');
        action = 'reduced';
      }
      db.prepare(`UPDATE allocation_plans_v2 SET required_kg=?,source_revision=?,spec_diameter=?,spec_material_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(kg(requirement.required_kg), requirement.source_revision ?? null, requirement.diameter, requirement.material_type, plan.id);
      if (action === 'preserved' && Number(plan.required_kg) !== Number(requirement.required_kg)) action = 'increased';
    }
    insertReconciliationEvent(db, plan.id, idempotencyKey, payloadFingerprint, input.reconciled_by ?? input.reconciledBy ?? null, {
      action, requirement_status: requirement.status, required_kg: kg(requirement.required_kg), source_revision: requirement.source_revision ?? null,
    });
    return getAllocationPlan(db, plan.id);
  });
  return reconcile.immediate();
}

function activeAllocatedForPlan(db, planId) {
  return kg(db.prepare("SELECT COALESCE(SUM(allocated_kg),0) AS total FROM allocation_plan_lines_v2 WHERE allocation_plan_id=? AND status='active'").get(planId).total);
}

function consumedForAllocationLine(db, lineId) {
  return kg(db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.event_type='consumption' THEN l.consumed_kg ELSE -l.consumed_kg END),0) AS total
    FROM material_consumption_event_lines_v2 l JOIN material_consumption_events_v2 e ON e.id=l.consumption_event_id
    WHERE l.allocation_plan_line_id=?`).get(lineId).total);
}

function planHasConsumedLines(db, planId) {
  return db.prepare(`SELECT 1 FROM allocation_plan_lines_v2 l JOIN material_consumption_event_lines_v2 c ON c.allocation_plan_line_id=l.id
    JOIN material_consumption_events_v2 e ON e.id=c.consumption_event_id
    WHERE l.allocation_plan_id=? GROUP BY l.id HAVING SUM(CASE WHEN e.event_type='consumption' THEN c.consumed_kg ELSE -c.consumed_kg END)>0 LIMIT 1`).get(planId);
}

module.exports = { activeAllocatedForLot, MaterialAllocationPlanningError, suggestFifoLots, confirmAllocationPlan, reconcileAllocationPlan, releaseAllocationPlan, getAllocationPlan };
