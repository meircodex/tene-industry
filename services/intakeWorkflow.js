const crypto = require('crypto');
const { normalizeCustomerTaxId } = require('./customerIdentity');
const { buildFullShapeSnapshot, buildMachineProfilesPlaceholder } = require('./shapeSnapshot');
const { mapOcrItemToShapeSnapshot } = require('./ocrShapeSnapshotMapper');
const { rebarKgPerMeter } = require('../constants');
const { normalizeSpiralParams, spiralCutLengthMm } = require('../modules/steel-rebar/shapes');

const SUPPORTED_DIAMETERS = new Set([6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40]);
const UNCERTAIN_RE = /review|required|unclear|uncertain|verify|ambiguous|not clear|missing|unknown|guess|approx|sketch|dimension|reported total|segment sum|length surplus|דורש|בדיקה|לא ברור/i;

function normalizeReviewNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter(note => note && typeof note === 'object' && !Array.isArray(note))
    .map(note => ({
      scope: note.scope || 'order',
      field: String(note.field || 'general'),
      severity: note.severity || 'review',
      code: note.code || 'needs_review',
      message: String(note.message || 'Review required'),
      value: note.value === undefined ? null : note.value,
      source: note.source || 'intake',
      item_index: Number.isFinite(Number(note.item_index)) ? Number(note.item_index) : null,
    }));
}

function pushReviewNote(notes, note) {
  const normalized = normalizeReviewNotes([note])[0];
  if (!normalized) return;
  const key = [normalized.scope, normalized.field, normalized.code, normalized.item_index].join('|');
  if (!notes.some(existing => [existing.scope, existing.field, existing.code, existing.item_index].join('|') === key)) {
    notes.push(normalized);
  }
}

function hasUncertainty(value) {
  return UNCERTAIN_RE.test(String(value || ''));
}

function parsedDeliveryDate(parsed = {}) {
  return parsed.delivery_date || parsed.deliveryDate || parsed.required_delivery_date || parsed.requiredDeliveryDate || '';
}

function itemHasDimensions(item = {}) {
  if (Array.isArray(item.sides) && item.sides.some(value => Number(value) > 0)) return true;
  if (Array.isArray(item.segments) && item.segments.some(segment => Number(segment.length_mm ?? segment.length_cm ?? segment.length) > 0)) return true;
  if (Number(item.length ?? item.total_length_mm ?? item.total_length_cm) > 0) return true;
  if (normalizeSpiralParams(item).isSpiral) return true;
  return false;
}

