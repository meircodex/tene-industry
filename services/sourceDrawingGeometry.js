'use strict';

const crypto = require('node:crypto');
const reviewedDrawings = [...require('../db/repairs/workbook87-20261012.json'), ...require('../db/repairs/source-drawings-20261012.json')];
const REPAIR_VERSION = 'source-paths-20261012-v1';
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

function sourceDrawingSvg(item = {}) {
  const drawing = sourceDrawingForItem(item);
  if (!drawing) return '';
  const lines = drawing.lines || [];
  const points = drawing.points.length ? drawing.points : lines.flat();
  if (points.length < 2) return '';
  const labels = (drawing.labels || []).filter(l => Number.isFinite(l.x) && Number.isFinite(l.y) && /^\d+(?:\.\d+)?$/.test(l.text));
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
  const dimensions = labels.map(l => {
    const [x,y] = map([l.x,l.y]);
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Heebo" font-weight="800" font-size="11" fill="#173b6b" stroke="white" stroke-width="2" paint-order="stroke fill">${l.text}</text>`;
  }).join('');
  return `<svg data-source-drawing="1" data-source-order="${drawing.orderId}" data-source-row="${drawing.row}" data-shape-kind="source-drawing" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" role="img" aria-label="צורה לפי שרטוט המקור" style="width:100%;height:100%;max-height:140px;overflow:visible"><path d="${path}" fill="none" stroke="#173b6b" stroke-width="3.5" stroke-linecap="square" stroke-linejoin="miter"/>${dimensions}</svg>`;
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
      diameter:item.diameter, segments, totalLengthMm:entry.totalLengthMm, bendCount:Math.max(0,segments.length-1),
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
        const correctedItem = entry.previousDiameter !== undefined
          ? { ...item,diameter:entry.diameter,total_length_mm:entry.totalLengthMm,
            weight_per_unit:require('../constants').rebarKgPerMeter(entry.diameter)*entry.totalLengthMm/1000,
            total_weight:require('../constants').rebarKgPerMeter(entry.diameter)*entry.totalLengthMm/1000*entry.quantity } : item;
        const snapshot=repairedSnapshot(correctedItem,entry);
        const after={shape_id:entry.shapeId,shape_name:entry.shapeName,segments:JSON.stringify(entry.segments),shape_snapshot_json:JSON.stringify(snapshot)};
        db.prepare(`INSERT INTO source_geometry_repairs(version,order_id,item_id,source_file,source_page,source_row,before_json,after_json)
          VALUES(?,?,?,?,?,?,?,?)`).run(REPAIR_VERSION,orderId,item.id,entry.sourceFile,entry.sourcePage,entry.row,JSON.stringify(item),JSON.stringify(after));
        db.prepare('UPDATE items SET shape_id=?,shape_name=?,segments=?,shape_snapshot_json=? WHERE id=?')
          .run(after.shape_id,after.shape_name,after.segments,after.shape_snapshot_json,item.id);
        if (entry.previousDiameter !== undefined) {
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
  if (repaired.length || skipped.length) console.log('[Source drawing audit]',JSON.stringify({repaired,skipped}));
  return {repaired,skipped};
}

module.exports = { REPAIR_VERSION, reviewedDrawings, geometryKey, sourceDrawingForItem, sourceDrawingSvg, repairedSnapshot, repairSourceDrawingOrders };
