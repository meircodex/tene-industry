'use strict';

const crypto = require('node:crypto');
const reviewedDrawings = [...require('../db/repairs/workbook87-20261012.json'), ...require('../db/repairs/source-drawings-20261012.json')];
const REPAIR_VERSION = 'source-paths-20261012-v1';
const reviewedLabels = require('../db/repairs/source-labels-20261012.json');
const LABEL_VERSION = 'source-labels-20261012-v1';
// Explicit human correction supplied on 12 Oct 2026. The second item was
// intentionally left without a diameter until the customer clarified it.
reviewedDrawings.push({ orderId:88,row:1,sourceFile:'תוספת בכתב ללא שרטוט — ליפט 12 מטר, קוטר 12',sourcePage:1,sourceSha256:'user-confirmed',
  diameter:12,quantity:2,totalLengthMm:12000,shapeName:'מוט ישר',shapeId:'straight_bar',
  segments:[{length_mm:12000,angle_deg:0}],points:[[0,20],[160,20]],labels:[{text:'1200',x:80,y:10}],requiresAngleConfirmation:false });
reviewedDrawings.push({ orderId:88,row:2,sourceFile:'תוספת בכתב ללא שרטוט — אושר קוטר 8 ועודף 10 בכל קצה',sourcePage:1,sourceSha256:'user-confirmed-20261012',
  diameter:8,previousDiameter:0,quantity:48,totalLengthMm:2600,previousLengthMm:0,shapeName:'חישוק',shapeId:'closed_stirrup',
  segments:[100,600,600,600,600,100].map((length_mm,i)=>({length_mm,angle_deg:[315,270,270,270,315,0][i]})),
  points:[[88,27],[100,15],[100,100],[15,100],[15,15],[100,15],[88,27]],
  labels:[{text:'60',x:57.5,y:5},{text:'60',x:112,y:57.5},{text:'60',x:57.5,y:112},{text:'60',x:3,y:57.5},{text:'10',x:80,y:30}],requiresAngleConfirmation:false });

function object(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
}

function geometryKey(segments) {
  const parsed = typeof segments === 'string' ? object(segments) : segments;
  if (!Array.isArray(parsed)) return '';
  return crypto.createHash('sha256').update(JSON.stringify(parsed.map(s => [
    Number(s.length_mm ?? s.lengthMm ?? s.length ?? s), Number(s.angle_deg ?? s.bendAfterDeg ?? s.angle ?? 0),
  ]))).digest('hex');
}

