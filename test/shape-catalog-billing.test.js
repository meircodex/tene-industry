'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const commercial = require('../modules/steel-rebar/shape-commercial');
const { ensureSavedShapeCatalogSchema, createSavedShapeCatalog } = require('../services/savedShapeCatalog');
const { buildOrderCommercialSummary, classifyOrderItem, summaryLine } = require('../services/orderCommercialSummary');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hoopPolicy = commercial.defaultPolicy({ presetId: 's8' });
function definition(overrides = {}) {
  return { name: 'חישוק בדיקה', itemCode: '001', definition: { family: 'bars', sides: [400,200,400,200], angles: [90,90,90,90], quantity: 100 }, billingPolicy: hoopPolicy, ...overrides };
}
function row(id, policy, weight, qty, extra = {}) {
  return { id, quantity: qty, total_weight: weight, total_length_mm: 1200, diameter: 8, shape_name: 'שם שלא מזהה צורה',
    shapeSnapshot: { family: 'bars', data: { sides: [400,200,400,200], angles: [90,90,90,90] }, billingPolicy: policy, catalogIdentity: { id: 'saved-test', itemCode: '001', version: 1 } }, ...extra };
}
test('shared catalogue migrates existing rows without loss, preserves codes and prevents duplicates/stale updates', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE shapes(id TEXT PRIMARY KEY,name TEXT,bends INTEGER,sides_default TEXT,angles_default TEXT,active INTEGER DEFAULT 1); INSERT INTO shapes(id,name) VALUES(\'legacy\',\'original\')');
  ensureSavedShapeCatalogSchema(db); ensureSavedShapeCatalogSchema(db);
  const catalog = createSavedShapeCatalog(db);
  assert.equal(db.prepare('SELECT name FROM shapes WHERE id=?').get('legacy').name, 'original');
  assert.deepEqual(catalog.list(), []);
  const created = catalog.create(definition()); assert.equal(created.status, 201);
  assert.equal(created.entry.itemCode, '001'); assert.equal(created.entry.definition.quantity, undefined);
  assert.deepEqual(created.entry.billingPolicy, hoopPolicy);
  assert.equal(catalog.create(definition()).status, 409);
  assert.equal(catalog.create(definition({ itemCode: 'S8' })).status, 400);
  assert.equal(catalog.create(definition({ itemCode: 'ABC' })).status, 201);
  assert.equal(catalog.create(definition({ itemCode: 'abc' })).status, 409);
  const updated = catalog.update(created.entry.id, definition({ expectedVersion: 1, name: 'שם חדש', billingPolicy: commercial.defaultPolicy({ shapeType: 'bench_bar' }) }));
  assert.equal(updated.status, 200); assert.equal(updated.entry.version, 2);
  assert.equal(catalog.update(created.entry.id, definition({ expectedVersion: 1 })).status, 409);
  assert.deepEqual(created.entry.billingPolicy, hoopPolicy, 'earlier order snapshots remain independent');
  const lift = catalog.create(definition({itemCode:'LIFT-1',definition:{family:'lifts',diameter:12,barLength:12000,weighedKg:900,quantity:3},billingPolicy:commercial.defaultPolicy({family:'lifts'})}));
  assert.equal(lift.status,201); assert.equal(lift.entry.definition.weighedKg,0,'a past order weighing must not become a template default');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
test('invalid geometry and ambiguous material basis cannot enter shared catalogue', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE shapes(id TEXT PRIMARY KEY,name TEXT,bends INTEGER,sides_default TEXT,angles_default TEXT,active INTEGER DEFAULT 1)'); ensureSavedShapeCatalogSchema(db);
  const catalog = createSavedShapeCatalog(db);
  assert.equal(catalog.create(definition({ definition: { family:'bars',sides:[0],angles:[] } })).status, 400);
  assert.equal(catalog.create(definition({ definition: { family:'bars',sides:[100,100],angles:[90],is3d:1 } })).status, 400);
  assert.equal(catalog.create(definition({ billingPolicy: { ...hoopPolicy, lines: [...hoopPolicy.lines,'mesh_kg'] } })).status, 400);
  assert.equal(catalog.create(definition({ billingPolicy: { ...hoopPolicy, lines: ['material_by_steel_type','invented'] } })).status, 400);
  assert.equal(catalog.list().length, 0);
});
test('hoop and bench coexist, smooth steel is distinct and processing does not multiply material weight', () => {
  const hoop = row(1, hoopPolicy, 100, 20);
  const bench = row(2, commercial.defaultPolicy({ shapeType:'bench_bar' }), 50, 10, { steelFinish:'smooth' });
  const summary = buildOrderCommercialSummary([hoop,bench]);
  for (const [key,value] of [['processed_rebar_kg',100],['smooth_rebar_kg',50],['cutting_kg',150],['bending_kg',150],['hoops_units',20],['chairs_units',10]]) assert.equal(summaryLine(summary,key).value,value,key);
  const material = summary.lines.filter(line => line.section === 'material');
  assert.equal(material.reduce((sum,line) => sum+line.value,0),150);
  const classified = classifyOrderItem({ ...hoop, shape_name:'ספסל' });
  assert.equal(classified.kind,'hoop'); assert.equal(classified.billingSource,'saved_shape_policy');
  assert.equal(classified.billingBasis.find(line => line.key === 'hoops_units').value,20);
  assert.equal(classified.catalogIdentity.version,1);
});
test('straight stock cutting is configurable and partial quantities keep the same policy', () => {
  const policy = commercial.defaultPolicy({ sides:[6000],angles:[] });
  assert.ok(!commercial.resolvedLines(policy,{lengthMm:6000}).includes('cutting_kg'));
  assert.ok(commercial.resolvedLines({...policy,cuttingMode:'always'},{lengthMm:6000}).includes('cutting_kg'));
  const partial = buildOrderCommercialSummary([row(1,hoopPolicy,25,5)]);
  assert.equal(summaryLine(partial,'hoops_units').value,5);
  assert.equal(summaryLine(partial,'bending_kg').value,25);
  assert.equal(summaryLine(partial,'processed_rebar_kg').value,25);
});
test('new order client serialization keeps a detached copy of billing policy and catalogue revision', () => {
  const html = fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const source = html.slice(html.indexOf('function approvedShapeContract('),html.indexOf('function spiralFieldsFromShapeData('));
  const serialize = vm.runInNewContext(source+'; approvedShapeContract;');
  const input = { contractVersion:2,shapeType:'custom_bar',family:'bars',data:{},billingPolicy:hoopPolicy,catalogIdentity:{id:'saved-1',itemCode:'001',version:1} };
  const output = serialize(input);
  assert.deepEqual(JSON.parse(JSON.stringify(output.billingPolicy)),hoopPolicy);
  assert.equal(output.catalogIdentity.itemCode,'001');
  input.catalogIdentity.version=2; assert.equal(output.catalogIdentity.version,1);
});
test('intake corrections keep explicit product billing even when old OCR suggests another shape', () => {
  const { normalizeIntakeItem } = require('../services/intakeWorkflow');
  const normalized = normalizeIntakeItem({diameter:10,quantity:20,total_length_mm:1200,sides:[400,200,400,200],angles:[90,90,90],shape_name:'שם מתוקן',externalShapeCode:'unknown',steelFinish:'smooth',shapeSnapshot:{billingPolicy:hoopPolicy,catalogIdentity:{itemCode:'001',version:1}}});
  assert.deepEqual(normalized.shapeSnapshot.billingPolicy,hoopPolicy);
  assert.equal(normalized.shapeSnapshot.catalogIdentity.itemCode,'001');
  assert.equal(normalized.shapeSnapshot.data.diameter,10);
  assert.equal(normalized.shapeSnapshot.data.steelFinish,'smooth');
  assert.equal(normalized.requires_shape_edit,false);
});
