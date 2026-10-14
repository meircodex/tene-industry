const SUPPORTED_DIAMETERS = new Set([6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40]);
const PARSER_VERSION = 'steel-document-parser-v1';

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/,/g, '').replace(/[^\d.-]/g, '').trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function bboxFromWords(words = []) {
  const valid = words.filter(word => Number.isFinite(word.x0) && Number.isFinite(word.x1) && Number.isFinite(word.top) && Number.isFinite(word.bottom));
  if (!valid.length) return null;
  return {
    x0: Math.min(...valid.map(word => word.x0)),
    y0: Math.min(...valid.map(word => word.top)),
    x1: Math.max(...valid.map(word => word.x1)),
    y1: Math.max(...valid.map(word => word.bottom)),
  };
}

function fieldValue(value, confidence, word, reason = '') {
  return {
    value,
    confidence,
    source_page: word?.page || null,
    source_bbox: word ? bboxFromWords([word]) : null,
    reason,
  };
}

function normalizePdfWordsPages(pages = []) {
  const tokens = [];
  pages.forEach((page, pageIndex) => {
    const pageNumber = Number(page.pageNumber || page.page || pageIndex + 1);
    (page.words || page.tokens || []).forEach(word => {
      const text = String(word.text || word.description || '').trim();
      if (!text) return;
      const x0 = Number(word.x0 ?? word.left ?? word.x ?? 0);
      const x1 = Number(word.x1 ?? (x0 + Number(word.width || 0)));
      const top = Number(word.top ?? word.y0 ?? word.y ?? 0);
      const bottom = Number(word.bottom ?? word.y1 ?? (top + Number(word.height || 0)));
      tokens.push({ text, x0, x1, top, bottom, page: pageNumber });
    });
  });
  return tokens;
}

function verticesToBbox(vertices = []) {
  const xs = vertices.map(vertex => Number(vertex.x || 0));
  const ys = vertices.map(vertex => Number(vertex.y || 0));
  if (!xs.length || !ys.length) return null;
  return { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function normalizeGoogleVisionPages(pages = []) {
  const tokens = [];
  pages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    (page.blocks || []).forEach(block => {
      (block.paragraphs || []).forEach(paragraph => {
        (paragraph.words || []).forEach(word => {
          const text = (word.symbols || []).map(symbol => symbol.text || '').join('').trim();
          if (!text) return;
          const bbox = verticesToBbox(word.boundingBox?.vertices || word.bounding_box?.vertices || []);
          if (!bbox) return;
          tokens.push({ text, page: pageNumber, ...bbox });
        });
      });
    });
  });
  return tokens;
}

function normalizeTokens(input = {}) {
  if (Array.isArray(input.tokens)) return input.tokens.map(token => ({ ...token, text: String(token.text || '').trim() })).filter(token => token.text);
  const pages = input.pages || [];
  if (pages.some(page => Array.isArray(page.words) || Array.isArray(page.tokens))) return normalizePdfWordsPages(pages);
  if (pages.some(page => Array.isArray(page.blocks))) return normalizeGoogleVisionPages(pages);
  return [];
}

function detectDocumentType({ text = '', tokens = [] } = {}) {
  const content = `${text}\n${tokens.map(token => token.text).join(' ')}`.toLowerCase();
  if (/production card|factory card|כרטיס/.test(content)) return { type: 'production_cards', confidence: 0.78 };
  if (/summary|סה.?כ|total/.test(content) && !/diameter|קוטר|רטוק/.test(content)) return { type: 'summary_page', confidence: 0.62 };
  if (/bending|bar schedule|רשימת|לכיפוף|ףופיכל|קוטר|רטוק/.test(content)) return { type: 'cutting_bending_sheet', confidence: 0.92 };
  return { type: 'steel_order', confidence: 0.72 };
}

function detectParsingProfile({ text = '', tokens = [] } = {}) {
  const content = `${text}\n${tokens.map(token => token.text).join(' ')}`.toLowerCase();
  if (/tassa|טסה|הספדה|dp2|easybar|רטוק|טומ/.test(content)) {
    return {
      id: 'tassa_easybar_bending_schedule',
      confidence: 0.92,
      reason: 'Known TASSA/Easybar bending table layout with stable numeric columns.',
      columns: TASSA_COLUMNS,
    };
  }
  return {
    id: 'generic_steel_table',
    confidence: 0.55,
    reason: 'Generic steel table; no dedicated profile matched.',
    columns: TASSA_COLUMNS,
  };
}

