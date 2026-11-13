'use strict';

const { ORDER_STATUS, normalizeOrderStatus } = require('../status-contracts');
const workspace = require('../public/order-workspace');

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

module.exports = { markOrderProductionStarted };
