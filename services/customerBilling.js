'use strict';

const BILLABLE_ORDER_STATUSES = [
  '\u05e0\u05e9\u05dc\u05d7\u05d4',
  '\u05e0\u05de\u05e1\u05e8\u05d4',
  '\u05e1\u05d5\u05e4\u05e7\u05d4',
  '\u05de\u05d5\u05db\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e1\u05d5\u05e3',
];

const WIP_ORDER_STATUSES = [
  '\u05de\u05de\u05ea\u05d9\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8',
  '\u05de\u05de\u05ea\u05d9\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8 \u05dc\u05e7\u05d5\u05d7',
  '\u05d0\u05d5\u05e9\u05e8\u05d4 \u2013 \u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d9\u05d9\u05e6\u05d5\u05e8',
  '\u05d1\u05ea\u05d5\u05e8 \u05d9\u05d9\u05e6\u05d5\u05e8',
  '\u05d1\u05d9\u05d9\u05e6\u05d5\u05e8',
  '\u05d4\u05d5\u05e9\u05dc\u05dd \u2013 \u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d0\u05d9\u05e1\u05d5\u05e3',
];

const CLOSED_INVOICE_STATUSES = [
  '\u05e9\u05d5\u05dc\u05de\u05d4',
  '\u05d1\u05d9\u05d8\u05d5\u05dc',
];

// Consolidated invoices keep their order IDs in items_json.
const INVOICE_CONTAINS_ORDER = `
  (inv.order_id = o.id OR (
    inv.customer_id = o.customer_id AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(inv.items_json) THEN inv.items_json ELSE '[]' END) AS line
      WHERE CASE WHEN line.type = 'object' THEN json_extract(line.value, '$.order_id') END
        IN (o.id, CAST(o.id AS TEXT))
    )
  ))
`;

function requiredDb(db) {
  if (!db) throw new Error('services/customerBilling missing dependency: db');
  return db;
}

