'use strict';

const { customerStatusFromOrder, CUSTOMER_STATUS } = require('./customerPortalStatus');

function canViewPrices(ctx = {}) {
  const caps = ctx.caps || ctx || {};
  return Boolean(caps.seePrice || caps.canViewPrices || caps.can_view_prices);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstText(...values) {
  for (const value of values) {
    const clean = String(value || '').trim();
    if (clean) return clean;
  }
  return '';
}

function projectPortalCustomer(customer = {}, ctx = {}) {
  const projected = {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    contact_name: customer.contact_name,
    contact_phone: customer.contact_phone,
    tax_id: customer.tax_id,
    payment_terms: customer.payment_terms,
    portal_price_list_visibility: customer.portal_price_list_visibility,
    portal_profile_locked_at: customer.portal_profile_locked_at,
  };
  if (ctx.pendingProfileChangeRequest !== undefined) {
    projected.pending_profile_change_request = ctx.pendingProfileChangeRequest;
  }
  return projected;
}

function projectPortalOrder(order = {}, ctx = {}) {
  const status = customerStatusFromOrder(order);
  const totalWeightKg = numberOrNull(order.totalWeightKg ?? order.total_weight);
  const billingWeightKg = numberOrNull(order.billingWeightKg ?? order.billing_weight);
  const canSeePrice = canViewPrices(ctx);
  const siteName = firstText(order.siteName, order.site_name);
  const orderNum = firstText(order.orderNum, order.order_num);
  const projected = {
    id: order.id,
    orderNum,
    order_num: orderNum,
    status: status.customer_status_label,
    customerStatus: status.customer_status,
    customer_status: status.customer_status,
    customerStatusLabel: status.customer_status_label,
    customer_status_label: status.customer_status_label,
    nextAction: status.customer_next_action,
    customer_next_action: status.customer_next_action,
    siteName,
    site_name: siteName,
    siteId: numberOrNull(order.siteId ?? order.site_id),
    site_id: numberOrNull(order.site_id ?? order.siteId),
    deliveryDate: order.deliveryDate || order.delivery_date || null,
    delivery_date: order.delivery_date || order.deliveryDate || null,
    deliveryWindow: order.deliveryWindow || order.delivery_time || null,
    delivery_time: order.delivery_time || order.deliveryWindow || null,
    totalWeightKg,
    total_weight: totalWeightKg,
    billingWeightKg,
    billing_weight: billingWeightKg,
    customerCanApprove: Boolean((ctx.caps || {}).canApprove && status.customer_status === CUSTOMER_STATUS.AWAITING_CUSTOMER_APPROVAL),
    customerCanViewPrice: canSeePrice,
    updatedAt: order.updated_at || order.created_at || null,
    created_at: order.created_at || null,
  };
  if (order.delivery_address) projected.delivery_address = order.delivery_address;
  if (order.notes) projected.notes = order.notes;
  if (canSeePrice) {
    const totalPrice = numberOrNull(order.totalPrice ?? order.portal_price);
    projected.totalPrice = totalPrice;
    projected.portal_price = totalPrice;
  }
  return projected;
}

function projectPortalItem(item = {}, ctx = {}) {
  const totalLengthMm = numberOrNull(item.totalLengthMm ?? item.total_length_mm);
  const quantity = numberOrNull(item.quantity ?? item.qty);
  const weightKg = numberOrNull(item.weightKg ?? item.total_weight);
  const unitWeightKg = numberOrNull(item.unitWeightKg ?? item.weight_per_unit);
  const shapeSnapshot = item.shapeSnapshot || item.shape_snapshot_json || null;
  const elementName = firstText(item.struct_element, item.elementName, item.element_name, item.element);
  return {
    id: item.id,
    itemNum: item.itemNum || item.item_uid || item.id || null,
    elementName,
    struct_element: item.struct_element || null,
    struct_floor: item.struct_floor || null,
    sheet_num: item.sheet_num || null,
    shapePreview: item.shapePreview || null,
    shapeDimsText: item.shapeDimsText || '',
    shapeSnapshot,
    shape_snapshot_json: shapeSnapshot,
    shapeName: firstText(item.shapeName, item.shape_name),
    shape_name: firstText(item.shape_name, item.shapeName),
    shape_svg: item.shape_svg || null,
    segments: item.segments || null,
    diameter: numberOrNull(item.diameter),
    quantity,
    qty: quantity,
    lengthM: totalLengthMm === null ? null : totalLengthMm / 1000,
    totalLengthM: totalLengthMm === null || quantity === null ? null : (totalLengthMm * quantity) / 1000,
    total_length_mm: totalLengthMm,
    weightKg,
    total_weight: weightKg,
    weight_per_unit: unitWeightKg,
    noteForCustomer: firstText(item.noteForCustomer, item.note),
    note: firstText(item.noteForCustomer, item.note),
  };
}

function projectPortalOrderDetail(order = {}, itemsOrPallets = [], documents = [], ctx = {}) {
  const orderProjection = projectPortalOrder(order, ctx);
  const looksLikePallets = Array.isArray(itemsOrPallets) && itemsOrPallets.some(row => Array.isArray(row.items));
  const pallets = looksLikePallets
    ? itemsOrPallets.map(pallet => ({
        id: pallet.id,
        pallet_num: pallet.pallet_num,
        notes: '',
        items: (pallet.items || []).map(item => projectPortalItem(item, ctx)),
      }))
    : [{ id: null, pallet_num: null, notes: '', items: (itemsOrPallets || []).map(item => projectPortalItem(item, ctx)) }];
  return {
    ...orderProjection,
    order: orderProjection,
    pallets,
    items: pallets.flatMap(pallet => pallet.items),
    documents: (documents || []).map(doc => ({
      id: doc.id,
      name: doc.original_name || doc.name || doc.file_name,
      type: doc.document_type || doc.mime_type || null,
      status: doc.status || null,
      uploadedAt: doc.uploaded_at || doc.created_at || null,
    })),
    timeline: [],
    messages: [],
    approvals: [],
    delivery: {
      address: order.delivery_address || null,
      date: order.delivery_date || null,
      window: order.delivery_time || null,
    },
  };
}

module.exports = {
  canViewPrices,
  projectPortalCustomer,
  projectPortalOrder,
  projectPortalOrderDetail,
  projectPortalItem,
};