const TASSA_COLUMNS = {
  weight_kg: [20, 70],
  kg_per_m: [70, 105],
  row_total_length_m: [105, 145],
  unit_length_m: [145, 185],
  element_quantity: [185, 210],
  quantity: [210, 238],
  diameter: [238, 270],
  bar_mark_or_shape_leg: [295, 325],
  shape_dimension: [335, 430],
  element_name: [490, 560],
  item_number: [560, 590],
};

function inBand(token, [min, max]) {
  const x = (Number(token.x0) + Number(token.x1)) / 2;
  return x >= min && x <= max;
}

function firstNumberInBand(words, band) {
  return words.find(word => inBand(word, band) && toNumber(word.text) !== null) || null;
}

function numbersInBand(words, band) {
  return words.filter(word => inBand(word, band) && toNumber(word.text) !== null);
}

function wordsInBand(words, band) {
  return words.filter(word => inBand(word, band));
}

function rowText(words) {
  return words.slice().sort((a, b) => a.x0 - b.x0).map(word => word.text).join(' ');
}

function isDataRowItemToken(token) {
  const itemNumber = toNumber(token.text);
  return Number.isInteger(itemNumber) && itemNumber > 0 && itemNumber < 10000 && token.x0 >= 555 && token.top > 130 && token.top < 780;
}

function reconstructTassaRows(tokens = []) {
  const rows = [];
  const byPage = new Map();
  tokens.forEach(token => {
    if (!byPage.has(token.page)) byPage.set(token.page, []);
    byPage.get(token.page).push(token);
  });

  [...byPage.entries()].forEach(([page, pageTokens]) => {
    const itemTokens = pageTokens.filter(isDataRowItemToken).sort((a, b) => a.top - b.top || a.x0 - b.x0);
    itemTokens.forEach((itemToken, index) => {
      const nextTop = itemTokens[index + 1]?.top ?? itemToken.top + 58;
      const top = itemToken.top - 18;
      const bottom = Math.min(nextTop - 6, itemToken.top + 54);
      const words = pageTokens.filter(token => token.top >= top && token.top <= bottom);
      rows.push({ page, itemToken, words, bbox: bboxFromWords(words), text: rowText(words) });
    });
  });

  return rows.sort((a, b) => (toNumber(a.itemToken.text) || 0) - (toNumber(b.itemToken.text) || 0));
}

function checksumMatches(totalLengthCm, segmentsCm) {
  const total = Number(totalLengthCm || 0);
  const sum = segmentsCm.reduce((value, segment) => value + Number(segment || 0), 0);
  return total > 0 && Math.abs(total - sum) <= 1;
}

function shapeSegment(lengthCm, angleDeg) {
  const cm = Number(lengthCm || 0);
  return { length_cm: cm, length_mm: Math.round(cm * 10), angle_deg: angleDeg };
}

function inferShape(row, values) {
  const notes = [];
  const uncertain = [];
  const totalLengthCm = values.total_length_cm;
  const longSide = values.shape_dimension_cm;
  const leg = values.shape_leg_cm;
  const elementWords = wordsInBand(row.words, TASSA_COLUMNS.element_name).map(word => word.text).join(' ');

  if (/[ח]/.test(elementWords)) {
    const dims = numbersInBand(row.words, [300, 430]).map(word => ({ word, value: toNumber(word.text) })).filter(entry => entry.value > 0);
    const sideValues = dims.map(entry => entry.value);
    return {
      shape_name: 'custom bent shape',
      shape_type: 'bent',
      shape_description: elementWords || 'bent shape',
      segments: sideValues.map((value, index) => shapeSegment(value, index === sideValues.length - 1 ? 0 : 90)),
      confidence: sideValues.length >= 2 ? 0.72 : 0.44,
      review_notes: sideValues.length >= 2 ? [] : [{ field: 'shape', code: 'shape_not_detected', message: 'Shape text indicates bent/custom geometry but dimensions are incomplete.' }],
    };
  }

  if (leg > 0 && longSide > 0 && checksumMatches(totalLengthCm, [leg, longSide])) {
    return {
      shape_name: 'L shape',
      shape_type: 'bent',
      shape_description: 'L shape from shape-column dimensions',
      segments: [
        shapeSegment(leg, 90),
        shapeSegment(longSide, 0),
      ],
      confidence: 0.9,
      review_notes: [],
    };
  }

  if (longSide > 0 && totalLengthCm > 0 && Math.abs(totalLengthCm - longSide) <= 1) {
    return {
      shape_name: 'straight bar',
      shape_type: 'straight',
      shape_description: 'straight bar',
      segments: [],
      confidence: 0.88,
      review_notes: [],
    };
  }

  if (longSide > 0 && totalLengthCm > 0 && leg > 0 && !checksumMatches(totalLengthCm, [leg, longSide])) {
    uncertain.push({ field: 'dimensions', code: 'possible_unit_conversion_issue', message: 'Shape dimensions do not match the table total length checksum.' });
  }
  if (longSide > 0 && totalLengthCm > 0 && Math.abs(totalLengthCm - longSide) > 1) {
    notes.push('Visible shape side does not explain total length; shape requires review.');
    uncertain.push({ field: 'shape', code: 'shape_not_detected', message: 'Could not prove whether the extra length is a bend leg, hook, overlap, or another drawing value.' });
  }

  return {
    shape_name: 'unknown',
    shape_type: 'unknown',
    shape_description: '',
    segments: longSide ? [shapeSegment(longSide, 0)] : [],
    confidence: 0.38,
    note: notes.join(' '),
    review_notes: uncertain,
  };
}

