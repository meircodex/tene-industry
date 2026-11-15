'use strict';

const router = require('express').Router();
const QRCode = require('qrcode');
const { requestPublicBaseUrl } = require('../services/publicScanLinks');

const INVITABLE_ROLES = new Set(['production', 'warehouse', 'driver', 'quality', 'maintenance']);
const INVITABLE_PERMISSIONS = new Set(['production', 'warehouse']);
const DEFAULT_ROLE_PERMISSIONS = {
  production: ['production'], quality: ['production'], maintenance: ['production'],
  warehouse: ['warehouse'], driver: ['warehouse'],
};

function required(name, value) {
  if (!value) throw new Error(`routes/workerInvitations missing dependency: ${name}`);
  return value;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanPhone(value) {
  return String(value || '').trim().replace(/[^+\d -]/g, '').slice(0, 30);
}

function normalizePhone(value) {
  const digits = cleanPhone(value).replace(/\D/g, '');
  return digits.startsWith('972') ? `0${digits.slice(3)}` : digits;
}

function cleanPermissions(value, role) {
  const requested = Array.isArray(value) ? value : [];
  const permissions = [...new Set(requested.map(item => cleanText(item, 30)).filter(item => INVITABLE_PERMISSIONS.has(item)))];
  return permissions.length ? permissions : (DEFAULT_ROLE_PERMISSIONS[role] || []);
}

function activationUrl(req, token, settingsService) {
  const base = requestPublicBaseUrl(req, settingsService);
  if (!base) return '';
  return `${base}/worker-invite.html?token=${encodeURIComponent(token)}`;
}

function publicActivationError(row, workerInvitations) {
  const status = workerInvitations.effectiveStatus(row);
  if (status === 'expired') return { status: 410, error: 'invitation_expired' };
  if (status === 'cancelled') return { status: 410, error: 'invitation_cancelled' };
  if (status === 'claimed') return { status: 409, error: 'invitation_already_used' };
  return { status: 404, error: 'invitation_not_found' };
}

function publicWorkerProfile(row) {
  return {
    id: row.id,
    worker_name: row.worker_name,
    phone: row.phone,
    role: row.role,
    permissions: cleanPermissions(JSON.parse(row.permissions_json || '[]'), row.role),
    active: Boolean(row.active),
    portal_username:row.portal_username||null,portal_active:Boolean(row.portal_active&&row.active),portal_language:row.portal_language||null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    latest_invitation_status: row.latest_invitation_status || null,
    latest_invitation_at: row.latest_invitation_at || null,
    device_status: row.device_status || null,
    device_name: row.device_name || null,
  };
}

module.exports = function createWorkerInvitationsRouter(deps) {
  const getDb = required('getDb', deps.getDb);
  const authService=required('authService',deps.authService);
  const portal=require('../services/workerPortalAccounts');portal.ensureSchema(getDb());
  const requireRole = required('requireRole', deps.requireRole);
  const deviceEnrollment = required('deviceEnrollment', deps.deviceEnrollment);
  const workerInvitations = required('workerInvitations', deps.workerInvitations);
  const activationLimiter = required('activationLimiter', deps.activationLimiter);
  const auditLog = required('auditLog', deps.auditLog);
  const settingsService = deps.settingsService || null;

  function workerDetails(body) {
    const workerName = cleanText(body?.worker_name, 100);
    const phone = cleanPhone(body?.phone);
    const phoneNormalized = normalizePhone(phone);
    const role = cleanText(body?.role, 40) || 'production';
    const permissions = cleanPermissions(body?.permissions, role);
    const valid = workerName.length >= 2 && phoneNormalized.length >= 9
      && INVITABLE_ROLES.has(role) && permissions.length > 0;
    return { workerName, phone, phoneNormalized, role, permissions, valid };
  }

  async function createInvitationResponse(req, res, details, workerProfileId = null) {
    const created = workerInvitations.create({
      workerName: details.workerName,
      phone: details.phone,
      role: details.role,
      permissions: details.permissions,
      workerProfileId,
      createdBy: Number(req.auth?.sub) || null,
      createdByName: cleanText(req.auth?.display_name, 100) || null,
    });
    const url = activationUrl(req, created.token, settingsService);
    let activationQr = '';
    try {
      activationQr = url ? await QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: 'M' }) : '';
    } catch (_) {
      // The one-time link remains usable even if image generation is
      // temporarily unavailable; the admin can still copy it to WhatsApp.
    }
    auditLog(
      'worker_invitation', created.row.id, created.row.invitation_uid, 'create', 'status', null, 'pending',
      `${details.workerName} · ${details.role}`, Number(req.auth?.sub) || null, cleanText(req.auth?.display_name, 100) || null,
    );
    return res.status(201).json({
      invitation: {
        id: created.row.id,
        invitation_uid: created.row.invitation_uid,
        worker_profile_id: created.row.worker_profile_id,
        worker_name: created.row.worker_name,
        phone: created.row.phone,
        role: created.row.role,
        permissions: details.permissions,
        status: created.row.status,
        expires_at: created.row.expires_at,
      },
      activation_url: url,
      activation_qr_data_url: activationQr,
      whatsapp_message: url
        ? `שלום ${details.workerName}, זהו קישור אישי להפעלת אפליקציית העובדים של טנא. הקישור תקף ל־15 דקות: ${url}`
        : '',
    });
  }

  router.get('/worker-profiles/:id/portal-account',requireRole('admin'),(req,res)=>{
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_worker_profile'});
    const db=getDb(),link=db.prepare('SELECT user_id FROM worker_portal_accounts WHERE profile_id=?').get(id);
    if(!db.prepare('SELECT id FROM worker_qr_profiles WHERE id=?').get(id))return res.status(404).json({error:'worker_profile_not_found'});
    res.set('Cache-Control','no-store');res.json({account:link?portal.publicAccount(portal.accountForUser(db,link.user_id)):null,portal_url:'/worker-portal.html'});
  });
  router.put('/worker-profiles/:id/portal-account',requireRole('admin'),(req,res)=>{
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_worker_profile'});
    try{res.json({account:portal.saveAccount(getDb(),authService,id,req.body||{},req.auth),portal_url:'/worker-portal.html'});}
    catch(e){if(e.status)return res.status(e.status).json({error:e.message});throw e;}
  });

  router.get('/worker-profiles', requireRole('admin'), (_req, res) => {
    workerInvitations.expireOutstanding();
    const rows = getDb().prepare(`
      SELECT p.*,pu.username AS portal_username,pu.active AS portal_active,pu.worker_portal_language AS portal_language,
             (SELECT wi.status FROM worker_invitations wi WHERE wi.worker_profile_id=p.id ORDER BY wi.id DESC LIMIT 1) AS latest_invitation_status,
             (SELECT wi.created_at FROM worker_invitations wi WHERE wi.worker_profile_id=p.id ORDER BY wi.id DESC LIMIT 1) AS latest_invitation_at,
             (SELECT d.status FROM device_enrollment_requests d
                JOIN worker_invitations wi ON wi.id=d.invitation_id
               WHERE wi.worker_profile_id=p.id ORDER BY d.id DESC LIMIT 1) AS device_status,
             (SELECT d.device_name FROM device_enrollment_requests d
                JOIN worker_invitations wi ON wi.id=d.invitation_id
               WHERE wi.worker_profile_id=p.id ORDER BY d.id DESC LIMIT 1) AS device_name
      FROM worker_qr_profiles p LEFT JOIN worker_portal_accounts pa ON pa.profile_id=p.id LEFT JOIN users pu ON pu.id=pa.user_id
      ORDER BY p.active DESC,p.worker_name COLLATE NOCASE,p.id
    `).all();
    res.json(rows.map(publicWorkerProfile));
  });

  router.post('/worker-profiles', requireRole('admin'), (req, res) => {
    const details = workerDetails(req.body);
    if (!details.valid) return res.status(400).json({ error: 'invalid_worker_profile' });
    const actorId = Number(req.auth?.sub) || null;
    const actorName = cleanText(req.auth?.display_name, 100) || null;
    try {
      const result = getDb().prepare(`
        INSERT INTO worker_qr_profiles
          (worker_name,phone,phone_normalized,role,permissions_json,created_by,created_by_name,updated_by,updated_by_name)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(details.workerName, details.phone, details.phoneNormalized, details.role,
        JSON.stringify(details.permissions), actorId, actorName, actorId, actorName);
      const row = getDb().prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(result.lastInsertRowid);
      auditLog('worker_qr_profile', row.id, details.phoneNormalized, 'create', null, null, null,
        details.workerName, actorId, actorName);
      return res.status(201).json(publicWorkerProfile(row));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'worker_phone_already_saved' });
      throw error;
    }
  });

  router.patch('/worker-profiles/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const details = workerDetails(req.body);
    if(req.body?.active!==undefined&&typeof req.body.active!=='boolean')return res.status(400).json({error:'invalid_worker_active'});
    if (!Number.isInteger(id) || id <= 0 || !details.valid) {
      return res.status(400).json({ error: 'invalid_worker_profile' });
    }
    const db = getDb();
    const before = db.prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(id);
    if (!before) return res.status(404).json({ error: 'worker_profile_not_found' });
    const actorId = Number(req.auth?.sub) || null;
    const actorName = cleanText(req.auth?.display_name, 100) || null;
    try {
      db.prepare(`
        UPDATE worker_qr_profiles
           SET worker_name=?,phone=?,phone_normalized=?,role=?,permissions_json=?,active=?,updated_by=?,updated_by_name=?,updated_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).run(details.workerName, details.phone, details.phoneNormalized, details.role,
        JSON.stringify(details.permissions), req.body.active===undefined?before.active:Number(req.body.active), actorId, actorName, id);
      const row = db.prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(id);
      auditLog('worker_qr_profile', id, details.phoneNormalized, 'update', 'profile', JSON.stringify({
        worker_name: before.worker_name, phone: before.phone, role: before.role, permissions_json: before.permissions_json, active: Boolean(before.active),
      }), JSON.stringify({
        worker_name: row.worker_name, phone: row.phone, role: row.role, permissions_json: row.permissions_json, active: Boolean(row.active),
      }), details.workerName, actorId, actorName);
      return res.json(publicWorkerProfile(row));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'worker_phone_already_saved' });
      throw error;
    }
  });

  router.post('/worker-profiles/:id/invitations', requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_worker_profile' });
    const db = getDb();
    const profile = db.prepare('SELECT * FROM worker_qr_profiles WHERE id=? AND active=1').get(id);
    if (!profile) return res.status(404).json({ error: 'worker_profile_not_found' });
    const details = workerDetails({
      worker_name: profile.worker_name,
      phone: profile.phone,
      role: profile.role,
      permissions: JSON.parse(profile.permissions_json || '[]'),
    });
    db.prepare(`
      UPDATE worker_invitations
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=?,cancelled_by_name=?
       WHERE worker_profile_id=? AND status IN ('pending','opened')
    `).run(Number(req.auth?.sub) || null, cleanText(req.auth?.display_name, 100) || null, id);
    return createInvitationResponse(req, res, details, id);
  });

  router.post('/worker-invitations', requireRole('admin'), async (req, res) => {
    const details = workerDetails(req.body);
    if (!details.valid) {
      return res.status(400).json({ error: 'invalid_worker_invitation' });
    }
    return createInvitationResponse(req, res, details);
  });

  router.get('/worker-invitations', requireRole('admin'), (_req, res) => {
    workerInvitations.expireOutstanding();
    const rows = getDb().prepare(`
      SELECT wi.id,wi.invitation_uid,wi.worker_profile_id,wi.worker_name,wi.phone,wi.role,wi.status,wi.expires_at,
             wi.created_at,wi.opened_at,wi.claimed_at,wi.cancelled_at,wi.created_by_name,wi.permissions_json,
             u.username AS claimed_username,u.display_name AS claimed_user_name,u.active AS claimed_user_active,
             d.id AS device_id,d.device_name,d.platform,d.status AS device_status
      FROM worker_invitations wi
      LEFT JOIN users u ON u.id=wi.claimed_user_id
      LEFT JOIN device_enrollment_requests d ON d.id=wi.claimed_device_id
      ORDER BY CASE wi.status WHEN 'pending' THEN 0 WHEN 'opened' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
               wi.created_at DESC
    `).all();
    res.json(rows);
  });

  router.patch('/worker-invitations/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const action = cleanText(req.body?.action, 20);
    if (!Number.isInteger(id) || id <= 0 || action !== 'cancel') {
      return res.status(400).json({ error: 'invalid_worker_invitation_action' });
    }
    workerInvitations.expireOutstanding();
    const before = getDb().prepare('SELECT * FROM worker_invitations WHERE id=?').get(id);
    if (!before) return res.status(404).json({ error: 'worker_invitation_not_found' });
    if (!['pending', 'opened'].includes(before.status)) {
      return res.status(409).json({ error: 'worker_invitation_not_cancellable', status: before.status });
    }
    getDb().prepare(`
      UPDATE worker_invitations
      SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=?,cancelled_by_name=?
      WHERE id=?
    `).run(Number(req.auth?.sub) || null, cleanText(req.auth?.display_name, 100) || null, id);
    auditLog(
      'worker_invitation', id, before.invitation_uid, 'cancel', 'status', before.status, 'cancelled',
      before.worker_name, Number(req.auth?.sub) || null, cleanText(req.auth?.display_name, 100) || null,
    );
    res.json({ success: true, status: 'cancelled' });
  });

  // The invite token is intentionally the only credential accepted here. It
  // never returns a token hash, a user list, or any factory data.
  router.get('/worker-invitations/activation', activationLimiter, (req, res) => {
    const row = workerInvitations.markOpened(req.query?.token);
    if (!row || !['pending', 'opened'].includes(workerInvitations.effectiveStatus(row))) {
      const failure = publicActivationError(row, workerInvitations);
      return res.status(failure.status).json({ error: failure.error });
    }
    res.json(workerInvitations.publicInvite(row));
  });

  router.post('/worker-invitations/activation', activationLimiter, (req, res) => {
    const token = String(req.body?.token || '').trim();
    const deviceName = cleanText(req.body?.device_name, 100);
    const platform = cleanText(req.body?.platform, 160);
    if (deviceName.length < 2) {
      return res.status(400).json({ error: 'worker_registration_details_required' });
    }

    let claimed;
    try {
      claimed = getDb().transaction(() => {
        const invite = workerInvitations.findByToken(token);
        if (!invite || !['pending', 'opened'].includes(workerInvitations.effectiveStatus(invite))) {
          const failure = publicActivationError(invite, workerInvitations);
          const error = new Error(failure.error);
          error.status = failure.status;
          throw error;
        }
        const profile=invite.worker_profile_id?getDb().prepare('SELECT * FROM worker_qr_profiles WHERE id=?').get(invite.worker_profile_id):null;
        if(invite.worker_profile_id&&(!profile||!profile.active))throw Object.assign(Error('worker_disabled'),{status:403});
        if(profile){invite.worker_name=profile.worker_name;invite.phone=profile.phone;invite.role=profile.role;invite.permissions_json=profile.permissions_json;}
        const permissions = cleanPermissions(JSON.parse(invite.permissions_json || '[]'), invite.role);
        if (invite.worker_profile_id) {
          getDb().prepare(`
            UPDATE device_enrollment_requests
               SET status='revoked',reviewed_at=CURRENT_TIMESTAMP,reviewed_by=NULL,reviewed_by_name='הפעלה מחדש'
             WHERE status='approved' AND invitation_id IN (
               SELECT id FROM worker_invitations WHERE worker_profile_id=? AND id<>?
             )
          `).run(invite.worker_profile_id, invite.id);
        }
        const enrollment = deviceEnrollment.createApprovedEnrollment({
          requesterName: invite.worker_name,
          deviceName,
          platform: platform || cleanText(req.get('user-agent'), 160),
          userAgent: cleanText(req.get('user-agent'), 500),
          ipAddress: cleanText(req.ip, 100),
          invitationId: invite.id,
          workerRole: invite.role,
          permissions,
        });
        const updated = getDb().prepare(`
          UPDATE worker_invitations
          SET status='claimed',claimed_at=CURRENT_TIMESTAMP,claimed_user_id=NULL,claimed_device_id=?
          WHERE id=? AND status IN ('pending','opened')
        `).run(enrollment.row.id, invite.id);
        if (updated.changes !== 1) throw new Error('invitation_already_used');
        return { invite, enrollment, permissions };
      })();
    } catch (error) {
      const status = Number(error.status) || (String(error.message).includes('UNIQUE') ? 409 : 400);
      return res.status(status).json({ error: error.message || 'worker_registration_failed' });
    }

    auditLog(
      'worker_invitation', claimed.invite.id, claimed.invite.invitation_uid, 'claim', 'status',
      claimed.invite.status, 'claimed', `${claimed.invite.worker_name} · ${claimed.enrollment.row.device_name}`,
      null, claimed.invite.worker_name,
    );
    res.status(201).json({
      status: 'approved',
      worker_name: claimed.invite.worker_name,
      permissions: claimed.permissions,
      device_name: claimed.enrollment.row.device_name,
      device_credential: claimed.enrollment.credential,
    });
  });

  return router;
};

module.exports.manifest = {
  id: 'worker-invitations',
  label: 'הזמנות עובדים',
  screens: ['worker-invite.html'],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  consumes: [{ table: 'users' }, { table: 'device_enrollment_requests' }],
  produces: [{ table: 'worker_qr_profiles' }, { table: 'worker_invitations' }],
};
