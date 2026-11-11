'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {ensureCoreSchema}=require('../db/coreSchema');
const {buildFullShapeSnapshot}=require('../services/shapeSnapshot');
const {planInventory}=require('../services/inventoryPlanning');
const {barEstimate}=require('../services/inventoryPlanningLength');

function setup(t){const db=new Database(':memory:');ensureCoreSchema(db);db.exec("INSERT INTO orders(id,order_num) VALUES(1,'LENGTH')");t.after(()=>db.close());return db;}
function lot(db,length,weight=1000){db.prepare("INSERT INTO raw_material(diameter,material_type,nominal_length_mm,weight_received) VALUES(12,'straight',?,?)").run(length,weight);}
function demand(db,length,weight,{family='lifts',version=1}={}){
 const shape=buildFullShapeSnapshot({family,calculated:{totalLengthMm:length}});
 const id=Number(db.prepare("INSERT INTO items(order_id,diameter,quantity,total_weight,total_length_mm,shape_snapshot_json) VALUES(1,12,1,?,?,?)").run(weight,length,JSON.stringify(shape)).lastInsertRowid);
 if(version===1)db.prepare("INSERT INTO inventory_reservations(order_id,item_id,diameter,material_type,reserved_kg,consumption_mode) VALUES(1,?,12,'straight',?,'on_completion')").run(id,weight);
 else {db.exec('UPDATE orders SET inventory_lifecycle_version=2 WHERE id=1');db.prepare("INSERT INTO material_requirements_v2(requirement_uid,order_id,item_id,diameter,material_type,required_kg,need_by_source,source) VALUES(?,1,?,12,'straight',?,'unknown','order_item')").run('req-'+id,id,weight);}
 return id;
}
const straight=(db)=>planInventory(db).groups.filter(g=>g.material_type==='straight');

test('6m shortage cannot use 12m stock or incoming; preview never writes stock or reservations',t=>{
 const db=setup(t);lot(db,6000,100);lot(db,12000,5000);demand(db,6000,1000);
 db.prepare("INSERT INTO purchase_orders(diameter,material_type,quantity_ton,status,specification_json) VALUES(12,'straight',3,'approved',?)").run(JSON.stringify({nominal_length_mm:12000}));
 const before=db.serialize(),rows=straight(db),six=rows.find(r=>r.nominal_length_mm===6000),twelve=rows.find(r=>r.nominal_length_mm===12000);
 assert.equal(six.physical_stock_kg,100);assert.equal(six.backlog_kg,1000);assert.equal(six.incoming_kg,0);assert.equal(six.recommended_purchase_kg,900);assert.equal(six.available_stock_kg,-900);
 assert.equal(twelve.physical_stock_kg,5000);assert.equal(twelve.incoming_kg,3000);assert.equal(twelve.recommended_purchase_kg,0);
 assert.equal(planInventory(db).purchase_policy.types.find(r=>r.material_type==='straight').diameter_shortage_kg,900);
 assert.deepEqual(db.serialize(),before);
});
test('known incoming covers only its matching length and observes the date cutoff',t=>{
 const db=setup(t);demand(db,6000,1000);demand(db,12000,2000);
 for(const [length,quantity,date] of [[6000,0.4,'2026-11-12'],[12000,3,'2026-12-01'],[null,8,'2026-11-12']])db.prepare("INSERT INTO purchase_orders(diameter,material_type,quantity_ton,status,expected_date,specification_json) VALUES(12,'straight',?,'approved',?,?)").run(quantity,date,JSON.stringify({nominal_length_mm:length}));
 const rows=planInventory(db,{through_date:'2026-11-30'}).groups;
 assert.equal(rows.find(r=>r.nominal_length_mm===6000).recommended_purchase_kg,600);
 assert.equal(rows.find(r=>r.nominal_length_mm===12000).recommended_purchase_kg,2000);
 assert.equal(rows.find(r=>r.nominal_length_mm===null).incoming_kg,8000);
});
test('unknown lengths and developed bent-bar lengths stay unassigned and never hide demand',t=>{
 const db=setup(t);lot(db,6000,3000);lot(db,null,4000);demand(db,6000,1000,{family:'bars'});
 const unknown=straight(db).find(r=>r.nominal_length_mm===null);
 assert.equal(unknown.requires_length_review,true);assert.equal(unknown.physical_stock_kg,4000);assert.equal(unknown.backlog_kg,1000);assert.equal(unknown.recommended_purchase_kg,1000);assert.equal(unknown.estimated_bar_count,null);
});
test('V2 demand uses its lift item length without counting V1 reservations again',t=>{
 const db=setup(t);lot(db,12000,5000);const id=demand(db,6000,1000,{version:2});
 db.prepare("INSERT INTO inventory_reservations(order_id,item_id,diameter,material_type,reserved_kg) VALUES(1,?,12,'straight',9999)").run(id);
 const rows=straight(db);assert.equal(rows.find(r=>r.nominal_length_mm===6000).backlog_kg,1000);assert.equal(rows.find(r=>r.nominal_length_mm===6000).recommended_purchase_kg,1000);
});
test('legacy consumption prepays only the same length; standard lengths with zero stock remain visible',t=>{
 const db=setup(t);lot(db,12000,5000);const id=demand(db,6000,1000);
 db.exec("UPDATE inventory_reservations SET consumption_mode='legacy'");db.prepare('INSERT INTO raw_material_usage(raw_material_id,order_id,item_id,weight_used) VALUES(1,1,?,1000)').run(id);
 const rows=straight(db);assert.equal(rows.find(r=>r.nominal_length_mm===6000).legacy_preallocated_kg,0);assert.equal(rows.find(r=>r.nominal_length_mm===6000).recommended_purchase_kg,1000);
 assert.equal(rows.find(r=>r.nominal_length_mm===6000).physical_stock_kg,0);
});
test('estimated whole bars use canonical diameter weight, length, and physical mass; never round up',()=>{
 assert.deepEqual(barEstimate(12,6000,2050),{unit_weight_kg:5.328,estimated_bar_count:384});
 assert.equal(barEstimate(12,12000,2050).estimated_bar_count,192);
 assert.equal(barEstimate(12,6000,0).estimated_bar_count,0);
 assert.equal(barEstimate(12,null,2050).estimated_bar_count,null);
 assert.equal(barEstimate(12,6000,-1).estimated_bar_count,null);
});
