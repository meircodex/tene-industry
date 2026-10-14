'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const units = require('../public/display-units');
const cards = require('../services/productionCards');
function bodyPoints(svg) {
  const pathData=svg.match(/<path d="(M [^"]+)"/)[1];
  const nums=pathData.match(/-?\d+(?:\.\d+)?/g).map(Number);
  return Array.from({length:nums.length/2},(_,i)=>[nums[i*2],nums[i*2+1]]);
}
function item(sides,angles) {
  return {shape_name:'מוט מכופף',diameter:16,quantity:64,total_length_mm:sides.reduce((a,b)=>a+b,0),total_weight:475.3,segments:JSON.stringify(sides.map((length_mm,i)=>({length_mm,angle_deg:angles[i]??0})))};
}
test('symmetric penetration detail keeps the central base horizontal, not its diagonal',()=>{
  const row=item([300,650,1050,700,1050,650,300],[90,125.2,234.8,234.8,125.2,90]);
  const before=JSON.stringify(row);
  const svg=cards.itemShapeSvg(row),pts=bodyPoints(svg);
  assert.ok(Math.abs(pts[3][1]-pts[4][1])<0.1);
  assert.ok(Math.abs(pts[1][1]-pts[2][1])<0.1);
  assert.ok(Math.abs(pts[5][1]-pts[6][1])<0.1);
  assert.match(svg,/data-dimension-layout="outside"/);
  assert.equal((svg.match(/data-side-dimension=/g)||[]).length,7);
  assert.equal(JSON.stringify(row),before,'no geometry, quantity, length or weight writes');
  for(const text of svg.matchAll(/data-angle-label="1"[^>]*>([^<]*)</g)) assert.match(text[1],/°$/);
  assert.doesNotMatch(svg,/marker-end|marker-start/,'no dimension arrows');
});
test('U bridge label is below the base; closure lengths remain independent',()=>{
  const svg=cards.itemShapeSvg(item([300,2100,300],[90,90]));
  const label=svg.match(/<text[^>]*y="([\d.]+)"[^>]*>210<\/text>/);
  assert.ok(label && Number(label[1])>78);
  assert.match(svg,/font-size="12"/);
  const hoop=cards.itemShapeSvg(item([80,500,800,500,800,100],[135,90,90,90,135]));
  assert.match(hoop,/data-shape-kind="closed-stirrup"/);
  assert.match(hoop,/>8<\/text>/);
  assert.match(hoop,/>10<\/text>/);
});
test('100/16/9 step has 16 above the upright and 9 to its right without label collisions',()=>{
  const pts=[[0,0],[100,0],[116,0],[116,-9]];
  const before=JSON.stringify(pts);
  const labels=units.diagramDimensionPositions(pts,['100','16','9']);
  assert.ok(labels[1].y<-9);
  assert.ok(labels[2].x>116);
  assert.ok(labels[0].y>0);
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++) {
    const a=labels[i].box,b=labels[j].box;
    assert.ok(a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top);
  }
  assert.equal(JSON.stringify(pts),before);
  const row=item([1000,160,90],[180,270]);
  const svg=cards.itemShapeSvg(row);
  assert.match(svg,/>16<\/text>/);
  assert.match(svg,/>9<\/text>/);
  assert.equal(row.total_length_mm,1250);
  const reversed=cards.itemShapeSvg(item([90,160,1000],[270,270]));
  const reversedPoints=bodyPoints(reversed);
  assert.ok(reversedPoints[1][0]>reversedPoints[3][0],'the return hook remains on the right');
  const outside=units.diagramDimensionPositions(reversedPoints,['9','16','100']);
  assert.ok(outside[0].x>Math.max(...reversedPoints.map(p=>p[0])),'9 is outside to the right');
  assert.ok(outside[1].y<Math.min(...reversedPoints.map(p=>p[1])),'16 is above the upright');
});
test('editor draft uses the same orientation and outside placement without changing its data contract',()=>{
  const context=vm.createContext({window:{IronBendDisplayUnits:units},console,localStorage:{getItem:()=>null}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../services/shapeSnapshot.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/shape-editor.js'),'utf8'),context);
  const shape={sides:[300,650,1050,700,1050,650,300],angles:[90,125.2,234.8,234.8,125.2,90],diameter:16};
  const before=JSON.stringify(shape);
  const svg=context.window.IronBendShapeGeometry.PolylineBarEngine.render(shape,300,260);
  const pts=bodyPoints(svg);
  assert.ok(Math.abs(pts[3][1]-pts[4][1])<0.1);
  assert.equal((svg.match(/data-side-dimension=/g)||[]).length,7);
  for(const label of svg.matchAll(/data-angle-label="1"[^>]*>([^<]*)</g)) assert.match(label[1],/°$/);
  assert.equal(JSON.stringify(shape),before);
});