function normalizeId(value, fieldName = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error(`invalid_${fieldName}`);
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function sum(rows, field) {
  return money((rows || []).reduce((total, row) => total + Number(row[field] || 0), 0));
}

function getCustomerAccountSummary(db, { customer_id } = {}) {
  const database = requiredDb(db);
  const customerId = normalizeId(customer_id, 'customer_id');

  const customer = database.prepare(`
    SELECT id,name,phone,email,tax_id,payment_terms,price_tier,discount_pct
    FROM customers
    WHERE id = ?
  `).get(customerId);

  if (!customer) {
    const err = new Error('customer_not_found');
    err.statusCode = 404;
    throw err;
  }

  const billableOrders = database.prepare(`
    SELECT
      o.id,
      o.order_num,
      o.status,
      o.delivery_date,
      o.delivery_address,
      o.total_weight,
      o.billing_weight,
      o.portal_price,
      o.sale_price,
      o.created_at,
      cs.id AS site_id,
      cs.name AS site_name,
      COALESCE(ob.billed_amount, 0) AS billed_amount,
      ob.billed_date,
      ob.priority_invoice_ref,
      COALESCE(oc.revenue, o.sale_price, o.portal_price, 0) AS expected_amount
    FROM orders o
    LEFT JOIN customer_sites cs ON cs.id = o.site_id
    LEFT JOIN order_billing ob ON ob.order_id = o.id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    WHERE o.customer_id = ?
      AND o.status IN (${placeholders(BILLABLE_ORDER_STATUSES)})
      AND COALESCE(ob.billed_amount, 0) <= 0
      AND COALESCE(ob.billed_by, '') <> 'customerBilling'
      AND NOT EXISTS (
        SELECT 1
        FROM invoices inv
        WHERE ${INVOICE_CONTAINS_ORDER}
          AND inv.status NOT IN (${placeholders(CLOSED_INVOICE_STATUSES.slice(1))})
      )
    ORDER BY COALESCE(o.delivery_date, o.created_at) ASC, o.id ASC
  `).all(customerId, ...BILLABLE_ORDER_STATUSES, CLOSED_INVOICE_STATUSES[1]);

  const openInvoices = database.prepare(`
    SELECT
      id,
      invoice_num,
      invoice_type,
      order_id,
      order_num,
      issue_date,
      due_date,
      subtotal,
      vat_amount,
      total,
      paid_amount,
      ROUND(COALESCE(total, 0) - COALESCE(paid_amount, 0), 2) AS balance_due,
      status,
      payment_method,
      payment_ref,
      notes,
      created_at
    FROM invoices
    WHERE customer_id = ?
      AND status NOT IN (${placeholders(CLOSED_INVOICE_STATUSES)})
    ORDER BY COALESCE(due_date, issue_date, created_at) ASC, id ASC
  `).all(customerId, ...CLOSED_INVOICE_STATUSES);

  const wipOrders = database.prepare(`
    SELECT
      o.id,
      o.order_num,
      o.status,
      o.delivery_date,
      o.total_weight,
      o.billing_weight,
      o.portal_price,
      o.sale_price,
      o.created_at,
      cs.id AS site_id,
      cs.name AS site_name,
      COALESCE(oc.revenue, o.sale_price, o.portal_price, 0) AS expected_amount,
      COALESCE(oc.total_cost, 0) AS estimated_cost
    FROM orders o
    LEFT JOIN customer_sites cs ON cs.id = o.site_id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    WHERE o.customer_id = ?
      AND o.status IN (${placeholders(WIP_ORDER_STATUSES)})
    ORDER BY COALESCE(o.delivery_date, o.created_at) ASC, o.id ASC
  `).all(customerId, ...WIP_ORDER_STATUSES);

  const customerCredit = database.prepare(`
    SELECT customer_id,credit_limit,payment_terms,open_debt,wip_value,total_exposure,credit_status,last_payment_date,notes,updated_at
    FROM customer_credit
    WHERE customer_id = ?
  `).get(customerId) || null;

  const creditAccount = database.prepare(`
    SELECT customer_id,credit_limit,payment_terms,current_debt,blocked,block_reason,notes,updated_at
    FROM credit_accounts
    WHERE customer_id = ?
  `).get(customerId) || null;

  const openDebt = sum(openInvoices, 'balance_due');
  const wipValue = sum(wipOrders, 'expected_amount');
  const totalExposure = money(openDebt + wipValue);
  const creditLimit = money(
    customerCredit?.credit_limit ?? creditAccount?.credit_limit ?? 0
  );
  const creditAvailable = money(creditLimit > 0 ? creditLimit - totalExposure : 0);
  const creditOverLimit = creditLimit > 0 && totalExposure > creditLimit;
  const creditOverLimitAmount = money(creditOverLimit ? totalExposure - creditLimit : 0);

  return {
    customer,
    billableOrders: {
      count: billableOrders.length,
      totalWeightKg: sum(billableOrders, 'total_weight'),
      billingWeightKg: sum(billableOrders, 'billing_weight'),
      expectedAmount: sum(billableOrders, 'expected_amount'),
      rows: billableOrders,
    },
    openInvoices: {
      count: openInvoices.length,
      total: sum(openInvoices, 'total'),
      paidAmount: sum(openInvoices, 'paid_amount'),
      openDebt,
      rows: openInvoices,
    },
    wip: {
      count: wipOrders.length,
      totalWeightKg: sum(wipOrders, 'total_weight'),
      billingWeightKg: sum(wipOrders, 'billing_weight'),
      expectedAmount: wipValue,
      estimatedCost: sum(wipOrders, 'estimated_cost'),
      rows: wipOrders,
    },
    credit: {
      source: customerCredit ? 'customer_credit' : (creditAccount ? 'credit_accounts' : 'none'),
      creditLimit,
      openDebt,
      wipValue,
      totalExposure,
      creditAvailable,
      creditOverLimit,
      creditOverLimitAmount,
      blocked: Boolean(creditAccount?.blocked) || customerCredit?.credit_status === 'blocked',
      blockReason: creditAccount?.block_reason || null,
      paymentTerms: customerCredit?.payment_terms ?? creditAccount?.payment_terms ?? customer.payment_terms ?? null,
      customerCredit,
      creditAccount,
    },
  };
}

function normalizeIdList(values, fieldName = 'ids') {
  const ids = Array.isArray(values) ? values.map(value => normalizeId(value, fieldName)) : [];
  return Array.from(new Set(ids));
}

function parsePaymentTermsDays(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/\d+/);
  if (match) return Number(match[0]);
  return 30;
}

function datePlusDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function nextDraftInvoiceNumber(database) {
  const year = new Date().getFullYear();
  const prefix = `DRAFT-${year}-`;
  const row = database.prepare("SELECT COUNT(*) + 1 AS n FROM invoices WHERE invoice_num LIKE ?").get(`${prefix}%`);
  return `${prefix}${String(row?.n || 1).padStart(5, '0')}`;
}

