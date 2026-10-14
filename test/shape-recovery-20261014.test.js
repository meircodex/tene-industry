const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Database=require('better-sqlite3');
const view=require('../public/hoop-view');
const cards=require('../services/productionCards');
const source=require('../services/sourceDrawingGeometry');
const {ensureCoreSchema}=require('../db/coreSchema');

test('all source hoops preserve ordered body dimensions and each closure end, without changing the input',()=>{
  const entries=source.reviewedDrawings.filter(e=>e.shapeId==='closed_stirrup');
  assert.equal(entries.length,59);
  for(const e of entries) {
    const item={shape_id:e.shapeId,segments:JSON.stringify(e.segments),diameter:e.diameter,quantity:e.quantity,total_length_mm:e.totalLengthMm};
    item.shape_snapshot_json=JSON.stringify(source.repairedSnapshot(item,e));
    const before=JSON.stringify(item), svg=cards.itemShapeSvg(item);
    const parts=view.parts(e.segments.map(s=>s.length_mm),e.segments.map(s=>s.angle_deg),true);
    assert.equal(parts.right,e.segments[1].length_mm);
    assert.equal(parts.top,e.segments[2].length_mm);
    assert.equal(parts.tailStart,e.segments[0].length_mm);
    assert.equal(parts.tailEnd,e.segments[5].length_mm);
    assert.match(svg,/data-canonical-hoop="1"/);
    assert.match(svg,/עודפי סגירה:/);
    assert.doesNotMatch(svg,/marker-end|marker-start/);
    assert.equal((svg.match(/<path /g)||[]).length,2,'no stray cell-border fragments');
    const pts=[...svg.matchAll(/[ML] ([\d.]+),([\d.]+)/g)].slice(0,4).map(m=>m.slice(1).map(Number));
    assert.ok(Math.abs((pts[1][0]-pts[0][0])/(pts[2][1]-pts[1][1])-parts.top/parts.right)<.001);
    assert.equal(cards.shapeSvgForProductionCard(item),svg);
    assert.equal(JSON.stringify(item),before);
  }
  assert.equal(view.parts([500,800],[90],true),null,'an L cannot become a hoop');
  assert.equal(view.parts([100,500,800,500,800,100],[90,159,201,90,90]),null,'open diagonal bars remain open');
});

test('closure lengths are independent and never selected by smallest-dimension sorting',()=>{
  for(const excess of [50,75,80,100]) {
    const p=view.parts([excess,250,600,250,600,100],[90,90,90,90,90],true);
    assert.equal(p.right,250); assert.equal(p.tailStart,excess); assert.equal(p.tailEnd,100);
  }
});

test('the actual inline print script never discards the canonical hoop drawing',()=>{
  const script=fs.readFileSync('services/productionCardPrintPage.js','utf8');
  const fn=script.match(/function shapeSvgForCard\(item, segments\) \{[\s\S]*?\n\}/)[0];
  const ctx={buildShapeSVG:()=>'<svg data-legacy="1"></svg>'};vm.createContext(ctx);vm.runInContext(fn,ctx);
  for(const entry of source.reviewedDrawings.filter(e=>e.shapeId==='closed_stirrup')) {
    const item={shape_id:entry.shapeId,shape_name:'חישוק',segments:JSON.stringify(entry.segments)};
    item.shape_snapshot_json=JSON.stringify(source.repairedSnapshot(item,entry));
    item.shape_svg=cards.itemShapeSvg(item);
    assert.equal(ctx.shapeSvgForCard(item,entry.segments),item.shape_svg);
  }
  assert.match(ctx.shapeSvgForCard({},[]),/data-legacy/);
});

