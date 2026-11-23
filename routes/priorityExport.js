const { Router } = require('express');
const {
  buildInvoiceExportPayload,
  buildDeliveryNoteExportPayload,
  exportAsJson,
  exportAsCsv,
  recordExportLog,
} = require('../services/exportEngine');

function required(name, value) {
  if (!value) throw new Error(`routes/priorityExport missing dependency: ${name}`);
  return value;
}

function exportedBy(req) {
  const id = Number(req.auth?.sub || req.user?.id || req.userId || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function filenameSafe(value) {
  return String(value || 'priority-export').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function recordExport(db, req, payload, format) {
  return recordExportLog(db, {
    entity_type: payload.documentType,
    entity_id: payload.sourceId,
    export_format: format,
    payload,
    status: 'exported',
    destination: payload.destination || req.query.destination || 'priority',
    external_ref: payload.destinationRefs?.existingDocumentRef || null,
    exported_by: exportedBy(req),
    exported_at: new Date().toISOString(),
  });
}

function recordSendAttempt(db, req, payload, { status, externalRef = null, errorMessage = null } = {}) {
  return recordExportLog(db, {
    entity_type: payload.documentType,
    entity_id: payload.sourceId,
    export_format: 'api',
    payload,
    status,
    destination: 'priority',
    external_ref: externalRef,
    error_message: errorMessage,
    exported_by: exportedBy(req),
    exported_at: status === 'draft' ? null : new Date().toISOString(),
  });
}

async function sendPriorityExport({ PRIORITY_ENABLED, payload }) {
  if (!PRIORITY_ENABLED) {
    return {
      sent: false,
      status: 'draft',
      code: 'priority_disabled',
      message: 'Priority export is disabled. Payload was prepared and saved as draft.',
    };
  }

  return {
    sent: false,
    status: 'failed',
    code: 'priority_send_not_implemented',
    message: 'Priority API send is not implemented yet for export engine.',
    payload,
  };
}

function sendStatusCode(result) {
  if (result.code === 'priority_send_not_implemented') return 501;
  return 200;
}
module.exports = function createPriorityExportRouter(deps) {
  const router = Router();
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const PRIORITY_ENABLED = Boolean(deps.PRIORITY_ENABLED);
  const exportRoles = ['finance', 'manager', 'admin'];

  router.post('/priority/export/invoices/:id/send', requireAnyRole(exportRoles), async (req, res, next) => {
    try {
      const payload = buildInvoiceExportPayload(db, { invoice_id: req.params.id, destination: 'priority' });
      const result = await sendPriorityExport({ PRIORITY_ENABLED, payload });
      const log = recordSendAttempt(db, req, payload, {
        status: result.status,
        externalRef: result.priorityRef || result.externalRef || null,
        errorMessage: result.status === 'failed' ? result.message : null,
      });
      res.status(sendStatusCode(result)).json({
        success: result.sent === true,
        ...result,
        exportLog: log,
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });

  router.post('/priority/export/delivery-notes/:id/send', requireAnyRole(exportRoles), async (req, res, next) => {
    try {
      const payload = buildDeliveryNoteExportPayload(db, { delivery_note_id: req.params.id, destination: 'priority' });
      const result = await sendPriorityExport({ PRIORITY_ENABLED, payload });
      const log = recordSendAttempt(db, req, payload, {
        status: result.status,
        externalRef: result.priorityRef || result.externalRef || null,
        errorMessage: result.status === 'failed' ? result.message : null,
      });
      res.status(sendStatusCode(result)).json({
        success: result.sent === true,
        ...result,
        exportLog: log,
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });
  router.get('/priority/export/invoices/:id.json', requireAnyRole(exportRoles), (req, res, next) => {
    try {
      const payload = buildInvoiceExportPayload(db, { invoice_id: req.params.id, destination: req.query.destination || 'priority' });
      const log = recordExport(db, req, payload, 'json');
      res.type('application/json').send(exportAsJson({ ...payload, exportLog: log }));
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });

  router.get('/priority/export/invoices/:id.csv', requireAnyRole(exportRoles), (req, res, next) => {
    try {
      const payload = buildInvoiceExportPayload(db, { invoice_id: req.params.id, destination: req.query.destination || 'priority' });
      const log = recordExport(db, req, payload, 'csv');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe(payload.sourceRef)}.csv"`);
      res.send(exportAsCsv({ ...payload, exportLog: log }));
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });

  router.get('/priority/export/delivery-notes/:id.json', requireAnyRole(exportRoles), (req, res, next) => {
    try {
      const payload = buildDeliveryNoteExportPayload(db, { delivery_note_id: req.params.id, destination: req.query.destination || 'priority' });
      const log = recordExport(db, req, payload, 'json');
      res.type('application/json').send(exportAsJson({ ...payload, exportLog: log }));
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });

  router.get('/priority/export/delivery-notes/:id.csv', requireAnyRole(exportRoles), (req, res, next) => {
    try {
      const payload = buildDeliveryNoteExportPayload(db, { delivery_note_id: req.params.id, destination: req.query.destination || 'priority' });
      const log = recordExport(db, req, payload, 'csv');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe(payload.sourceRef)}.csv"`);
      res.send(exportAsCsv({ ...payload, exportLog: log }));
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      return next(err);
    }
  });

  return router;
};

module.exports.manifest = {
  id: 'priority-export',
  label: 'Priority Export',
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit', manager: 'edit', finance: 'edit' } },
  consumes: [
    { table: 'invoices' },
    { table: 'delivery_notes' },
    { table: 'customers' },
    { table: 'orders' },
  ],
  produces: [{ table: 'export_log' }],
};
