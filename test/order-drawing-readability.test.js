'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {reviewedDrawings,repairedSnapshot,sourceDrawingSvg,dimensionBox,edgeIntersectsBox} = require('../services/sourceDrawingGeometry');
const {itemShapeSvg} = require('../services/productionCards');

function fixture(entry) {
  const item = {segments:JSON.stringify(entry.segments),shape_id:entry.shapeId,shape_name:entry.shapeName,
    diameter:entry.diameter,quantity:entry.quantity,total_length_mm:entry.totalLengthMm};
  item.shape_snapshot_json = JSON.stringify(repairedSnapshot(item,entry));
  return item;
}

test('readable order dimensions preserve saved geometry and the compact print profile', () => {
  const entry = reviewedDrawings.find(e=>e.orderId===96&&e.row===4);
  const item = fixture(entry), before = JSON.stringify(item);
  const compact = itemShapeSvg(item), screen = itemShapeSvg(item,{dimensionFontSize:18});
  assert.match(screen,/font-size="18"/);
  assert.match(compact,/font-size="11"/);
  assert.equal(screen.match(/<path d="([^"]+)"/)[1],compact.match(/<path d="([^"]+)"/)[1]);
  assert.equal(JSON.stringify(item),before);
  assert.equal((screen.match(/data-dimension-label="1"/g)||[]).length,3);
  assert.match(screen,/>870<\/text>/);
});

test('large dimensions stay inside their frame without hiding bends or other labels', () => {
  for(const entry of reviewedDrawings.filter(e=>e.shapeId!=='closed_stirrup')) {
    const svg = sourceDrawingSvg(fixture(entry),{dimensionFontSize:18,schematic:true});
    const path=svg.match(/<path d="([^"]+)"/)[1], edges=[];
    let previous;
    for(const token of path.matchAll(/([ML]) ([\d.]+),([\d.]+)/g)) {
      const point=[Number(token[2]),Number(token[3])];
      if(token[1]==='L'&&previous)edges.push({a:previous,b:point});
      previous=point;
    }
    const labels=[...svg.matchAll(/data-dimension-segment="(-?\d+)" x="([\d.]+)" y="([\d.]+)"[^>]*>([\d.]+)<\/text>/g)]
      .map(m=>({segmentIndex:Number(m[1]),x:Number(m[2]),y:Number(m[3]),text:m[4],fontSize:18}));
    assert.equal(labels.length,entry.labels.length);
    const boxes=labels.map(dimensionBox);
    for(let i=0;i<labels.length;i++) {
      const box=boxes[i],key=`${entry.orderId}/${entry.row}/${labels[i].text}`;
      assert.ok(!edges.some(e=>edgeIntersectsBox(e,box)),key+' covers geometry');
      assert.ok(box.left>=1.999&&box.right<=278.001&&box.top>=1.999&&box.bottom<=138.001,key+' clipped');
      for(let j=0;j<i;j++) assert.ok(!(box.left<boxes[j].right&&box.right>boxes[j].left&&box.top<boxes[j].bottom&&box.bottom>boxes[j].top),key+' overlaps');
    }
    assert.doesNotMatch(svg,/marker-end|marker-start/);
  }
});

test('readability styles are scoped to order diagrams, not print pages or cage captions', () => {
  const html=fs.readFileSync('public/orders.html','utf8');
  assert.match(html,/\.item-visual svg\{[^}]*max-height:none!important/);
  assert.match(html,/\.item-visual svg\{[^}]*max-width:none!important/);
  assert.match(html,/\.item-visual svg:is\([^}]+font-size:16px/);
  assert.match(html,/\.item-visual svg \[data-angle-label\]\{font-size:14px/);
  const routes=fs.readFileSync('routes/orders.js','utf8');
  assert.match(routes,/itemShapeSvg\(item, \{ dimensionFontSize: 18, schematic: true \}\)/);
});

test('schematic screen U and L retain visible short bends without altering manufacturing data', () => {
  const entry=reviewedDrawings.find(e=>e.orderId===96&&e.row===4), item=fixture(entry);
  const before=JSON.stringify(item);
  const svg=itemShapeSvg(item,{dimensionFontSize:18,schematic:true});
  const points=[...svg.match(/<path d="([^"]+)"/)[1].matchAll(/[ML] ([\d.]+),([\d.]+)/g)].map(m=>[+m[1],+m[2]]);
  const shortLeg=Math.abs(points[1][1]-points[0][1]),bridge=Math.abs(points[2][0]-points[1][0]);
  assert.ok(shortLeg/bridge>=.139 && shortLeg>=25);
  assert.match(svg,/>46<\/text>/); assert.match(svg,/>870<\/text>/);
  assert.equal(JSON.stringify(item),before);
  const l={segments:JSON.stringify([{length_mm:100,angle_deg:90},{length_mm:9000,angle_deg:0}]),shape_name:'L'};
  const raw=JSON.stringify(l), normal=itemShapeSvg(l), schematic=itemShapeSvg(l,{schematic:true});
  assert.notEqual(normal.match(/<path d="([^"]+)"/)[1],schematic.match(/<path d="([^"]+)"/)[1]);
  assert.match(schematic,/>10<\/text>/);assert.match(schematic,/>900<\/text>/);
  assert.equal(JSON.stringify(l),raw);
});
