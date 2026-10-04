'use strict';

const productionCards = require('./productionCards');
const { itemShapeMetrics } = require('./shapeSnapshot');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');

const SECTION_DEFINITIONS = Object.freeze([
  { key: 'material', label: 'ברזל מעובד' },
  { key: 'processing', label: 'עיבודים ברזל' },
  { key: 'finished_products', label: 'רשת סטנדרט' },
]);

const LINE_DEFINITIONS = Object.freeze([
  { key: 'processed_rebar_kg', section: 'material', label: 'ברזל', unit: 'kg' },
  { key: 'round_wire_coil_kg', section: 'material', label: 'סלילים עגולים-חוטים', unit: 'kg' },
  { key: 'cutting_kg', section: 'processing', label: 'חיתוך', unit: 'kg' },
  { key: 'bending_kg', section: 'processing', label: 'כיפוף', unit: 'kg' },
  { key: 'spiral_processing_kg', section: 'processing', label: 'עיבוד ספירלות עד קוטר 12 כולל', unit: 'kg' },
  { key: 'chairs_units', section: 'processing', label: 'כסאות', unit: 'unit' },
  { key: 'rings_units', section: 'processing', label: 'עיבוד טבעות', unit: 'unit' },
  { key: 'hoops_units', section: 'processing', label: 'עיבוד חישוקים', unit: 'unit' },
  { key: 'column_penetration_units', section: 'processing', label: 'פרטי חדירה לעמודים', unit: 'unit' },
  { key: 'lifting_units', section: 'processing', label: 'ציפורים/אזני הרמה/קרומים', unit: 'unit' },
  { key: 'mesh_kg', section: 'finished_products', label: 'רשת לבניין סטנדרט בחבילות', unit: 'kg' },
  { key: 'pile_cages_kg', section: 'finished_products', label: 'כלונסאות / כלובי זיון', unit: 'kg' },
  { key: 'lift_packages_units', section: 'finished_products', label: 'ליפטים — חבילות (חבילה = יחידה)', unit: 'unit' },
  { key: 'lift_packages_kg', section: 'finished_products', label: 'ליפטים — משקל שנשקל', unit: 'kg' },
]);