function buildStructuredReviewNotes(parsed = {}, options = {}) {
  const notes = normalizeReviewNotes(parsed.review_notes || parsed.reviewNotes);
  const sourceIdentity = options.sourceIdentity || parsed.source_identity || parsed.sourceIdentity || null;
  const sourceSystem = sourceIdentity?.source_system || parsed.source_system || parsed.sourceSystem || '';
  const externalId = sourceIdentity?.external_id || parsed.external_id || parsed.externalId || '';
  const customerName = cleanRecognizedCustomerName(parsed.customer_name || parsed.customerName || parsed.name || '');
  const deliveryDate = parsedDeliveryDate(parsed);
  const siteOrProject = parsed.site_id || parsed.siteId || parsed.site_name || parsed.siteName || parsed.project_id || parsed.projectId || parsed.project_name || parsed.projectName || parsed.delivery_address || parsed.deliveryAddress || '';

  if (!sourceSystem || !externalId) {
    pushReviewNote(notes, { scope: 'order', field: 'source_identity', code: 'missing_source_identity', message: 'source_system and external_id were not both provided; duplicate protection cannot be applied.', value: { source_system: sourceSystem || null, external_id: externalId || null }, source: 'intake' });
  }
  if (!customerName || hasUncertainty(parsed.customer_note || parsed.customerNote || parsed.notes)) {
    pushReviewNote(notes, { scope: 'order', field: 'customer', code: customerName ? 'uncertain_customer' : 'missing_customer', message: customerName ? 'Customer value requires review.' : 'Customer was not confidently identified.', value: customerName || null, source: 'intake' });
  }
  if (!siteOrProject || hasUncertainty(parsed.site_note || parsed.project_note || parsed.delivery_address_note || parsed.notes)) {
    pushReviewNote(notes, { scope: 'order', field: 'site_project', code: siteOrProject ? 'uncertain_site_project' : 'missing_site_project', message: siteOrProject ? 'Site/project value requires review.' : 'Site/project was not confidently identified.', value: siteOrProject || null, source: 'intake' });
  }
  if (!deliveryDate || hasUncertainty(parsed.delivery_date_note || parsed.deliveryDateNote || parsed.notes)) {
    pushReviewNote(notes, { scope: 'order', field: 'delivery_date', code: deliveryDate ? 'uncertain_delivery_date' : 'missing_delivery_date', message: deliveryDate ? 'Delivery date requires review.' : 'Delivery date was not confidently identified.', value: deliveryDate || null, source: 'intake' });
  }

  (parsed.items || []).forEach((item, index) => {
    const itemNote = String(item.note || item.notes || '');
    const quantity = Number(item.qty ?? item.quantity);
    const diameter = Number(item.diameter);
    const shape = item.shapeName || item.shape_name || item.shape || item.shapeId || '';
    if (!(quantity > 0) || hasUncertainty(item.quantity_note || item.quantityNote || itemNote)) {
      pushReviewNote(notes, { scope: 'item', item_index: index, field: 'quantity', code: quantity > 0 ? 'uncertain_quantity' : 'missing_quantity', message: quantity > 0 ? 'Quantity requires review.' : 'Quantity was not confidently identified.', value: Number.isFinite(quantity) ? quantity : null, source: 'intake' });
    }
    if (!SUPPORTED_DIAMETERS.has(diameter) || hasUncertainty(item.diameter_note || item.diameterNote || itemNote)) {
      pushReviewNote(notes, { scope: 'item', item_index: index, field: 'diameter', code: SUPPORTED_DIAMETERS.has(diameter) ? 'uncertain_diameter' : 'invalid_diameter', message: SUPPORTED_DIAMETERS.has(diameter) ? 'Diameter requires review.' : 'Diameter is missing or not supported.', value: Number.isFinite(diameter) ? diameter : null, source: 'intake' });
    }
    if (!shape || hasUncertainty(item.shape_note || item.shapeNote || item.shape_description || item.shapeDescription || itemNote)) {
      pushReviewNote(notes, { scope: 'item', item_index: index, field: 'shape', code: shape ? 'uncertain_shape' : 'missing_shape', message: shape ? 'Shape requires review.' : 'Shape was not confidently identified.', value: shape || null, source: 'intake' });
    }
    if (!itemHasDimensions(item) || hasUncertainty(item.dimensions_note || item.dimensionsNote || item.length_note || item.lengthNote || itemNote)) {
      pushReviewNote(notes, { scope: 'item', item_index: index, field: 'dimensions', code: itemHasDimensions(item) ? 'uncertain_dimensions' : 'missing_dimensions', message: itemHasDimensions(item) ? 'Dimensions require review.' : 'Dimensions were not confidently identified.', value: item.length ?? item.total_length_mm ?? item.total_length_cm ?? null, source: 'intake' });
    }
  });

  return notes;
}

function withStructuredReviewNotes(parsed = {}, options = {}) {
  const sourceNotes = buildStructuredReviewNotes(parsed, options);
  const items = (parsed.items || []).map((item, index) => ({
    ...item,
    review_notes: sourceNotes.filter(note => note.scope === 'item' && note.item_index === index),
  }));
  return {
    ...parsed,
    source_identity: options.sourceIdentity || parsed.source_identity || parsed.sourceIdentity || null,
    review_notes: sourceNotes,
    items,
  };
}


