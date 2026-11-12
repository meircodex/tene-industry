'use strict';

const crypto = require('node:crypto');
const { normalizeDiameter } = require('./materialCatalog');
const { bendingShapeColumns, MATERIAL_TYPES } = require('./inventory');

class PendingReceiptError extends Error { constructor(code) { super(code); this.name = 'PendingReceiptError'; this.code = code; } }
const fail = code => { throw new PendingReceiptError(code); };
const kg = value => Number(Number(value || 0).toFixed(3));
const stable = value => JSON.stringify(value);
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const positive = (value, code) => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) fail(code); const rounded=kg(n); if(rounded<=0)fail(code); return rounded; };

function normalizeLines(lines = []) {
  if (!Array.isArray(lines) || !lines.length) fail('receipt_lines_required');
  const seen = new Set();
  return lines.map((row, index) => {
    const sourceLineRef = String(row.source_line_ref ?? row.sourceLineRef ?? index + 1);
    if (seen.has(sourceLineRef)) fail('duplicate_source_line_ref'); seen.add(sourceLineRef);
    const materialType = String(row.material_type ?? row.materialType ?? '');
    if (!MATERIAL_TYPES.has(materialType)) fail('invalid_material_type');
    const diameter = normalizeDiameter(row.diameter);
    if (!diameter) fail('invalid_diameter');
    const shape = bendingShapeColumns(row);
    return { sourceLineRef, materialType, diameter, lotNumber: row.lot_number ?? row.lotNumber ?? row.heat_number ?? row.heatNumber ?? null,
      certificateNum: row.certificate_num ?? row.certificateNum ?? null, grade: row.grade ?? null,
      standardCode: row.standard_code ?? row.standardCode ?? null, nominalLengthMm: Number(row.nominal_length_mm ?? row.nominalLengthMm) || null,
      weightReceived: positive(row.weight_received ?? row.weightReceived ?? row.weight_kg, 'invalid_weight_received'),
      purchasePrice: Number(row.purchase_price ?? row.purchasePrice) || 0, warehouseLoc: row.warehouse_loc ?? row.warehouseLoc ?? null,
      shape, notes: row.notes ?? null, catalogItemId: Number(row.catalog_item_id ?? row.catalogItemId) || null };
  });
}

function getReceipt(db, id) {
  const receipt = db.prepare('SELECT * FROM pending_raw_material_receipts_v2 WHERE id=?').get(Number(id));
  if (!receipt) return null;
  const lines = db.prepare('SELECT * FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id=? ORDER BY id').all(receipt.id);
  return { ...receipt, lines, duplicate_warning: duplicateWarning(db, receipt, lines) };
}

function duplicateWarning(db, receipt, lines) {
  const matches = [];
  for (const line of lines) {
    if (!line.lot_number || !receipt.delivery_note_num) continue;
    const existing = db.prepare(`SELECT id FROM raw_material WHERE supplier_id IS ? AND lot_number=? AND id<>COALESCE(?, -1) LIMIT 1`)
      .get(receipt.supplier_id ?? null, line.lot_number, line.created_raw_material_id ?? null);
    if (existing) matches.push({ line_id: line.id, raw_material_id: existing.id });
  }
  return matches.length ? { suspected: true, matches } : { suspected: false, matches: [] };
}