function createInvoiceDraftFromBillableOrders(db, { customer_id, order_ids } = {}) {
  const database = requiredDb(db);
  const customerId = normalizeId(customer_id, 'customer_id');
  const orderIds = normalizeIdList(order_ids, 'order_id');

  if (!orderIds.length) {
    const err = new Error('order_ids_required');
    err.statusCode = 400;
    throw err;
  }

  const customer = database.prepare(`
    SELECT id,name,tax_id,payment_terms
    FROM customers
    WHERE id = ?
  `).get(customerId);

  if (!customer) {
    const err = new Error('customer_not_found');
    err.statusCode = 404;
    throw err;
  }

  const selectOrders = database.prepare(`
    SELECT
      o.id,
      o.order_num,
      o.status,
      o.delivery_date,
      o.delivery_address,
      o.total_weight,
      o.billing_weight,
      o.portal_price,
      o.sale_price,
      o.created_at,
      cs.id AS site_id,
      cs.name AS site_name,
      COALESCE(ob.billed_amount, 0) AS billed_amount,
      COALESCE(oc.revenue, o.sale_price, o.portal_price, 0) AS expected_amount
    FROM orders o
    LEFT JOIN customer_sites cs ON cs.id = o.site_id
    LEFT JOIN order_billing ob ON ob.order_id = o.id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    WHERE o.customer_id = ?
      AND o.id IN (${placeholders(orderIds)})
      AND o.status IN (${placeholders(BILLABLE_ORDER_STATUSES)})
      AND COALESCE(ob.billed_amount, 0) <= 0
      AND COALESCE(ob.billed_by, '') <> 'customerBilling'
      AND NOT EXISTS (
        SELECT 1
        FROM invoices inv
        WHERE ${INVOICE_CONTAINS_ORDER}
          AND inv.status NOT IN (${placeholders(CLOSED_INVOICE_STATUSES.slice(1))})
      )
    ORDER BY COALESCE(o.delivery_date, o.created_at) ASC, o.id ASC
  `);

  const draft = database.transaction(() => {
    const orders = selectOrders.all(customerId, ...orderIds, ...BILLABLE_ORDER_STATUSES, CLOSED_INVOICE_STATUSES[1]);
    const selectedIds = new Set(orders.map(order => Number(order.id)));
    const rejectedOrderIds = orderIds.filter(id => !selectedIds.has(id));

    if (!orders.length) {
      const err = new Error('no_billable_orders');
      err.statusCode = 409;
      err.rejectedOrderIds = rejectedOrderIds;
      throw err;
    }

    if (rejectedOrderIds.length) {
      const err = new Error('some_orders_are_not_billable');
      err.statusCode = 409;
      err.rejectedOrderIds = rejectedOrderIds;
      throw err;
    }

    const items = orders.map(order => {
      const amount = money(order.expected_amount);
      return {
        type: 'order',
        order_id: order.id,
        order_num: order.order_num,
        description: `הזמנה ${order.order_num}`,
        status: order.status,
        site_id: order.site_id || null,
        site_name: order.site_name || null,
        delivery_date: order.delivery_date || null,
        delivery_address: order.delivery_address || null,
        total_weight_kg: money(order.total_weight),
        billing_weight_kg: money(order.billing_weight),
        amount,
      };
    });

    const subtotal = sum(items, 'amount');
    const vatRate = 0.18;
    const vatAmount = money(subtotal * vatRate);
    const total = money(subtotal + vatAmount);
    const invoiceNum = nextDraftInvoiceNumber(database);
    const singleOrder = orders.length === 1 ? orders[0] : null;
    const dueDate = datePlusDays(parsePaymentTermsDays(customer.payment_terms));

    const result = database.prepare(`
      INSERT INTO invoices (
        invoice_num,
        invoice_type,
        order_id,
        order_num,
        customer_id,
        customer_name,
        customer_vat_id,
        issue_date,
        due_date,
        items_json,
        subtotal,
        vat_rate,
        vat_amount,
        total,
        status,
        notes,
        created_by
      ) VALUES (?,?,?,?,?,?,?,date('now'),?,?,?,?,?,?,?,?,?)
    `).run(
      invoiceNum,
      'draft',
      singleOrder?.id || null,
      singleOrder?.order_num || null,
      customer.id,
      customer.name,
      customer.tax_id || null,
      dueDate,
      JSON.stringify(items),
      subtotal,
      vatRate,
      vatAmount,
      total,
      'טיוטה',
      'Invoice draft from billable customer orders',
      null
    );

    return {
      id: result.lastInsertRowid,
      invoice_num: invoiceNum,
      status: 'טיוטה',
      customer_id: customer.id,
      customer_name: customer.name,
      order_ids: orderIds,
      subtotal,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      total,
      due_date: dueDate,
      items,
    };
  });

  return draft();
}

