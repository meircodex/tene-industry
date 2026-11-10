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
    active: row.active === 1, definition: JSON.parse(row.definition_json), billingPolicy: JSON.parse(row.billing_json) };
}
function validateDefinition(input, builtinId = null) {
  const errors = [];
  const name = String(input.name || '').trim();
  const itemCode = String(input.itemCode || '').trim();
  if (!name || name.length > 120) errors.push('יש להזין שם צורה עד 120 תווים');
  if (!commercial.numericItemCode(itemCode)) errors.push('מק״ט חייב להכיל ספרות בלבד, עד 40 ספרות');
  if (Object.entries(commercial.BUILTIN_CODES).some(([id,code]) => code === itemCode && id !== builtinId)) errors.push('מק״ט זה שייך לצורה מובנית');
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
    for (const key of ['quantity','qty','structElement','shapeId','approvedAt','catalogIdentity','billingPolicy','custom','builtinPresetId']) delete definition[key];
    if (definition.family === 'lifts') definition.weighedKg = 0;
    return definition;
  }
  return {
    list: () => db.prepare('SELECT * FROM shapes WHERE active=1 AND definition_json IS NOT NULL ORDER BY item_code COLLATE NOCASE, name').all().map(readEntry),
    archived: () => db.prepare('SELECT * FROM shapes WHERE active=0 AND definition_json IS NOT NULL ORDER BY item_code COLLATE NOCASE, name').all().map(row => {
      const entry=readEntry(row);
      return {id:entry.id,itemCode:entry.itemCode,name:entry.name,version:entry.version,builtinId:entry.definition.builtinPresetId || null};
    }),
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
    updateBuiltin(builtinId, input) {
      if (!Object.hasOwn(commercial.BUILTIN_CODES,builtinId)) return {status:404,error:'הצורה לא נמצאה'};
      const id = 'catalog-builtin-' + builtinId;
      const normalized = validateDefinition(input,builtinId);
      if (normalized.errors.length) return {status:400,error:normalized.errors.join('; ')};
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM shapes WHERE id=?').get(id);
        if (row) return this.update(id,input);
        if (input.expectedVersion !== 1) return {status:409,error:'גרסת הצורה השתנתה; יש לפתוח אותה מחדש'};
        if (db.prepare('SELECT id FROM shapes WHERE item_code=?').get(normalized.itemCode)) return {status:409,error:'מספר הצורה כבר קיים'};
        const definition = {...cleanDefinition(normalized.definition),builtinPresetId:builtinId};
        db.prepare('INSERT INTO shapes(id,name,bends,sides_default,angles_default,item_code,definition_json,billing_json,definition_version) VALUES(?,?,?,?,?,?,?,?,2)').run(id,normalized.name,definition.angles?.length||0,JSON.stringify(definition.sides||[]),JSON.stringify(definition.angles||[]),normalized.itemCode,JSON.stringify(definition),JSON.stringify(normalized.billingPolicy));
        return {status:200,entry:readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id))};
      })();
    },
    update(id, input) {
      const existing = db.prepare('SELECT * FROM shapes WHERE id=? AND active=1 AND definition_json IS NOT NULL').get(id);
      if (!existing) return { status: 404, error: 'הצורה לא נמצאה' };
      const builtinId = JSON.parse(existing.definition_json).builtinPresetId || null;
      const normalized = validateDefinition(input,builtinId);
      if (normalized.errors.length) return { status: 400, error: normalized.errors.join('; ') };
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM shapes WHERE id=? AND active=1 AND definition_json IS NOT NULL').get(id);
        if (!row) return { status: 404, error: 'הצורה לא נמצאה' };
        if (row.definition_version !== input.expectedVersion) return { status: 409, error: 'הצורה השתנתה מאז שנפתחה. יש לבחור אותה מחדש מהקטלוג' };
        if (db.prepare('SELECT id FROM shapes WHERE item_code=? COLLATE NOCASE AND id<>?').get(normalized.itemCode, id)) return { status: 409, error: 'מספר הצורה כבר קיים' };
        const definition = cleanDefinition(normalized.definition);
        if (builtinId) definition.builtinPresetId = builtinId;
        db.prepare('UPDATE shapes SET name=?,item_code=?,definition_json=?,billing_json=?,sides_default=?,angles_default=?,bends=?,definition_version=definition_version+1 WHERE id=?')
          .run(normalized.name, normalized.itemCode, JSON.stringify(definition), JSON.stringify(normalized.billingPolicy), JSON.stringify(definition.sides || []), JSON.stringify(definition.angles || []), definition.angles?.length || 0, id);
        return { status: 200, entry: readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id)) };
      })();
    },
    archiveBuiltin(builtinId, input) {
      if (!Object.hasOwn(commercial.BUILTIN_CODES,builtinId)) return {status:404,error:'הצורה לא נמצאה'};
      return db.transaction(() => {
        const id='catalog-builtin-'+builtinId;
        if (db.prepare('SELECT id FROM shapes WHERE id=?').get(id)) return this.archive(id,input);
        if (input.expectedVersion!==1) return {status:409,error:'גרסת הצורה השתנתה; יש לבחור אותה מחדש לפני הסרה'};
        const normalized=validateDefinition({...input,itemCode:commercial.BUILTIN_CODES[builtinId]},builtinId);
        if (normalized.errors.length) return {status:400,error:normalized.errors.join('; ')};
        if (db.prepare('SELECT id FROM shapes WHERE item_code=?').get(normalized.itemCode)) return {status:409,error:'מספר הצורה כבר קיים'};
        const definition={...cleanDefinition(normalized.definition),builtinPresetId:builtinId};
        db.prepare('INSERT INTO shapes(id,name,bends,sides_default,angles_default,item_code,definition_json,billing_json,definition_version,active) VALUES(?,?,?,?,?,?,?,?,2,0)')
          .run(id,normalized.name,definition.angles?.length||0,JSON.stringify(definition.sides||[]),JSON.stringify(definition.angles||[]),normalized.itemCode,JSON.stringify(definition),JSON.stringify(normalized.billingPolicy));
        return {status:200,entry:readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id))};
      })();
    },
    archive(id, input) {
      return db.transaction(() => {
        const row=db.prepare('SELECT * FROM shapes WHERE id=? AND definition_json IS NOT NULL').get(id);
        if (!row) return {status:404,error:'הצורה לא נמצאה'};
        if (row.definition_version!==input.expectedVersion) return {status:409,error:'הצורה השתנתה מאז שנפתחה. יש לבחור אותה מחדש לפני הסרה'};
        if (!row.active) return {status:200,entry:readEntry(row)};
        db.prepare('UPDATE shapes SET active=0,definition_version=definition_version+1 WHERE id=?').run(id);
        return {status:200,entry:readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id))};
      })();
    },
    restore(id, input) {
      return db.transaction(() => {
        const row=db.prepare('SELECT * FROM shapes WHERE id=? AND definition_json IS NOT NULL').get(id);
        if (!row) return {status:404,error:'הצורה לא נמצאה'};
        if (row.definition_version!==input.expectedVersion) return {status:409,error:'הצורה השתנתה מאז שנפתחה. יש לרענן את רשימת הצורות לפני שחזור'};
        if (row.active) return {status:200,entry:readEntry(row)};
        db.prepare('UPDATE shapes SET active=1,definition_version=definition_version+1 WHERE id=?').run(id);
        return {status:200,entry:readEntry(db.prepare('SELECT * FROM shapes WHERE id=?').get(id))};
      })();
    },
  };
}
module.exports = { ensureSavedShapeCatalogSchema, createSavedShapeCatalog, validateDefinition };