function importCell(row, aliases) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase().replace(/[\s_-]+/g, ''), value])
  );
  for (const alias of aliases) {
    const value = normalized[String(alias).toLowerCase().replace(/[\s_-]+/g, '')];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

const STRUCT_ELEMENT_ALIASES = [
  'מיקום',
  'שם אלמנט',
  'שם האלמנט',
  'אלמנט',
  'מיקום אלמנט',
  'שייך ל',
  'struct_element',
  'structElement',
  'elementName',
  'element_name',
  'element',
  'location',
  'mark',
  'item_label',
  'itemLabel',
];

function parseDelimitedRows(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some(value => String(value).trim())) records.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => String(value).trim())) records.push(row);
  if (!records.length) throw Object.assign(new Error('CSV file is empty'), { statusCode: 400 });
  const headers = records.shift().map(header => String(header).trim());
  return records.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function buildOrderImportPreview(buffer, { orderExists = () => false, sourceIdentity = null } = {}) {
  const rows = parseDelimitedRows(buffer);
  const groups = new Map();
  const errors = [];

  rows.forEach((row, index) => {
    const sourceOrderNum = String(importCell(row, ['order_num', 'ordernum', 'order', 'מספרהזמנה', 'הזמנה']) || '').trim();
    const customerName = String(importCell(row, ['customer_name', 'customer', 'client', 'לקוח', 'שםלקוח']) || '').trim();
    const customerPhone = String(importCell(row, ['customer_phone', 'phone', 'טלפון', 'טלפוןלקוח']) || '').trim();
    const customerTaxId = normalizeCustomerTaxId(importCell(row, ['customer_tax_id', 'tax_id', 'taxId', 'ח.פ', 'חפ', 'מספרעוסק']));
    const deliveryDate = String(importCell(row, ['delivery_date', 'deliverydate', 'אספקה', 'תאריךאספקה']) || '').trim();
    const deliveryAddress = String(importCell(row, ['delivery_address', 'address', 'כתובת', 'כתובתאספקה']) || '').trim();
    const diameter = Number(importCell(row, ['diameter', 'dia', 'קוטר']));
    const length = Number(importCell(row, ['length', 'length_mm', 'אורך', 'אורךממ']));
    const qty = Number(importCell(row, ['qty', 'quantity', 'כמות']));
    const shape = String(importCell(row, ['shape', 'shape_name', 'צורה']) || 'straight').trim();
    const notes = String(importCell(row, ['notes', 'note', 'הערות']) || '').trim();
    const structElement = String(importCell(row, STRUCT_ELEMENT_ALIASES) || '').trim();
    const rowErrors = [];
    if (!customerName) rowErrors.push('customer is required');
    if (!(diameter > 0)) rowErrors.push('diameter is required');
    if (!(length > 0)) rowErrors.push('length is required');
    if (!(qty > 0)) rowErrors.push('quantity is required');
    if (rowErrors.length) {
      errors.push({ row: index + 2, errors: rowErrors });
      return;
    }
    const groupKey = sourceOrderNum || `${customerTaxId || customerName}|${deliveryDate}|${deliveryAddress}`;
    if (groups.has(groupKey) && customerTaxId && groups.get(groupKey).payload.customer.taxId && groups.get(groupKey).payload.customer.taxId !== customerTaxId) {
      errors.push({ row: index + 2, errors: ['The same order number contains different customer tax IDs'] });
      return;
    }
    if (!groups.has(groupKey)) {
      const orderReviewNotes = buildStructuredReviewNotes({ customer_name: customerName, delivery_date: deliveryDate, delivery_address: deliveryAddress, items: [] }, { sourceIdentity });
      groups.set(groupKey, {
        sourceOrderNum,
        duplicate: Boolean(sourceOrderNum && orderExists(sourceOrderNum)),
        review_notes: orderReviewNotes,
        payload: {
          customer: { name: customerName, phone: customerPhone, address: deliveryAddress, ...(customerTaxId ? { taxId: customerTaxId } : {}) },
          order: { orderNum: sourceOrderNum || undefined, channel: 'spreadsheet', deliveryDate, deliveryAddress, priority: 'regular', reviewNotes: orderReviewNotes },
          pallets: [{ maxWeight: 9999, items: [] }],
        },
      });
    }
    const itemReviewNotes = buildStructuredReviewNotes({ items: [{ diameter, length, sides: [length], qty, shapeId: shape, shapeName: shape, note: notes }] }, { sourceIdentity })
      .filter(note => note.scope === 'item')
      .map(note => ({ ...note, item_index: groups.get(groupKey).payload.pallets[0].items.length }));
    groups.get(groupKey).payload.pallets[0].items.push({
      diameter,
      length,
      sides: [length],
      qty,
      shapeId: shape,
      shapeName: shape,
      note: notes,
      structElement,
      struct_element: structElement,
      reviewNotes: itemReviewNotes,
      review_notes: itemReviewNotes,
    });
    groups.get(groupKey).review_notes.push(...itemReviewNotes);
  });

  return { orders: [...groups.values()], errors, rowCount: rows.length };
}