function parseInvoiceItems(invoice) {
  try {
    const items = JSON.parse(invoice?.items_json || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function invoiceLineAmountMap(invoice) {
  const map = new Map();
  for (const item of parseInvoiceItems(invoice)) {
    const orderId = Number(item.order_id || 0);
    if (!orderId) continue;
    map.set(orderId, (map.get(orderId) || 0) + Number(item.amount || 0));
  }
  return map;
}

function linkInvoiceToOrders(db, { invoice_id, order_ids } = {}) {
  const database = requiredDb(db);
  const invoiceId = normalizeId(invoice_id, 'invoice_id');
  const orderIds = normalizeIdList(order_ids, 'order_id');

  if (!orderIds.length) {
    const err = new Error('order_ids_required');
    err.statusCode = 400;
    throw err;
  }

  const invoice = database.prepare(`
    SELECT *
    FROM invoices
    WHERE id = ?
  `).get(invoiceId);

  if (!invoice) {
    const err = new Error('invoice_not_found');
    err.statusCode = 404;
    throw err;
  }

  if (CLOSED_INVOICE_STATUSES.includes(invoice.status)) {
    const err = new Error('invoice_is_closed');
    err.statusCode = 409;
    throw err;
  }

  const selectOrders = database.prepare(`
    SELECT
      o.id,
      o.order_num,
      o.customer_id,
      o.status,
      COALESCE(ob.billed_amount, 0) AS billed_amount,
      COALESCE(oc.revenue, o.sale_price, o.portal_price, 0) AS expected_amount
    FROM orders o
    LEFT JOIN order_billing ob ON ob.order_id = o.id
    LEFT JOIN order_costs oc ON oc.order_id = o.id
    WHERE o.customer_id = ?
      AND o.id IN (${placeholders(orderIds)})
      AND o.status IN (${placeholders(BILLABLE_ORDER_STATUSES)})
      AND COALESCE(ob.billed_amount, 0) <= 0
      AND COALESCE(ob.billed_by, '') <> 'customerBilling'
      AND NOT EXISTS (
        SELECT 1
        FROM invoices inv
        WHERE inv.id <> ?
          AND ${INVOICE_CONTAINS_ORDER}
          AND inv.status NOT IN (${placeholders(CLOSED_INVOICE_STATUSES.slice(1))})
      )
    ORDER BY o.id ASC
  `);

  const link = database.transaction(() => {
    const orders = selectOrders.all(invoice.customer_id, ...orderIds, ...BILLABLE_ORDER_STATUSES, invoiceId, CLOSED_INVOICE_STATUSES[1]);
    const selectedIds = new Set(orders.map(order => Number(order.id)));
    const rejectedOrderIds = orderIds.filter(id => !selectedIds.has(id));

    if (!orders.length) {
      const err = new Error('no_billable_orders_to_link');
      err.statusCode = 409;
      err.rejectedOrderIds = rejectedOrderIds;
      throw err;
    }

    if (rejectedOrderIds.length) {
      const err = new Error('some_orders_are_not_billable');
      err.statusCode = 409;
      err.rejectedOrderIds = rejectedOrderIds;
      throw err;
    }

    const itemAmounts = invoiceLineAmountMap(invoice);
    const today = new Date().toISOString().slice(0, 10);
    const billedDate = invoice.issue_date || today;
    const billingNotes = `Linked to invoice ${invoice.invoice_num || invoice.id}`;

    const upsertBilling = database.prepare(`
      INSERT INTO order_billing (
        order_id,
        order_num,
        billed_amount,
        billed_date,
        priority_invoice_ref,
        billing_notes,
        billed_by,
        updated_at
      ) VALUES (?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(order_id) DO UPDATE SET
        billed_amount = excluded.billed_amount,
        billed_date = excluded.billed_date,
        priority_invoice_ref = excluded.priority_invoice_ref,
        billing_notes = excluded.billing_notes,
        billed_by = excluded.billed_by,
        updated_at = datetime('now')
    `);

    const linkedOrders = orders.map(order => {
      const billedAmount = money(itemAmounts.get(Number(order.id)) ?? order.expected_amount);
      upsertBilling.run(
        order.id,
        order.order_num,
        billedAmount,
        billedDate,
        invoice.invoice_num || String(invoice.id),
        billingNotes,
        'customerBilling'
      );
      return {
        order_id: order.id,
        order_num: order.order_num,
        billed_amount: billedAmount,
        billing_ref: invoice.invoice_num || String(invoice.id),
      };
    });

    if (orders.length === 1) {
      database.prepare('UPDATE invoices SET order_id=?, order_num=? WHERE id=?')
        .run(orders[0].id, orders[0].order_num, invoice.id);
    }

    return {
      invoice_id: invoice.id,
      invoice_num: invoice.invoice_num,
      customer_id: invoice.customer_id,
      linked_count: linkedOrders.length,
      linked_amount: sum(linkedOrders, 'billed_amount'),
      linked_orders: linkedOrders,
    };
  });

  return link();
}

module.exports = {
  getCustomerAccountSummary,
  createInvoiceDraftFromBillableOrders,
  linkInvoiceToOrders,
  BILLABLE_ORDER_STATUSES,
  WIP_ORDER_STATUSES,
};