function buildFieldReviewNote(field, code, message, value, word) {
  return {
    scope: 'item',
    field,
    code,
    severity: 'review',
    message,
    value: value ?? null,
    source: 'steel_document_parser',
    source_page: word?.page || null,
    source_bbox: word ? bboxFromWords([word]) : null,
  };
}

function parseTassaRow(row, index) {
  const itemWord = firstNumberInBand(row.words, TASSA_COLUMNS.item_number) || row.itemToken;
  const diameterWord = firstNumberInBand(row.words, TASSA_COLUMNS.diameter);
  const quantityWord = firstNumberInBand(row.words, TASSA_COLUMNS.quantity);
  const unitLengthWord = firstNumberInBand(row.words, TASSA_COLUMNS.unit_length_m);
  const rowTotalLengthWord = firstNumberInBand(row.words, TASSA_COLUMNS.row_total_length_m);
  const weightWord = firstNumberInBand(row.words, TASSA_COLUMNS.weight_kg);
  const legWord = firstNumberInBand(row.words, TASSA_COLUMNS.bar_mark_or_shape_leg);
  const shapeWord = firstNumberInBand(row.words, TASSA_COLUMNS.shape_dimension);

  const itemNumber = toNumber(itemWord?.text);
  const diameter = toNumber(diameterWord?.text);
  const quantity = toNumber(quantityWord?.text);
  const unitLengthM = toNumber(unitLengthWord?.text);
  const rowTotalLengthM = toNumber(rowTotalLengthWord?.text);
  const weightKg = toNumber(weightWord?.text);
  const shapeLegCm = toNumber(legWord?.text);
  const shapeDimensionCm = toNumber(shapeWord?.text);
  const totalLengthCm = unitLengthM ? Math.round(unitLengthM * 100) : null;
  const totalLengthMm = totalLengthCm ? totalLengthCm * 10 : null;
  const shape = inferShape(row, { total_length_cm: totalLengthCm, shape_dimension_cm: shapeDimensionCm, shape_leg_cm: shapeLegCm });
  const reviewNotes = [...(shape.review_notes || [])];

  if (!SUPPORTED_DIAMETERS.has(Number(diameter))) {
    reviewNotes.push(buildFieldReviewNote('diameter', 'diameter_conflict', 'Diameter is missing or not in the supported steel diameter list.', diameter, diameterWord));
  }
  if (!(quantity > 0)) {
    reviewNotes.push(buildFieldReviewNote('quantity', 'quantity_conflict', 'Quantity was not found in the quantity column.', quantity, quantityWord));
  }
  if (!(totalLengthCm > 0)) {
    reviewNotes.push(buildFieldReviewNote('length', 'length_not_clear', 'Unit length was not found in the unit-length column.', totalLengthCm, unitLengthWord));
  }
  if (shape.shape_type === 'unknown') {
    reviewNotes.push(buildFieldReviewNote('shape', 'shape_not_detected', 'Shape could not be confidently detected from the drawing column.', shape.shape_name, shapeWord));
  }
  if (shapeLegCm > 0 && quantity === shapeLegCm) {
    reviewNotes.push(buildFieldReviewNote('quantity', 'quantity_conflict', 'Quantity equals a drawing/bar-mark value; verify the quantity column was used.', quantity, quantityWord));
  }

  const fieldConfidence = {
    item_number: itemWord ? 0.98 : 0.2,
    diameter: SUPPORTED_DIAMETERS.has(Number(diameter)) ? 0.94 : 0.35,
    quantity: quantity > 0 ? 0.94 : 0.25,
    total_length_cm: totalLengthCm > 0 ? 0.94 : 0.25,
    weight_kg: weightKg > 0 ? 0.86 : 0.35,
    shape: shape.confidence,
  };
  const confidence = Math.min(...Object.values(fieldConfidence));

  return {
    original_row_number: itemNumber ? String(itemNumber) : String(index + 1),
    item_number: itemNumber ? String(itemNumber) : null,
    element_name: wordsInBand(row.words, TASSA_COLUMNS.element_name).map(word => word.text).join(' ') || null,
    shape_description: shape.shape_description || null,
    diameter,
    quantity,
    qty: quantity,
    unit_length_cm: totalLengthCm,
    total_length_cm: totalLengthCm,
    total_length_mm: totalLengthMm,
    length_mm: totalLengthMm,
    length: totalLengthMm,
    row_total_length_m: rowTotalLengthM,
    weight_kg: weightKg,
    shape_name: shape.shape_name,
    shape_type: shape.shape_type,
    segments: shape.segments,
    material_grade: '',
    uncertain_fields: reviewNotes.map(note => note.field),
    note: shape.note || '',
    confidence,
    field_confidence: fieldConfidence,
    fields: {
      item_number: fieldValue(itemNumber ? String(itemNumber) : null, fieldConfidence.item_number, itemWord, 'item number column'),
      diameter: fieldValue(diameter, fieldConfidence.diameter, diameterWord, 'diameter column'),
      quantity: fieldValue(quantity, fieldConfidence.quantity, quantityWord, 'quantity column only'),
      total_length_cm: fieldValue(totalLengthCm, fieldConfidence.total_length_cm, unitLengthWord, 'unit-length table column converted from meters to centimeters'),
      weight_kg: fieldValue(weightKg, fieldConfidence.weight_kg, weightWord, 'weight column'),
      shape: fieldValue(shape.shape_name, fieldConfidence.shape, shapeWord || legWord, 'shape drawing column'),
    },
    source_ref: {
      page: row.page,
      bbox: row.bbox,
      row_text: row.text,
    },
    review_status: confidence >= 0.9 && !reviewNotes.length ? 'parsed' : 'needs_review',
    review_notes: reviewNotes.map(note => ({ ...note, item_index: index })),
  };
}

