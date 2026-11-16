const crypto = require('crypto');
const { sha256 } = require('../auth-core');

const DEVICE_HEADER = 'x-ironbend-device';
const APPROVED_STATUS = 'approved';

function createDeviceEnrollmentService({ getDb }) {
  if (typeof getDb !== 'function') throw new Error('device enrollment requires getDb');

  function credentialFromRequest(req) {
    return String(req.get(DEVICE_HEADER) || '').trim();
  }

  function findByCredential(credential) {
    const value = String(credential || '').trim();
    if (!value) return null;
    return getDb().prepare(`
      SELECT id,request_uid,requester_name,device_name,platform,status,worker_role,permissions_json,
             requester_user_id,invitation_id,requested_at,reviewed_at,reviewed_by,
             reviewed_by_name,last_seen_at
      FROM device_enrollment_requests
      WHERE credential_hash=?
    `).get(sha256(value)) || null;
  }

  function createEnrollment({
    requesterName,
    deviceName,
    platform = null,
    userAgent = null,
    ipAddress = null,
    requesterUserId = null,
    invitationId = null,
    workerRole = null,
    permissions = [],
    status = 'pending',
  }) {
    const requestUid = `DEV-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const secret = crypto.randomBytes(32).toString('base64url');
    const credential = `${requestUid}.${secret}`;
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO device_enrollment_requests
        (request_uid,credential_hash,requester_name,device_name,platform,status,user_agent,ip_address,
         requester_user_id,invitation_id,worker_role,permissions_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      requestUid,
      sha256(credential),
      requesterName,
      deviceName,
      platform || null,
      status,
      userAgent || null,
      ipAddress || null,
      requesterUserId || null,
      invitationId || null,
      workerRole || null,
      JSON.stringify(permissions),
    );
    return {
      credential,
      row: db.prepare('SELECT * FROM device_enrollment_requests WHERE id=?').get(result.lastInsertRowid),
    };
  }

  function createPendingEnrollment(options) {
    return createEnrollment({ ...options, status: 'pending' });
  }

  function createApprovedEnrollment(options) {
    return createEnrollment({ ...options, status: APPROVED_STATUS });
  }

  function statusForRequest(req) {
    return findByCredential(credentialFromRequest(req));
  }

  function requireApprovedDevice(req, res, next) {
    const device = statusForRequest(req);
    if (!device || device.status !== APPROVED_STATUS) {
      return res.status(403).json({
        error: 'device_approval_required',
        code: 'device_approval_required',
        device_status: device?.status || 'unregistered',
      });
    }

    req.approvedDevice = device;
    getDb().prepare(`
      UPDATE device_enrollment_requests
      SET last_seen_at=CURRENT_TIMESTAMP
      WHERE id=? AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-5 minutes'))
    `).run(device.id);
    next();
  }

  return {
    credentialFromRequest,
    createApprovedEnrollment,
    createPendingEnrollment,
    findByCredential,
    requireApprovedDevice,
    statusForRequest,
  };
}

module.exports = { APPROVED_STATUS, DEVICE_HEADER, createDeviceEnrollmentService };
