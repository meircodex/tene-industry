'use strict';
const { ORDER_STATUS } = require('../status-contracts');
function createPortalInbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS portal_order_inbox (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id), owner_user_id INTEGER REFERENCES users(id),
    read_at TEXT, handled_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  const pending = [ORDER_STATUS.CUSTOMER_PENDING_APPROVAL, ORDER_STATUS.PENDING_APPROVAL];
  function list() {
    return db.prepare(`SELECT o.id,o.order_num,c.name AS customer_name,o.status,o.created_at,o.site_id,
      i.owner_user_id,u.display_name AS owner_name,i.read_at,i.handled_at,
      CASE WHEN i.read_at IS NULL THEN 1 ELSE 0 END AS unread
      FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN portal_order_inbox i ON i.order_id=o.id LEFT JOIN users u ON u.id=i.owner_user_id
      WHERE (o.portal_order=1 OR o.channel='פורטל לקוח') AND o.status IN (?,?)
      ORDER BY o.created_at,o.id`).all(...pending);
  }
  function update(orderId, actorId, action) {
    if (!['read','claim','handled','reopen'].includes(action)) return { status:400,error:'פעולה לא תקינה' };
    const order = list().find(o=>o.id === Number(orderId));
    if (!order) return { status:404,error:'הבקשה אינה ממתינה בתיבת הפורטל' };
    if (action === 'handled' && order.status === ORDER_STATUS.CUSTOMER_PENDING_APPROVAL) {
      return { status:409,error:'ההזמנה עדיין ממתינה לאישור הלקוח; ניתן לקבל אחריות אך לא לסיים טיפול' };
    }
    db.prepare('INSERT OR IGNORE INTO portal_order_inbox(order_id) VALUES(?)').run(orderId);
    if (action === 'claim') db.prepare('UPDATE portal_order_inbox SET owner_user_id=?,read_at=COALESCE(read_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(actorId,orderId);
    if (action === 'read') db.prepare('UPDATE portal_order_inbox SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(orderId);
    if (action === 'handled') db.prepare('UPDATE portal_order_inbox SET handled_at=CURRENT_TIMESTAMP,read_at=COALESCE(read_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(orderId);
    if (action === 'reopen') db.prepare('UPDATE portal_order_inbox SET handled_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE order_id=?').run(orderId);
    return { success:true };
  }
  return {list,update};
}
module.exports = { createPortalInbox };
