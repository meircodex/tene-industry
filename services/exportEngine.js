'use strict';

const DEFAULT_DESTINATION = 'priority';
const SUPPORTED_DESTINATIONS = new Set(['priority', 'hashovshevet', 'csv', 'api', 'generic']);
const SUPPORTED_FORMATS = new Set(['json', 'csv']);

function requiredDb(db) {
  if (!db) throw new Error('services/exportEngine missing dependency: db');
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

function normalizeDestination(destination = DEFAULT_DESTINATION) {
  const value = String(destination || DEFAULT_DESTINATION).trim().toLowerCase();
  return SUPPORTED_DESTINATIONS.has(value) ? value : 'generic';
}

function normalizeFormat(format = 'json') {
  const value = String(format || 'json').trim().toLowerCase();
  if (!SUPPORTED_FORMATS.has(value)) {
    const err = new Error('unsupported_export_format');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function safeJsonParse(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function loadCustomer(database, customerId) {
  if (!customerId) return null;
  return database.prepare(`
    SELECT id,name,phone,email,address,tax_id,priority_id,contact_name,contact_phone
    FROM customers
    WHERE id = ?
  `).get(customerId) || null;
}

function loadOrder(database, orderId) {
  if (!orderId) return null;
  return database.prepare(`
    SELECT id,order_num,priority_order_id,delivery_date,delivery_address,total_weight,billing_weight,status
    FROM orders
    WHERE id = ?
  `).get(orderId) || null;
}

function destinationRefs(customer, order, destination) {
  return {
    customerRef: destination === 'priority' ? (customer?.priority_id || null) : null,
    orderRef: destination === 'priority' ? (order?.priority_order_id || null) : null,
    existingDocumentRef: null,
  };
}

function invoiceRowsToLines(invoice) {
  const rows = safeJsonParse(invoice.items_json, []);
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const quantityTon = Number(row.billing_weight_kg || row.total_weight_kg || 0) / 1000;
    const amount = money(row.amount || row.total || 0);
    const unitPrice = quantityTon > 0 ? money(amount / quantityTon) : amount;
    return compactObject({
      lineNo: index + 1,
      sourceType: row.type || 'invoice_line',
      sourceId: row.order_id || null,
      sourceRef: row.order_num || null,
      description: row.description || row.order_num || `Invoice line ${index + 1}`,
      quantity: quantityTon > 0 ? Number(quantityTon.toFixed(3)) : Number(row.quantity || 1),
      unit: quantityTon > 0 ? 'ton' : (row.unit || 'unit'),
      unitPrice,
      amount,
      weightKg: money(row.billing_weight_kg || row.total_weight_kg || 0),
      deliveryDate: row.delivery_date || null,
      siteName: row.site_name || null,
    });
  });
}

function deliveryRowsToLines(note) {
  const packages = safeJsonParse(note.packages_json, []);
  const items = safeJsonParse(note.items_json, []);
  const sourceRows = Array.isArray(packages) && packages.length ? packages : (Array.isArray(items) ? items : []);
  return sourceRows.map((row, index) => compactObject({
    lineNo: index + 1,
    sourceType: Array.isArray(packages) && packages.length ? 'package' : 'item',
    sourceId: row.id || row.item_id || null,
    sourceRef: row.package_code || row.item_uid || row.shape_name || null,
    description: row.description || row.shape_name || row.package_code || `Delivery line ${index + 1}`,
    quantity: Number(row.quantity || row.production_qty || 1),
    unit: 'unit',
    weightKg: money(row.weight || row.total_weight || row.totalWeightKg || 0),
    diameter: row.diameter || null,
    zone: row.zone || null,
    orderId: row.order_id || null,
    orderNum: row.order_num || null,
  }));
}

function basePayload({ documentType, sourceId, sourceRef, destination, customer, order }) {
  const normalizedDestination = normalizeDestination(destination);
  return {
    documentType,
    sourceSystem: 'IronBend',
    sourceId,
    sourceRef,
    exportVersion: 2,
    destination: normalizedDestination,
    destinationRefs: destinationRefs(customer, order, normalizedDestination),
  };
}

function buildInvoiceExportPayload(db, { invoice_id, destination = DEFAULT_DESTINATION } = {}) {
  const database = requiredDb(db);
  const invoiceId = normalizeId(invoice_id, 'invoice_id');
  const invoice = database.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);

  if (!invoice) {
    const err = new Error('invoice_not_found');
    err.statusCode = 404;
    throw err;
  }

  const customer = loadCustomer(database, invoice.customer_id);
  const order = loadOrder(database, invoice.order_id);

  return {
    ...basePayload({
      documentType: 'invoice',
      sourceId: invoice.id,
      sourceRef: invoice.invoice_num,
      destination,
      customer,
      order,
    }),
    customer: {
      id: invoice.customer_id,
      name: invoice.customer_name || customer?.name || null,
      vatId: invoice.customer_vat_id || customer?.tax_id || null,
      phone: customer?.phone || null,
      email: customer?.email || null,
      address: customer?.address || null,
    },
    order: order ? {
      id: order.id,
      orderNum: order.order_num,
      externalRef: order.priority_order_id || null,
      deliveryDate: order.delivery_date || null,
      deliveryAddress: order.delivery_address || null,
    } : null,
    dates: {
      issueDate: invoice.issue_date || null,
      dueDate: invoice.due_date || null,
      createdAt: invoice.created_at || null,
    },
    totals: {
      subtotal: money(invoice.subtotal),
      vatRate: Number(invoice.vat_rate || 0),
      vatAmount: money(invoice.vat_amount),
      total: money(invoice.total),
      paidAmount: money(invoice.paid_amount),
    },
    status: invoice.status || null,
    lines: invoiceRowsToLines(invoice),
    raw: { invoice },
  };
}

function buildDeliveryNoteExportPayload(db, { delivery_note_id, destination = DEFAULT_DESTINATION } = {}) {
  const database = requiredDb(db);
  const deliveryNoteId = normalizeId(delivery_note_id, 'delivery_note_id');
  if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_note_cancellations'").get() && database.prepare('SELECT 1 FROM delivery_note_cancellations WHERE note_id=?').get(deliveryNoteId)) {
    throw Object.assign(new Error('delivery_note_cancelled'),{statusCode:409});
  }
  const note = database.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(deliveryNoteId);

  if (!note) {
    const err = new Error('delivery_note_not_found');
    err.statusCode = 404;
    throw err;
  }

  const customer = loadCustomer(database, note.customer_id);
  const order = loadOrder(database, note.order_id);
  const linkedOrders = database.prepare(`
    SELECT order_id,order_num,total_weight FROM delivery_note_orders
    WHERE delivery_note_id=? ORDER BY rowid
  `).all(note.id);

  return {
    ...basePayload({
      documentType: 'delivery_note',
      sourceId: note.id,
      sourceRef: note.note_num,
      destination,
      customer,
      order,
    }),
    customer: customer ? {
      id: customer.id,
      name: customer.name,
      vatId: customer.tax_id || null,
      phone: customer.phone || null,
      address: customer.address || null,
    } : { id: note.customer_id || null },
    order: order ? {
      id: order.id,
      orderNum: order.order_num,
      externalRef: order.priority_order_id || null,
      deliveryDate: order.delivery_date || null,
      deliveryAddress: order.delivery_address || null,
    } : {
      id: note.order_id || null,
      orderNum: note.order_num || null,
    },
    dates: {
      issuedAt: note.issued_at || null,
      deliveredAt: note.delivered_at || null,
    },
    totals: {
      totalWeightKg: money(note.total_weight),
    },
    logistics: {
      deliveryId: note.delivery_id || null,
      driverId: note.driver_id || null,
      signedBy: note.signed_by || null,
    },
    lines: deliveryRowsToLines(note),
    linkedOrders: linkedOrders.map(row => ({
      orderId: Number(row.order_id),
      orderNum: row.order_num,
      totalWeightKg: money(row.total_weight),
    })),
    raw: { deliveryNote: note },
  };
}

function exportAsJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportAsCsv(payload) {
  const header = [
    'destination',
    'document_type',
    'document_ref',
    'customer_ref',
    'customer_name',
    'line_no',
    'source_ref',
    'description',
    'quantity',
    'unit',
    'unit_price',
    'amount',
    'weight_kg',
  ];
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const rows = lines.length ? lines : [{ lineNo: 1 }];
  const csvRows = rows.map(line => [
    payload.destination || DEFAULT_DESTINATION,
    payload.documentType,
    payload.sourceRef,
    payload.destinationRefs?.customerRef || '',
    payload.customer?.name || '',
    line.lineNo,
    line.sourceRef || '',
    line.description || '',
    line.quantity || '',
    line.unit || '',
    line.unitPrice || '',
    line.amount || '',
    line.weightKg || '',
  ].map(csvEscape).join(','));
  return [header.join(','), ...csvRows].join('\n');
}

function exportAsFormat(payload, format = 'json') {
  const normalizedFormat = normalizeFormat(format);
  return normalizedFormat === 'csv' ? exportAsCsv(payload) : exportAsJson(payload);
}

function ensureExportLogSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS export_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destination TEXT NOT NULL DEFAULT 'generic',
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      export_format TEXT NOT NULL DEFAULT 'json',
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      external_ref TEXT,
      error_message TEXT,
      exported_by INTEGER,
      exported_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function recordExportLog(db, result = {}) {
  const database = requiredDb(db);
  ensureExportLogSchema(database);

  const payload = result.payload || null;
  const entityType = result.entity_type || result.entityType || result.documentType || payload?.documentType;
  const entityId = Number(result.entity_id || result.entityId || result.sourceId || payload?.sourceId || 0);
  if (!entityType || !Number.isInteger(entityId) || entityId <= 0) {
    const err = new Error('invalid_export_log_entity');
    err.statusCode = 400;
    throw err;
  }

  const destination = normalizeDestination(result.destination || payload?.destination || DEFAULT_DESTINATION);
  const exportFormat = normalizeFormat(result.export_format || result.exportFormat || 'json');
  const externalRef = result.external_ref || result.externalRef || result.priority_ref || result.priorityRef || null;
  const row = database.prepare(`
    INSERT INTO export_log (
      destination,
      entity_type,
      entity_id,
      export_format,
      payload_json,
      status,
      external_ref,
      error_message,
      exported_by,
      exported_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    destination,
    entityType,
    entityId,
    exportFormat,
    payload ? JSON.stringify(payload) : (result.payload_json || null),
    result.status || 'draft',
    externalRef,
    result.error_message || result.errorMessage || null,
    result.exported_by || result.exportedBy || null,
    result.exported_at || result.exportedAt || null
  );

  return {
    id: row.lastInsertRowid,
    destination,
    entity_type: entityType,
    entity_id: entityId,
    export_format: exportFormat,
    status: result.status || 'draft',
  };
}


function resolveOrderBillingTargets(database, { entity_type, entity_id, billed_amount } = {}) {
  const entityType = String(entity_type || '').trim();
  const entityId = normalizeId(entity_id, 'entity_id');

  if (entityType === 'order_billing') {
    const row = database.prepare(`
      SELECT ob.order_id, ob.order_num, ob.billed_amount, o.order_num AS fallback_order_num
      FROM order_billing ob
      LEFT JOIN orders o ON o.id = ob.order_id
      WHERE ob.id = ?
    `).get(entityId);
    if (!row) {
      const err = new Error('order_billing_not_found');
      err.statusCode = 404;
      throw err;
    }
    return [{
      order_id: row.order_id,
      order_num: row.order_num || row.fallback_order_num,
      billed_amount: money(billed_amount ?? row.billed_amount),
    }];
  }

  if (entityType === 'invoice') {
    const invoice = database.prepare('SELECT * FROM invoices WHERE id = ?').get(entityId);
    if (!invoice) {
      const err = new Error('invoice_not_found');
      err.statusCode = 404;
      throw err;
    }
    const items = safeJsonParse(invoice.items_json, []);
    const rows = Array.isArray(items)
      ? items
          .filter(item => Number(item.order_id || 0) > 0)
          .map(item => ({
            order_id: Number(item.order_id),
            order_num: item.order_num || null,
            billed_amount: money(item.amount || item.total || 0),
          }))
      : [];
    if (rows.length) return rows;
    if (invoice.order_id) {
      return [{
        order_id: Number(invoice.order_id),
        order_num: invoice.order_num || null,
        billed_amount: money(billed_amount ?? invoice.subtotal ?? invoice.total),
      }];
    }
    const err = new Error('invoice_has_no_linked_orders');
    err.statusCode = 409;
    throw err;
  }

  if (entityType === 'delivery_note') {
    const note = database.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(entityId);
    if (!note) {
      const err = new Error('delivery_note_not_found');
      err.statusCode = 404;
      throw err;
    }
    const linkedOrders = database.prepare(`
      SELECT order_id,order_num,total_weight FROM delivery_note_orders
      WHERE delivery_note_id=? ORDER BY rowid
    `).all(note.id);
    if (linkedOrders.length) {
      const linkedWeight = linkedOrders.reduce((sum, row) => sum + Number(row.total_weight || 0), 0);
      const requestedAmount = money(billed_amount || 0);
      return linkedOrders.map(row => ({
        order_id: Number(row.order_id),
        order_num: row.order_num || null,
        billed_amount: linkedWeight > 0
          ? money(requestedAmount * Number(row.total_weight || 0) / linkedWeight)
          : money(requestedAmount / linkedOrders.length),
      }));
    }
    if (!note.order_id) {
      const err = new Error('delivery_note_has_no_order');
      err.statusCode = 409;
      throw err;
    }
    return [{
      order_id: Number(note.order_id),
      order_num: note.order_num || null,
      billed_amount: money(billed_amount || 0),
    }];
  }

  const err = new Error('unsupported_billing_export_entity');
  err.statusCode = 400;
  throw err;
}

function linkExportToOrderBilling(db, {
  entity_type,
  entity_id,
  priority_ref,
  billed_amount,
  billed_date,
  exported_by,
} = {}) {
  const database = requiredDb(db);
  const priorityRef = String(priority_ref || '').trim();
  if (!priorityRef) {
    const err = new Error('priority_ref_required');
    err.statusCode = 400;
    throw err;
  }

  const billedDate = billed_date || new Date().toISOString().slice(0, 10);
  const billingTargets = resolveOrderBillingTargets(database, { entity_type, entity_id, billed_amount });

  const link = database.transaction(() => {
    const upsert = database.prepare(`
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

    const linked = billingTargets.map(target => {
      const order = database.prepare('SELECT id,order_num FROM orders WHERE id = ?').get(target.order_id) || {};
      const amount = money(target.billed_amount ?? billed_amount ?? 0);
      upsert.run(
        target.order_id,
        target.order_num || order.order_num || null,
        amount,
        billedDate,
        priorityRef,
        `Linked from ${entity_type} export ${entity_id}`,
        exported_by || 'exportEngine'
      );
      return {
        order_id: target.order_id,
        order_num: target.order_num || order.order_num || null,
        billed_amount: amount,
        priority_ref: priorityRef,
      };
    });

    return {
      entity_type,
      entity_id: Number(entity_id),
      priority_ref: priorityRef,
      billed_date: billedDate,
      linked_count: linked.length,
      linked_amount: money(linked.reduce((total, row) => total + Number(row.billed_amount || 0), 0)),
      linked_orders: linked,
    };
  });

  return link();
}

module.exports = {
  buildInvoiceExportPayload,
  buildDeliveryNoteExportPayload,
  exportAsJson,
  exportAsCsv,
  exportAsFormat,
  recordExportLog,
  linkExportToOrderBilling,
  ensureExportLogSchema,
  normalizeDestination,
  normalizeFormat,
};