function parseManualIntakeText({ text, source, parseWhatsAppMessage, parseOCRText }) {
  if (!text) throw Object.assign(new Error('text required'), { statusCode: 400 });
  const parsed = source === 'whatsapp'
    ? parseWhatsAppMessage(text)
    : parseOCRText(text);
  parsed.source = source || 'manual';
  return parsed;
}

function extractFirstEmailFromText(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function cleanRecognizedCustomerName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  if (extractFirstEmailFromText(name)) return '';
  if (extractFirstPhoneFromText(name)) return '';
  if (/^https?:\/\//i.test(name)) return '';
  return name;
}

function isTechnicalRecognitionNote(value) {
  const note = String(value || '').trim();
  if (!note) return false;
  if (note.length > 220) return true;
  return /cover page|row\s+\d+|interpreted|sketch|review required|reported total|segment sum|length surplus|unclear|uncertain|conservatively|tassa|pdf/i.test(note);
}

function operationalOrderNote(value) {
  const note = String(value || '').trim();
  return isTechnicalRecognitionNote(note) ? '' : note;
}

function normalizeIntakePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').replace(/^972/, '0');
}

function extractFirstPhoneFromText(value) {
  const match = String(value || '').match(/(?:\+?972|0)[\d\s().-]{7,14}/);
  return match ? normalizeIntakePhone(match[0]) : '';
}

function resolveIntakeCustomer(parsed = {}, rawContent = '', lookups = {}) {
  const name = cleanRecognizedCustomerName(parsed.customer_name || parsed.customerName || parsed.name || '');
  const phone = normalizeIntakePhone(parsed.customer_phone || parsed.customerPhone || parsed.phone || extractFirstPhoneFromText(rawContent));
  const email = String(parsed.customer_email || parsed.customerEmail || extractFirstEmailFromText(rawContent) || '').trim().toLowerCase();
  const priorityId = String(parsed.priority_id || parsed.priorityId || parsed.customer_id || parsed.customerId || '').trim();
  const taxId = normalizeCustomerTaxId(parsed.customer_tax_id || parsed.customerTaxId || parsed.tax_id || parsed.taxId);
  const candidates = [];
  const pushCandidate = (row, matchType, confidence) => {
    if (!row || candidates.some(candidate => candidate.id === row.id)) return;
    candidates.push({
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      priority_id: row.priority_id,
      tax_id: row.tax_id,
      match_type: matchType,
      confidence,
    });
  };

  if (taxId) {
    if (/^[0-9]{9}$/.test(taxId)) pushCandidate(lookups.byTaxId?.(taxId), 'tax_id', 1);
  } else {
    if (phone) pushCandidate(lookups.byPhone?.(phone), 'phone', 0.98);
    if (email) pushCandidate(lookups.byEmail?.(email), 'email', 0.96);
    if (priorityId) pushCandidate(lookups.byPriorityId?.(priorityId), 'priority_id', 0.92);
    if (name) pushCandidate(lookups.byName?.(name), 'name', 0.82);
  }

  const best = candidates[0] || null;
  return {
    input: { name, phone, email, priority_id: priorityId, tax_id: taxId || null },
    customer: best,
    candidates,
    needs_customer_review: !best || best.confidence < 0.9,
  };
}

function firstTextValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function intakeItemElementName(item = {}) {
  return firstTextValue(
    item.structElement,
    item.struct_element,
    item.element_name,
    item.elementName,
    item.element,
    item.location,
    item.mark,
    item.item_label,
    item.itemLabel,
    item.member_name,
    item.memberName,
    item['מיקום'],
    item['שם אלמנט'],
    item['שם האלמנט'],
    item['אלמנט'],
    item['מיקום אלמנט'],
    item['שייך ל']
  );
}

function intakeItemNote(item = {}) {
  return firstTextValue(item.notes, item.note, item.shape_description, item.shapeDescription);
}

