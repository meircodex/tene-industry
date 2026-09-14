'use strict';

const { randomUUID } = require('node:crypto');
const { validateCustomerTaxId, normalizeCustomerTaxId, findCustomersByTaxId, customerIdentityError, mergedCustomerId } = require('./customerIdentity');

function required(name, value) {
  if (!value) throw new Error(`services/orderQuotes missing dependency: ${name}`);
  return value;
}

function parseJsonObject(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function quotePayloadError(payload = {}) {
  if (!payload || typeof payload !== 'object') return 'quote payload is required';
  if (!String(payload.customer?.name || '').trim()) return 'customer.name is required';
  if (!Array.isArray(payload.pallets) || !payload.pallets.some(pallet => Array.isArray(pallet?.items) && pallet.items.length)) {
    return 'At least one quote item is required';
  }
  return null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pricingTotal(snapshot) {
  const value = numeric(snapshot?.totals?.total ?? snapshot?.total ?? snapshot?.total_price);
  return Number(value.toFixed(2));
}

function quoteSummaryRow(row = {}) {
  return {
    ...row,
    pricing_snapshot: parseJsonObject(row.pricing_snapshot_json, null),
    payload: parseJsonObject(row.payload_json, null),
  };
}

function createOrderQuoteService(db, deps = {}) {
  required('db', db);
  const createOrderFromPayload = required('createOrderFromPayload', deps.createOrderFromPayload);

  function createQuote({ payload, pricingSnapshot = null, createdBy = null } = {}) {
    const validationError = quotePayloadError(payload);
    if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 });

    let customer = payload.customer || {};
    let customerId = Number(customer.id || 0) || null;
    const canonicalId = customerId ? mergedCustomerId(db, customerId) : null;
    if (canonicalId) {
      const canonical = db.prepare('SELECT id,name,tax_id FROM customers WHERE id=?').get(canonicalId);
      customerId = canonical.id;
      customer = { ...customer, id: customerId, name: canonical.name, taxId: customer.taxId || customer.tax_id || canonical.tax_id };
      payload = { ...payload, customer };
    }
    const taxId = validateCustomerTaxId(customer.taxId ?? customer.tax_id);
    if (taxId) {
      const matches = findCustomersByTaxId(db, taxId);
      if (matches.length > 1) throw customerIdentityError('ambiguous_customer_tax_id', 'ח.פ זה מופיע בכמה כרטיסים. יש לבדוק את הכפילות לפני פתיחת הצעה.', 409);
      const selected = customerId ? db.prepare('SELECT id,name,tax_id FROM customers WHERE id=?').get(customerId) : null;
      if (customerId && !selected) throw customerIdentityError('customer_not_found', 'כרטיס הלקוח שנבחר לא נמצא', 404);
      if (selected && ((normalizeCustomerTaxId(selected.tax_id) && normalizeCustomerTaxId(selected.tax_id) !== taxId) || (matches[0] && matches[0].id !== customerId))) {
        throw customerIdentityError('customer_tax_id_mismatch', 'הח.פ אינו תואם לכרטיס הלקוח שנבחר', 409);
      }
      const existing = selected || matches[0];
      customerId = existing?.id || null;
      customer = { ...customer, id: customerId, name: existing?.name || customer.name, taxId };
      payload = { ...payload, customer };
    }
    const totalWeight = numeric(payload.order?.totalWeight);
    const snapshot = parseJsonObject(pricingSnapshot, pricingSnapshot && typeof pricingSnapshot === 'object' ? pricingSnapshot : null);
    const temporaryNum = `QT-PENDING-${randomUUID()}`;
    const created = db.prepare(`
      INSERT INTO order_quotes
        (quote_num,status,customer_id,customer_name,customer_phone,customer_email,payload_json,pricing_snapshot_json,total_weight,total_price,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      temporaryNum,
      'pending_approval',
      customerId,
      String(customer.name || '').trim(),
      String(customer.phone || '').trim() || null,
      String(customer.email || '').trim() || null,
      JSON.stringify(payload),
      snapshot ? JSON.stringify(snapshot) : null,
      totalWeight,
      pricingTotal(snapshot),
      createdBy || null,
    );
    const id = Number(created.lastInsertRowid);
    const quoteNum = `QT-${String(id).padStart(6, '0')}`;
    db.prepare('UPDATE order_quotes SET quote_num=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(quoteNum, id);
    return quoteSummaryRow(db.prepare('SELECT * FROM order_quotes WHERE id=?').get(id));
  }

  function listQuotes({ status = null } = {}) {
    const statuses = new Set(['draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'converted']);
    const where = statuses.has(String(status || '')) ? 'WHERE q.status=?' : '';
    const params = where ? [String(status)] : [];
    const rows = db.prepare(`
      SELECT q.*, COALESCE(c.name, q.customer_name) AS resolved_customer_name,
             o.order_num AS converted_order_num
      FROM order_quotes q
      LEFT JOIN customers c ON c.id=q.customer_id
      LEFT JOIN orders o ON o.id=q.converted_order_id
      ${where}
      ORDER BY CASE q.status WHEN 'pending_approval' THEN 0 ELSE 1 END, q.created_at DESC, q.id DESC
    `).all(...params);
    return rows.map(quoteSummaryRow);
  }

  function getQuote(id) {
    const row = db.prepare(`
      SELECT q.*, COALESCE(c.name, q.customer_name) AS resolved_customer_name,
             o.order_num AS converted_order_num
      FROM order_quotes q
      LEFT JOIN customers c ON c.id=q.customer_id
      LEFT JOIN orders o ON o.id=q.converted_order_id
      WHERE q.id=?
    `).get(Number(id));
    return row ? quoteSummaryRow(row) : null;
  }

  function approveQuote({ quoteId, approvedBy = null } = {}) {
    const quote = getQuote(quoteId);
    if (!quote) throw Object.assign(new Error('הצעת מחיר לא נמצאה'), { statusCode: 404 });
    if (quote.status === 'converted' && quote.converted_order_id) {
      return {
        success: true,
        alreadyConverted: true,
        quote,
        orderId: Number(quote.converted_order_id),
        orderNum: quote.converted_order_num || null,
      };
    }
    if (!['draft', 'pending_approval', 'approved'].includes(quote.status)) {
      throw Object.assign(new Error('לא ניתן לאשר הצעת מחיר במצב הנוכחי'), { statusCode: 409 });
    }

    const payload = quote.payload;
    const validationError = quotePayloadError(payload);
    if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 });
    const originalNotes = String(payload.order?.generalNotes || '').trim();
    const quoteReference = `מקור: הצעת מחיר ${quote.quote_num}`;
    payload.order = {
      ...(payload.order || {}),
      quoteId: quote.id,
      quoteNum: quote.quote_num,
      quoteTotal: quote.total_price,
      createdBy: approvedBy || payload.order?.createdBy || null,
      generalNotes: originalNotes ? `${originalNotes} | ${quoteReference}` : quoteReference,
    };

    const created = createOrderFromPayload(payload);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE order_quotes
      SET status='converted', approved_by=?, approved_at=?, converted_order_id=?, updated_at=?
      WHERE id=? AND status IN ('draft','pending_approval','approved')
    `).run(approvedBy || null, now, created.orderId, now, quote.id);

    const updated = getQuote(quote.id);
    return { success: true, quote: updated, orderId: created.orderId, orderNum: created.orderNum, created };
  }

  return {
    createQuoteTransaction: db.transaction(createQuote),
    approveQuoteTransaction: db.transaction(approveQuote),
    listQuotes,
    getQuote,
  };
}

module.exports = { createOrderQuoteService, quotePayloadError };