test('length alias repair is narrow, backed up, idempotent and preserves manufacturing state',()=>{
  const db=new Database(':memory:');
  try {
    ensureCoreSchema(db); source.repairSourceDrawingOrders(db);
    db.prepare("INSERT INTO orders(id,order_num,status) VALUES(87,'HZ-2026-087','בייצור')").run();
    db.prepare('INSERT INTO pallets(id,order_id,pallet_num) VALUES(87,87,1)').run();
    const e=source.reviewedDrawings[0];
    const item={diameter:e.diameter,quantity:e.quantity,total_length_mm:e.totalLengthMm,segments:JSON.stringify(e.segments),weight_per_unit:1,total_weight:44};
    const snap=source.repairedSnapshot(item,e);snap.machineOutput.generic.lengthMm=0;
    db.prepare(`INSERT INTO items(pallet_id,shape_snapshot_json,diameter,quantity,total_length_mm,segments,total_weight,produced_qty,status)
      VALUES(87,?,?,?,?,?,?,3,'הושלם')`).run(JSON.stringify(snap),e.diameter,e.quantity,e.totalLengthMm,item.segments,44);
    const before=db.prepare('SELECT * FROM items').get();
    assert.equal(source.repairSourceLengthAliases(db),1);
    assert.equal(source.repairSourceLengthAliases(db),0);
    const after=db.prepare('SELECT * FROM items').get();
    assert.equal(JSON.parse(after.shape_snapshot_json).machineOutput.generic.lengthMm,e.totalLengthMm);
    assert.deepEqual({...after,shape_snapshot_json:null},{...before,shape_snapshot_json:null});
    const backup=db.prepare("SELECT before_json FROM source_geometry_repairs WHERE version='source-length-alias-20261014-v1'").get();
    assert.equal(backup.before_json,before.shape_snapshot_json);
  } finally {db.close();}
});

test('editor and draft preview retain exact segment ratios; narrow bench bridge is not stretched',()=>{
  const ctx={window:{IronBendHoopView:view},console,localStorage:{getItem:()=>null,setItem:()=>{}}};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/shape-editor.js','utf8'),ctx);
  const sides=[1100,780,150,780,1100];
  const {pts}=ctx.benchBarSVGPath(sides,300,260,38);
  const lengths=pts.slice(1).map((p,i)=>Math.hypot(p[0]-pts[i][0],p[1]-pts[i][1]));
  lengths.forEach((n,i)=>assert.ok(Math.abs(n/lengths[0]-sides[i]/sides[0])<.00001));
  assert.equal(pts[0][1],pts[1][1]);assert.equal(pts[4][1],pts[5][1]);
  assert.equal(pts[1][0],pts[2][0]);assert.equal(pts[3][0],pts[4][0]);
  const html=fs.readFileSync('public/index.html','utf8');
  vm.runInContext(html.slice(html.indexOf('function orderSketchGeometry('),html.indexOf('function orderSketchUnit(')),ctx);
  const raw=ctx.orderSketchGeometry([100,800,150],[90,270]).points;
  const edge=raw.slice(1).map((p,i)=>Math.hypot(p[0]-raw[i][0],p[1]-raw[i][1]));
  assert.deepEqual(Array.from(edge,Math.round),[100,800,150]);
});

test('approving a lift creates a real draft line with its length, package count and whole-line weighing',()=>{
  const html=fs.readFileSync('public/index.html','utf8');
  const contract={family:'lifts',data:{diameter:12,barLength:12000,weighedKg:194},calculated:{totalLengthMm:12000,weightKg:194}};
  const ctx={window:{},pallets:[{id:1,items:[]}],_shapeTarget:{palletId:1,itemId:9,isNew:true,pendingItem:{id:9}},
    approvedShapeContract:data=>data, itemShapeContract:item=>item.shapeSnapshot,
    renderPallets:()=>{},updateSummary:()=>{}};
  vm.createContext(ctx);
  vm.runInContext(html.match(/function shapeSelected\(data\) \{[\s\S]*?\n\}/)[0],ctx);
  vm.runInContext(html.match(/function calcItemWeight\(item\) \{[\s\S]*?\n\}/)[0],ctx);
  ctx.shapeSelected({...contract,orderItemQuantity:4});
  const item=ctx.pallets[0].items[0];
  assert.equal(item.family,'lifts');assert.equal(item.length,12000);assert.equal(item.qty,4);
  assert.equal(ctx.calcItemWeight(item),194);
  assert.equal(ctx._shapeTarget,null);
});