function applyOcrShapeSnapshotMapping(item = {}, normalized = {}) {
  const result = mapOcrItemToShapeSnapshot({ item: { ...item, ...normalized }, source: item.source || {} });
  if (result.status === 'not_applicable') return false;

  if (result.status === 'success') {
    normalized.shapeSnapshot = result.shapeSnapshot;
    normalized.shape_review_status = 'ready';
    normalized.requires_shape_edit = false;
    return true;
  }

  normalized.requires_shape_edit = true;
  normalized.shape_review_status = 'requires_shape_edit';
  normalized.shape_review_reason = result.reason;
  normalized.reviewNotes = normalizeReviewNotes(normalized.reviewNotes || normalized.review_notes);
  pushReviewNote(normalized.reviewNotes, {
    scope: 'item',
    field: 'shape',
    code: result.reason || 'requires_shape_edit',
    message: `Shape requires review: ${result.reason || 'requires_shape_edit'}`,
    value: result.mapping?.externalCode || item.externalShapeCode || item.externalCode || item.shapeCode || item.rawShapeCode || null,
    source: 'ocr_shape_snapshot_mapper',
  });
  normalized.review_notes = normalized.reviewNotes;
  return true;
}

function normalizeIntakeItem(item = {}) {
  const reviewNotes = normalizeReviewNotes(item.review_notes || item.reviewNotes);
  const structElement = intakeItemElementName(item);
  const note = intakeItemNote(item);
  const spiral = normalizeOcrSpiralItem(item);
  if (spiral.isSpiral) {
    const length = Number(item.length ?? item.total_length_mm) || spiral.totalLengthMm;
    const qty = Number(item.qty ?? item.quantity ?? 1);
    const normalized = {
      diameter: Number(item.diameter),
      length,
      sides: [],
      angles: [],
      qty,
      shapeId: item.shapeId || item.shape || 'spiral',
      shapeName: item.shapeName || item.shape_name || item.shape || 'spiral',
      spiralDiameterMm: spiral.spiralDiameterMm,
      spiralTurns: spiral.turns,
      spiral_diameter_mm: spiral.spiralDiameterMm,
      spiral_turns: spiral.turns,
      note,
      structElement,
      struct_element: structElement,
      reviewNotes,
      review_notes: reviewNotes,
    };
    if (!applyOcrShapeSnapshotMapping(item, normalized)) {
      normalized.shapeSnapshot = buildIntakeShapeSnapshot(item, normalized);
    }
    return normalized;
  }
  const sourceSegments = Array.isArray(item.segments) ? item.segments : [];
  const sourceSides = Array.isArray(item.sides) && item.sides.length
    ? item.sides
    : sourceSegments.map(segment => segment.length_mm ?? segment.lengthMm ?? segment.length);
  const sides = sourceSides.map(Number).filter(length => Number.isFinite(length) && length > 0);
  const fallbackLength = Number(item.length ?? item.total_length_mm ?? 0);
  if (!sides.length && fallbackLength > 0) sides.push(fallbackLength);
  const length = fallbackLength || sides.reduce((sum, side) => sum + side, 0);
  const sourceAngles = Array.isArray(item.angles) && item.angles.length
    ? item.angles
    : sourceSegments.map(segment => segment.angle_deg ?? segment.angleDeg ?? segment.angle);
  const angles = sourceAngles.length
    ? sourceAngles.map(Number).filter(Number.isFinite).slice(0, Math.max(0, sides.length - 1))
    : Array(Math.max(0, sides.length - 1)).fill(90);
  const qty = Number(item.qty ?? item.quantity ?? 1);
  const normalized = {
    diameter: Number(item.diameter),
    length,
    sides,
    angles,
    qty,
    shapeId: item.shapeId || item.shape || (sides.length === 3 ? 's3' : 's1'),
    shapeName: item.shapeName || item.shape || (sides.length === 3 ? 'U - anchor' : 'straight'),
    note,
    structElement,
    struct_element: structElement,
    reviewNotes,
    review_notes: reviewNotes,
  };
  if (!applyOcrShapeSnapshotMapping(item, normalized)) {
    normalized.shapeSnapshot = buildIntakeShapeSnapshot(item, normalized);
  }
  return normalized;
}

function intakeShapeText(value) {
  return String(value || '').toLowerCase();
}

function ocrShapeContractText(item = {}) {
  return [
    item.shape_type,
    item.shapeType,
    item.shape_name,
    item.shapeName,
    item.shape,
    item.type,
    item.shape_description,
    item.shapeDescription,
    item.note,
    item.notes,
  ].map(intakeShapeText).join(' ');
}


