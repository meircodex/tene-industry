'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const allocation = require('../services/materialAllocationPlanningV2');
const consumption = require('../services/materialConsumptionV2');

function db() { const value = new Database(':memory:'); value.pragma('foreign_keys=ON'); ensureCoreSchema(value); return value; }
function seed(value, { lifecycle = 2, allocationKg = 80 } = {}) {
  value.prepare('INSERT INTO orders (id,order_num,inventory_lifecycle_version) VALUES (1,?,?)').run('B3-1', lifecycle);
  value.prepare('INSERT INTO items (id,order_id,diameter,total_weight) VALUES (1,1,12,100)').run();
  value.prepare("INSERT INTO material_requirements_v2 (id,requirement_uid,order_id,item_id,lifecycle_version,diameter,material_type,required_kg,need_by_source,status,source,source_revision) VALUES (1,'b3-req',1,1,2,12,'coil',100,'unknown','open','manual','r1')").run();
  value.prepare("INSERT INTO raw_material (id,diameter,material_type,weight_received,verification_status,active) VALUES (1,12,'coil',100,'approved',1)").run();
  if (lifecycle !== 2) return {};
  const plan = allocation.confirmAllocationPlan(value, { material_requirement_id: 1, idempotency_key: 'plan', lines: [{ raw_material_id: 1, allocated_kg: allocationKg }] });
  return { plan, line: plan.lines[0] };
}
function draft(value, line, kgValue = 25) {
  return consumption.createConsumptionReport(value, { material_requirement_id: 1, created_by: 7, lines: [{ allocation_plan_line_id: line.allocation_sequence ? value.prepare('SELECT id FROM allocation_plan_lines_v2 WHERE allocation_plan_id=?').get(line.allocation_plan_id || 1)?.id : 1, raw_material_id: 1, consumed_kg: kgValue }] });
}
function allocationLineId(value) { return value.prepare('SELECT id FROM allocation_plan_lines_v2 WHERE allocation_plan_id=1').get().id; }
test('physical-count policy gates V2 approval on eligible item completion, independently of other items',()=>{
  const value=db();seed(value);const completion=require('../services/inventoryItemCompletion');
  value.exec("UPDATE orders SET created_at='2026-11-04 10:00:00'; INSERT INTO items(id,order_id,status) VALUES(2,1,'ממתין'); INSERT INTO inventory_stocktakes(id,idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(1,'physical','x','2026-11-08T20:56:41.574Z','count',1)");
  completion.activatePolicy(value,{stocktake_id:1});
  const report=consumption.createConsumptionReport(value,{material_requirement_id:1,lines:[{allocation_plan_line_id:allocationLineId(value),raw_material_id:1,consumed_kg:20}]});
  assert.throws(()=>consumption.approveConsumptionReport(value,{report_id:report.id,approved_by:9,idempotency_key:'gate'}),/item_consumption_production_incomplete/);
  value.exec("UPDATE items SET status='הושלם',completed_at='2026-11-09 10:00:00' WHERE id=1");
  consumption.approveConsumptionReport(value,{report_id:report.id,approved_by:9,idempotency_key:'gate'});assert.equal(value.prepare('SELECT weight_used FROM raw_material').get().weight_used,20);value.close();
});
test('drafts are editable/cancellable and never change stock or lock allocations', () => {
  const value = db(); seed(value); const lineId = allocationLineId(value);
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, created_by: 5, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 20 }] });
  assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 0);
  const updated = consumption.updateConsumptionReport(value, { report_id: report.id, updated_by: 5, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 30 }] });
  assert.equal(updated.lines[0].consumed_kg, 30); assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 0);
  const cancelled = consumption.cancelConsumptionReport(value, { report_id: report.id, cancelled_by: 5 });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 0); value.close();
});
test('approved reports atomically write immutable consumption and enforce idempotency/allocation limits', () => {
  const value = db(); seed(value); const lineId = allocationLineId(value);
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 40 }] });
  const event = consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'approve' });
  assert.equal(event.event_type, 'consumption'); assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 40);
  assert.equal(consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'approve' }).id, event.id);
  assert.throws(() => consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'different' }), /draft_consumption_report_required/);
  const over = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 41 }] });
  assert.throws(() => consumption.approveConsumptionReport(value, { report_id: over.id, approved_by: 9, idempotency_key: 'over' }), /consumption_exceeds_allocation/);
  value.close();
});
test('competing approvals on one allocation line allow only the remaining allocation to be consumed', () => {
  const value = db(); seed(value, { allocationKg: 50 }); const lineId = allocationLineId(value);
  const first = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 50 }] });
  const second = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 1 }] });
  consumption.approveConsumptionReport(value, { report_id: first.id, approved_by: 9, idempotency_key: 'winner' });
  assert.throws(() => consumption.approveConsumptionReport(value, { report_id: second.id, approved_by: 10, idempotency_key: 'loser' }), /consumption_exceeds_allocation/);
  assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 50);
  assert.equal(value.prepare("SELECT COUNT(*) AS n FROM material_consumption_events_v2 WHERE event_type='consumption'").get().n, 1);
  value.close();
});
test('partial reversals are append-only and cannot exceed original consumption', () => {
  const value = db(); seed(value); const lineId = allocationLineId(value);
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 50 }] });
  const event = consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'consume-50' });
  const originalLine = event.lines[0];
  consumption.reverseConsumptionEvent(value, { original_event_id: event.id, reversed_by: 1, idempotency_key: 'reverse-20', lines: [{ original_event_line_id: originalLine.id, raw_material_id: 1, consumed_kg: 20 }] });
  assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 30);
  assert.equal(consumption.getConsumptionEvent(value, event.id).reversal_status, 'partially_reversed');
  assert.equal(consumption.listConsumptionEvents(value, { material_requirement_id: 1 }).find(row => row.id === event.id).reversal_status, 'partially_reversed');
  assert.equal(consumption.listConsumptionEvents(value, { item_id: 1 }).find(row => row.id === event.id).reversal_status, 'partially_reversed');
  assert.throws(() => consumption.reverseConsumptionEvent(value, { original_event_id: event.id, reversed_by: 1, idempotency_key: 'reverse-too-much', lines: [{ original_event_line_id: originalLine.id, raw_material_id: 1, consumed_kg: 31 }] }), /reversal_exceeds_consumption/);
  assert.equal(value.prepare('SELECT COUNT(*) AS n FROM material_consumption_events_v2').get().n, 2); value.close();
});
test('full reversal is projected from append-only reversal lines', () => {
  const value = db(); seed(value); const lineId = allocationLineId(value);
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 20 }] });
  const event = consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'full-consume' });
  consumption.reverseConsumptionEvent(value, { original_event_id: event.id, reversed_by: 1, idempotency_key: 'full-reverse', lines: [{ original_event_line_id: event.lines[0].id, raw_material_id: 1, consumed_kg: 20 }] });
  assert.equal(consumption.getConsumptionEvent(value, event.id).reversal_status, 'fully_reversed'); assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 0); value.close();
});
test('one approved report can consume explicitly from multiple allocated lots', () => {
  const value = db();
  value.prepare("INSERT INTO orders (id,order_num,inventory_lifecycle_version) VALUES (1,'B3-MULTI',2)").run(); value.prepare('INSERT INTO items (id,order_id,diameter,total_weight) VALUES (1,1,12,100)').run();
  value.prepare("INSERT INTO material_requirements_v2 (id,requirement_uid,order_id,item_id,lifecycle_version,diameter,material_type,required_kg,need_by_source,status,source) VALUES (1,'multi',1,1,2,12,'coil',100,'unknown','open','manual')").run();
  for (const id of [1, 2]) value.prepare("INSERT INTO raw_material (id,diameter,material_type,weight_received,verification_status,active) VALUES (?,12,'coil',50,'approved',1)").run(id);
  allocation.confirmAllocationPlan(value, { material_requirement_id: 1, idempotency_key: 'multi-plan', lines: [{ raw_material_id: 1, allocated_kg: 50 }, { raw_material_id: 2, allocated_kg: 50 }] });
  const lines = value.prepare('SELECT id,raw_material_id FROM allocation_plan_lines_v2 ORDER BY id').all();
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: lines.map((line, index) => ({ allocation_plan_line_id: line.id, raw_material_id: line.raw_material_id, consumed_kg: index ? 30 : 20 })) });
  const event = consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'multi-approve' });
  assert.equal(event.lines.length, 2); assert.deepEqual(value.prepare('SELECT id,weight_used FROM raw_material ORDER BY id').all(), [{ id: 1, weight_used: 20 }, { id: 2, weight_used: 30 }]); value.close();
});
test('lifecycle-v1 is fail-closed and B2 cannot release consumed allocation after requirement cancellation', () => {
  const value = db(); const { line } = seed(value); const lineId = allocationLineId(value);
  const report = consumption.createConsumptionReport(value, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: lineId, raw_material_id: 1, consumed_kg: 10 }] });
  consumption.approveConsumptionReport(value, { report_id: report.id, approved_by: 9, idempotency_key: 'consume' });
  assert.throws(() => allocation.releaseAllocationPlan(value, { allocation_plan_id: 1 }), /allocation_has_confirmed_consumption/);
  value.prepare("UPDATE material_requirements_v2 SET status='cancelled' WHERE id=1").run();
  assert.throws(() => allocation.reconcileAllocationPlan(value, { material_requirement_id: 1, idempotency_key: 'cancel-after-consumption' }), /allocation_has_confirmed_consumption/);
  assert.equal(value.prepare('SELECT weight_used FROM raw_material WHERE id=1').get().weight_used, 10);
  value.close();
  const legacy = db(); seed(legacy, { lifecycle: 1 });
  assert.throws(() => consumption.createConsumptionReport(legacy, { material_requirement_id: 1, lines: [{ allocation_plan_line_id: 1, raw_material_id: 1, consumed_kg: 1 }] }), /lifecycle_v2_required/); legacy.close();
});
