'use strict';

const ACCESS_MODE_KEY = 'QR_ACCESS_MODE';
const ACCESS_MODES = new Set(['open', 'secure']);
const QR_PERMISSIONS = new Set(['production', 'warehouse']);

const ROLE_PERMISSIONS = {
  production: ['production'],
  kiosk: ['production'],
  quality: ['production'],
  maintenance: ['production'],
  warehouse: ['warehouse'],
  driver: ['warehouse'],
  manager: ['production', 'warehouse'],
  admin: ['production', 'warehouse'],
};

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(permission => QR_PERMISSIONS.has(permission)) : [];
  } catch {
    return [];
  }
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

function createQrAccessService({ db, settingsService, deviceEnrollment }) {
  if (!db || !settingsService || !deviceEnrollment) throw new Error('QR access requires db, settings and device enrollment');

  db.exec(`
    CREATE TABLE IF NOT EXISTS qr_scan_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_mode TEXT NOT NULL,
      permission TEXT NOT NULL,
      qr_kind TEXT NOT NULL,
      qr_value TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_name TEXT,
      actor_phone TEXT,
      device_enrollment_id INTEGER,
      device_name TEXT,
      scanner_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(device_enrollment_id) REFERENCES device_enrollment_requests(id)
    );
    CREATE INDEX IF NOT EXISTS idx_qr_scan_activity_occurred ON qr_scan_activity(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_qr_scan_activity_device ON qr_scan_activity(device_enrollment_id,occurred_at DESC);
  `);

  function mode() {
    const configured = cleanText(settingsService.get(ACCESS_MODE_KEY, 'open'), 20).toLowerCase();
    return ACCESS_MODES.has(configured) ? configured : 'open';
  }

  function setMode(value, updatedBy = null) {
    const next = typeof value === 'string' ? cleanText(value, 20).toLowerCase() : '';
    if (!ACCESS_MODES.has(next)) throw Object.assign(new Error('invalid_qr_access_mode'), { status: 400 });
    settingsService.set(ACCESS_MODE_KEY, next, { updatedBy });
    return next;
  }

  function invitationFor(device) {
    if (!device?.invitation_id) return null;
    const invite=db.prepare('SELECT worker_name,phone,role,permissions_json,worker_profile_id FROM worker_invitations WHERE id=?').get(device.invitation_id);
    if(!invite)return null;
    const profile=invite.worker_profile_id?db.prepare('SELECT id,worker_name,phone,role,permissions_json,active FROM worker_qr_profiles WHERE id=?').get(invite.worker_profile_id):null;
    return profile?{...invite,...profile,worker_profile_id:profile.id}:invite;
  }

  function allowedPermissions(req, device, invitation) {
    if(invitation?.worker_profile_id)return parsePermissions(invitation.permissions_json);
    const explicit = parsePermissions(device?.permissions_json);
    if (explicit.length) return explicit;
    const invited = parsePermissions(invitation?.permissions_json);
    if (invited.length) return invited;
    const role = cleanText(device?.worker_role || invitation?.role || req.auth?.role, 40).toLowerCase();
    return ROLE_PERMISSIONS[role] || [];
  }

  function authorize(req, permission) {
    if (!QR_PERMISSIONS.has(permission)) return { ok: false, status: 400, error: 'invalid_qr_permission' };
    const accessMode = mode();
    const device = deviceEnrollment.statusForRequest(req);
    const invitation = invitationFor(device);
    if(accessMode==='open'&&(!device||device.status!=='approved')){
      const grant={mode:accessMode,permission,actor_name:cleanText(req.auth?.display_name,120)||'סריקה פתוחה',device:null,invitation:null};req.qrAccess=grant;return {ok:true,...grant};
    }
    if (device) {
      req.qrAccess = {
        mode: accessMode,
        permission,
        actor_name: invitation?.worker_name || device.requester_name || cleanText(req.auth?.display_name,120),
        actor_phone: invitation?.phone || null,
        device,
        invitation,
      };
    }
    if (!device || device.status !== 'approved') {
      return {
        ok: false,
        status: 403,
        error: 'device_activation_required',
        device_status: device?.status || 'unregistered',
        mode: accessMode,
      };
    }
    if(invitation?.active===0)return {ok:false,status:403,error:'worker_disabled',mode:accessMode,device_status:device.status};
    if (!allowedPermissions(req, device, invitation).includes(permission)) {
      return { ok: false, status: 403, error: 'qr_permission_denied', mode: accessMode, device_status: device.status };
    }

    db.prepare(`
      UPDATE device_enrollment_requests SET last_seen_at=CURRENT_TIMESTAMP
      WHERE id=? AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-5 minutes'))
    `).run(device.id);
    const grant = req.qrAccess;
    req.approvedDevice = device;
    req.qrAccess = grant;
    return { ok: true, ...grant };
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      const result = authorize(req, permission);
      if (!result.ok) return res.status(result.status).json({
        error: result.error,
        code: result.error,
        mode: result.mode || mode(),
        device_status: result.device_status || 'unregistered',
      });
      next();
    };
  }

  function record(req, { permission, kind, value = null, action, outcome = 'allowed', scannerId = null }) {
    const grant = req.qrAccess || {};
    const device = grant.device || req.approvedDevice || null;
    return db.prepare(`
      INSERT INTO qr_scan_activity
        (access_mode,permission,qr_kind,qr_value,action,outcome,actor_name,actor_phone,
         device_enrollment_id,device_name,scanner_id,ip_address,user_agent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      grant.mode || mode(), permission, kind, cleanText(value, 512) || null, cleanText(action, 80), cleanText(outcome, 40),
      grant.actor_name || (mode() === 'open' ? 'סריקה פתוחה' : null), grant.actor_phone || null,
      device?.id || null, device?.device_name || null, cleanText(scannerId, 100) || null,
      cleanText(req.ip, 100) || null, cleanText(req.get?.('user-agent'), 500) || null,
    );
  }

  function listActivity(limit = 200) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    return db.prepare(`
      SELECT id,access_mode,permission,qr_kind,qr_value,action,outcome,actor_name,actor_phone,
             device_enrollment_id,device_name,scanner_id,occurred_at
      FROM qr_scan_activity
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit);
  }

  return { authorize, listActivity, mode, record, requirePermission, setMode };
}

module.exports = { ACCESS_MODE_KEY, QR_PERMISSIONS, createQrAccessService };
