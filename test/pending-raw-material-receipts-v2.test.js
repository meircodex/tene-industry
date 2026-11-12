'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const receipts = require('../services/pendingRawMaterialReceiptV2');

function db() { const value = new Database(':memory:'); value.pragma('foreign_keys=ON'); ensureCoreSchema(value); return value; }
function line(overrides = {}) { return { source_line_ref: '1', material_type: 'coil', diameter: 12, lot_number: 'HEAT-1', certificate_num: 'CERT-1', grade: 'B500B', weight_received: 100, ...overrides }; }
function fullCatalog(value) {
  value.prepare("INSERT OR IGNORE INTO diameter_catalog (diameter_key,diameter_display,status) VALUES ('12','Ø12','active'),('14','Ø14','active')").run();
  return value.prepare("INSERT INTO catalog_items (sku,item_kind,name,supply_form,diameter_key,steel_grade,standard_code,nominal_length_mm) VALUES ('RB-12-FULL','raw_material','RB 12','coil','12','B500B','SI-4466',600)").run().lastInsertRowid;
}
function approveSpec(value, overrides = {}) {
  const itemId = fullCatalog(value); const draft = receipts.createDraft(value, { source_type: 'manual', idempotency_key: `spec-${Math.random()}`, lines: [line({ catalog_item_id: itemId, standard_code: 'SI-4466', nominal_length_mm: 600, ...overrides })] });
  receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: `approve-${Math.random()}` });
  const receiptLine = value.prepare('SELECT * FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id=?').get(draft.id); const lot = value.prepare('SELECT * FROM raw_material WHERE id=?').get(receiptLine.created_raw_material_id);
  return { receiptLine, lot };
}
function assertSpec(value, overrides, expected) {
 const {receiptLine,lot}=approveSpec(value,overrides);
 assert.equal(lot.verification_status,'approved');assert.equal(lot.catalog_item_id,null);
 assert.equal(lot.weight_received,100);assert.equal(JSON.parse(receiptLine.spec_snapshot_json),null);
 assert.ok(JSON.parse(receiptLine.spec_exceptions_json).includes(expected));value.close();
}

test('draft receipt is separate from inventory and approval creates an approved lot', () => {
  const value = db(); value.prepare("INSERT INTO diameter_catalog (diameter_key,diameter_display,status) VALUES ('12','Ø12','active')").run();
  const catalogItemId = value.prepare("INSERT INTO catalog_items (sku,item_kind,name,supply_form,diameter_key,steel_grade) VALUES ('RB-12','raw_material','RB 12','coil','12','B500B')").run().lastInsertRowid;
  const draft = receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'draft-1', lines: [line({ catalog_item_id: catalogItemId })] });
  assert.equal(value.prepare('SELECT COUNT(*) AS n FROM raw_material').get().n, 0); assert.equal(draft.status, 'draft');
  const approved = receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-1', decided_by: 1 });
  assert.equal(approved.status, 'approved'); const lot = value.prepare('SELECT * FROM raw_material').get(); assert.equal(lot.verification_status, 'approved'); assert.equal(lot.weight_used, 0); value.close();
});
test('valid diameter type and weight enter usable stock without an optional catalog link', () => {
  const value = db();
  value.prepare("INSERT INTO diameter_catalog (diameter_key,diameter_display,status) VALUES ('12','Ø12','active')").run();
  const draft = receipts.createDraft(value, { source_type: 'ocr', source_ref: 'doc-1', idempotency_key: 'ocr-1', lines: [line()] });
  const approved = receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-ocr', decided_by: 1 });
  const receiptLine = value.prepare('SELECT * FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id=?').get(draft.id);
  const lot = value.prepare('SELECT * FROM raw_material').get();
  assert.equal(approved.status, 'approved');
  assert.equal(value.prepare('SELECT COUNT(*) AS n FROM raw_material').get().n, 1);
  assert.equal(lot.verification_status, 'approved');
  assert.equal(lot.spec_exception, 1);
  assert.equal(lot.catalog_item_id, null);
  assert.equal(JSON.parse(receiptLine.spec_snapshot_json), null);
  const exceptions = JSON.parse(receiptLine.spec_exceptions_json);
  assert.deepEqual(exceptions, ['catalog_item_unidentified']);
  value.close();
});
test('duplicate is a warning and requires explicit approval confirmation', () => {
  const value = db(); value.prepare("INSERT INTO diameter_catalog (diameter_key,diameter_display,status) VALUES ('12','Ø12','active')").run();
  value.prepare("INSERT INTO suppliers (id,name) VALUES (1,'S')").run(); value.prepare("INSERT INTO raw_material (diameter,material_type,supplier_id,lot_number,weight_received) VALUES (12,'coil',1,'HEAT-1',1)").run();
  const draft = receipts.createDraft(value, { source_type: 'purchase_order', supplier_id: 1, delivery_note_num: 'DN-1', idempotency_key: 'po-1', lines: [line()] });
  assert.throws(() => receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-duplicate', decided_by: 1 }), /duplicate_confirmation_required/);
  const approved = receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-duplicate-ok', confirm_duplicate: true, decided_by: 1 }); assert.equal(approved.status, 'approved'); value.close();
});
test('idempotent creation replay is safe and conflicting payload is rejected', () => {
  const value = db(); const first = receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'same', lines: [line()] });
  assert.equal(receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'same', lines: [line()] }).id, first.id);
  assert.throws(() => receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'same', lines: [line({ weight_received: 99 })] }), /idempotency_key_conflict/); value.close();
});
test('approval idempotency rejects a conflicting replay', () => {
  const value = db(); value.prepare("INSERT INTO diameter_catalog (diameter_key,diameter_display,status) VALUES ('12','Ø12','active')").run();
  const draft = receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'draft-approval', lines: [line()] });
  receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-once', decided_by: 1 });
  assert.equal(receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-once', decided_by: 1 }).status, 'approved');
  assert.throws(() => receipts.approveReceipt(value, { receipt_id: draft.id, idempotency_key: 'approve-once', confirm_duplicate: true, decided_by: 1 }), /idempotency_key_conflict/); value.close();
});

