'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const recognition=require('../modules/steel-rebar/shape-recognition');
const commercial=require('../modules/steel-rebar/shape-commercial');
const {createSavedShapeCatalog,ensureSavedShapeCatalogSchema}=require('../services/savedShapeCatalog');
const {buildOrderCommercialSummary,summaryLine}=require('../services/orderCommercialSummary');
const u={family:'bars',sides:[300,600,300],angles:[90,90]};
const entry=(code,shape,name='שם חופשי')=>({code,name,source:'shared',shape:{...shape,id:'saved-'+code}});

test('manual U recognition uses bend order, ignores lengths/diameter/name/quantity, and adds no unit fee',()=>{
  const input={...u,sides:[400,200,700],diameter:20,quantity:30,presetName:'חישוק',category:'שם לא מוכיח מוצר'};
  const catalog=[entry('31',u,'ח׳'),entry('32',{...u,roundedBends:true},'מעוגל')];
  const result=recognition.recognize(input,catalog);
  assert.equal(result.status,'unique');assert.equal(result.candidates[0].code,'31');
  assert.equal(recognition.matches({...input,angles:[90,-90]},u),false,'opposite bend direction is a different path');
  const policy=commercial.defaultPolicy(u);
  const summary=buildOrderCommercialSummary([{quantity:30,total_weight:123,shapeSnapshot:{family:'bars',billingPolicy:policy,catalogIdentity:{itemCode:'31'},data:input}}]);
  assert.equal(summary.material_weight_kg,123);assert.equal(summaryLine(summary,'cutting_kg').value,123);assert.equal(summaryLine(summary,'bending_kg').value,123);
  assert.equal(summary.lines.some(line=>line.unit==='unit'),false);
});

test('same geometry with different products stays ambiguous, irrespective of matching names or dimensions',()=>{
  const a=entry('31',u,'ח׳'),b=entry('32',u,'מוצר מיוחד לפי יחידות');
  const before=JSON.stringify(u),result=recognition.recognize(u,[b,a]);
  assert.equal(result.status,'ambiguous');assert.deepEqual(result.candidates.map(e=>e.code),['32','31']);assert.equal(JSON.stringify(u),before);
  assert.equal(recognition.recognize(u,[]).status,'unmatched');
  assert.equal(recognition.recognize(u,[{...a,source:'local'}]).status,'unmatched');
});

test('closed loops require geometric closure; extra legs, overlaps and rounded ends remain distinct',()=>{
  const rectangle={family:'bars',sides:[400,200,400,200],angles:[90,90,90,90]};
  assert.equal(recognition.matches({...rectangle,sides:[800,500,800,500],angles:[90,90,90]},rectangle),true,'final metadata closing angle is not an extra segment');
  assert.equal(recognition.matches({...rectangle,sides:[400,200,500,200]},rectangle),false,'four right turns alone do not establish closure');
  assert.equal(recognition.matches({...rectangle,sides:[400,200,400,200,100],angles:[90,90,90,90]},rectangle),false);
  const overlap={family:'bars',sides:[150,200,400,200,400,150],angles:[90,90,90,90,90]};
  assert.equal(recognition.describe(overlap).overlaps.length,2);
  assert.equal(recognition.matches({...overlap,sides:[150,200,100,200,400,150]},overlap),false,'a new overlapping interval pattern is not silently accepted');
  assert.equal(recognition.matches(u,{...u,shapeType:'rounded_end_bar'}),false);
});

test('reversal, mirror and opt-out are explicit rules; true 3D geometry differs from a 2D silhouette',()=>{
  const mirrored={...u,angles:[-90,-90]};
  const oneWay={...u,recognitionRules:{version:1,enabled:true,allowReverse:false,allowMirror:false}};
  assert.equal(recognition.matches(mirrored,oneWay),false);
  assert.equal(recognition.matches(mirrored,{...oneWay,recognitionRules:{...oneWay.recognitionRules,allowMirror:true}}),true);
  assert.equal(recognition.matches(mirrored,u),true,'the same bar may be entered from the other end');
  assert.equal(recognition.matches(u,{...oneWay,recognitionRules:{...oneWay.recognitionRules,enabled:false}}),false);
  const bench={family:'bars',sides:[280,170,300,170,280],angles:[90,90,90,90],is3d:1,azAngles:[0,90,90,90,90],elAngles:[90,0,0,0,90]};
  assert.equal(recognition.describe(bench).nonPlanar,true);
  assert.equal(recognition.matches({...bench,sides:[200,300,500,300,200],shapeType:'custom_bar'},bench),true);
  assert.equal(recognition.matches({...bench,is3d:0},bench),false);
  assert.equal(recognition.matches({...bench,azAngles:[15,90,90,90,90]},bench),true,'global azimuth changes do not change a product');
  assert.equal(recognition.describe({...bench,elAngles:[]}).valid,false);
});

test('invalid and non-finite geometry cannot produce a product match; curved product families do not mix',()=>{
  for(const sides of [[],[0],[NaN],[Infinity],['100'],Array(101).fill(1)])assert.equal(recognition.describe({...u,sides}).valid,false);
  assert.equal(recognition.describe({...u,angles:[90]}).valid,false);
  const ring={family:'spirals',shapeType:'ring',barDiameter:8,ringDiameter:400};
  const spiral={family:'spirals',barDiameter:8,spiralDiameter:400,turns:20};
  assert.equal(recognition.matches(ring,spiral),false);assert.equal(recognition.matches({...ring,ringDiameter:800},ring),true);
});

test('versioned catalogue stores validated rules, derives authoritative traits, and never trusts supplied trait labels',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE shapes(id TEXT PRIMARY KEY,name TEXT,bends INTEGER,sides_default TEXT,angles_default TEXT,active INTEGER DEFAULT 1)');ensureSavedShapeCatalogSchema(db);
  const catalog=createSavedShapeCatalog(db),input={name:'ח׳',itemCode:'31',definition:{...u,recognitionTraits:{closed:true},productRecognition:{method:'forged'}},billingPolicy:commercial.defaultPolicy(u)};
  const saved=catalog.create(input);assert.equal(saved.status,201);
  assert.equal(saved.entry.recognitionTraits.closed,false);assert.equal(saved.entry.definition.recognitionTraits,undefined);assert.equal(saved.entry.definition.productRecognition,undefined);
  assert.deepEqual(saved.entry.definition.recognitionRules,{version:1,enabled:true,allowReverse:true,allowMirror:false});
  assert.equal(catalog.create({...input,itemCode:'32',definition:{...u,recognitionRules:{version:1,enabled:'yes'}}}).status,400);
  const revised=catalog.update(saved.entry.id,{...input,expectedVersion:1,definition:{...u,recognitionRules:{version:1,enabled:false,allowReverse:true,allowMirror:false}}});
  assert.equal(revised.entry.version,2);assert.equal(recognition.matches(u,revised.entry.definition),false);
  assert.equal(catalog.archive(saved.entry.id,{expectedVersion:2}).status,200);assert.equal(catalog.list().length,0);
});
