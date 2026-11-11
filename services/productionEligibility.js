'use strict';

// Production consumes the Orders workspace lifecycle; it does not maintain a
// second definition of closed/deleted/paid customer orders.
const workspace = require('../public/order-workspace');
const { bucketCondition } = require('./orderWorkspace');
const { ORDER_STATUS, ORDER_STATUS_ALIASES, ITEM_STATUS, normalizeOrderStatus } = require('../status-contracts');
const startOrderStatuses = new Set([ORDER_STATUS.PRODUCTION_QUEUE, ORDER_STATUS.IN_PRODUCTION, ORDER_STATUS.PARTIAL_DELIVERY]);
const visualOrderStatuses = new Set([...startOrderStatuses, ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.ON_THE_WAY, ORDER_STATUS.SENT, ORDER_STATUS.DELIVERY_PROBLEM]);
function orderFromItem(item = {}) {
  return { status: normalizeOrderStatus(item.order_status), payment_status: item.order_payment_status, deleted_at: item.order_deleted_at };
}
function isActiveOrder(item) { return Boolean(item) && workspace.bucket(orderFromItem(item)) === 'active'; }
function canReopenDeliveredOrder(item) { return Boolean(item) && workspace.bucket(orderFromItem(item)) === 'delivered'; }
function isProductionOrderOpen(item) { return isActiveOrder(item) && startOrderStatuses.has(normalizeOrderStatus(item.order_status)); }
function isProductionGateOpen(item) {
  return isProductionOrderOpen(item) && [ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION].includes(item.status)
    && item.cancelled_at == null && item.production_stopped_at == null;
}
function productionGateError(item = {}) {
  const number = item.order_num ? ' ' + item.order_num : '';
  const bucket = workspace.bucket(orderFromItem(item));
  const explanations = {
    trash: `ההזמנה${number} נמצאת בסל המחזור. יש לשחזר אותה במסך ההזמנות ולאשר שהיא פתוחה לייצור`,
    closed: `ההזמנה${number} סגורה. יש לפתוח אותה מחדש במסך ההזמנות לפני המשך ייצור`,
    delivered: `ההזמנה${number} כבר סופקה. חזרה לייצור מחייבת תיקון מאושר במסך ההזמנות`,
    cancelled: `ההזמנה${number} בוטלה. אין להתחיל או לדווח ייצור עבורה`,
  };
  const pending = [ORDER_STATUS.PENDING_APPROVAL, ORDER_STATUS.CUSTOMER_PENDING_APPROVAL].includes(normalizeOrderStatus(item.order_status));
  return { error: 'item_not_released_to_production', user_message: explanations[bucket] || (pending
    ? `ההזמנה${number} ממתינה לאישור. יש לאשר אותה לייצור במסך ההזמנות`
    : `לא ניתן להתחיל את הפריט במצב הנוכחי: הזמנה ״${item.order_status || 'לא ידוע'}״, פריט ״${item.status || 'לא ידוע'}״. יש לעדכן את מצב העבודה במערכת`),
    item_status: item.status || null, order_status: item.order_status || null, order_bucket: bucket };
}
function productionQueueCondition({ visual = false } = {}) {
  const allowed = visual ? visualOrderStatuses : startOrderStatuses;
  const rawOrders = [...allowed, ...Object.keys(ORDER_STATUS_ALIASES).filter(status => allowed.has(normalizeOrderStatus(status)))];
  const itemStatuses = visual ? [ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION, ITEM_STATUS.DONE, ITEM_STATUS.LOADED, ITEM_STATUS.SENT, ITEM_STATUS.DELIVERED] : [ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION];
  const quoted = list => [...new Set(list)].map(status => "'" + status.replace(/'/g,"''") + "'").join(',');
  return `(${bucketCondition('active')}) AND o.status IN (${quoted(rawOrders)}) AND i.status IN (${quoted(itemStatuses)}) AND i.cancelled_at IS NULL AND i.production_stopped_at IS NULL`;
}
module.exports = { isActiveOrder, canReopenDeliveredOrder, isProductionOrderOpen, isProductionGateOpen, productionGateError, productionQueueCondition };