function sourceDrawingForItem(item = {}) {
  const snapshot = object(item.shape_snapshot_json ?? item.shapeSnapshot);
  const drawing = snapshot.sourceDrawing;
  if (!drawing || drawing.version !== REPAIR_VERSION || !Array.isArray(drawing.points)) return null;
  const segments = item.segments || snapshot.segments;
  // A later edit must invalidate the previous drawing. Never make an old
  // source preview override a newly saved item/machine definition.
  if (drawing.geometryKey !== geometryKey(segments)) return null;
  if (!drawing.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
  if (drawing.lines && !drawing.lines.every(line => line.length === 2 && line.every(p => p.length === 2 && p.every(Number.isFinite)))) return null;
  return drawing;
}

function sourceDrawingSvg(item = {}, options = {}) {
  const drawing = sourceDrawingForItem(item);
  if (!drawing) return '';
  const lines = drawing.lines || [];
  let points = drawing.points.length ? drawing.points : lines.flat();
  if (points.length < 2) return '';
  let labels = (drawing.labels || []).filter(l => Number.isFinite(l.x) && Number.isFinite(l.y) && /^\d+(?:\.\d+)?$/.test(l.text));
  const segmentValue = item.segments || object(item.shape_snapshot_json ?? item.shapeSnapshot).segments;
  const rawSegments = typeof segmentValue === 'string' ? object(segmentValue) : segmentValue;
  const sequence = Array.isArray(rawSegments) ? rawSegments : [];
  // The source supplies direction/handedness, the saved dimensions supply
  // length. PDF sketches are not to scale. Never change saved bend angles.
  if (!lines.length && points.length===sequence.length+1 && sequence.every(s=>Number(s.length_mm)>0)) {
    const original=points;
    const rebuilt=[[0,0]];
    const originalEdges=original.slice(0,-1).map((a,i)=>({a,b:original[i+1],index:i}));
    originalEdges.forEach((edge,i)=>{
      const dx=edge.b[0]-edge.a[0],dy=edge.b[1]-edge.a[1],norm=Math.hypot(dx,dy)||1;
      const start=rebuilt[i], length=Number(sequence[i].length_mm);
      rebuilt.push([start[0]+dx/norm*length,start[1]+dy/norm*length]);
    });
    const outset=Math.max(...sequence.map(s=>Number(s.length_mm)))*.06;
    labels=labels.map(label=>{
      const matches=originalEdges.filter(edge=>Math.abs(Number(sequence[edge.index].length_mm)/10-Number(label.text))<.11);
      const candidates=matches.length?matches:originalEdges;
      const edge=candidates.reduce((best,e)=>{
        const p=nearestOnEdge(label,e),q=nearestOnEdge(label,best);
        return Math.hypot(label.x-p.x,label.y-p.y)<Math.hypot(label.x-q.x,label.y-q.y)?e:best;
      },candidates[0]);
      const a=rebuilt[edge.index],b=rebuilt[edge.index+1];
      const dx=edge.b[0]-edge.a[0],dy=edge.b[1]-edge.a[1],norm=Math.hypot(dx,dy)||1;
      let nx=-dy/norm,ny=dx/norm;
      if ((label.x-(edge.a[0]+edge.b[0])/2)*nx+(label.y-(edge.a[1]+edge.b[1])/2)*ny<0) {nx=-nx;ny=-ny;}
      return {...label,x:(a[0]+b[0])/2+nx*outset,y:(a[1]+b[1])/2+ny*outset};
    });
    points=rebuilt;
  }
  const xs = points.map(p => p[0]).concat(labels.map(l => l.x));
  const ys = points.map(p => p[1]).concat(labels.map(l => l.y));
  const minX = Math.min(...xs), minY = Math.min(...ys), rangeX = Math.max(...xs)-minX || 1, rangeY = Math.max(...ys)-minY || 1;
  const width = 280, height = 140, marginX = 20, marginY = 18;
  const scale = Math.min((width-marginX*2)/rangeX, (height-marginY*2)/rangeY);
  const offsetX = (width-rangeX*scale)/2, offsetY = (height-rangeY*scale)/2;
  const map = ([x,y]) => [(offsetX+(x-minX)*scale).toFixed(3), (offsetY+(y-minY)*scale).toFixed(3)];
  const path = lines.length
    ? lines.map(line => 'M '+line.map(p => map(p).join(',')).join(' L ')).join(' ')
    : 'M '+points.map(p => map(p).join(',')).join(' L ');
  const mappedPoints = points.map(p => map(p).map(Number));
  const edges = lines.length
    ? lines.map((line,index)=>({a:map(line[0]).map(Number),b:map(line[1]).map(Number),index}))
    : mappedPoints.slice(0,-1).map((a,index)=>({a,b:mappedPoints[index+1],index,
      lengthMm:sequence.length===mappedPoints.length-1 ? Number(sequence[index]?.length_mm) : undefined}));
  const dimensionFontSize = Math.max(8, Math.min(24, Number(options.dimensionFontSize) || 11));
  const positionedLabels = layoutSourceDimensions(labels.map(l=>({text:l.text,x:Number(map([l.x,l.y])[0]),y:Number(map([l.x,l.y])[1])})),edges,width,height,dimensionFontSize);
  const dimensions = positionedLabels.map(l => {
    return `<text data-dimension-label="1" data-dimension-segment="${l.segmentIndex}" x="${l.x.toFixed(3)}" y="${l.y.toFixed(3)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Heebo" font-weight="800" font-size="${dimensionFontSize}" fill="#173b6b" stroke="white" stroke-width="2" paint-order="stroke fill">${l.text}</text>`;
  }).join('');
  return `<svg data-source-drawing="1" data-source-order="${drawing.orderId}" data-source-row="${drawing.row}" data-shape-kind="source-drawing" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" role="img" aria-label="צורה לפי שרטוט המקור" style="width:100%;height:100%;max-height:140px;overflow:visible"><path d="${path}" fill="none" stroke="#173b6b" stroke-width="3.5" stroke-linecap="square" stroke-linejoin="miter"/>${dimensions}</svg>`;
}

function nearestOnEdge(point, edge) {
  const dx=edge.b[0]-edge.a[0],dy=edge.b[1]-edge.a[1];
  const t=Math.max(0,Math.min(1,((point.x-edge.a[0])*dx+(point.y-edge.a[1])*dy)/(dx*dx+dy*dy||1)));
  return {x:edge.a[0]+dx*t,y:edge.a[1]+dy*t};
}

function dimensionBox(label) {
  // Includes the white text halo and clearance around the rebar stroke.
  const fontScale=(Number(label.fontSize)||11)/11;
  const halfWidth=Math.max(10,label.text.length*3.6*fontScale+4),halfHeight=10*fontScale;
  return {left:label.x-halfWidth,right:label.x+halfWidth,top:label.y-halfHeight,bottom:label.y+halfHeight};
}

function edgeIntersectsBox(edge,box) {
  let start=0,end=1;
  const dx=edge.b[0]-edge.a[0],dy=edge.b[1]-edge.a[1];
  for (const [p,q] of [[-dx,edge.a[0]-box.left],[dx,box.right-edge.a[0]],[-dy,edge.a[1]-box.top],[dy,box.bottom-edge.a[1]]]) {
    if (Math.abs(p)<1e-9) {if(q<0)return false;continue;}
    const r=q/p;
    if(p<0)start=Math.max(start,r);else end=Math.min(end,r);
    if(start>end)return false;
  }
  return true;
}

function layoutSourceDimensions(labels,edges,width=280,height=140,fontSize=11) {
  const used=new Set(),occupied=[];
  const assigned=labels.map(label=>{
    const matching=edges.filter(edge=>Number.isFinite(edge.lengthMm)&&Math.abs(edge.lengthMm/10-Number(label.text))<.01);
    const available=matching.filter(edge=>!used.has(edge.index));
    const candidates=available.length?available:matching.length?matching:edges;
    const edge=[...candidates].sort((a,b)=>{
      const pa=nearestOnEdge(label,a),pb=nearestOnEdge(label,b);
      return Math.hypot(label.x-pa.x,label.y-pa.y)-Math.hypot(label.x-pb.x,label.y-pb.y);
    })[0];
    if(edge)used.add(edge.index);
    return {...label,fontSize,edge,segmentIndex:edge?.index ?? -1};
  });
  const clear=label=>{
    const box=dimensionBox(label);
    return box.left>=2&&box.right<=width-2&&box.top>=2&&box.bottom<=height-2
      && !edges.some(edge=>edgeIntersectsBox(edge,box))
      && !occupied.some(other=>box.left<other.right&&box.right>other.left&&box.top<other.bottom&&box.bottom>other.top);
  };
  // Reserve already readable labels first, so fixing a closing-tail label does
  // not displace a good body dimension. Numeric matching locates e.g. the 17cm
  // return in K/4 even when the source printed its callout beside the far end.
  for(const label of assigned) {
    if(!label.edge)continue;
    const nearest=nearestOnEdge(label,label.edge);
    if(Math.hypot(label.x-nearest.x,label.y-nearest.y)<=20&&clear(label)) {
      label.positioned=true;occupied.push(dimensionBox(label));
    }
  }
  for(const label of assigned) {
    if(label.positioned||!label.edge)continue;
    const edge=label.edge,dx=edge.b[0]-edge.a[0],dy=edge.b[1]-edge.a[1],length=Math.hypot(dx,dy)||1;
    const tx=dx/length,ty=dy/length,nx=-ty,ny=tx;
    const mx=(edge.a[0]+edge.b[0])/2,my=(edge.a[1]+edge.b[1])/2;
    const sign=(label.x-mx)*nx+(label.y-my)*ny>=0?1:-1;
    const candidates=[];
    for(const distance of [15,19,23,27,31,35,43,51])for(const side of [sign,-sign])for(const shift of [0,8,-8,16,-16,24,-24]) {
      const candidate={...label,x:mx+nx*distance*side+tx*shift,y:my+ny*distance*side+ty*shift};
      // Keep the dimension next to its own side; no arrows or leader lines.
      if(clear(candidate))candidates.push({candidate,score:distance*distance+shift*shift+(side===sign?0:180)});
    }
    candidates.sort((a,b)=>a.score-b.score);
    if(candidates.length)Object.assign(label,candidates[0].candidate);
    else {
      // Crowded drawings still get a free text box rather than hiding a bend.
      let best=null;
      for(let y=12;y<=height-12;y+=4)for(let x=14;x<=width-14;x+=4){
        const candidate={...label,x,y};if(!clear(candidate))continue;
        const score=(x-mx)**2+(y-my)**2;if(!best||score<best.score)best={candidate,score};
      }
      if(best)Object.assign(label,best.candidate);
    }
    occupied.push(dimensionBox(label));
  }
  return assigned.map(({edge,positioned,...label})=>label);
}

function repairedSnapshot(item, entry) {
  const old = object(item.shape_snapshot_json);
  const segments = entry.segments;
  const sourceDrawing = {
    version: REPAIR_VERSION, orderId: entry.orderId, row: entry.row,
    sourceFile: entry.sourceFile, sourcePage: entry.sourcePage, sourceSha256: entry.sourceSha256,
    geometryKey: geometryKey(segments), points: entry.points, lines: entry.lines || [], labels: entry.labels,
    angleBasis: entry.requiresAngleConfirmation ? 'schematic_source_not_dimensioned' : 'orthogonal_source_path',
    requiresAngleConfirmation: entry.requiresAngleConfirmation,
    // Closing-tail angles are drawn schematically too. Retain this provenance
    // rather than claiming measured PDF angles are prescribed machine settings.
    schematicAngles: entry.shapeId === 'closed_stirrup' || entry.requiresAngleConfirmation,
  };
  const sides = segments.map(s => s.length_mm), angles = segments.slice(0,-1).map(s => s.angle_deg);
  const data = { ...object(old.data), sides, angles, segments, diameter: item.diameter, shapeId: entry.shapeId, shapeType: entry.shapeId };
  return {
    ...old, family: 'bars', shapeId: entry.shapeId, shapeType: entry.shapeId,
    displayName: entry.shapeName, shapeName: entry.shapeName, sides, angles, segments, data, sourceDrawing,
    calculated: { ...object(old.calculated), totalLengthMm: entry.totalLengthMm, unitLengthMm: entry.totalLengthMm, quantity: item.quantity,
      unitWeightKg: item.weight_per_unit, weightKg: item.weight_per_unit, totalWeightKg: item.total_weight, bendCount: Math.max(0, segments.length-1) },
    machineOutput: { ...object(old.machineOutput), generic: { ...object(old.machineOutput?.generic), family:'bars', shapeType:entry.shapeId,
      diameter:item.diameter, segments, totalLengthMm:entry.totalLengthMm, lengthMm:entry.totalLengthMm, bendCount:Math.max(0,segments.length-1),
      angleBasis:sourceDrawing.angleBasis, requiresAngleConfirmation:sourceDrawing.schematicAngles } },
  };
}

function repairSourceDrawingOrders(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_geometry_repairs (
    version TEXT NOT NULL, order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
    source_file TEXT NOT NULL, source_page INTEGER NOT NULL, source_row INTEGER NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(version,item_id)
  )`);
  const orderIds = [...new Set(reviewedDrawings.map(e => e.orderId))];
  const repaired = [], skipped = [];
  for (const orderId of orderIds) {
    const entries = reviewedDrawings.filter(e => e.orderId === orderId).sort((a,b)=>a.row-b.row);
    const order = db.prepare('SELECT o.*,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?').get(orderId);
    if (!order || order.order_num !== `HZ-2026-${String(orderId).padStart(3,'0')}` || !/עשוש/.test(order.customer_name || '')) continue;
    const existing = db.prepare('SELECT COUNT(*) AS n FROM source_geometry_repairs WHERE version=? AND order_id=?').get(REPAIR_VERSION,orderId).n;
    if (existing === entries.length) continue;
    const rows = db.prepare(`SELECT i.* FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=?
      ORDER BY p.pallet_num,COALESCE(i.sort_order,i.id),i.id`).all(orderId);
    const reason = existing ? 'partial_previous_repair'
      : order.locked || !['ממתינה לאישור','ממתינה לאישור לקוח'].includes(order.status) ? 'order_has_started'
      : rows.length !== entries.length ? 'item_count_mismatch'
      : rows.some((r,i)=>Number(r.quantity)!==entries[i].quantity || Number(r.diameter)!==(entries[i].previousDiameter ?? entries[i].diameter)
          || Number(r.total_length_mm)!==(entries[i].previousLengthMm ?? entries[i].totalLengthMm) || Number(r.produced_qty)>0 || Number(r.loaded_qty)>0) ? 'source_identity_mismatch' : null;
    if (reason) { skipped.push({orderId,reason}); continue; }
    db.transaction(()=>{
      rows.forEach((item,index)=>{
        const entry=entries[index];
        const correctedItem = entry.previousDiameter !== undefined || entry.previousLengthMm !== undefined
          ? { ...item,diameter:entry.diameter,total_length_mm:entry.totalLengthMm,
            weight_per_unit:require('../constants').rebarKgPerMeter(entry.diameter)*entry.totalLengthMm/1000,
            total_weight:require('../constants').rebarKgPerMeter(entry.diameter)*entry.totalLengthMm/1000*entry.quantity } : item;
        const snapshot=repairedSnapshot(correctedItem,entry);
        const after={shape_id:entry.shapeId,shape_name:entry.shapeName,segments:JSON.stringify(entry.segments),shape_snapshot_json:JSON.stringify(snapshot),
          diameter:correctedItem.diameter,total_length_mm:correctedItem.total_length_mm,weight_per_unit:correctedItem.weight_per_unit,total_weight:correctedItem.total_weight};
        db.prepare(`INSERT INTO source_geometry_repairs(version,order_id,item_id,source_file,source_page,source_row,before_json,after_json)
          VALUES(?,?,?,?,?,?,?,?)`).run(REPAIR_VERSION,orderId,item.id,entry.sourceFile,entry.sourcePage,entry.row,JSON.stringify(item),JSON.stringify(after));
        db.prepare('UPDATE items SET shape_id=?,shape_name=?,segments=?,shape_snapshot_json=? WHERE id=?')
          .run(after.shape_id,after.shape_name,after.segments,after.shape_snapshot_json,item.id);
        if (entry.previousDiameter !== undefined || entry.previousLengthMm !== undefined) {
          db.prepare('UPDATE items SET diameter=?,total_length_mm=?,weight_per_unit=?,total_weight=? WHERE id=?')
            .run(correctedItem.diameter,correctedItem.total_length_mm,correctedItem.weight_per_unit,correctedItem.total_weight,item.id);
          db.prepare('UPDATE pallets SET total_weight=(SELECT SUM(total_weight) FROM items WHERE pallet_id=?) WHERE id=?').run(item.pallet_id,item.pallet_id);
          const total = db.prepare('SELECT SUM(i.total_weight) AS total FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=?').get(orderId).total;
          db.prepare('UPDATE orders SET total_weight=?,billing_weight=? WHERE id=?').run(total,total*(1+Number(order.waste_pct_charged || 0)/100),orderId);
        }
      });
    })();
    repaired.push({orderId,items:rows.length});
  }
  repairSourceLabels(db);
  if (repaired.length || skipped.length) console.log('[Source drawing audit]',JSON.stringify({repaired,skipped}));
  return {repaired,skipped};
}

function repairSourceLabels(db) {
  let count = 0;
  db.transaction(() => {
    for (const entry of reviewedLabels) {
      if (!entry.element) continue;
      const audit = db.prepare('SELECT * FROM source_geometry_repairs WHERE version=? AND order_id=? AND source_row=?')
        .get(REPAIR_VERSION,entry.orderId,entry.row);
      if (!audit || db.prepare('SELECT 1 FROM source_geometry_repairs WHERE version=? AND item_id=?').get(LABEL_VERSION,audit.item_id)) continue;
      const item = db.prepare('SELECT * FROM items WHERE id=?').get(audit.item_id);
      const original = object(audit.before_json);
      // Do not replace a name or geometry that a user has edited since the audit.
      if (!item || !sourceDrawingForItem(item) || item.struct_element !== original.struct_element || Number(item.produced_qty)>0 || Number(item.loaded_qty)>0) continue;
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(entry.orderId);
      if (!order || order.locked || !['ממתינה לאישור','ממתינה לאישור לקוח'].includes(order.status)) continue;
      const after = {...item,struct_element:entry.element.replace(/\s+/g,' ').trim()};
      db.prepare('INSERT INTO source_geometry_repairs(version,order_id,item_id,source_file,source_page,source_row,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(LABEL_VERSION,entry.orderId,item.id,audit.source_file,audit.source_page,entry.row,JSON.stringify(item),JSON.stringify(after));
      db.prepare('UPDATE items SET struct_element=? WHERE id=?').run(after.struct_element,item.id);
      count++;
    }
  })();
  if (count) console.log('[Source label audit]',JSON.stringify({repaired:count}));
}

// Only repair an obsolete length alias on an already source-verified snapshot.
// No changes to steel, geometry, quantities, statuses, inventory or prices.
function repairSourceLengthAliases(db) {
  const version='source-length-alias-20261014-v1';
  const rows=db.prepare('SELECT i.*,p.order_id AS source_order_id FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id BETWEEN 87 AND 100').all();
  let count=0;
  db.transaction(()=>{
    for (const row of rows) {
      const drawing=sourceDrawingForItem(row), snapshot=object(row.shape_snapshot_json), generic=snapshot.machineOutput?.generic;
      const length=Number(row.total_length_mm);
      if (!drawing || !generic || !(length>0) || Number(snapshot.calculated?.totalLengthMm)!==length
        || Number(generic.totalLengthMm)!==length || generic.lengthMm==null || Number(generic.lengthMm)===length) continue;
      if(db.prepare('SELECT 1 FROM source_geometry_repairs WHERE version=? AND item_id=?').get(version,row.id)) continue;
      const before=row.shape_snapshot_json;
      generic.lengthMm=length;
      const after=JSON.stringify(snapshot);
      db.prepare('INSERT INTO source_geometry_repairs(version,order_id,item_id,source_file,source_page,source_row,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(version,row.source_order_id,row.id,drawing.sourceFile,drawing.sourcePage,drawing.row,before,after);
      db.prepare('UPDATE items SET shape_snapshot_json=? WHERE id=? AND shape_snapshot_json=?').run(after,row.id,before);
      count++;
    }
  })();
  return count;
}
module.exports = { REPAIR_VERSION, reviewedDrawings, geometryKey, sourceDrawingForItem, sourceDrawingSvg, repairedSnapshot, repairSourceDrawingOrders,repairSourceLengthAliases,layoutSourceDimensions,dimensionBox,edgeIntersectsBox };
