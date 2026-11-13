'use strict';

const { ORDER_STATUS, normalizeOrderStatus } = require('../status-contracts');
const workspace = require('../public/order-workspace');
const { bucketCondition } = require('./orderWorkspace');

// Orders owns the order transition; Production supplies the accepted work event.
function markOrderProductionStarted(db, orderId, actor = {}) {
  return db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order || workspace.bucket(order) !== 'active' || normalizeOrderStatus(order.status) !== ORDER_STATUS.PRODUCTION_QUEUE) return null;
    db.prepare('UPDATE orders SET status=?,workspace_version=workspace_version+1 WHERE id=?').run(ORDER_STATUS.IN_PRODUCTION, order.id);
    db.prepare(`INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
      VALUES('order',?,?,'production_started_automatically','status',?,?,?, ?,?)`).run(
      order.id, order.order_num, order.status, ORDER_STATUS.IN_PRODUCTION,
      'תחילת ייצור בעקבות עדכון כרטיס', actor.userId || null, actor.userName || null);
    return { id: order.id, status: ORDER_STATUS.IN_PRODUCTION, orderNum: order.order_num };
  })();
}

function reconcileQueuedProduction(db) {
  return db.transaction(() => {
    const orders = db.prepare(`SELECT o.id,o.status FROM orders o WHERE ${bucketCondition('active')}
      AND EXISTS(SELECT 1 FROM items i JOIN pallets p ON p.id=i.pallet_id WHERE p.order_id=o.id
        AND i.cancelled_at IS NULL AND i.status NOT IN ('בוטל','בוטלה')
        AND (i.status IN ('בייצור','הושלם','הועמס','נשלח','סופק') OR i.produced_qty>0))`).all();
    return orders.filter(order => normalizeOrderStatus(order.status) === ORDER_STATUS.PRODUCTION_QUEUE)
      .filter(order => {
        const manual=db.prepare("SELECT old_value,new_value FROM audit_log WHERE entity_type='order' AND entity_id=? AND action='status_change' ORDER BY rowid DESC LIMIT 1").get(order.id);
        return !(manual && normalizeOrderStatus(manual.old_value)===ORDER_STATUS.IN_PRODUCTION && normalizeOrderStatus(manual.new_value)===ORDER_STATUS.PRODUCTION_QUEUE);
      })
      .map(order => markOrderProductionStarted(db, order.id, { userName: 'סנכרון סטטוס לפי כרטיסי ייצור' })).filter(Boolean);
  })();
}

module.exports = { markOrderProductionStarted, reconcileQueuedProduction };
