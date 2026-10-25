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
  assert.equal(outside[0].x, (reversedPoints[0][0]+reversedPoints[1][0])/2, '9 stays centered on its horizontal side');
  assert.equal(outside[1].y, (reversedPoints[1][1]+reversedPoints[2][1])/2, '16 stays centered on its upright');
  assert.ok(outside[1].x>Math.max(...reversedPoints.map(p=>p[0])), 'upright dimension is outside to the right');
});

test('return bend dimensions stay centered outside their own sides in either direction', () => {
  for (const depth of [10, 25]) {
    for (const points of [ [[0,0],[100,0],[100,depth],[0,depth]], [[0,depth],[100,depth],[100,0],[0,0]], [[100,0],[0,0],[0,depth],[100,depth]] ]) {
      const labels = units.diagramDimensionPositions(points, ['100', String(depth), '100']);
      const center = points.reduce((sum,p)=>[sum[0]+p[0]/4,sum[1]+p[1]/4],[0,0]);
      labels.forEach((label,i) => {
        const dx=points[i+1][0]-points[i][0],dy=points[i+1][1]-points[i][1];
        const offset=[label.x-label.mid[0],label.y-label.mid[1]];
        assert.ok(Math.abs(offset[0]*dx+offset[1]*dy)<0.001, 'no shift along the side');
        assert.ok(offset[0]*(label.mid[0]-center[0])+offset[1]*(label.mid[1]-center[1])>0, 'outward from the shape');
      });
    }
    const svg=cards.itemShapeSvg(item([1000,depth*10,1000],[90,90]));
    const points=bodyPoints(svg);
    const labels = [...svg.matchAll(/data-side-dimension="(\d+)"[\s\S]*?<text data-length-label="1" x="([\d.-]+)" y="([\d.-]+)"/g)];
    assert.equal(labels.length, 3);
    for(const match of labels) {
      const i=Number(match[1]),x=Number(match[2]),y=Number(match[3]);
      const a=points[i],b=points[i+1];
      assert.ok(Math.abs((x-(a[0]+b[0])/2)*(b[0]-a[0])+(y-(a[1]+b[1])/2)*(b[1]-a[1]))<1);
    }
  }
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
