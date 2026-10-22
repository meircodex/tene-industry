'use strict';

const { ORDER_STATUS } = require('../status-contracts');

const CUSTOMER_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED_REVIEW: 'submitted_review',
  NEEDS_INFO: 'needs_info',
  AWAITING_CUSTOMER_APPROVAL: 'awaiting_customer_approval',
  APPROVED: 'approved',
  IN_PRODUCTION: 'in_production',
  READY_FOR_DELIVERY: 'ready_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
});

const CUSTOMER_STATUS_LABELS = Object.freeze({
  [CUSTOMER_STATUS.DRAFT]: 'טיוטה',
  [CUSTOMER_STATUS.SUBMITTED_REVIEW]: 'נשלחה לבדיקה',
  [CUSTOMER_STATUS.NEEDS_INFO]: 'נדרשת השלמה',
  [CUSTOMER_STATUS.AWAITING_CUSTOMER_APPROVAL]: 'ממתינה לאישורך',
  [CUSTOMER_STATUS.APPROVED]: 'אושרה',
  [CUSTOMER_STATUS.IN_PRODUCTION]: 'בייצור',
  [CUSTOMER_STATUS.READY_FOR_DELIVERY]: 'מוכנה לאספקה',
  [CUSTOMER_STATUS.DELIVERED]: 'סופקה',
  [CUSTOMER_STATUS.CANCELLED]: 'בוטלה',
});

const CUSTOMER_NEXT_ACTION = Object.freeze({
  [CUSTOMER_STATUS.DRAFT]: 'אפשר להשלים ולשלוח לטנא',
  [CUSTOMER_STATUS.SUBMITTED_REVIEW]: 'טנא בודקת את הבקשה',
  [CUSTOMER_STATUS.NEEDS_INFO]: 'נדרשת השלמה ממך',
  [CUSTOMER_STATUS.AWAITING_CUSTOMER_APPROVAL]: 'נדרש אישור שלך',
  [CUSTOMER_STATUS.APPROVED]: 'אין פעולה נדרשת כרגע',
  [CUSTOMER_STATUS.IN_PRODUCTION]: 'אין פעולה נדרשת כרגע',
  [CUSTOMER_STATUS.READY_FOR_DELIVERY]: 'ההזמנה מוכנה לאספקה',
  [CUSTOMER_STATUS.DELIVERED]: 'ההזמנה סופקה',
  [CUSTOMER_STATUS.CANCELLED]: 'ההזמנה בוטלה',
});

function text(value) {
  return String(value || '').trim();
}

function hasAny(value, fragments) {
  const raw = text(value);
  return fragments.some(fragment => raw.includes(fragment));
}

function customerStatusFromOrder(order = {}) {
  const raw = text(order.customer_status || order.status);
  let customerStatus = CUSTOMER_STATUS.SUBMITTED_REVIEW;

  if (!raw || hasAny(raw, ['טיוטה', 'draft'])) {
    customerStatus = CUSTOMER_STATUS.DRAFT;
  } else if (raw === ORDER_STATUS.CANCELLED || hasAny(raw, ['בוטל', 'cancel'])) {
    customerStatus = CUSTOMER_STATUS.CANCELLED;
  } else if (raw === ORDER_STATUS.CUSTOMER_PENDING_APPROVAL || hasAny(raw, ['ממתינה לאישור לקוח', 'ממתין לאישור לקוח', 'לאישורך'])) {
    customerStatus = CUSTOMER_STATUS.AWAITING_CUSTOMER_APPROVAL;
  } else if (hasAny(raw, ['דורשת השלמה', 'חסר מידע', 'נדרשת השלמה', 'missing'])) {
    customerStatus = CUSTOMER_STATUS.NEEDS_INFO;
  } else if (raw === ORDER_STATUS.DELIVERED_CONFIRMED || hasAny(raw, ['סופק', 'נמסר', 'delivered'])) {
    customerStatus = CUSTOMER_STATUS.DELIVERED;
  } else if (raw === ORDER_STATUS.DONE_WAITING_PICKUP || raw === ORDER_STATUS.ON_THE_WAY || hasAny(raw, ['מוכן לאספקה', 'מוכנה לאספקה', 'בדרך'])) {
    customerStatus = CUSTOMER_STATUS.READY_FOR_DELIVERY;
  } else if (raw === ORDER_STATUS.IN_PRODUCTION || hasAny(raw, ['בייצור'])) {
    customerStatus = CUSTOMER_STATUS.IN_PRODUCTION;
  } else if (raw === ORDER_STATUS.PRODUCTION_QUEUE || hasAny(raw, ['אושרה', 'מאושר'])) {
    customerStatus = CUSTOMER_STATUS.APPROVED;
  } else if (raw === ORDER_STATUS.PENDING_APPROVAL || hasAny(raw, ['ממתינה לאישור', 'נשלחה לבדיקה', 'ממתין לאישור'])) {
    customerStatus = CUSTOMER_STATUS.SUBMITTED_REVIEW;
  }

  return {
    customer_status: customerStatus,
    customer_status_label: CUSTOMER_STATUS_LABELS[customerStatus],
    customer_next_action: CUSTOMER_NEXT_ACTION[customerStatus],
  };
}

module.exports = {
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_LABELS,
  customerStatusFromOrder,
};
