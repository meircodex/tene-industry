const messages = require('../public/user-messages');

function displayContext(req, body) {
  const d = body.details && typeof body.details === 'object' ? body.details : {};
  const positive = v => /^\d{1,12}$/.test(String(v ?? '')) && Number(v) > 0 ? String(v) : null;
  const parts = [];
  const orderId = positive(req.params?.orderId || (/^\/api\/orders\//.test(req.originalUrl || req.path) ? req.params?.id : null));
  if (orderId) parts.push('הזמנה מספר ' + orderId);
  const sequence = positive(d.item_sequence);
  const itemId = positive(d.item_id || req.params?.itemId);
  if (sequence) parts.push('שורת פריט ' + sequence);
  else if (itemId) parts.push('פריט מספר ' + itemId);
  const ids = Array.isArray(d.item_ids) ? d.item_ids.map(positive).filter(Boolean).slice(0, 20) : [];
  if (ids.length) parts.push('פריטים מספר ' + ids.join(', '));
  if (d.field === 'preferred_raw_material_id' && /^-?\d{1,12}(?:\.\d{1,3})?$/.test(String(d.value))) {
    parts.push('מנת מלאי שנבחרה: ' + d.value);
  }
  if (Number.isFinite(d.effective_produced_qty)) parts.push('כמות הייצור הרשומה: ' + d.effective_produced_qty);
  if (body.error === 'produced_qty_exceeds_quantity' && Number.isFinite(body.quantity)) parts.push('הכמות המותרת בפריט: ' + body.quantity + ' יחידות');
  return parts.length ? parts.join(' · ') + '. ' : '';
}

// Add presentation text; error/code/status remain the API's machine contract.
function attachResponseMessages(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string' && body.error) {
      const missingLabels = {machineId:'מכונה',diameter:'קוטר הברזל במילימטרים',qty:'כמות יחידות',totalLengthMm:'אורך הפריט במילימטרים',qrData:'קוד כרטיס העבודה'};
      const missing = Array.isArray(body.details?.missing_fields) ? body.details.missing_fields.map(field=>missingLabels[field]).filter(Boolean) : [];
      body.user_message = displayContext(req, body) + (missing.length ? 'לא הוזנו: '+missing.join(', ')+'. יש להשלים את השדות האלה לפני המשך הפעולה.' : messages.text(body.error, {
        status: res.statusCode, path: req.path, method: req.method, requestId: req.requestId,
      }));
      if (res.statusCode >= 500 || /SQLITE|constraint failed|database is locked/i.test(body.error)) {
        // No payload, query string, token, filesystem path or upstream response in logs.
        const safeConstraint = /^(?:(?:FOREIGN KEY|UNIQUE|NOT NULL|CHECK) constraint failed(?:: [a-zA-Z0-9_., ]+)?|SQLITE_[A-Z_]+|database is locked)$/;
        const code = messages.isKnownCode(body.error) || safeConstraint.test(body.error) ? body.error : 'internal_error';
        console.error('[request-error]', JSON.stringify({ requestId: req.requestId, method: req.method,
          route: req.route?.path || 'unmatched', status: res.statusCode, code }));
      }
    }
    return json(body);
  };
  next();
}

function apiErrorHandler(error, req, res, next) {
  if (!req.path.startsWith('/api/') || res.headersSent) return next(error);
  const status = error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE' ? 413
    : error.type === 'entity.parse.failed' ? 400
      : Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  const code = status === 413 ? 'request_too_large' : error.type === 'entity.parse.failed'
    ? 'invalid_request_json' : 'internal_server_error';
  res.status(status).json({ error: code });
}

module.exports = { attachResponseMessages, apiErrorHandler };
