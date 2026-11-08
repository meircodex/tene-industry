'use strict';

const { kg, materialOnHand } = require('./materialBalance');

function consumeCompletionReservation(db, reservation, actualWeightKg) {
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(reservation.id);
    if (current.status !== 'active') return { consumed: 0 };
    const replay = db.prepare('SELECT * FROM inventory_completion_consumptions WHERE reservation_id=?').get(current.id);
    if (replay) return { consumed: 0 };
    const amount = kg(actualWeightKg ?? current.pending_actual_kg ?? current.reserved_kg);
    const order = db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(current.order_id);
    if (Number(order?.inventory_lifecycle_version) === 2) throw new Error('v2_requires_approved_consumption_report');
    const lots = db.prepare(`SELECT * FROM raw_material WHERE active=1 AND COALESCE(verification_status,'approved')='approved'
      AND diameter=? AND COALESCE(material_type,'coil')=? ORDER BY COALESCE(received_date,created_at),id`).all(current.diameter,current.material_type);
    const allocations=[]; let remaining=amount;
    for (const lot of lots) {
      if (current.preferred_raw_material_id && Number(current.preferred_raw_material_id)!==lot.id) continue;
      // Respect the explicit plans of the separate V2 workflow.
      const { activeAllocatedForLot } = require('./materialAllocationPlanningV2');
      const free = Math.max(0,kg(materialOnHand(lot)-activeAllocatedForLot(db,lot.id)));
      const take=kg(Math.min(free,remaining));
      if (take>0) allocations.push({raw_material_id:lot.id,weight_used:take});
      remaining=kg(remaining-take);
      if (remaining<=0) break;
    }
    if (remaining>0) {
      db.prepare('UPDATE inventory_reservations SET pending_actual_kg=? WHERE id=?').run(amount,current.id);
      const message=`צריכת חומר ממתינה: הזמנה ${current.order_id}, פריט ${current.item_id}, חסרים ${remaining} ק״ג בקוטר ${current.diameter} (${current.material_type})`;
      if (!db.prepare("SELECT id FROM alerts WHERE type='inventory_consumption_pending' AND order_id=? AND message=? AND resolved=0").get(current.order_id,message)) {
        db.prepare('INSERT INTO alerts(type,level,message,order_id) VALUES(?,?,?,?)').run('inventory_consumption_pending','warning',message,current.order_id);
      }
      return {consumed:0,pending:{reservation_id:current.id,item_id:current.item_id,missing_kg:remaining}};
    }
    db.prepare("UPDATE alerts SET resolved=1 WHERE type='inventory_consumption_pending' AND order_id=? AND message LIKE ?").run(current.order_id,`צריכת חומר ממתינה: הזמנה ${current.order_id}, פריט ${current.item_id},%`);
    for (const line of allocations) {
      db.prepare('UPDATE raw_material SET weight_used=ROUND(weight_used+?,3) WHERE id=?').run(line.weight_used,line.raw_material_id);
      db.prepare("INSERT INTO raw_material_usage(raw_material_id,order_id,item_id,weight_used,allocation_policy) VALUES(?,?,?,?,'production_completion')")
        .run(line.raw_material_id,current.order_id,current.item_id,line.weight_used);
    }
    db.prepare('INSERT INTO inventory_completion_consumptions(reservation_id,consumed_kg,allocations_json) VALUES(?,?,?)')
      .run(current.id,amount,JSON.stringify(allocations));
    db.prepare("UPDATE inventory_reservations SET status='consumed',reserved_kg=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(amount,current.id);
    return {consumed:1,consumed_kg:amount,allocations};
  }).immediate();
}
module.exports={consumeCompletionReservation};
