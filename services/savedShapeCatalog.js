'use strict';
const crypto = require('node:crypto');
const commercial = require('../modules/steel-rebar/shape-commercial');

function ensureSavedShapeCatalogSchema(db) {
  const columns = new Set(db.pragma('table_info(shapes)').map(column => column.name));
  for (const [name, type] of [['item_code', 'TEXT'], ['definition_json', 'TEXT'], ['billing_json', 'TEXT'], ['definition_version', 'INTEGER NOT NULL DEFAULT 1']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE shapes ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shapes_item_code ON shapes(item_code COLLATE NOCASE) WHERE item_code IS NOT NULL');
}
function readEntry(row) {
  return { id: row.id, itemCode: row.item_code, name: row.name, version: row.definition_version,
    definition: JSON.parse(row.definition_json), billingPolicy: JSON.parse(row.billing_json) };
}
function validateDefinition(input) {
  const errors = [];
  const name = String(input.name || '').trim();
  const itemCode = String(input.itemCode || '').trim();
  if (!name || name.length > 120) errors.push('יש להזין שם צורה עד 120 תווים');
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(itemCode)) errors.push('מספר צורה חייב להכיל עד 40 אותיות, ספרות, מקף או קו תחתון');
  // Built-in IDs remain reserved; new user codes never shadow a shipped shape.
  if (/^s(?:[1-9]|1[0-6])$/i.test(itemCode) || ['mesh1','spiral1','ring1','round-pile-cage','lift-package'].includes(itemCode.toLowerCase())) errors.push('קוד זה שייך לצורה מובנית');
  const definition = input.definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) errors.push('חסרה הגדרת צורה');
  else {
    if (!['bars','mesh','spirals','piles','lifts'].includes(definition.family)) errors.push('משפחת צורה לא תקינה');
    if (JSON.stringify(definition).length > 100000) errors.push('הגדרת הצורה גדולה מדי');
    if (definition.family === 'bars') {
      const sides = definition.sides, angles = definition.angles;
      if (!Array.isArray(sides) || !sides.length || sides.length > 100 || sides.some(v => !Number.isFinite(v) || v <= 0)) errors.push('אורכי הצלעות חייבים להיות חיוביים');
      // Existing closed presets include the closing bend as the final angle.
      if (!Array.isArray(angles) || !Array.isArray(sides) || ![sides.length - 1, sides.length].includes(angles.length) || angles.some(v => !Number.isFinite(v) || Math.abs(v) > 360)) errors.push('רצף כיפופים לא תקין');
      if (definition.is3d) for (const key of ['azAngles','elAngles']) {
        if (!Array.isArray(definition[key]) || definition[key].length !== sides?.length || definition[key].some(v => !Number.isFinite(v))) errors.push('חסרים נתוני תלת־ממד');
      }
    } else {
      const positive = key => { if (!Number.isFinite(definition[key]) || definition[key] <= 0) errors.push('מידה לא תקינה: ' + key); };
      if (definition.family === 'mesh') ['length','width','longitudinalDiameter','longitudinalSpacing','transverseDiameter','transverseSpacing'].forEach(positive);
      if (definition.family === 'spirals') {
        positive('barDiameter');
        if (definition.shapeType === 'ring' || definition.specialty === 'ring') positive('ringDiameter');
        else ['spiralDiameter','turns'].forEach(positive);
      }
      if (definition.family === 'piles') ['pileDiameter','pileLength','longitudinalBars','longitudinalDiameter'].forEach(positive);
      if (definition.family === 'lifts') ['diameter','barLength'].forEach(positive);
    }
  }
  const billingPolicy = commercial.normalizePolicy(input.billingPolicy);
  if (!billingPolicy) errors.push('יש להגדיר בסיס חומר יחיד וסעיפי חיוב תקינים');
  else {
    const material = {bars:'material_by_steel_type',spirals:'material_by_steel_type',mesh:'mesh_kg',piles:'pile_cages_kg',lifts:'lift_packages_kg'}[definition?.family];
    if (material && !billingPolicy.lines.includes(material)) errors.push('בסיס החומר אינו מתאים למשפחת הצורה');
  }
  return { name, itemCode, definition, billingPolicy, errors };
}
function createSavedShapeCatalog(db) {
  function cleanDefinition(input) {
    const definition = { ...input };
    for (const key of ['quantity','qty','structElement','shapeId','approvedAt','catalogIdentity','billingPolicy','custom']) delete definition[key];
    if (definition.family === 'lifts') definition.weighedKg = 0;
    return definition;
  }
  return {
    list: () => db.prepare('SELECT * FROM shapes WHERE active=1 AND definition_json IS NOT NULL ORDER BY item_code COLLATE NOCASE, name').all().map(readEntry),
    create(input) {
      const normalized = validateDefinition(input);
      if (normalized.errors.length) return { status: 400, error: normalized.errors.join('; ') };
      return db.transaction(() => {
        if (db.prepare('SELECT id FROM shapes WHERE item_code=? COLLATE NOCASE').get(normalized.itemCode)) return { status: 409, error: 'מספר הצורה כבר קיים' };
        const id = 'saved-' + crypto.randomUUID();
        const definition = cleanDefinition(normalized.definition);
        db.prepare(`INSERT INTO shapes (id,name,bends,sides_default,angles_default,item_code,definition_json,billing_json,definition_version) VALUES (?,?,?,?,?,?,?,?,1)`)
          .run(id, normalized.name, definition.angles?.length || 0, JSON.stringify(definition.sides || []), JSON.stringify(definition.angles || []), normalized.itemCode, JSON.stringify(definition), JSON.stringify(normalized.billingPolicy));
        return { status: 201, entry: readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id)) };
      })();
    },
    update(id, input) {
      const normalized = validateDefinition(input);
      if (normalized.errors.length) return { status: 400, error: normalized.errors.join('; ') };
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM shapes WHERE id=? AND active=1 AND definition_json IS NOT NULL').get(id);
        if (!row) return { status: 404, error: 'הצורה לא נמצאה' };
        if (row.definition_version !== input.expectedVersion) return { status: 409, error: 'הצורה השתנתה מאז שנפתחה. יש לבחור אותה מחדש מהקטלוג' };
        if (db.prepare('SELECT id FROM shapes WHERE item_code=? COLLATE NOCASE AND id<>?').get(normalized.itemCode, id)) return { status: 409, error: 'מספר הצורה כבר קיים' };
        const definition = cleanDefinition(normalized.definition);
        db.prepare('UPDATE shapes SET name=?,item_code=?,definition_json=?,billing_json=?,sides_default=?,angles_default=?,bends=?,definition_version=definition_version+1 WHERE id=?')
          .run(normalized.name, normalized.itemCode, JSON.stringify(definition), JSON.stringify(normalized.billingPolicy), JSON.stringify(definition.sides || []), JSON.stringify(definition.angles || []), definition.angles?.length || 0, id);
        return { status: 200, entry: readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id)) };
      })();
    },
  };
}
module.exports = { ensureSavedShapeCatalogSchema, createSavedShapeCatalog, validateDefinition };
