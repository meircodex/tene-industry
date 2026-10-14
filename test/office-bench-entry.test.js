'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildOrderCommercialSummary, classifyOrderItem, summaryLine } = require('../services/orderCommercialSummary');

function chair(quantity = 440) {
  return { shape_name: 'ספסל', shape_id: 's15', struct_element: 'ספסל לרשתות Φ10@60/60 · L=118',
    note: 'ספסל לרשתות; במקור L=150, אושר להזין 118', diameter: 10, quantity,
    total_length_mm: 1180, total_weight: 1.18 * .617 * quantity,
    shape_snapshot_json: JSON.stringify({family:'bars',shapeType:'bench_bar',data:{is3d:1}}),
    segments: JSON.stringify([300,140,300,140,300].map((length_mm,i)=>({length_mm,angle_deg:i<4?90:null}))) };
}

test('mesh-support chairs remain chairs with cutting, bending and units, never mesh', () => {
  for (const qty of [1500,1200,440]) {
    const item = chair(qty);
    const classified = classifyOrderItem(item);
    assert.equal(classified.kind, 'chair');
    const summary = buildOrderCommercialSummary([item]);
    assert.equal(summaryLine(summary,'mesh_kg'), null);
    assert.equal(summaryLine(summary,'chairs_units').value, qty);
    for (const key of ['processed_rebar_kg','cutting_kg','bending_kg'])
      assert.equal(summaryLine(summary,key).value, Math.round(item.total_weight*1000)/1000);
  }
});

test('an explicit mesh family still wins over chair wording in an annotation', () => {
  const item = chair();
  item.shape_snapshot_json = JSON.stringify({family:'mesh',shapeType:'mesh_rectangular'});
  assert.equal(classifyOrderItem(item).kind, 'mesh');
});

test('a canonical bent bar cannot become mesh through source review notes', () => {
  const item = chair(8);
  item.shape_name = 'מוט מכופף'; item.shape_id = 's3';
  item.struct_element = 'אזור חדירה';
  item.note = 'הזוויות אינן מפורטות במקור, נדרשת בדיקה לפני ייצור';
  item.shape_snapshot_json = JSON.stringify({family:'bars',shapeType:'bent_bar'});
  assert.equal(classifyOrderItem(item).kind, 'bent_rebar');
  item.note += '; סמוך לרשת';
  assert.equal(classifyOrderItem(item).kind, 'bent_rebar');
});

test('legacy Hebrew mesh wording uses real Unicode word boundaries', () => {
  const item = {shape_name:'מוט מכופף',note:'נדרשת בדיקה',quantity:8,total_weight:28.95,
    total_length_mm:2290,segments:JSON.stringify([{length_mm:490,angle_deg:225},{length_mm:1200,angle_deg:135},{length_mm:600}])};
  assert.equal(classifyOrderItem(item).kind, 'bent_rebar');
  item.shape_name = 'רשת לבניין';
  assert.equal(classifyOrderItem(item).kind, 'mesh');
});

test('office preview uses chair projection before rectangular hoop recognition', () => {
  const html = fs.readFileSync('public/index.html','utf8');
  const points = [[0,0],[30,0],[30,14],[60,14],[60,0],[90,0]];
  const ctx = {window:{IronBendHoopView:{parts:()=>{throw Error('chair must not enter hoop recognition');}}},
    isBenchBarItem:()=>true, isRoundPileCageItem:()=>false, isStandaloneRingItem:()=>false,
    benchBarSVGPath:()=>({pts:points}),engineeringShapeSketchSvg:(_s,_a,p)=>p};
  vm.createContext(ctx);
  vm.runInContext(html.match(/function itemPreviewSvg\(item, sides, angles\) \{[\s\S]*?\n\}/)[0],ctx);
  assert.equal(ctx.itemPreviewSvg({is3d:1},[300,140,300,140,300],[90,90,90,90]),points);
});