const LINE_BY_KEY = new Map(LINE_DEFINITIONS.map(line => [line.key, line]));

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function itemQuantity(item = {}) {
  const quantity = Number(item.quantity ?? item.qty ?? item.production_qty ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function shapeSnapshot(item = {}) {
  return parseJsonObject(
    item.shape_snapshot_json
      ?? item.shapeSnapshot
      ?? item.shape_snapshot
      ?? item.shapeData
      ?? item.shape_data
  ) || {};
}

function identity(item = {}, snapshot = shapeSnapshot(item)) {
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput?.generic || {};
  const shapeType = String(item.shapeType || item.shape_type || snapshot.shapeType || data.shapeType || generic.shapeType || '').toLowerCase();
  const family = String(item.family || snapshot.family || data.family || generic.family || '').toLowerCase();
  const shapeId = String(item.shape_id || item.shapeId || snapshot.shapeId || '').toLowerCase();
  const text = [item.shape_name, item.shapeName, item.struct_element, item.note, snapshot.displayName, shapeType, shapeId, family]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { data, generic, shapeType, family, shapeId, text };
}

function pileCageBreakdown(item, snapshot) {
  if (!productionCards.isRoundPileCageItem(item)) return null;
  try {
    const calculated = calculatePileCage(snapshot);
    if (!calculated.validation?.ok) return null;
    const components = Array.isArray(calculated.calculated?.manufacturingBreakdown)
      ? calculated.calculated.manufacturingBreakdown
      : [];
    if (components.length !== 4) return null;
    const quantity = itemQuantity(item);
    return {
      unitWeightKg: positive(calculated.calculated?.totalWeightKg),
      totalWeightKg: round(positive(calculated.calculated?.totalWeightKg) * quantity),
      components: components.map(component => ({
        component_type: String(component.componentType || component.type || ''),
        description: String(component.description || ''),
        diameter_mm: positive(component.diameterMm),
        quantity: positive(component.quantity),
        total_length_mm: round(positive(component.totalLengthMm), 1),
        weight_kg: round(positive(component.weightKg) * quantity),
      })),
    };
  } catch {
    return null;
  }
}

function effectiveItemWeight(item, pileBreakdown = null) {
  const actual = positive(item.actual_weight_kg ?? item.actualWeightKg);
  if (actual > 0) return { weightKg: round(actual), source: 'actual' };

  if (pileBreakdown?.totalWeightKg > 0) {
    return { weightKg: pileBreakdown.totalWeightKg, source: 'canonical_pile_cage' };
  }

  const storedTotal = positive(item.total_weight ?? item.totalWeight);
  if (storedTotal > 0) return { weightKg: round(storedTotal), source: 'theoretical_saved' };

  const metrics = itemShapeMetrics(item);
  const snapshotTotal = positive(metrics.totalWeightKg);
  if (snapshotTotal > 0) return { weightKg: round(snapshotTotal), source: 'theoretical_snapshot' };

  const unit = positive(item.weight_per_unit ?? item.weightPerUnit ?? metrics.unitWeightKg);
  if (unit > 0) return { weightKg: round(unit * itemQuantity(item)), source: 'theoretical_unit' };
  return { weightKg: 0, source: 'missing' };
}

function isCommercialStraightLength(lengthMm) {
  const length = Number(lengthMm);
  return Number.isFinite(length)
    && (Math.abs(length - 6000) < 0.001 || Math.abs(length - 12000) < 0.001);
}

function isBentItem(item) {
  const segments = productionCards.shapeSegmentsFromItem(item);
  return Array.isArray(segments)
    && segments.length > 1
    && segments.slice(0, -1).some(segment => productionCards.isPrintableBendAngle(segment.angle_deg));
}

function normalizedMaterialSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (['coil', 'coils', 'wire', 'סליל', 'סלילים'].includes(source)) return 'coil';
  if (['straight', 'bar', 'bars', 'rod', 'מוט', 'מוטות'].includes(source)) return 'straight';
  return null;
}

function explicitMaterialSource(item, snapshot) {
  const data = snapshot?.data || {};
  const generic = snapshot?.machineOutput?.generic || {};
  const candidates = [
    item.material_source,
    item.materialSource,
    item.stock_source,
    item.stockSource,
    item.material_type,
    item.supply_form,
    snapshot?.materialSource,
    snapshot?.materialType,
    snapshot?.supplyForm,
    data.materialSource,
    data.materialType,
    data.supplyForm,
    generic.materialSource,
    generic.materialType,
    generic.supplyForm,
  ];
  return candidates.map(normalizedMaterialSource).find(Boolean) || null;
}

function resolveMaterialSource({ item, snapshot }) {
  const explicit = explicitMaterialSource(item, snapshot);
  if (explicit) return { source: explicit, basis: 'explicit' };
  // A shape, diameter, or cut length cannot prove its stock source. Until a
  // future stock/machine selection is recorded explicitly, all such items are
  // commercial processed rebar rather than inferred coils/wire.
  return { source: 'straight', basis: 'default_processed_rebar' };
}

function classifyOrderItem(item = {}) {
  const snapshot = shapeSnapshot(item);
  const shape = identity(item, snapshot);
  const quantity = itemQuantity(item);
  const pileBreakdown = pileCageBreakdown(item, snapshot);
  const { weightKg, source: weightSource } = effectiveItemWeight(item, pileBreakdown);
  const lengthMm = positive(productionCards.shapeTotalLengthMmFromItem(item) ?? item.total_length_mm);
  const spiralTurns = positive(item.spiral_turns ?? item.spiralTurns ?? shape.data.spiral?.turns ?? shape.generic.turns);
  // A lift is recognised by its family alone. Never by wording: the OCR wording
  // rules own 'ליפט' for bent bars and must keep behaving exactly as before.
  const isLiftPackage = shape.family === 'lifts' || shape.shapeType === 'lift_package';
  const isPileCage = !isLiftPackage && Boolean(pileBreakdown || productionCards.isRoundPileCageItem(item));
  const isMesh = shape.family === 'mesh' || /(^|\W)(mesh|wire mesh|רשת)(\W|$)/i.test(shape.text);
  const isColumnPenetration = !isPileCage && !isMesh && (
    /חדירה\s*לעמודים?|עמודים?\s*חדירה|column\s*penetration|penetration\s*column/i.test(shape.text)
      // Imported penetration details are named "מוטה ... ב-2 כיוונים".
      || /מוטה[\s\S]*ב[-־]?2\s*כיוונים/.test(shape.text)
  );
  const isChair = shape.shapeType === 'bench_bar' || shape.shapeId === 's15' || /(^|\W)(chair|bench|כסא|כסאות|ספסל)(\W|$)/i.test(shape.text);
  const isSpiral = !isPileCage && !isMesh && shape.shapeType !== 'ring' && (
    shape.family === 'spirals' && spiralTurns > 1.5
    || /spiral|helix|spring|coil|ספיר|סליל|קפיץ/i.test(shape.text)
  );
  // A ring (טבעת) and a hoop/stirrup (חישוק) are different products and must
  // remain separate in the commercial summary. Prefer the explicit shape type
  // and then the product wording when legacy rows do not have a type.
  const isHoop = !isSpiral && !isPileCage && !isMesh && (
    ['closed_stirrup', 'stirrup', 'hoop'].includes(shape.shapeType)
      || /(^|\W)(hoop|חישוק)(\W|$)/i.test(shape.text)
  );
  const isRing = !isHoop && !isSpiral && !isPileCage && !isMesh && (
    shape.shapeType === 'ring'
      || /(^|\W)(ring|טבעת)(\W|$)/i.test(shape.text)
  );
  const isLifting = !isPileCage && !isMesh && /ציפור|ציפורים|אוזן|אזני|הרמה|קרום|קרומים|bird|lifting|insert/i.test(shape.text);
  const bent = isChair || isRing || isLifting || (!isSpiral && isBentItem(item));
  const material = resolveMaterialSource({ item, snapshot });

  if (isLiftPackage) return { kind: 'lift_package', weightKg, weightSource, quantity, lengthMm, lines: ['lift_packages_units', 'lift_packages_kg'] };
  if (isPileCage) return { kind: 'pile_cage', weightKg, weightSource, quantity, lengthMm, pileBreakdown, lines: ['pile_cages_kg'] };
  if (isMesh) return { kind: 'mesh', weightKg, weightSource, quantity, lengthMm, lines: ['mesh_kg'] };
  if (isColumnPenetration) return {
    kind: 'column_penetration',
    weightKg,
    weightSource,
    materialSource: material.source,
    materialSourceBasis: material.basis,
    quantity,
    lengthMm,
    // This is its own per-unit add-on while sharing the ordinary cutting and
    // bending kg services with other bent products.
    lines: [material.source === 'coil' ? 'round_wire_coil_kg' : 'processed_rebar_kg', 'cutting_kg', 'bending_kg', 'column_penetration_units'],
  };
  if (isSpiral) return {
    kind: 'spiral', weightKg, weightSource, quantity, lengthMm,
    materialSource: material.source, materialSourceBasis: material.basis,
    lines: [material.source === 'coil' ? 'round_wire_coil_kg' : 'processed_rebar_kg', 'cutting_kg', 'spiral_processing_kg'],
  };

  if (isRing || isHoop) return {
    kind: isHoop ? 'hoop' : 'ring',
    weightKg,
    weightSource,
    materialSource: material.source,
    materialSourceBasis: material.basis,
    quantity,
    lengthMm,
    // Both products are bent: keep their own unit-count line, and also
    // charge/show their weight in the common bending line.
    lines: [material.source === 'coil' ? 'round_wire_coil_kg' : 'processed_rebar_kg', 'cutting_kg', 'bending_kg', isHoop ? 'hoops_units' : 'rings_units'],
  };

  const lines = [material.source === 'coil' ? 'round_wire_coil_kg' : 'processed_rebar_kg'];
  if (bent || !isCommercialStraightLength(lengthMm)) lines.push('cutting_kg');
  if (bent) lines.push('bending_kg');
  if (isChair) lines.push('chairs_units');
  else if (isLifting) lines.push('lifting_units');
  return {
    kind: isChair ? 'chair' : isLifting ? 'lifting' : bent ? 'bent_rebar' : 'straight_rebar',
    weightKg,
    weightSource,
    materialSource: material.source,
    materialSourceBasis: material.basis,
    quantity,
    lengthMm,
    lines,
  };
}

function contributorFor(item, classification, lineNo) {
  return {
    item_id: Number(item.id) || null,
    item_uid: item.item_uid || null,
    line_no: lineNo,
    shape_name: String(item.shape_name || item.shapeName || ''),
    diameter_mm: positive(item.diameter),
    quantity: classification.quantity,
    unit_length_mm: classification.lengthMm,
    weight_kg: classification.weightKg,
    weight_source: classification.weightSource,
    material_source: classification.materialSource || null,
    material_source_basis: classification.materialSourceBasis || null,
    classification: classification.kind,
    pile_components: classification.pileBreakdown?.components || [],
  };
}

function buildOrderCommercialSummary(items = []) {
  const lines = new Map(LINE_DEFINITIONS.map(definition => [definition.key, { ...definition, value: 0, contributors: [] }]));
  const classifications = [];

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const classification = classifyOrderItem(item);
    classifications.push({ item_id: Number(item.id) || null, ...classification });
    const contributor = contributorFor(item, classification, index + 1);
    classification.lines.forEach(key => {
      const line = lines.get(key);
      if (!line) return;
      line.value += line.unit === 'kg' ? classification.weightKg : classification.quantity;
      line.contributors.push(contributor);
    });
  });

  const visibleLines = LINE_DEFINITIONS
    .map(definition => lines.get(definition.key))
    .filter(line => line.value > 0)
    .map(line => ({ ...line, value: round(line.value) }));
  const sections = SECTION_DEFINITIONS.map(section => ({
    ...section,
    lines: visibleLines.filter(line => line.section === section.key),
  })).filter(section => section.lines.length > 0);

  const materialWeightKg = visibleLines
    .filter(line => line.unit === 'kg' && ['material', 'finished_products'].includes(line.section))
    .reduce((sum, line) => sum + line.value, 0);

  return {
    version: 'ORDER_COMMERCIAL_SUMMARY_V1',
    calculation: 'computed_on_read',
    sections,
    lines: visibleLines,
    material_weight_kg: round(materialWeightKg),
    item_count: (Array.isArray(items) ? items : []).length,
    classifications,
  };
}

function summaryLine(summary, key) {
  return summary?.lines?.find(line => line.key === key) || null;
}

module.exports = {
  SECTION_DEFINITIONS,
  LINE_DEFINITIONS,
  buildOrderCommercialSummary,
  classifyOrderItem,
  effectiveItemWeight,
  isCommercialStraightLength,
  summaryLine,
};
