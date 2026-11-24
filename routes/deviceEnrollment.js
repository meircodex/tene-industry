const { Router } = require('express');

const REVIEW_STATUSES = new Set(['approved', 'rejected', 'revoked']);

function required(name, value) {
  if (!value) throw new Error(`routes/deviceEnrollment missing dependency: ${name}`);
  return value;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function publicDevice(row) {
  if (!row) return { registered: false, status: 'unregistered', approved: false };
  return {
    registered: true,
    approved: row.status === 'approved',
    id: row.id,
    request_uid: row.request_uid,
    requester_name: row.requester_name,
    device_name: row.device_name,
    platform: row.platform,
    status: row.status,
    requested_at: row.requested_at,
    reviewed_at: row.reviewed_at,
    reviewed_by_name: row.reviewed_by_name,
    last_seen_at: row.last_seen_at,
  };
}

module.exports = function createDeviceEnrollmentRouter(deps) {
  const router = Router();
  const getDb = required('getDb', deps.getDb);
  const requireRole = required('requireRole', deps.requireRole);
  const deviceEnrollment = required('deviceEnrollment', deps.deviceEnrollment);
  const enrollmentLimiter = required('enrollmentLimiter', deps.enrollmentLimiter);
  const auditLog = required('auditLog', deps.auditLog);
  const allowUninvitedEnrollment = deps.allowUninvitedEnrollment === true;

  router.post('/device-enrollment/requests', enrollmentLimiter, (req, res) => {
    if (!allowUninvitedEnrollment) {
      return res.status(403).json({
        error: 'worker_invitation_required',
        code: 'worker_invitation_required',
      });
    }
    const requesterName = cleanText(req.body?.requester_name, 80);
    const deviceName = cleanText(req.body?.device_name, 100);
    const platform = cleanText(req.body?.platform, 160);
    if (requesterName.length < 2 || deviceName.length < 2) {
      return res.status(400).json({ error: 'requester_name_and_device_name_required' });
    }

    const current = deviceEnrollment.statusForRequest(req);
    if (current && ['pending', 'approved'].includes(current.status)) {
      return res.status(current.status === 'pending' ? 202 : 200).json(publicDevice(current));
    }

    const created = deviceEnrollment.createPendingEnrollment({
      requesterName,
      deviceName,
      platform: platform || null,
      userAgent: cleanText(req.get('user-agent'), 500) || null,
      ipAddress: cleanText(req.ip, 100) || null,
    });
    res.status(201).json({ ...publicDevice(created.row), credential: created.credential });
  });

  router.get('/device-enrollment/status', (req, res) => {
    res.json(publicDevice(deviceEnrollment.statusForRequest(req)));
  });

  router.get('/device-enrollment/requests', requireRole('admin'), (req, res) => {
    const status = cleanText(req.query?.status, 20);
    const params = [];
    let sql = `
      SELECT d.id,d.request_uid,d.requester_name,d.device_name,d.platform,d.status,d.requested_at,
             d.reviewed_at,d.reviewed_by,d.reviewed_by_name,d.last_seen_at,d.requester_user_id,d.invitation_id,
             d.worker_role,d.permissions_json,
             u.username AS requester_username,u.active AS requester_user_active
      FROM device_enrollment_requests d
      LEFT JOIN users u ON u.id=d.requester_user_id
    `;
    if (status && ['pending', 'approved', 'rejected', 'revoked'].includes(status)) {
      sql += ' WHERE d.status=?';
      params.push(status);
    }
    sql += " ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.requested_at DESC";
    res.json(getDb().prepare(sql).all(...params));
  });

  router.patch('/device-enrollment/requests/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const status = cleanText(req.body?.status, 20);
    if (!Number.isInteger(id) || id <= 0 || !REVIEW_STATUSES.has(status)) {
      return res.status(400).json({ error: 'invalid_device_review' });
    }
    const db = getDb();
    const before = db.prepare('SELECT * FROM device_enrollment_requests WHERE id=?').get(id);
    if (!before) return res.status(404).json({ error: 'device_request_not_found' });

    const reviewerId = Number(req.auth?.sub) || null;
    const reviewerName = cleanText(req.auth?.display_name, 100) || null;
    db.transaction(() => {
      db.prepare(`
        UPDATE device_enrollment_requests
        SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,reviewed_by_name=?
        WHERE id=?
      `).run(status, reviewerId, reviewerName, id);
      // A user created through a personal invitation is deliberately inactive
      // until this exact device is approved by an administrator.
      if (status === 'approved' && before.invitation_id && before.requester_user_id) {
        db.prepare('UPDATE users SET active=1 WHERE id=?').run(before.requester_user_id);
      }
    })();
    auditLog(
      'device_enrollment', id, before.request_uid, 'device_review', 'status', before.status, status,
      `${before.requester_name} · ${before.device_name}`, reviewerId, reviewerName,
    );
    res.json(publicDevice(db.prepare('SELECT * FROM device_enrollment_requests WHERE id=?').get(id)));
  });

  return router;
};

module.exports.manifest = {
  id: 'device-enrollment',
  label: 'אישור מכשירי סריקה',
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  consumes: [{ table: 'device_enrollment_requests' }, { table: 'users' }],
  produces: [],
};
