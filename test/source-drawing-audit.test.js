const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { reviewedDrawings,repairSourceDrawingOrders,repairedSnapshot,sourceDrawingSvg,sourceDrawingForItem } = require('../services/sourceDrawingGeometry');
const cards = require('../services/productionCards');
const { classifyOrderItem } = require('../services/orderCommercialSummary');

function fixtureDb() {
  const db=new Database(':memory:');
  ensureCoreSchema(db);
  db.prepare('INSERT INTO customers(id,name) VALUES(1,?)').run('י.ד עשוש');
  for (const orderId of [...new Set(reviewedDrawings.map(e=>e.orderId))]) {
    db.prepare('INSERT INTO orders(id,order_num,customer_id,status) VALUES(?,?,1,?)').run(orderId,`HZ-2026-${String(orderId).padStart(3,'0')}`,'ממתינה לאישור');
    db.prepare('INSERT INTO pallets(id,order_id,pallet_num) VALUES(?,?,1)').run(orderId,orderId);
    for (const e of reviewedDrawings.filter(e=>e.orderId===orderId)) {
      db.prepare(`INSERT INTO items(pallet_id,order_id,sort_order,shape_name,diameter,quantity,total_length_mm,segments,weight_per_unit,total_weight)
        VALUES(?,?,?,'old shape',?,?,?,?,1,?)`).run(orderId,orderId,e.row,e.previousDiameter ?? e.diameter,e.quantity,e.previousLengthMm ?? e.totalLengthMm,JSON.stringify(e.segments),e.quantity);
    }
  }
  return db;
}

test('all 322 source rows reconcile diameter, quantity and total length; manual hoop data is explicit',()=>{
  assert.equal(reviewedDrawings.length,322);
  const keys=new Set();
  for (const e of reviewedDrawings) {
    const key=e.orderId+':'+e.row;
    assert.ok(!keys.has(key),key);keys.add(key);
    assert.ok(e.diameter>0 && e.quantity>0,key);
    assert.equal(e.segments.reduce((s,x)=>s+x.length_mm,0),e.totalLengthMm,key);
  }
  const hoop=reviewedDrawings.find(e=>e.orderId===88 && e.row===2);
  assert.equal(hoop.diameter,8);assert.equal(hoop.quantity,48);
  assert.deepEqual(hoop.segments.map(s=>s.length_mm),[100,600,600,600,600,100]);
});

test('repairs are source identity guarded, retain every before state and never overwrite later edits',()=>{
  const db=fixtureDb();
  try {
    const initial=repairSourceDrawingOrders(db);
    assert.equal(initial.skipped.length,0);
    assert.equal(initial.repaired.reduce((s,o)=>s+o.items,0),322);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_geometry_repairs WHERE version=?').get('source-paths-20261012-v1').n,322);
    const item=db.prepare('SELECT * FROM items WHERE order_id=97 AND sort_order=4').get();
    const snapshot=JSON.parse(item.shape_snapshot_json);
    assert.deepEqual(snapshot.data.sides,[300,650,1050,700,1050,650,300]);
    assert.equal(sourceDrawingForItem(item).requiresAngleConfirmation,true);
    const amended='[{"length_mm":500,"angle_deg":0}]';
    db.prepare('UPDATE items SET segments=? WHERE id=?').run(amended,item.id);
    assert.equal(repairSourceDrawingOrders(db).repaired.length,0);
    const read=db.prepare('SELECT * FROM items WHERE id=?').get(item.id);
    assert.equal(read.segments,amended);
    assert.equal(sourceDrawingSvg(read),'');
  } finally {db.close();}
});

test('source corrections recalculate weights and source labels without overwriting subsequent edits',()=>{
  const db=fixtureDb();
  try {
    repairSourceDrawingOrders(db);
    const kg=require('../constants').rebarKgPerMeter;
    for (const [order,row,length,diameter,quantity] of [[90,3,5100,16,44],[90,15,2270,12,24],[88,2,2600,8,48]]) {
      const item=db.prepare('SELECT * FROM items WHERE order_id=? AND sort_order=?').get(order,row);
      assert.equal(item.total_length_mm,length);
      assert.equal(item.diameter,diameter);
      assert.equal(item.total_weight,kg(diameter)*length/1000*quantity);
      assert.equal(JSON.parse(item.shape_snapshot_json).calculated.totalWeightKg,item.total_weight);
    }
    const item=db.prepare('SELECT * FROM items WHERE order_id=95 AND sort_order=3').get();
    assert.match(item.struct_element,/ראש כלונס/);
    db.prepare('UPDATE items SET struct_element=? WHERE id=?').run('Customer amended name',item.id);
    repairSourceDrawingOrders(db);
    assert.equal(db.prepare('SELECT struct_element FROM items WHERE id=?').get(item.id).struct_element,'Customer amended name');
  } finally {db.close();}
});

test('source plots preserve the N diagonal valley and the K crossing paths in cards and orders',()=>{
  for (const [order,row] of [[97,4],[95,3],[95,4],[95,6],[95,8],[90,3],[94,3]]) {
    const entry=reviewedDrawings.find(e=>e.orderId===order&&e.row===row);
    const item={segments:JSON.stringify(entry.segments),diameter:entry.diameter,quantity:entry.quantity,total_length_mm:entry.totalLengthMm,shape_name:entry.shapeName};
    item.shape_snapshot_json=JSON.stringify(repairedSnapshot(item,entry));
    const svg=cards.itemShapeSvg(item);
    assert.match(svg,/data-source-drawing="1"/);
    assert.equal(cards.shapeSvgForProductionCard(item),svg);
    const d=svg.match(/<path d="([^"]+)"/)[1];
    const points=[...d.matchAll(/[ML] ([\d.]+),([\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
    assert.equal(points.length,entry.points.length);
    // Relative orientation and turn sign are independent of viewport scale.
    for(let i=0;i<points.length-1;i++) {
      const src=[entry.points[i+1][0]-entry.points[i][0],entry.points[i+1][1]-entry.points[i][1]];
      const out=[points[i+1][0]-points[i][0],points[i+1][1]-points[i][1]];
      assert.ok(Math.abs(src[0]*out[1]-src[1]*out[0])<.1,`${order}/${row}/${i}`);
      assert.ok(src[0]*out[0]+src[1]*out[1]>0,`${order}/${row}/${i}`);
    }
    if(order===97) {
      assert.ok(points[3][1]>points[2][1] && points[4][1]>points[5][1]);
      assert.ok(Math.abs(points[1][1]-points[6][1])<.01);
    }
  }
});

test('hoops retain closing tails, are billed as hoops, and L bars never gain hoop work',()=>{
  for (const [order,row] of [[87,47],[89,11],[96,27],[98,5],[100,5]]) {
    const e=reviewedDrawings.find(e=>e.orderId===order&&e.row===row);
    assert.equal(e.shapeName,'חישוק');
    const item={shape_name:e.shapeName,diameter:e.diameter,quantity:e.quantity,total_length_mm:e.totalLengthMm,segments:JSON.stringify(e.segments),total_weight:1};
    item.shape_snapshot_json=JSON.stringify(repairedSnapshot(item,e));
    assert.match(cards.itemShapeSvg(item),/data-source-drawing/);
    assert.equal(classifyOrderItem(item).kind,'hoop');
  }
  const l=reviewedDrawings.find(e=>e.orderId===96&&e.row===7);
  assert.equal(l.shapeId,'l_bar');
});