test('decision idempotency binds the action and decision payload', () => {
  const value = db();
  const draft = receipts.createDraft(value, { source_type: 'manual', idempotency_key: 'decision-draft', lines: [line()] });
  assert.equal(receipts.rejectReceipt(value, { receipt_id: draft.id, idempotency_key: 'decision-key', notes: 'certificate missing' }).status, 'rejected');
  assert.throws(() => receipts.rejectReceipt(value, { receipt_id: draft.id, idempotency_key: 'decision-key', notes: 'changed note' }), /idempotency_key_conflict/);
  assert.throws(() => receipts.cancelDraft(value, { receipt_id: draft.id, idempotency_key: 'decision-key', notes: 'certificate missing' }), /idempotency_key_conflict/);
  value.close();
});
test('full matching catalog specification is approved with a snapshot', () => { const value = db(); const { receiptLine, lot } = approveSpec(value); assert.equal(lot.verification_status, 'approved'); assert.deepEqual(JSON.parse(receiptLine.spec_exceptions_json), []); assert.equal(JSON.parse(receiptLine.spec_snapshot_json).sku, 'RB-12-FULL'); value.close(); });
test('missing catalog standard does not block stock', () => assertSpec(db(), { standard_code: null }, 'catalog_standard_code_missing'));
test('missing catalog nominal length does not block stock', () => assertSpec(db(), { nominal_length_mm: null }, 'catalog_nominal_length_mm_missing'));
test('missing catalog grade does not block stock', () => assertSpec(db(), { grade: null }, 'catalog_steel_grade_missing'));
test('mismatched catalog grade does not block stock', () => assertSpec(db(), { grade: 'B400' }, 'catalog_steel_grade_mismatch'));
test('mismatched catalog supply form does not block stock', () => assertSpec(db(), { material_type: 'straight' }, 'catalog_supply_form_mismatch'));
test('mismatched catalog diameter does not block stock', () => assertSpec(db(), { diameter: 14 }, 'catalog_diameter_key_mismatch'));

test('only required stock identity fields reject an incomplete intake before any receipt or lot is written',()=>{
 for(const changes of [{diameter:null},{diameter:-12},{material_type:null},{material_type:''},{material_type:'invalid'},{weight_received:0},{weight_received:-1},{weight_received:Infinity},{weight_received:0.0001}]){
  const value=db();assert.throws(()=>receipts.createDraft(value,{idempotency_key:'invalid-required',lines:[line(changes)]}),/invalid_diameter|invalid_material_type|invalid_weight_received/);
  assert.equal(value.prepare('SELECT COUNT(*) AS n FROM pending_raw_material_receipts_v2').get().n,0);
  assert.equal(value.prepare('SELECT COUNT(*) AS n FROM raw_material').get().n,0);value.close();
 }
});
test('manual receipt with just type diameter and weight is usable and approval replay cannot duplicate stock',()=>{
 const value=db();const draft=receipts.createDraft(value,{idempotency_key:'three-fields',lines:[{material_type:'coil',diameter:12,weight_received:60606}]});
 receipts.approveReceipt(value,{receipt_id:draft.id,idempotency_key:'three-fields-approve'});
 receipts.approveReceipt(value,{receipt_id:draft.id,idempotency_key:'three-fields-approve'});
 const lots=value.prepare('SELECT * FROM raw_material').all();assert.equal(lots.length,1);assert.equal(lots[0].verification_status,'approved');assert.equal(lots[0].weight_received,60606);assert.equal(lots[0].catalog_item_id,null);value.close();
});