function intakeShapeType(item = {}, sides = [], spiral = null) {
  const text = ocrShapeContractText(item);
  if (spiral?.isSpiral || /(^|\W)(spiral|coil|ring)(\W|$)|\u05e1\u05e4\u05d9\u05e8\u05dc|\u05e1\u05dc\u05d9\u05dc/.test(text)) return 'spiral';
  if (/stirrup|closed|\u05d7\u05d9\u05e9\u05d5\u05e7/.test(text)) return 'stirrup';
  if (/u[- ]?shape|open u|\bu\b/.test(text) || sides.length === 3) return 'u_bar';
  if (/l[- ]?shape|hook|angle|\bl\b/.test(text) || sides.length === 2) return 'l_bar';
  if (sides.length <= 1) return 'straight_bar';
  return 'bent_bar';
}

function shapeSnapshotId(item = {}, shapeType = 'bar') {
  return firstTextValue(item.shapeId, item.shape_id)
    || crypto.createHash('sha1').update(JSON.stringify({
      shapeType,
      diameter: Number(item.diameter),
      sides: item.sides || null,
      segments: item.segments || null,
      length: item.length || item.total_length_mm || item.total_length_cm || null,
      spiralDiameter: item.spiralDiameterMm || item.spiral_diameter_mm || null,
      spiralTurns: item.spiralTurns || item.spiral_turns || item.turns || null,
    })).digest('hex').slice(0, 16);
}

function buildIntakeShapeSnapshot(item = {}, normalized = {}) {
  const now = new Date().toISOString();
  const spiral = normalizeOcrSpiralItem({ ...item, ...normalized });
  const sides = Array.isArray(normalized.sides) ? normalized.sides.map(Number).filter(value => Number.isFinite(value) && value > 0) : [];
  const angles = Array.isArray(normalized.angles) ? normalized.angles.map(Number).filter(Number.isFinite) : [];
  const diameter = Number(normalized.diameter ?? item.diameter);
  const totalLengthMm = Number(normalized.length ?? item.length ?? item.total_length_mm ?? 0) || 0;
  const shapeType = intakeShapeType(item, sides, spiral);
  const shapeId = shapeSnapshotId(item, shapeType);
  const displayName = normalized.shapeName || item.shapeName || item.shape_name || item.shape || shapeType;
  const reviewNotes = normalizeReviewNotes(normalized.reviewNotes || normalized.review_notes || item.reviewNotes || item.review_notes);
  const weightKg = Number.isFinite(diameter) && totalLengthMm > 0 ? rebarKgPerMeter(diameter) * (totalLengthMm / 1000) : 0;
  const genericSegments = sides.map((lengthMm, index) => ({
    index: index + 1,
    lengthMm,
    bendAfterDeg: index < sides.length - 1 ? (angles[index] ?? 90) : null,
  }));
  const data = shapeType === 'spiral'
    ? { diameter, spiralDiameterMm: spiral.spiralDiameterMm, spiralTurns: spiral.turns }
    : { sides, angles, diameter };
  const generic = shapeType === 'spiral'
    ? {
        family: 'bars',
        shapeType,
        diameter,
        spiralDiameterMm: spiral.spiralDiameterMm,
        spiralTurns: spiral.turns,
        totalLengthMm,
        segments: [],
        bendCount: 0,
      }
    : {
        family: 'bars',
        shapeType,
        diameter,
        segments: genericSegments,
        totalLengthMm,
        bendCount: angles.length,
      };
  return buildFullShapeSnapshot({
    shapeVersion: 1,
    shapeId,
    shapeType,
    family: 'bars',
    source: 'intake-ocr-approval',
    approvedAt: now,
    displayName,
    data,
    calculated: { totalLengthMm, weightKg, bendCount: angles.length },
    machineOutput: { generic, machineProfiles: buildMachineProfilesPlaceholder() },
    validation: {
      valid: true,
      errors: [],
      warnings: reviewNotes.map(note => note.message).filter(Boolean),
      timestamp: now,
    },
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractOcrNumberAfter(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(escapeRegex(label) + '\\D{0,20}(\\d+(?:\\.\\d+)?)', 'i'));
    if (match) return Number(match[1]);
  }
  return 0;
}

function extractOcrNumberBefore(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp('(\\d+(?:\\.\\d+)?)\\D{0,20}' + escapeRegex(label), 'i'));
    if (match) return Number(match[1]);
  }
  return 0;
}

function normalizeOcrSpiralDiameterMm(value) {
  const numeric = Number(value) || 0;
  if (!numeric) return 0;
  return numeric <= 100 ? numeric * 10 : numeric;
}

