'use strict';

const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/qrAccess missing dependency: ${name}`);
  return value;
}

module.exports = function createQrAccessRouter(deps) {
  const qrAccess = required('qrAccess', deps.qrAccess);
  const requireRole = required('requireRole', deps.requireRole);
  const auditLog = required('auditLog', deps.auditLog);

  router.get('/qr-access/mode', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const mode = qrAccess.mode();
    res.json({ mode, open: mode === 'open', secure: mode === 'secure' });
  });

  router.patch('/qr-access/mode', requireRole('admin'), (req, res) => {
    const before = qrAccess.mode();
    try {
      const mode = qrAccess.setMode(req.body?.mode, Number(req.auth?.sub) || null);
      auditLog('qr_access', null, 'QR_ACCESS_MODE', 'update', 'mode', before, mode,
        'מצב סריקת QR', Number(req.auth?.sub) || null, String(req.auth?.display_name || '').trim() || null);
      res.json({ mode, open: mode === 'open', secure: mode === 'secure' });
    } catch (error) {
      res.status(Number(error.status) || 400).json({ error: error.message || 'invalid_qr_access_mode' });
    }
  });

  router.get('/qr-access/activity', requireRole('admin'), (req, res) => {
    res.json(qrAccess.listActivity(req.query?.limit));
  });

  router.post('/qr-access/scan', (req, res) => {
    const kind = String(req.body?.kind || '').trim().toLowerCase();
    const permission = kind === 'order' ? 'warehouse' : kind === 'card' ? 'production' : '';
    const value = String(req.body?.value || '').trim();
    const orderId = Number(req.body?.order_id);
    if (!permission || !value || value.length > 512 || (kind === 'order' && (!Number.isInteger(orderId) || orderId <= 0))) {
      return res.status(400).json({ error: 'invalid_qr_scan' });
    }
    const grant = qrAccess.authorize(req, permission);
    if (!grant.ok) {
      qrAccess.record(req, { permission, kind, value, action: 'open', outcome: grant.error, scannerId: req.body?.scanner_id });
      return res.status(grant.status).json({ error: grant.error, mode: grant.mode, device_status: grant.device_status || 'unregistered' });
    }
    const target = kind === 'order'
      ? `/warehouse.html?load_order=${encodeURIComponent(orderId)}&autostart=1&source=in_app_scan`
      : `/worker-visual.html?scan=1&card=${encodeURIComponent(value)}&source=in_app_scan`;
    qrAccess.record(req, { permission, kind, value, action: kind === 'order' ? 'open_loading' : 'open_worker_card', scannerId: req.body?.scanner_id });
    res.json({ allowed: true, mode: grant.mode, target });
  });

  return router;
};

module.exports.manifest = {
  id: 'qr-access',
  label: 'סריקת QR',
  screens: [{ id: 'scanner', path: '/scan.html', label: 'סריקת QR', icon: '📷', group: 'תפעול' }],
  access: { default: 'read', roles: {} },
  consumes: [{ table: 'device_enrollment_requests' }],
  produces: [{ table: 'qr_scan_activity' }],
};
