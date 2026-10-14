'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const units = require('../public/display-units');
const cards = require('../services/productionCards');

function editorContext() {
  const context = { window: { IronBendDisplayUnits: units }, console, localStorage: { getItem: () => null }, document: { querySelector: () => null } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/shapeSnapshot.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/shape-editor.js'), 'utf8'), context);
  return context;
}

test('signed angle display preserves direction, decimals and the signed 180 boundary', () => {
  for (const [stored, label] of [[270,'-90°'],[330,'-30°'],[201,'-159°'],[329.3,'-30.7°'],[90,'+90°'],[135,'+135°'],[180,'+180°'],[-180,'-180°'],[360,'0°'],[-360,'0°'],[null,'—']]) {
    assert.equal(units.formatSignedAngle(stored), label);
  }
  for (let angle=-720; angle<=720; angle+=7.5) {
    const signed = units.signedAngleDegrees(angle);
    assert.ok(signed >= -180 && signed <= 180);
    assert.ok(Math.abs(Math.sin(angle*Math.PI/180)-Math.sin(signed*Math.PI/180)) < 1e-9);
    assert.ok(Math.abs(Math.cos(angle*Math.PI/180)-Math.cos(signed*Math.PI/180)) < 1e-9);
  }
});

test('editing a signed angle round trips to the same canonical stored geometry', () => {
  const context = editorContext();
  const modal = Object.create(context.window.IronBendShapeGeometry.ShapeEditorModal.prototype);
  modal.current = { sides:[500,800], angles:[270], azAngles:[0,-90] };
  modal._updatePreview = () => {};
  modal._setAngle(0, -90);
  assert.equal(modal.current.angles[0], 270);
  modal._setAngle(0, -30.7);
  assert.equal(modal.current.angles[0], 329.3);
});

test('both source hoops in order 91 use an upright rectangle, not a rotated generic polygon', () => {
  const context = editorContext();
  for (const [sides, angles] of [
    [[100,500,800,500,800,100],[329.3,270,270,270,300.7]],
    [[100,500,230,500,230,100],[311,270,270,270,319]],
    [[80,600,600,600,600,100],[135,90,90,90,135]],
  ]) {
    const item = {shape_name:'חישוק',diameter:12,quantity:208,total_length_mm:sides.reduce((a,b)=>a+b,0),segments:JSON.stringify(sides.map((length_mm,i)=>({length_mm,angle_deg:angles[i]??0})))};
    const frozen = JSON.stringify(item);
    const svg = cards.itemShapeSvg(item);
    assert.match(svg, /data-shape-kind="closed-stirrup"/);
    assert.match(svg, /data-stirrup-marker="overlap"/);
    assert.doesNotMatch(svg, /270°|329\.3°|rotate\(/);
    assert.equal(JSON.stringify(item), frozen);
    const detected = context.detectClosedStirrupParts(sides, angles);
    assert.equal(detected.tailStart, sides[0]);
    assert.equal(detected.tailEnd, sides[5]);
    assert.equal(detected.right, sides[1]);
    assert.equal(detected.top, sides[2]);
    const preview = context.PolylineBarEngine.render({sides,angles},300,260);
    assert.match(preview,/data-shape-kind="closed-stirrup"/);
  }
});

test('an open L or mixed-direction rectangle is not forced into a hoop drawing', () => {
  const ctx = editorContext();
  assert.equal(ctx.detectClosedStirrupParts([100,500,800,500,800,100],[135,90,270,90,135]),null);
  assert.equal(ctx.detectClosedStirrupParts([500,800,500,800],[90,270,90]),null);
  assert.doesNotMatch(cards.itemShapeSvg({segments:JSON.stringify([{length_mm:500,angle_deg:90},{length_mm:800,angle_deg:270},{length_mm:500,angle_deg:90},{length_mm:800,angle_deg:0}])}),/data-shape-kind="closed-stirrup"/);
  assert.doesNotMatch(cards.itemShapeSvg({segments:JSON.stringify([{length_mm:500,angle_deg:90},{length_mm:800,angle_deg:270},{length_mm:500,angle_deg:0}])}),/data-shape-kind="open-u"/);
  assert.doesNotMatch(cards.itemShapeSvg({shape_name:'L',segments:JSON.stringify([{length_mm:500,angle_deg:270},{length_mm:800,angle_deg:0}])}),/data-shape-kind="closed-stirrup"/);
});

test('screen and print retain the fresh canonical server SVG rather than rebuild hoops', () => {
  const orders = fs.readFileSync(path.join(__dirname,'../public/orders.html'),'utf8');
  const printed = fs.readFileSync(path.join(__dirname,'../services/productionCardPrintPage.js'),'utf8');
  assert.match(orders,/const canonicalShapeSvg = encodeURIComponent\(item\.shape_svg \|\| ''\)/);
  assert.doesNotMatch(printed,/if \(isHoop && cleanSegments\.length\) return generated/);
  assert.match(printed,/return item\.shape_svg \|\| generated/);
});