function normalizeOcrSpiralItem(item = {}) {
  const base = normalizeSpiralParams(item);
  const text = ocrShapeContractText(item);
  const mentionsSpiral = base.isSpiral
    || /(^|\W)(spiral|coil|ring|spring|helix|salil|turns|wraps)(\W|$)/.test(text)
    || /(\u05e1\u05e4\u05d9\u05e8|\u05e1\u05dc\u05d9\u05dc|\u05e7\u05e4\u05d9\u05e5|\u05e1\u05d9\u05d1\u05d5\u05d1)/.test(text);

  if (!mentionsSpiral) {
    return { isSpiral: false, spiralDiameterMm: 0, turns: 0, totalLengthMm: 0 };
  }

  const diameterCandidate = base.spiralDiameterMm
    || item.spiral_diameter_mm
    || item.spiralDiameterMm
    || extractOcrNumberAfter(text, ['spiral diameter', 'coil diameter', 'ring diameter', 'od', 'diameter', '\u00f8', '\u2300', '\u05e7\u05d5\u05d8\u05e8 \u05e1\u05e4\u05d9\u05e8\u05dc\u05d4'])
    || extractOcrNumberBefore(text, ['cm diameter', 'diameter', '\u05e7\u05d5\u05d8\u05e8 \u05e1\u05e4\u05d9\u05e8\u05dc\u05d4']);
  const spiralDiameterMm = normalizeOcrSpiralDiameterMm(diameterCandidate);
  const explicitTurns = extractOcrNumberBefore(text, ['turns', 'wraps', '\u05e1\u05d9\u05d1\u05d5\u05d1\u05d9\u05dd', '\u05e1\u05d9\u05d1\u05d5\u05d1'])
    || extractOcrNumberAfter(text, ['turns', 'wraps', '\u05e1\u05d9\u05d1\u05d5\u05d1\u05d9\u05dd', '\u05e1\u05d9\u05d1\u05d5\u05d1']);
  const turns = explicitTurns
    || base.turns
    || item.spiral_turns
    || item.spiralTurns
    || item.turns
    || item.wraps;

  return {
    isSpiral: true,
    spiralDiameterMm,
    turns: Number(turns) || 0,
    totalLengthMm: spiralDiameterMm && turns ? spiralCutLengthMm(spiralDiameterMm, turns) : 0,
  };
}

function isStraightOcrShape(item = {}) {
  const text = ocrShapeContractText(item);
  if (/(^|\W)(stirrup|spiral|coil|ring|hook|angle|bent|bend|bench|lift|closed|open u|u[- ]?shape)(\W|$)|90/.test(text)) {
    return false;
  }
  return /(^|\W)(straight|straight bar)(\W|$)/.test(text)
    || text.includes('\u05de\u05d5\u05d8 \u05d9\u05e9\u05e8')
    || text.includes('\u05d1\u05e8\u05d6\u05dc \u05d9\u05e9\u05e8')
    || /(^|\s)\u05d9\u05e9\u05e8($|\s)/.test(text);
}

function isLikelyOcrLShape(item = {}) {
  const text = ocrShapeContractText(item);
  return /(^|\W)(l|hook|angle|bent|bend)(\W|$)|90/.test(text);
}