function parseTassaEasybar(tokens, input = {}) {
  const rows = reconstructTassaRows(tokens);
  const items = rows.map(parseTassaRow);
  return {
    items,
    row_reconstruction: rows.map((row, index) => ({ index, page: row.page, bbox: row.bbox, text: row.text })),
  };
}

function parseSteelDocument(input = {}) {
  const tokens = normalizeTokens(input);
  const text = String(input.text || input.fullText || '');
  const documentType = detectDocumentType({ text, tokens });
  const profile = detectParsingProfile({ text, tokens });
  const parsed = profile.id === 'tassa_easybar_bending_schedule' || tokens.length
    ? parseTassaEasybar(tokens, input)
    : { items: [], row_reconstruction: [] };
  const reviewNotes = [];
  if (!tokens.length) {
    reviewNotes.push({ scope: 'order', field: 'source_layout', code: 'row_boundary_uncertain', severity: 'review', message: 'No positioned OCR tokens were available; parser cannot reconstruct rows by coordinates.', source: 'steel_document_parser' });
  }
  if (!parsed.items.length) {
    reviewNotes.push({ scope: 'order', field: 'items', code: 'row_boundary_uncertain', severity: 'review', message: 'No steel item rows were reconstructed from the document layout.', source: 'steel_document_parser' });
  }

  return {
    success: true,
    parser_version: PARSER_VERSION,
    source_document_name: input.fileName || input.source_document_name || null,
    document_type: documentType.type,
    document_type_confidence: documentType.confidence,
    parsing_profile: profile,
    customer_name: input.customer_name || null,
    project_name: input.project_name || null,
    site_name: input.site_name || null,
    supplier_order_num: input.supplier_order_num || null,
    delivery_date: input.delivery_date || null,
    items: parsed.items,
    row_reconstruction: parsed.row_reconstruction,
    comparison_rows: parsed.items.map(item => ({
      original_detected_row_number: item.original_row_number,
      parsed_item: item,
      confidence: item.confidence,
      source_reference: item.source_ref,
      review_status: item.review_status,
    })),
    review_notes: reviewNotes,
    metrics: {
      positioned_tokens: tokens.length,
      rows_detected: parsed.items.length,
      usable_rows: parsed.items.filter(item => item.diameter > 0 && item.quantity > 0 && item.total_length_cm > 0).length,
      fields_marked_for_review: parsed.items.reduce((sum, item) => sum + (item.review_notes || []).length, 0),
    },
  };
}

module.exports = {
  PARSER_VERSION,
  detectDocumentType,
  detectParsingProfile,
  normalizeTokens,
  parseSteelDocument,
  reconstructTassaRows,
};