'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {meshOrderMetrics}=require('../services/customerPortalShapeDraft');
const {buildFullShapeSnapshot}=require('../services/shapeSnapshot');
const {itemShapeSvg}=require('../services/productionCards');

function mesh() {
  return buildFullShapeSnapshot({family:'mesh',shapeType:'mesh_rectangular',displayName:'רשת',
    data:{length:4300,width:2500,longitudinalDiameter:10,transverseDiameter:12,
      longitudinalSpacing:200,transverseSpacing:100,edgeLeft:0,edgeRight:0,edgeTop:0,edgeBottom:0},
    calculated:{totalLengthMm:1,weightKg:999},validation:{valid:true}});
}

test('office mesh recalculates both diameters from mm dimensions, ignoring submitted weight',()=>{
  const m=meshOrderMetrics({shapeSnapshot:mesh()});
  assert.equal(m.totalLengthMm,14*4300+44*2500);
  assert.equal(m.weightKg,+(60.2*.617+110*.888).toFixed(3));
  assert.equal(m.snapshot.data.length,4300);
  assert.equal(m.snapshot.data.width,2500);
  assert.throws(()=>meshOrderMetrics({shapeSnapshot:{...mesh(),data:{...mesh().data,longitudinalSpacing:0}}}));
});

test('office mesh approval retains quantity, element, nonzero weight and empty bend segments',()=>{
  const html=fs.readFileSync('public/index.html','utf8');
  const snapshot=meshOrderMetrics({shapeSnapshot:mesh()}).snapshot;
  const ctx={window:{},pallets:[{id:1,items:[{id:9,qty:29}]}],_shapeTarget:{palletId:1,itemId:9},
    approvedShapeContract:d=>d,itemShapeContract:i=>i.shapeSnapshot,
    renderPallets:()=>{},updateSummary:()=>{}};
  vm.createContext(ctx);
  vm.runInContext(html.match(/function shapeSelected\(data\) \{[\s\S]*?\n\}/)[0],ctx);
  vm.runInContext(html.match(/function calcItemWeight\(item\) \{[\s\S]*?\n\}/)[0],ctx);
  ctx.shapeSelected({...snapshot,orderItemQuantity:29,structElement:'רשת A'});
  const item=ctx.pallets[0].items[0];
  assert.equal(item.length,snapshot.calculated.totalLengthMm);
  assert.equal(item.qty,29);
  assert.equal(item.structElement,'רשת A');
  assert.equal(ctx.calcItemWeight(item),snapshot.calculated.weightKg*29);
  assert.equal(item.shapeSides.length,0);
});

test('mesh editor and production sheet display mm data as cm without losing its family',()=>{
  const ctx={window:{},localStorage:{getItem:()=>null},console};vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/shape-editor.js','utf8'),ctx);
  const svg=ctx.MeshEngine.render(mesh().data,300,260);
  assert.match(svg,/L 430 ס״מ/);assert.match(svg,/W 250 ס״מ/);
  assert.match(svg,/Ø10@20 ס״מ/);assert.match(svg,/Ø12@10 ס״מ/);
  assert.match(svg,/data-longitudinal-count="14"/);assert.match(svg,/data-transverse-count="44"/);
  const printed=itemShapeSvg({shapeSnapshot:mesh(),segments:'[]'});
  assert.match(printed,/data-shape-kind="mesh"/);
  assert.match(printed,/430 ס״מ/);assert.match(printed,/>250</);
  assert.doesNotMatch(printed,/spiral/);
});

test('saving an office mesh preserves both diameters, weight and source identity without classifying it as coil',()=>{
  const Database=require('better-sqlite3');
  const {ensureCoreSchema}=require('../db/coreSchema');
  const {runCoreMigrations}=require('../db/startup');
  const {createOrderFactory}=require('../services/orders');
  const db=new Database(':memory:');
  try {
    ensureCoreSchema(db);runCoreMigrations(db);
    createOrderFactory(db,{generateOrderNum:()=> 'MESH-TEST-1',industry:require('../modules/steel-rebar')}).createOrderFromPayload({
      customer:{name:'Mesh test'},order:{},pallets:[{items:[{
        shapeSnapshot:mesh(),shapeName:'רשת',diameter:10,qty:29,length:0,sides:[],angles:[],sourceItemNumber:'1',
      }]}],
    });
    const item=db.prepare('SELECT * FROM items').get();
    assert.equal(item.shape_name,'רשת');assert.equal(item.quantity,29);
    assert.equal(item.total_length_mm,170200);
    assert.equal(item.total_weight,meshOrderMetrics({shapeSnapshot:mesh()}).weightKg*29);
    assert.equal(item.segments,'[]');assert.equal(item.spiral_turns,null);
    assert.equal(item.source_item_number,'1');
    const snapshot=JSON.parse(item.shape_snapshot_json);
    assert.equal(snapshot.data.transverseDiameter,12);
    assert.notEqual(snapshot.calculated.weightKg,999);
    assert.match(itemShapeSvg(item),/data-shape-kind="mesh"/);
  } finally {db.close();}
});
