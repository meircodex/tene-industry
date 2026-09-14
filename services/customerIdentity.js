'use strict';

// Keep identifiers as text so leading zeroes are never lost. This validates the
// local format only; it does not claim to verify a company with an external registry.
function normalizeCustomerTaxId(value) {
  return value == null ? '' : String(value).replace(/[ \t\r\n\u00a0\u200e\u200f-]/g, '');
}

function customerIdentityError(code, message, statusCode = 400, customer = null) {
  return Object.assign(new Error(message), { code, statusCode, customer });
}

function validateCustomerTaxId(value, { required = false } = {}) {
  const taxId = normalizeCustomerTaxId(value);
  if (!taxId && !required) return null;
  if (!taxId) throw customerIdentityError('customer_tax_id_required', 'יש להזין ח.פ / מספר עוסק ללקוח חדש');
  if (!/^[0-9]{9}$/.test(taxId) || taxId === '000000000') {
    throw customerIdentityError('invalid_customer_tax_id', 'ח.פ / מספר עוסק חייב להכיל 9 ספרות');
  }
  return taxId;
}

// Column expressions are internal constants, never user input.
function customerTaxIdSql(column = 'tax_id') {
  let expression = `COALESCE(${column},'')`;
  for (const code of [32, 9, 13, 10, 160, 8206, 8207, 45]) {
    expression = `REPLACE(${expression},char(${code}),'')`;
  }
  return expression;
}

function findCustomersByTaxId(db, value, excludeId = 0) {
  const taxId = normalizeCustomerTaxId(value);
  if (!taxId) return [];
  return db.prepare(`SELECT id,name,tax_id FROM customers WHERE ${customerTaxIdSql()}=? AND id<>? ORDER BY id`)
    .all(taxId, Number(excludeId) || 0);
}

function assertCustomerTaxIdAvailable(db, taxId, excludeId = 0) {
  const existing = findCustomersByTaxId(db, taxId, excludeId)[0];
  if (existing) {
    throw customerIdentityError('duplicate_customer_tax_id', `ח.פ זה כבר משויך ללקוח ${existing.name} (מספר ${existing.id}). יש להשתמש בכרטיס הקיים.`, 409, existing);
  }
}

function mergedCustomerId(db, id) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_merge_archive'").get()) return null;
  return db.prepare('SELECT target_customer_id FROM customer_merge_archive WHERE old_customer_id=?').get(id)?.target_customer_id || null;
}

function ensureCustomerIdentityConstraints(db) {
  const current = customerTaxIdSql();
  const incoming = customerTaxIdSql('NEW.tax_id');
  // A unique index would prevent startup when legacy duplicates already exist.
  // These guards preserve legacy rows, but reject every new conflicting identity.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_tax_id_normalized ON customers (${current});
    CREATE TRIGGER IF NOT EXISTS customers_tax_id_insert_guard
    BEFORE INSERT ON customers
    WHEN ${incoming}<>'' AND EXISTS (SELECT 1 FROM customers WHERE ${current}=${incoming})
    BEGIN SELECT RAISE(ABORT, 'duplicate_customer_tax_id'); END;
    CREATE TRIGGER IF NOT EXISTS customers_tax_id_update_guard
    BEFORE UPDATE OF tax_id ON customers
    WHEN ${incoming}<>'' AND ${incoming}<>${customerTaxIdSql('OLD.tax_id')}
      AND EXISTS (SELECT 1 FROM customers WHERE id<>NEW.id AND ${current}=${incoming})
    BEGIN SELECT RAISE(ABORT, 'duplicate_customer_tax_id'); END;
  `);
}

module.exports = {
  normalizeCustomerTaxId, validateCustomerTaxId, customerTaxIdSql,
  customerIdentityError, findCustomersByTaxId, assertCustomerTaxIdAvailable,
  ensureCustomerIdentityConstraints,
  mergedCustomerId,
};