function normalizeOcrLShapeSegments(item = {}, sourceSegments = [], reportedLengthMm = 0) {
  const segments = (sourceSegments || []).map(segment => ({
    ...segment,
    length_mm: Number(segment.length_mm || 0),
    angle_deg: Number(segment.angle_deg ?? segment.angle ?? 0),
  })).filter(segment => segment.length_mm > 0);

  if (segments.length !== 1) {
    return { segments, adjusted: false, addedLegMm: 0 };
  }

  const [only] = segments;
  if (Math.abs(Number(only.angle_deg || 0)) !== 180 || only.length_mm < 1000) {
    return { segments, adjusted: false, addedLegMm: 0 };
  }

  const reportedLength = Number(reportedLengthMm || 0);
  const inferredLegMm = Number((reportedLength - only.length_mm).toFixed(3));
  if (!isLikelyOcrLShape(item) && inferredLegMm <= 0.001) {
    return { segments, adjusted: false, addedLegMm: 0 };
  }
  if (!reportedLength || inferredLegMm <= 0.001) {
    return { segments, adjusted: false, addedLegMm: 0 };
  }

  return {
    segments: [
      { length_mm: inferredLegMm, angle_deg: 90 },
      { ...only, angle_deg: 0 },
    ],
    adjusted: true,
    addedLegMm: inferredLegMm,
  };
}
function distributeSurplusToEndSegments(sourceSegments, reportedLengthMm) {
  const segments = (sourceSegments || []).map(segment => ({
    ...segment,
    length_mm: Number(segment.length_mm || 0),
  }));
  const reportedLength = Number(reportedLengthMm || 0);
  const segmentSum = segments.reduce((sum, segment) => sum + segment.length_mm, 0);
  const surplus = reportedLength - segmentSum;

  if (!reportedLength || !segments.length || surplus <= 0.001) {
    return {
      segments,
      adjusted: false,
      surplus: 0,
      perEnd: 0,
      totalLength: segmentSum,
      segmentSum,
    };
  }

  const perEnd = surplus / 2;
  const lastIndex = segments.length - 1;
  segments[0].length_mm = Number((segments[0].length_mm + perEnd).toFixed(3));
  if (lastIndex > 0) {
    segments[lastIndex].length_mm = Number((segments[lastIndex].length_mm + perEnd).toFixed(3));
  } else {
    segments[0].length_mm = Number((segments[0].length_mm + perEnd).toFixed(3));
  }

  return {
    segments,
    adjusted: true,
    surplus: Number(surplus.toFixed(3)),
    perEnd: Number(perEnd.toFixed(3)),
    totalLength: reportedLength,
    segmentSum,
  };
}

function buildIntakeOrderPayload(parsed = {}, {
  source = 'intake',
  customerOverride = null,
  rawContent = '',
  findCustomerById = () => null,
  resolveCustomer = () => null,
  calcWeightPerUnit = () => 0,
} = {}) {
  const enrichedParsed = withStructuredReviewNotes(parsed, { sourceIdentity: parsed.source_identity || parsed.sourceIdentity || null });
  const reviewNotes = enrichedParsed.review_notes;
  const items = (enrichedParsed.items || []).map(normalizeIntakeItem);
  const overrideCustomer = customerOverride?.id ? findCustomerById(customerOverride.id) : null;
  const match = customerOverride?.id ? null : resolveCustomer(parsed, rawContent);
  const selectedCustomer = overrideCustomer || customerOverride || match;
  return {
    customer: {
      id: selectedCustomer?.id || null,
      name: customerOverride?.name || selectedCustomer?.name || cleanRecognizedCustomerName(parsed.customer_name || parsed.customerName) || 'Unidentified customer',
      phone: customerOverride?.phone || selectedCustomer?.phone || parsed.customer_phone || parsed.customerPhone || '',
      email: customerOverride?.email || selectedCustomer?.email || parsed.customer_email || parsed.customerEmail || extractFirstEmailFromText(rawContent),
      taxId: selectedCustomer?.tax_id || customerOverride?.taxId || parsed.customer_tax_id || parsed.customerTaxId || parsed.tax_id || parsed.taxId || null,
      address: parsed.delivery_address || parsed.deliveryAddress || '',
    },
    order: {
      channel: source,
      deliveryDate: parsed.delivery_date || parsed.deliveryDate || null,
      deliveryAddress: parsed.delivery_address || parsed.deliveryAddress || '',
      priority: parsed.priority || 'regular',
      generalNotes: operationalOrderNote(parsed.notes),
      totalWeight: items.reduce((sum, item) => sum + calcWeightPerUnit(item.diameter, item.length) * item.qty, 0),
      reviewNotes,
    },
    pallets: [{ maxWeight: 9999, items }],
  };
}

module.exports = {
  buildIntakeOrderPayload,
  buildOrderImportPreview,
  buildStructuredReviewNotes,
  cleanRecognizedCustomerName,
  distributeSurplusToEndSegments,
  extractFirstEmailFromText,
  extractFirstPhoneFromText,
  importCell,
  isTechnicalRecognitionNote,
  normalizeIntakePhone,
  normalizeIntakeItem,
  buildIntakeShapeSnapshot,
  normalizeOcrSpiralItem,
  isStraightOcrShape,
  normalizeOcrLShapeSegments,
  operationalOrderNote,
  parseDelimitedRows,
  parseManualIntakeText,
  withStructuredReviewNotes,
  resolveIntakeCustomer,
};
