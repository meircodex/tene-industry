'use strict';
// Production owns the single read projection used by both the original queue and machine stations.
const {productionQueueCondition}=require('./productionEligibility');
function readProductionQueueItems(db,options={}){
  const {machine=null,visual=false}=options;
    let q = `
      SELECT i.id, i.pallet_id, i.shape_id, i.shape_name, i.diameter, i.machine_id,
             i.quantity, i.produced_qty, i.total_weight AS weight, i.status, i.machine,
             i.actual_weight_kg, i.weight_deviation_pct,
             i.segments, i.shape_snapshot_json, i.spiral_diameter_mm, i.spiral_turns,
             i.total_length_mm, i.note, i.qc_status,
             p.order_id, p.pallet_num,
             o.order_num, o.priority, o.delivery_date, o.customer_id, o.status AS order_status, o.payment_status AS order_payment_status, o.deleted_at AS order_deleted_at,
             c.name as customer_name,
             COALESCE(o.priority='דחוף',0)*100 +
             COALESCE(JULIANDAY('now') - JULIANDAY(o.delivery_date), 0)*10 as priority_score
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      LEFT JOIN customers c ON o.customer_id=c.id
      WHERE ${productionQueueCondition({ visual })}
    `;
    const params = [];
    q += ' ORDER BY i.machine, priority_score DESC, o.delivery_date ASC, i.diameter ASC';
    let items = db.prepare(q).all(...params);
    const activeMachines=db.prepare('SELECT id,name,label FROM machines WHERE retired_at IS NULL').all();
    for(const item of items){
      const assigned=require('../services/machineRegistry').queueMachine(item,activeMachines);
      if(item.machine&&!assigned)item.previous_machine=item.machine;
      item.machine=assigned;
    }
    if(machine){const canonical=require('../services/machineRegistry').queueMachine({machine},activeMachines)||machine;items=items.filter(i=>i.machine===canonical);}
  return items;
}
module.exports={readProductionQueueItems};
