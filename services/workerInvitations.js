'use strict';

const crypto = require('crypto');
const { sha256 } = require('../auth-core');

const INVITATION_TTL_MS = 15 * 60 * 1000;

function ensureWorkerInvitationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_qr_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      phone_normalized TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'production',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by INTEGER,
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER,
      updated_by_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(updated_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_qr_profiles_active_name
      ON worker_qr_profiles(active, worker_name);

    CREATE TABLE IF NOT EXISTS worker_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invitation_uid TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      worker_name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'production',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','opened','claimed','expired','cancelled')),
      expires_at DATETIME NOT NULL,
      created_by INTEGER,
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      opened_at DATETIME,
      claimed_at DATETIME,
      claimed_user_id INTEGER,
      claimed_device_id INTEGER,
      cancelled_at DATETIME,
      cancelled_by INTEGER,
      cancelled_by_name TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(claimed_user_id) REFERENCES users(id),
      FOREIGN KEY(claimed_device_id) REFERENCES device_enrollment_requests(id),
      FOREIGN KEY(cancelled_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_invitations_status_expires
      ON worker_invitations(status, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_worker_invitations_claimed_user
      ON worker_invitations(claimed_user_id);
  `);
  try { db.exec("ALTER TABLE worker_invitations ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE worker_invitations ADD COLUMN worker_profile_id INTEGER"); } catch {}
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_invitations_profile
      ON worker_invitations(worker_profile_id, created_at DESC);
  `);
}

function createInvitationUid() {
  return `WINV-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function createInvitationToken() {
  return `${createInvitationUid()}.${crypto.randomBytes(32).toString('base64url')}`;
}

function asDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createWorkerInvitationService({ getDb, now = () => new Date() }) {
  if (typeof getDb !== 'function') throw new Error('worker invitations require getDb');

  function effectiveStatus(row) {
    if (!row) return 'invalid';
    if (['claimed', 'cancelled', 'expired'].includes(row.status)) return row.status;
    const expiresAt = asDate(row.expires_at);
    return !expiresAt || expiresAt.getTime() <= now().getTime() ? 'expired' : row.status;
  }

  function expireIfNeeded(row) {
    if (!row || effectiveStatus(row) !== 'expired' || row.status === 'expired') return row;
    getDb().prepare(`
      UPDATE worker_invitations
      SET status='expired'
      WHERE id=? AND status IN ('pending','opened')
    `).run(row.id);
    return getDb().prepare('SELECT * FROM worker_invitations WHERE id=?').get(row.id);
  }

  function findByToken(token) {
    const value = String(token || '').trim();
    if (value.length < 32) return null;
    const row = getDb().prepare('SELECT * FROM worker_invitations WHERE token_hash=?').get(sha256(value));
    return expireIfNeeded(row);
  }

  function publicInvite(row) {
    if (!row) return null;
    let language='he';
    if(row.worker_profile_id&&getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_portal_accounts'").get())language=getDb().prepare('SELECT u.worker_portal_language language FROM worker_portal_accounts a JOIN users u ON u.id=a.user_id WHERE a.profile_id=?').get(row.worker_profile_id)?.language||'he';
    return {
      language,
      portal_available:Boolean(row.worker_profile_id&&parsePermissions(row.permissions_json).includes('production')),
      invitation_uid: row.invitation_uid,
      worker_name: row.worker_name,
      role: row.role,
      permissions: parsePermissions(row.permissions_json),
      status: effectiveStatus(row),
      expires_at: row.expires_at,
    };
  }

  function create({ workerName, phone, role, permissions = [], workerProfileId = null, createdBy, createdByName }) {
    const db = getDb();
    const token = createInvitationToken();
    const expiresAt = new Date(now().getTime() + INVITATION_TTL_MS).toISOString();
    const result = db.prepare(`
      INSERT INTO worker_invitations
        (invitation_uid,token_hash,worker_name,phone,role,permissions_json,worker_profile_id,expires_at,created_by,created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      createInvitationUid(),
      sha256(token),
      workerName,
      phone || null,
      role,
      JSON.stringify(permissions),
      workerProfileId || null,
      expiresAt,
      createdBy || null,
      createdByName || null,
    );
    return {
      row: db.prepare('SELECT * FROM worker_invitations WHERE id=?').get(result.lastInsertRowid),
      token,
    };
  }

  function markOpened(token) {
    const row = findByToken(token);
    if (!row || !['pending', 'opened'].includes(effectiveStatus(row))) return row;
    if (row.status === 'pending') {
      getDb().prepare(`
        UPDATE worker_invitations
        SET status='opened',opened_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='pending'
      `).run(row.id);
      return getDb().prepare('SELECT * FROM worker_invitations WHERE id=?').get(row.id);
    }
    return row;
  }

  function expireOutstanding() {
    getDb().prepare(`
      UPDATE worker_invitations
      SET status='expired'
      WHERE status IN ('pending','opened') AND datetime(expires_at) <= CURRENT_TIMESTAMP
    `).run();
  }

  return {
    INVITATION_TTL_MS,
    create,
    effectiveStatus,
    expireOutstanding,
    findByToken,
    markOpened,
    publicInvite,
  };
}

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

module.exports = {
  INVITATION_TTL_MS,
  createWorkerInvitationService,
  ensureWorkerInvitationSchema,
};
