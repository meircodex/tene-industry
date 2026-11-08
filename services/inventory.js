const MATERIAL_TYPES = new Set(['coil', 'straight', 'bent']);

function normalizeBendingShapeInput(input = {}) {
  const rawSegments = Array.isArray(input.bending_shape_segments)
    ? input.bending_shape_segments
    : (() => {
        try { return JSON.parse(input.bending_shape_segments || '[]'); }
        catch { return []; }
      })();
  const segments = rawSegments.map(segment => ({
    length_mm: Math.max(0, Number(segment.length_mm) || 0),
    angle_deg: Number(segment.angle_deg) || 180,
  })).filter(segment => segment.length_mm > 0);
  return {
    name: String(input.bending_shape_name || '').trim(),
    segments,
    source: String(input.bending_shape_source || 'manual').trim() || 'manual',
    confidence: input.bending_shape_confidence == null ? null : Number(input.bending_shape_confidence),
  };
}

function bendingShapeColumns(input = {}) {
  const shape = normalizeBendingShapeInput(input);
  return {
    name: shape.name || null,
    segments: shape.segments.length ? JSON.stringify(shape.segments) : null,
    source: shape.source,
    confidence: Number.isFinite(shape.confidence) ? shape.confidence : null,
  };
}

function normalizeReceiptReviewItem(item = {}) {
  const materialType = MATERIAL_TYPES.has(item.material_type) ? item.material_type : 'coil';
  const shape = bendingShapeColumns({
    bending_shape_name: item.bending_shape_name || item.shape_name,
    bending_shape_segments: item.bending_shape_segments || item.segments || [],
    bending_shape_source: item.bending_shape_source || 'supplier_delivery_note',
    bending_shape_confidence: item.bending_shape_confidence ?? item.confidence,
  });
  return {
    material_type: materialType,
    diameter: Number(item.diameter) || null,
    supplier_id: item.supplier_id || null,
    lot_number: item.lot_number || item.heat_number || null,
    certificate_num: item.certificate_num || null,
    grade: item.grade || 'B500B',
    received_date: item.received_date || null,
    weight_received: Number(item.weight_received ?? item.weight_kg ?? item.quantity_kg) || null,
    purchase_price: Number(item.purchase_price || 0) || 0,
    warehouse_loc: item.warehouse_loc || null,
    bending_shape_name: materialType === 'bent' ? shape.name : null,
    bending_shape_segments: materialType === 'bent' ? shape.segments : null,
    bending_shape_source: materialType === 'bent' ? shape.source : null,
    bending_shape_confidence: materialType === 'bent' ? shape.confidence : null,
    notes: item.notes || null,
  };
}

function parseReceiptReviewPayload(parsed = {}) {
  const items = Array.isArray(parsed.items) ? parsed.items.map(normalizeReceiptReviewItem) : [];
  return {
    supplier_name: parsed.supplier_name || null,
    delivery_note_num: parsed.delivery_note_num || parsed.delivery_note_number || null,
    received_date: parsed.received_date || null,
    notes: parsed.notes || null,
    items,
  };
}

module.exports = { MATERIAL_TYPES, bendingShapeColumns, normalizeBendingShapeInput, normalizeReceiptReviewItem, parseReceiptReviewPayload };