function createDraft(db, input = {}) {
  const sourceType = String(input.source_type ?? input.sourceType ?? 'manual');
  if (!['manual', 'ocr', 'purchase_order'].includes(sourceType)) fail('invalid_receipt_source');
  const idempotencyKey = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim(); if (!idempotencyKey) fail('idempotency_key_required');
  const lines = normalizeLines(input.lines);
  const payload = { sourceType, sourceRef: input.source_ref ?? input.sourceRef ?? null, supplierId: input.supplier_id ?? input.supplierId ?? null, deliveryNoteNum: input.delivery_note_num ?? input.deliveryNoteNum ?? null, lines };
  const payloadFingerprint = fingerprint(payload);
  const tx = db.transaction(() => {
    const replay = db.prepare("SELECT * FROM pending_raw_material_receipts_v2 WHERE idempotency_key=?").get(idempotencyKey);
    if (replay) { if (replay.payload_fingerprint !== payloadFingerprint) fail('idempotency_key_conflict'); return getReceipt(db, replay.id); }
    const result = db.prepare(`INSERT INTO pending_raw_material_receipts_v2
      (receipt_uid,source_type,source_ref,supplier_id,supplier_name,delivery_note_num,notes,created_by,idempotency_key,payload_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), sourceType, input.source_ref ?? input.sourceRef ?? null,
      input.supplier_id ?? input.supplierId ?? null, input.supplier_name ?? input.supplierName ?? null,
      input.delivery_note_num ?? input.deliveryNoteNum ?? null, input.notes ?? null, input.created_by ?? input.createdBy ?? null, idempotencyKey, payloadFingerprint);
    const insert = db.prepare(`INSERT INTO pending_raw_material_receipt_lines_v2
      (receipt_id,source_line_ref,material_type,diameter,lot_number,certificate_num,grade,standard_code,nominal_length_mm,weight_received,purchase_price,warehouse_loc,bending_shape_name,bending_shape_segments,bending_shape_source,bending_shape_confidence,notes,catalog_item_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const line of lines) insert.run(result.lastInsertRowid, line.sourceLineRef, line.materialType, line.diameter.numeric, line.lotNumber, line.certificateNum, line.grade, line.standardCode, line.nominalLengthMm, line.weightReceived, line.purchasePrice, line.warehouseLoc, line.shape.name, line.shape.segments, line.shape.source, line.shape.confidence, line.notes, line.catalogItemId || null);
    db.prepare('INSERT INTO pending_raw_material_receipt_events_v2 (receipt_id,event_type,idempotency_key,payload_fingerprint,actor_id,details_json) VALUES (?,?,?,?,?,?)')
      .run(result.lastInsertRowid, 'created', `create:${idempotencyKey}`, payloadFingerprint, input.created_by ?? input.createdBy ?? null, JSON.stringify({ source_type: sourceType }));
    return getReceipt(db, result.lastInsertRowid);
  }); return tx.immediate();
}

function updateDraft(db, input = {}) {
  const receiptId = Number(input.receipt_id ?? input.receiptId); const lines = normalizeLines(input.lines);
  const tx = db.transaction(() => {
    const receipt = db.prepare("SELECT * FROM pending_raw_material_receipts_v2 WHERE id=? AND status='draft'").get(receiptId); if (!receipt) fail('draft_receipt_required');
    db.prepare('DELETE FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id=?').run(receiptId);
    const key = `update:${receiptId}:${crypto.randomUUID()}`;
    const insert = db.prepare(`INSERT INTO pending_raw_material_receipt_lines_v2 (receipt_id,source_line_ref,material_type,diameter,lot_number,certificate_num,grade,standard_code,nominal_length_mm,weight_received,purchase_price,warehouse_loc,bending_shape_name,bending_shape_segments,bending_shape_source,bending_shape_confidence,notes,catalog_item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const line of lines) insert.run(receiptId,line.sourceLineRef,line.materialType,line.diameter.numeric,line.lotNumber,line.certificateNum,line.grade,line.standardCode,line.nominalLengthMm,line.weightReceived,line.purchasePrice,line.warehouseLoc,line.shape.name,line.shape.segments,line.shape.source,line.shape.confidence,line.notes,line.catalogItemId || null);
    db.prepare('UPDATE pending_raw_material_receipts_v2 SET notes=COALESCE(?,notes),updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.notes ?? null, receiptId);
    db.prepare('INSERT INTO pending_raw_material_receipt_events_v2 (receipt_id,event_type,idempotency_key,payload_fingerprint,actor_id,details_json) VALUES (?,?,?,?,?,?)').run(receiptId,'updated',key,fingerprint({ lines }),input.updated_by ?? input.updatedBy ?? null,JSON.stringify({ line_count: lines.length }));
    return getReceipt(db, receiptId);
  }); return tx.immediate();
}

function decideReceipt(db, input = {}, status) {
  const id = Number(input.receipt_id ?? input.receiptId); const key = String(input.idempotency_key ?? input.idempotencyKey ?? '').trim(); if (!key) fail('idempotency_key_required');
  const tx = db.transaction(() => {
    const eventPayload = { action: status, receipt_id: id, confirm_duplicate: input.confirm_duplicate === true || input.confirmDuplicate === true, notes: input.notes ?? null };
    const eventFingerprint = fingerprint(eventPayload);
    const replay = db.prepare('SELECT * FROM pending_raw_material_receipt_events_v2 WHERE idempotency_key=?').get(key);
    if (replay) { if (replay.payload_fingerprint !== eventFingerprint) fail('idempotency_key_conflict'); return getReceipt(db, replay.receipt_id); }
    const receipt = db.prepare("SELECT * FROM pending_raw_material_receipts_v2 WHERE id=? AND status='draft'").get(id); if (!receipt) fail('draft_receipt_required');
    const lines = db.prepare('SELECT * FROM pending_raw_material_receipt_lines_v2 WHERE receipt_id=? ORDER BY id').all(id);
    const warning = duplicateWarning(db, receipt, lines); if (status === 'approved' && warning.suspected && input.confirm_duplicate !== true && input.confirmDuplicate !== true) fail('duplicate_confirmation_required');
    if (status === 'approved') {
      const insert = db.prepare(`INSERT INTO raw_material (material_type,diameter,catalog_item_id,verification_status,supplier_id,lot_number,certificate_num,grade,standard_code,nominal_length_mm,spec_exception,received_date,weight_received,purchase_price,warehouse_loc,bending_shape_name,bending_shape_segments,bending_shape_source,bending_shape_confidence,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const link = db.prepare('UPDATE pending_raw_material_receipt_lines_v2 SET created_raw_material_id=?,spec_snapshot_json=?,spec_exceptions_json=? WHERE id=?');
      for (const line of lines) {
        const diameter = normalizeDiameter(line.diameter); const catalog = diameter && db.prepare("SELECT status FROM diameter_catalog WHERE diameter_key=?").get(diameter.key);
        const item = line.catalog_item_id ? db.prepare("SELECT * FROM catalog_items WHERE id=? AND item_kind='raw_material' AND active=1").get(line.catalog_item_id) : null;
        const exceptions = []; if (!catalog || catalog.status !== 'active') exceptions.push('diameter_not_active');
        if (!line.catalog_item_id) exceptions.push('catalog_item_unidentified');
        else if (!item) exceptions.push('catalog_item_not_found');
        if (item) for (const [field, actual] of [['diameter_key', diameter.key],['supply_form',line.material_type],['steel_grade',line.grade],['standard_code',line.standard_code],['nominal_length_mm',line.nominal_length_mm]]) {
          if (item[field] == null) continue;
          if (actual == null || actual === '') exceptions.push(`catalog_${field}_missing`);
          else if (String(item[field]) !== String(actual)) exceptions.push(`catalog_${field}_mismatch`);
        }
        // Operational stock is determined by the validated type, diameter and weight.
        // Optional catalog metadata never quarantines an otherwise valid receipt.
        const matchedItem = exceptions.some(code=>code.startsWith('catalog_')) ? null : item;
        const verification = 'approved'; const snapshot = matchedItem ? { id:matchedItem.id,sku:matchedItem.sku,diameter_key:matchedItem.diameter_key,supply_form:matchedItem.supply_form,steel_grade:matchedItem.steel_grade,standard_code:matchedItem.standard_code,nominal_length_mm:matchedItem.nominal_length_mm } : null;
        const lot = insert.run(line.material_type, line.diameter, matchedItem?.id || null, verification, receipt.supplier_id, line.lot_number, line.certificate_num, line.grade, line.standard_code, line.nominal_length_mm, exceptions.length ? 1 : 0, new Date().toISOString().slice(0,10), line.weight_received, line.purchase_price, line.warehouse_loc, line.bending_shape_name, line.bending_shape_segments, line.bending_shape_source, line.bending_shape_confidence, line.notes);
        link.run(lot.lastInsertRowid, JSON.stringify(snapshot), JSON.stringify(exceptions), line.id);
      }
    }
    db.prepare('UPDATE pending_raw_material_receipts_v2 SET status=?,decided_by=?,decision_notes=?,decided_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,input.decided_by ?? input.decidedBy ?? null,input.notes ?? null,id);
    db.prepare('INSERT INTO pending_raw_material_receipt_events_v2 (receipt_id,event_type,idempotency_key,payload_fingerprint,actor_id,details_json) VALUES (?,?,?,?,?,?)').run(id,status,key,eventFingerprint,input.decided_by ?? input.decidedBy ?? null,JSON.stringify({ duplicate_warning: warning }));
    return getReceipt(db,id);
  }); return tx.immediate();
}
function approveReceipt(db, input) { return decideReceipt(db,input,'approved'); }
function rejectReceipt(db, input) { return decideReceipt(db,input,'rejected'); }
function cancelDraft(db, input = {}) { return decideReceipt(db,{...input, idempotency_key: input.idempotency_key ?? input.idempotencyKey ?? `cancel:${input.receipt_id ?? input.receiptId}`},'cancelled'); }
function listReceipts(db, { status = 'draft' } = {}) { return db.prepare('SELECT id FROM pending_raw_material_receipts_v2 WHERE status=? ORDER BY id DESC').all(status).map(row => getReceipt(db,row.id)); }
module.exports = { PendingReceiptError, createDraft, updateDraft, approveReceipt, rejectReceipt, cancelDraft, getReceipt, listReceipts };
