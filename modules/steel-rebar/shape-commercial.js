(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IronBendShapeCommercial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LINE_DEFINITIONS = Object.freeze([
    { key: 'processed_rebar_kg', section: 'material', label: 'ברזל', unit: 'kg' },
    { key: 'smooth_rebar_kg', section: 'material', label: 'ברזל חלק', unit: 'kg' },
    { key: 'round_wire_coil_kg', section: 'material', label: 'סלילים עגולים-חוטים', unit: 'kg' },
    { key: 'cutting_kg', section: 'processing', label: 'חיתוך', unit: 'kg' },
    { key: 'bending_kg', section: 'processing', label: 'כיפוף', unit: 'kg' },
    { key: 'spiral_processing_kg', section: 'processing', label: 'עיבוד ספירלות עד קוטר 12 כולל', unit: 'kg' },
    { key: 'chairs_units', section: 'processing', label: 'כסאות', unit: 'unit' },
    { key: 'rings_units', section: 'processing', label: 'עיבוד טבעות', unit: 'unit' },
    { key: 'hoops_units', section: 'processing', label: 'עיבוד חישוקים', unit: 'unit' },
    { key: 'column_penetration_units', section: 'processing', label: 'פריט חדירה לעמודים', unit: 'unit' },
    { key: 'lifting_units', section: 'processing', label: 'ציפורים/אזני הרמה/קרומים', unit: 'unit' },
    { key: 'mesh_kg', section: 'finished_products', label: 'רשת לבניין סטנדרט בחבילות', unit: 'kg' },
    { key: 'pile_cages_kg', section: 'finished_products', label: 'כלונסאות / כלובי זיון', unit: 'kg' },
    { key: 'lift_packages_units', section: 'finished_products', label: 'ליפטים — חבילות (חבילה = יחידה)', unit: 'unit' },
    { key: 'lift_packages_kg', section: 'finished_products', label: 'ליפטים — משקל שנשקל', unit: 'kg' },
  ]);
  const POLICY_LINES = Object.freeze([
    { key: 'material_by_steel_type', section: 'material', label: 'ברזל לפי סוג החומר', unit: 'kg' },
    ...LINE_DEFINITIONS.filter(x => !['processed_rebar_kg', 'smooth_rebar_kg', 'round_wire_coil_kg'].includes(x.key)),
  ]);
  const known = new Map(POLICY_LINES.map(x => [x.key, x]));
  function normalizePolicy(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.lines) || !value.lines.length) return null;
    if (value.lines.some(key => typeof key !== 'string' || !known.has(key))) return null;
    if (!['always', 'non_standard', 'none'].includes(value.cuttingMode)) return null;
    const lines = [...new Set(value.lines)];
    // A processing basis may repeat a material weight, but the material itself never does.
    if (lines.filter(key => known.get(key).unit === 'kg' && known.get(key).section !== 'processing').length !== 1) return null;
    if (lines.includes('cutting_kg') === (value.cuttingMode === 'none')) return null;
    return { version: 1, lines, cuttingMode: value.cuttingMode };
  }
  function defaultPolicy(shape = {}) {
    const id = /^s\d+$/.test(shape.shapeType || '') ? shape.shapeType : (shape.presetId || shape.id);
    const type = shape.shapeType;
    let lines = ['material_by_steel_type'], cuttingMode = 'always';
    if (shape.family === 'lifts') return { version: 1, lines: ['lift_packages_kg', 'lift_packages_units'], cuttingMode: 'none' };
    if (shape.family === 'mesh') return { version: 1, lines: ['mesh_kg'], cuttingMode: 'none' };
    if (shape.family === 'piles') return { version: 1, lines: ['pile_cages_kg'], cuttingMode: 'none' };
    lines.push('cutting_kg');
    if (type === 'ring' || shape.specialty === 'ring') lines.push('bending_kg', 'rings_units');
    else if (shape.family === 'spirals') lines.push('spiral_processing_kg');
    else if (type === 'bench_bar' || id === 's15') lines.push('bending_kg', 'chairs_units');
    else if (['closed_stirrup', 'stirrup', 'hoop'].includes(type) || ['s8', 's9'].includes(id) || shape.category === 'חישוק') lines.push('bending_kg', 'hoops_units');
    else {
      if ((shape.sides || []).length > 1 || (shape.angles || []).length > 0) lines.push('bending_kg');
      else cuttingMode = 'non_standard';
      if (shape.category === 'ציפורים') lines.push('lifting_units');
    }
    return { version: 1, lines, cuttingMode };
  }
  function steelFinish(item = {}, snapshot = {}) {
    const data = snapshot.data || {};
    const value = item.steelFinish ?? item.steel_finish ?? snapshot.steelFinish ?? data.steelFinish ?? data.steel_finish;
    return value === 'smooth' || value === 'חלק' ? 'smooth' : 'ribbed';
  }
  function resolvedLines(policy, { steelType = 'ribbed', lengthMm = 0 } = {}) {
    const p = normalizePolicy(policy);
    if (!p) return null;
    const standard = [6000, 12000].some(length => Math.abs(Number(lengthMm) - length) < 0.001);
    return p.lines.filter(key => !(key === 'cutting_kg' && p.cuttingMode === 'non_standard' && standard))
      .map(key => key === 'material_by_steel_type' ? (steelType === 'smooth' ? 'smooth_rebar_kg' : 'processed_rebar_kg') : key);
  }
  function explain(policy, { steelType = 'ribbed', lengthMm = 0, weightKg = 0, quantity = 0 } = {}) {
    const keys = resolvedLines(policy, { steelType, lengthMm });
    if (!keys) return [];
    return keys.map(key => {
      const line = LINE_DEFINITIONS.find(x => x.key === key);
      return { ...line, label: key === 'processed_rebar_kg' ? 'ברזל מצולע' : line.label,
        basis: line.unit === 'kg' ? 'weight_kg' : 'quantity',
        value: line.unit === 'kg' ? Number(weightKg) || 0 : Number(quantity) || 0 };
    });
  }
  return { LINE_DEFINITIONS, POLICY_LINES, normalizePolicy, defaultPolicy, steelFinish, resolvedLines, explain };
});
