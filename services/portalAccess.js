'use strict';

function required(name, value) {
  if (!value) throw new Error(`services/portalAccess missing dependency: ${name}`);
  return value;
}

function createPortalAccessService(deps) {
  const db = required('db', deps.db);
  const crypto = required('crypto', deps.crypto);
  const bcrypt = require('bcryptjs');
  const settingsService = required('settingsService', deps.settingsService);
  const PORT = required('PORT', deps.PORT);

  // BUG-41: limited projection - never return sensitive fields via portal resolver.
  const CUSTOMER_PORTAL_COLS = 'id,name,phone,email,address,tax_id,payment_terms,contact_name,contact_phone,portal_price_list_visibility,portal_can_manage_users,portal_can_create_sites,portal_can_set_budgets,portal_can_expose_prices,portal_token,portal_token_expires_at,portal_token_revoked_at,price_tier,discount_pct,price_approved_at,portal_profile_locked_at';

  function configuredBaseUrl(requestBaseUrl = '') {
    // When a link is generated from an HTTP request, keep it on the same public
    // host that the manager is currently using. This prevents a stale BASE_URL
    // setting from sending customers to an older deployment.
    const raw = String(requestBaseUrl || process.env.BASE_URL || settingsService.get('BASE_URL', '') || '').trim();
    return raw.replace(/\/+$/, '');
  }

  function portalLink(token, options = {}) {
    const baseUrl = configuredBaseUrl(options.baseUrl || `http://localhost:${PORT}`);
    return `${baseUrl}/customer.html?token=${encodeURIComponent(token)}`;
  }

  // ── משתמשי פורטל עם תפקידים (מזמין/מאשר) — ראה docs/spec-portal-roles.md ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      phone       TEXT NOT NULL UNIQUE,
      name        TEXT,
      role        TEXT NOT NULL DEFAULT 'both' CHECK (role IN ('orderer','approver','both','finance','field_manager','customer_admin')),
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN token TEXT`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN token_expires_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN password_hash TEXT`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN password_changed_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN email TEXT`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_manage_users INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_create_sites INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_assign_site_users INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_create_orders INTEGER DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_approve_orders INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_view_prices INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_view_budget INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_set_budget INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_approve_budget_overrun INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_view_invoices INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_view_delivery_notes INTEGER DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN can_view_payment_alerts INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN default_site_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE portal_users ADD COLUMN updated_at TEXT`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_portal_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_by_portal_user_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_portal_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
      device_token_hash TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      device_name TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_portal_enrollment_user ON customer_portal_enrollments(portal_user_id,expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_device_user ON customer_portal_devices(portal_user_id,active);
  `);
  try { db.exec(`ALTER TABLE customer_portal_devices ADD COLUMN pin_hash TEXT`); } catch {}

  // Backfill חד-פעמי: כל לקוח קיים עם טלפון → משתמש פורטל role=both (שומר התנהגות קיימת)
  try {
    if (db.prepare('SELECT COUNT(*) c FROM portal_users').get().c === 0) {
      const custs = db.prepare("SELECT id,name,phone FROM customers WHERE phone IS NOT NULL AND TRIM(phone)<>''").all();
      const ins = db.prepare("INSERT OR IGNORE INTO portal_users (customer_id,phone,name,role) VALUES (?,?,?,'both')");
      for (const c of custs) ins.run(c.id, normalizePortalPhone(c.phone), c.name);
    }
  } catch (e) { console.warn('[portal_users backfill]', e.message); }

  // יכולות לפי תפקיד — כולם מזמינים; מחיר ואישור רק ל-approver/both
  function bool(value) {
    return Number(value || 0) === 1;
  }

  function customerPortalCaps(customer = {}) {
    return {
      canManageUsers: bool(customer.portal_can_manage_users),
      canCreateSites: bool(customer.portal_can_create_sites),
      canSetBudgets: bool(customer.portal_can_set_budgets),
      canExposePrices: bool(customer.portal_can_expose_prices),
    };
  }

  function roleCaps(portalUserOrRole, customer = {}) {
    const isUser = portalUserOrRole && typeof portalUserOrRole === 'object';
    const role = isUser ? portalUserOrRole.role : portalUserOrRole;
    const r = role || 'both';
    const customerCaps = customerPortalCaps(customer);
    const oldApprover = r === 'approver' || r === 'both';
    const fieldManager = r === 'field_manager' || r === 'orderer';
    const finance = r === 'finance';
    const customerAdmin = r === 'customer_admin';
    const userCan = name => isUser ? bool(portalUserOrRole[name]) : false;
    const priceExposureAllowed = customerCaps.canExposePrices || customer.portal_price_list_visibility !== 'none';
    const canViewPrices = priceExposureAllowed && (isUser ? userCan('can_view_prices') : (customerAdmin || oldApprover || finance));
    const canViewInvoices = customerAdmin || (isUser ? userCan('can_view_invoices') : finance);
    const canViewPaymentAlerts = customerAdmin || (isUser ? userCan('can_view_payment_alerts') : finance);
    const canOrder = customerAdmin || (!isUser ? true : userCan('can_create_orders'));
    const canApprove = customerAdmin || (!isUser ? oldApprover : userCan('can_approve_orders'));
    return {
      role: r,
      canOrder,
      seePrice: canViewPrices,
      canApprove,
      canManageUsers: customerCaps.canManageUsers && (customerAdmin || (!isUser ? oldApprover : userCan('can_manage_users'))),
      canCreateSites: customerCaps.canCreateSites && (customerAdmin || (!isUser ? r === 'both' : userCan('can_create_sites'))),
      canAssignSiteUsers: customerCaps.canManageUsers && (customerAdmin || (isUser && userCan('can_assign_site_users'))),
      canViewBudget: customerAdmin ? customerCaps.canSetBudgets : ((isUser ? userCan('can_view_budget') : finance) && (customerCaps.canSetBudgets || (isUser && userCan('can_view_budget')))),
      canSetBudget: customerCaps.canSetBudgets && (customerAdmin || (isUser ? userCan('can_set_budget') : finance)),
      canApproveBudgetOverrun: customerCaps.canSetBudgets && (customerAdmin || (isUser ? userCan('can_approve_budget_overrun') : finance)),
      canViewInvoices,
      canViewPaymentAlerts,
      canViewDeliveryNotes: customerAdmin || !isUser || userCan('can_view_delivery_notes'),
    };
  }

  function normalizeSite(row, caps = {}) {
    if (!row) return null;
    const site = {
      id: row.id,
      customer_id: row.customer_id,
      name: row.name,
      address: row.address,
      city: row.city,
      status: row.status,
      manager_name: row.manager_name,
      manager_phone: row.manager_phone,
      alert_pct: row.alert_pct,
      block_over_budget: Number(row.block_over_budget || 0) === 1,
    };
    if (caps.canViewBudget || caps.canSetBudget || caps.canApproveBudgetOverrun) {
      site.budget_amount = Number(row.budget_amount || 0);
      site.budget_kg = Number(row.budget_kg || 0);
    }
    return site;
  }

  function listAuthorizedSites(customerId, portalUser = null, caps = null) {
    const effectiveCaps = caps || roleCaps(portalUser, {});
    let rows;
    if (!portalUser || portalUser.role === 'customer_admin') {
      rows = db.prepare(`
        SELECT id,customer_id,name,address,city,status,manager_name,manager_phone,budget_amount,budget_kg,alert_pct,block_over_budget
        FROM customer_sites
        WHERE customer_id=? AND COALESCE(status,'active')<>'inactive'
        ORDER BY name
      `).all(customerId);
    } else {
      rows = db.prepare(`
        SELECT s.id,s.customer_id,s.name,s.address,s.city,s.status,s.manager_name,s.manager_phone,
               s.budget_amount,s.budget_kg,s.alert_pct,s.block_over_budget,su.is_default
        FROM customer_sites s
        JOIN customer_site_users su ON su.site_id=s.id AND su.portal_user_id=?
        WHERE s.customer_id=? AND COALESCE(s.status,'active')<>'inactive'
        ORDER BY su.is_default DESC, s.name
      `).all(portalUser.id, customerId);
      if (!rows.length && (portalUser.default_site_id || 0)) {
        const row = db.prepare(`
          SELECT id,customer_id,name,address,city,status,manager_name,manager_phone,budget_amount,budget_kg,alert_pct,block_over_budget
          FROM customer_sites WHERE id=? AND customer_id=? AND COALESCE(status,'active')<>'inactive'
        `).get(portalUser.default_site_id, customerId);
        rows = row ? [row] : [];
      }
    }
    return rows.map(row => normalizeSite(row, effectiveCaps));
  }

  function portalContext(customer, portalUser = null) {
    const caps = roleCaps(portalUser || 'both', customer);
    const sites = listAuthorizedSites(customer.id, portalUser, caps);
    const defaultSiteId = portalUser?.default_site_id && sites.some(site => site.id === portalUser.default_site_id)
      ? portalUser.default_site_id
      : sites[0]?.id || null;
    return {
      role: portalUser?.role || 'both',
      caps,
      portalUser: portalUser ? {
        id: portalUser.id,
        name: portalUser.name,
        phone: portalUser.phone,
        email: portalUser.email,
        role: portalUser.role,
        default_site_id: defaultSiteId,
      } : null,
      sites,
      defaultSiteId,
      canChooseSite: sites.length > 1,
    };
  }

  function resolveAuthorizedSite(customerId, portalUser, requestedSiteId) {
    const customer = db.prepare(`SELECT ${CUSTOMER_PORTAL_COLS} FROM customers WHERE id=?`).get(customerId) || { id: customerId };
    const ctx = portalContext(customer, portalUser);
    if (!ctx.sites.length) {
      // A scoped portal user must never create or approve an unassigned order.
      // A null user is reserved for explicitly privileged support previews.
      if (portalUser) return { ok: false, status: 403, error: 'למשתמש זה אין אתרים מורשים', context: ctx };
      return { ok: true, site: null, context: ctx };
    }
    const wanted = Number(requestedSiteId || ctx.defaultSiteId || 0);
    const site = ctx.sites.find(row => Number(row.id) === wanted);
    if (!site) return { ok: false, status: 403, error: 'האתר לא מורשה למשתמש זה', context: ctx };
    return { ok: true, site, context: ctx };
  }

  function resolvePortalUser(phone) {
    const np = normalizePortalPhone(phone);
    if (!np) return null;
    return db.prepare('SELECT * FROM portal_users WHERE phone=? AND active=1').get(np);
  }

  function findOrCreatePortalUser(customerId, phone, name) {
    const np = normalizePortalPhone(phone);
    let u = db.prepare('SELECT * FROM portal_users WHERE phone=?').get(np);
    if (!u) {
      const r = db.prepare("INSERT INTO portal_users (customer_id,phone,name,role) VALUES (?,?,?,'both')")
        .run(customerId, np, name || null);
      u = db.prepare('SELECT * FROM portal_users WHERE id=?').get(r.lastInsertRowid);
    }
    return u;
  }

  function issueUserToken(portalUser) {
    const token = crypto.randomBytes(12).toString('hex');
    const expiresAt = portalTokenExpiresAt();
    db.prepare('UPDATE portal_users SET token=?, token_expires_at=? WHERE id=?').run(token, expiresAt, portalUser.id);
    return { token, expiresAt };
  }

  function supportPreviewSignature(payload) {
    return crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'dev-secret'))
      .update(payload)
      .digest('base64url');
  }

  function issueSupportPreviewToken(customerId, actorUserId, portalUserId = null) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const payload = Buffer.from(JSON.stringify({
      type: 'portal-support-preview',
      customerId: Number(customerId),
      portalUserId: portalUserId ? Number(portalUserId) : null,
      actorUserId: actorUserId ? Number(actorUserId) : null,
      expiresAt: expiresAt.toISOString(),
      nonce: crypto.randomBytes(12).toString('hex'),
    })).toString('base64url');
    return {
      token: `sp.${payload}.${supportPreviewSignature(payload)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  function resolveSupportPreviewToken(token) {
    if (!String(token || '').startsWith('sp.')) return null;
    try {
      const [, payload, signature] = String(token).split('.');
      if (!payload || !signature) return null;
      const expected = supportPreviewSignature(payload);
      const actualBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (claims.type !== 'portal-support-preview' || new Date(claims.expiresAt).getTime() <= Date.now()) return null;
      const customer = db.prepare(`SELECT ${CUSTOMER_PORTAL_COLS} FROM customers WHERE id=?`).get(claims.customerId);
      if (!customer) return null;
      const user = claims.portalUserId
        ? db.prepare('SELECT * FROM portal_users WHERE id=? AND customer_id=? AND active=1').get(claims.portalUserId, customer.id)
        : null;
      if (claims.portalUserId && !user) return null;
      return {
        customer,
        user: user || null,
        role: user?.role || 'both',
        supportPreview: true,
        supportActorUserId: claims.actorUserId || null,
        supportPreviewExpiresAt: claims.expiresAt,
      };
    } catch {
      return null;
    }
  }

  function normalizePortalPassword(password) {
    return String(password || '').trim();
  }

  function validatePortalPassword(password) {
    const clean = normalizePortalPassword(password);
    if (clean.length < 4) return { ok: false, error: 'הסיסמה חייבת להכיל לפחות 4 תווים' };
    if (clean.length > 64) return { ok: false, error: 'הסיסמה ארוכה מדי' };
    return { ok: true, password: clean };
  }

  function setPortalPassword(userId, password) {
    const valid = validatePortalPassword(password);
    if (!valid.ok) return valid;
    const hash = bcrypt.hashSync(valid.password, 10);
    db.prepare('UPDATE portal_users SET password_hash=?, password_changed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(hash, userId);
    return { ok: true };
  }

  function verifyPortalPassword(portalUser, password) {
    if (!portalUser || !portalUser.password_hash) return false;
    const clean = normalizePortalPassword(password);
    if (!clean) return false;
    return bcrypt.compareSync(clean, portalUser.password_hash);
  }

  function generatePortalPassword() {
    return String(crypto.randomInt(100000, 1000000));
  }

  function normalizePortalPin(pin) {
    return String(pin || '').replace(/\D/g, '');
  }

  function validatePortalPin(pin) {
    const clean = normalizePortalPin(pin);
    if (!/^\d{6}$/.test(clean)) return { ok: false, error: 'ה-PIN חייב להכיל 6 ספרות' };
    const weak = new Set(['000000','111111','222222','333333','444444','555555','666666','777777','888888','999999','123456','654321']);
    if (weak.has(clean)) return { ok: false, error: 'יש לבחור PIN שאינו רצף פשוט או ספרות זהות' };
    return { ok: true, pin: clean };
  }

  function hashOpaqueToken(value) {
    return crypto.createHash('sha256')
      .update(`${process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret'}:${String(value || '')}`)
      .digest('hex');
  }

  function issuePortalEnrollment(portalUser, options = {}) {
    if (!portalUser?.id || Number(portalUser.active) !== 1) return { ok: false, error: 'משתמש הפורטל אינו פעיל' };
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare('UPDATE customer_portal_enrollments SET consumed_at=CURRENT_TIMESTAMP WHERE portal_user_id=? AND consumed_at IS NULL')
      .run(portalUser.id);
    db.prepare(`
      INSERT INTO customer_portal_enrollments
        (customer_id,portal_user_id,token_hash,expires_at,created_by_portal_user_id)
      VALUES (?,?,?,?,?)
    `).run(portalUser.customer_id, portalUser.id, hashOpaqueToken(token), expiresAt, options.createdByPortalUserId || null);
    const baseUrl = configuredBaseUrl(options.baseUrl || `http://localhost:${PORT}`);
    return {
      ok: true,
      token,
      expiresAt,
      activationLink: `${baseUrl}/customer.html?enroll=${encodeURIComponent(token)}`,
    };
  }

  function activatePortalDevice(enrollmentToken, pin, deviceName = '') {
    const pinResult = validatePortalPin(pin);
    if (!pinResult.ok) return { ...pinResult, status: 400 };
    const enrollment = db.prepare(`
      SELECT e.*,u.active AS user_active,u.customer_id AS user_customer_id
      FROM customer_portal_enrollments e
      JOIN portal_users u ON u.id=e.portal_user_id
      WHERE e.token_hash=? AND e.consumed_at IS NULL
      ORDER BY e.id DESC LIMIT 1
    `).get(hashOpaqueToken(enrollmentToken));
    if (!enrollment) return { ok: false, status: 401, error: 'קישור ההפעלה אינו תקין או שכבר נוצל' };
    if (new Date(enrollment.expires_at).getTime() <= Date.now()) {
      db.prepare('UPDATE customer_portal_enrollments SET consumed_at=CURRENT_TIMESTAMP WHERE id=?').run(enrollment.id);
      return { ok: false, status: 401, error: 'קישור ההפעלה פג תוקף. בקש קישור חדש.' };
    }
    if (Number(enrollment.user_active) !== 1 || Number(enrollment.customer_id) !== Number(enrollment.user_customer_id)) {
      return { ok: false, status: 403, error: 'משתמש הפורטל אינו פעיל' };
    }
    const deviceToken = crypto.randomBytes(32).toString('base64url');
    const deviceLabel = String(deviceName || '').trim().slice(0, 100) || 'דפדפן מאושר';
    const transaction = db.transaction(() => {
      const hash = bcrypt.hashSync(pinResult.pin, 10);
      const created = db.prepare(`
        INSERT INTO customer_portal_devices
          (customer_id,portal_user_id,device_token_hash,pin_hash,device_name,last_used_at)
        VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      `).run(enrollment.customer_id, enrollment.portal_user_id, hashOpaqueToken(deviceToken), hash, deviceLabel);
      db.prepare('UPDATE customer_portal_enrollments SET consumed_at=CURRENT_TIMESTAMP WHERE id=?').run(enrollment.id);
      return created.lastInsertRowid;
    });
    const deviceId = transaction();
    const user = db.prepare('SELECT * FROM portal_users WHERE id=? AND active=1').get(enrollment.portal_user_id);
    return { ok: true, deviceToken, deviceId, user };
  }

  function resolvePortalDevice(deviceToken) {
    if (!deviceToken) return null;
    return db.prepare(`
      SELECT d.*,u.phone,u.name,u.role,u.active AS user_active
      FROM customer_portal_devices d
      JOIN portal_users u ON u.id=d.portal_user_id AND u.customer_id=d.customer_id
      WHERE d.device_token_hash=? AND d.active=1 AND u.active=1
      LIMIT 1
    `).get(hashOpaqueToken(deviceToken)) || null;
  }

  function authenticatePortalDevicePin(deviceToken, pin) {
    const device = resolvePortalDevice(deviceToken);
    if (!device) return { ok: false, status: 401, error: 'המכשיר אינו מאושר. יש להשתמש בקישור הפעלה חדש.' };
    if (device.locked_until && new Date(device.locked_until).getTime() > Date.now()) {
      return { ok: false, status: 429, error: 'המכשיר נעול זמנית לאחר מספר ניסיונות שגויים' };
    }
    const clean = normalizePortalPin(pin);
    const valid = /^\d{6}$/.test(clean) && device.pin_hash && bcrypt.compareSync(clean, device.pin_hash);
    if (!valid) {
      const attempts = Number(device.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      db.prepare('UPDATE customer_portal_devices SET failed_attempts=?,locked_until=? WHERE id=?')
        .run(lockedUntil ? 0 : attempts, lockedUntil, device.id);
      return { ok: false, status: lockedUntil ? 429 : 401, error: lockedUntil ? 'המכשיר ננעל ל-15 דקות' : 'PIN שגוי' };
    }
    db.prepare('UPDATE customer_portal_devices SET failed_attempts=0,locked_until=NULL,last_used_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(device.id);
    const user = db.prepare('SELECT * FROM portal_users WHERE id=? AND active=1').get(device.portal_user_id);
    return { ok: true, user, deviceId: device.id };
  }

  function changePortalDevicePin(deviceToken, portalUserId, oldPin, newPin) {
    const device = resolvePortalDevice(deviceToken);
    if (!device || Number(device.portal_user_id) !== Number(portalUserId)) {
      return { ok: false, status: 401, error: 'המחשב אינו מאושר למשתמש זה' };
    }
    const next = validatePortalPin(newPin);
    if (!next.ok) return { ...next, status: 400 };
    const current = normalizePortalPin(oldPin);
    if (!/^\d{6}$/.test(current) || !device.pin_hash || !bcrypt.compareSync(current, device.pin_hash)) {
      return { ok: false, status: 401, error: 'ה-PIN הנוכחי שגוי' };
    }
    db.prepare('UPDATE customer_portal_devices SET pin_hash=?,failed_attempts=0,locked_until=NULL WHERE id=?')
      .run(bcrypt.hashSync(next.pin, 10), device.id);
    return { ok: true, deviceId: device.id };
  }

  function listPortalDevices(customerId, portalUserId = null) {
    const where = ['d.customer_id=?'];
    const params = [Number(customerId)];
    if (portalUserId) { where.push('d.portal_user_id=?'); params.push(Number(portalUserId)); }
    return db.prepare(`
      SELECT d.id,d.portal_user_id,d.device_name,d.active,d.last_used_at,d.revoked_at,d.created_at,u.name AS user_name,u.phone
      FROM customer_portal_devices d
      JOIN portal_users u ON u.id=d.portal_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.active DESC,COALESCE(d.last_used_at,d.created_at) DESC
    `).all(...params);
  }

  function revokePortalDevice(customerId, deviceId) {
    const result = db.prepare(`
      UPDATE customer_portal_devices
      SET active=0,revoked_at=CURRENT_TIMESTAMP
      WHERE id=? AND customer_id=? AND active=1
    `).run(Number(deviceId), Number(customerId));
    return result.changes > 0;
  }

  // טוקן פר-משתמש → {customer, user, role}. נופל ל-null אם לא קיים/פג.
  function resolvePortalSession(token) {
    if (!token) return null;
    const u = db.prepare(`
      SELECT * FROM portal_users
      WHERE token=? AND active=1 AND (token_expires_at IS NULL OR token_expires_at > ?)
    `).get(token, new Date().toISOString());
    if (!u) return resolveSupportPreviewToken(token);
    const customer = db.prepare(`SELECT ${CUSTOMER_PORTAL_COLS} FROM customers WHERE id=?`).get(u.customer_id);
    if (!customer) return null;
    return { customer, user: u, role: u.role };
  }

  function resolveCustomer(token, phone) {
    if (token) return db.prepare(`
      SELECT ${CUSTOMER_PORTAL_COLS} FROM customers
      WHERE portal_token=?
        AND portal_token_revoked_at IS NULL
        AND (portal_token_expires_at IS NULL OR portal_token_expires_at > ?)
    `).get(token, new Date().toISOString());
    if (phone) return db.prepare(`SELECT ${CUSTOMER_PORTAL_COLS} FROM customers WHERE phone=?`).get(phone);
    return null;
  }

  const portalOtpTtlMinutes = () => settingsService.getNum('PORTAL_OTP_TTL_MINUTES', Number(process.env.PORTAL_OTP_TTL_MINUTES || 10));
  const portalTokenTtlDays = () => settingsService.getNum('PORTAL_TOKEN_TTL_DAYS', Number(process.env.PORTAL_TOKEN_TTL_DAYS || 90));

  function normalizePortalPhone(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  function hashPortalOtp(phone, code) {
    return crypto.createHash('sha256')
      .update(`${process.env.JWT_SECRET || 'dev-secret'}:${phone}:${code}`)
      .digest('hex');
  }

  function portalTokenExpiresAt() {
    return new Date(Date.now() + portalTokenTtlDays() * 24 * 60 * 60 * 1000).toISOString();
  }

  function hasActivePortalToken(customer) {
    if (!customer.portal_token || customer.portal_token_revoked_at) return false;
    if (!customer.portal_token_expires_at) return true;
    return new Date(customer.portal_token_expires_at).getTime() > Date.now();
  }

  function ensurePortalToken(customer, options = {}) {
    if (!options.forceRotate && hasActivePortalToken(customer)) return customer.portal_token;
    const token = crypto.randomBytes(12).toString('hex');
    const expiresAt = portalTokenExpiresAt();
    db.prepare(`
      UPDATE customers
      SET portal_token=?,
          portal_token_created_at=CURRENT_TIMESTAMP,
          portal_token_expires_at=?,
          portal_token_revoked_at=NULL
      WHERE id=?
    `).run(token, expiresAt, customer.id);
    customer.portal_token = token;
    customer.portal_token_expires_at = expiresAt;
    customer.portal_token_revoked_at = null;
    return token;
  }

  function issuePortalOtp(customer) {
    const phone = normalizePortalPhone(customer.phone);
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + portalOtpTtlMinutes() * 60 * 1000).toISOString();
    db.prepare('UPDATE customer_portal_otps SET consumed_at=CURRENT_TIMESTAMP WHERE phone=? AND consumed_at IS NULL')
      .run(phone);
    db.prepare(`
      INSERT INTO customer_portal_otps (customer_id,phone,code_hash,expires_at)
      VALUES (?,?,?,?)
    `).run(customer.id, phone, hashPortalOtp(phone, code), expiresAt);
    return { code, expiresAt };
  }

  function verifyPortalOtp(phone, code) {
    const normalizedPhone = normalizePortalPhone(phone);
    const cleanCode = String(code || '').replace(/\D/g, '');
    const otp = db.prepare(`
      SELECT * FROM customer_portal_otps
      WHERE phone=? AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(normalizedPhone);
    if (!otp) return { ok: false, status: 401, error: 'Invalid code' };
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      db.prepare('UPDATE customer_portal_otps SET consumed_at=CURRENT_TIMESTAMP WHERE id=?').run(otp.id);
      return { ok: false, status: 401, error: 'Code expired' };
    }
    if (Number(otp.attempts || 0) >= 5) return { ok: false, status: 429, error: 'Too many attempts' };
    if (hashPortalOtp(normalizedPhone, cleanCode) !== otp.code_hash) {
      db.prepare('UPDATE customer_portal_otps SET attempts=attempts+1 WHERE id=?').run(otp.id);
      return { ok: false, status: 401, error: 'Invalid code' };
    }
    db.prepare('UPDATE customer_portal_otps SET consumed_at=CURRENT_TIMESTAMP WHERE id=?').run(otp.id);
    return { ok: true, customerId: otp.customer_id };
  }

  function portalAuthResponse(customer, options = {}) {
    const token = ensurePortalToken(customer, options);
    const ctx = portalContext(customer, options.portalUser || null);
    return {
      token,
      link: portalLink(token, options),
      expiresAt: customer.portal_token_expires_at || null,
      role: ctx.role,
      caps: ctx.caps,
      portalUser: ctx.portalUser,
      sites: ctx.sites,
      defaultSiteId: ctx.defaultSiteId,
      canChooseSite: ctx.canChooseSite,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        contact_name: customer.contact_name,
        contact_phone: customer.contact_phone,
        tax_id: customer.tax_id,
        payment_terms: customer.payment_terms,
        portal_price_list_visibility: customer.portal_price_list_visibility,
        price_tier: customer.price_tier,
      }
    };
  }

  return {
    normalizePortalPhone,
    resolveCustomer,
    resolvePortalUser,
    findOrCreatePortalUser,
    issueUserToken,
    issueSupportPreviewToken,
    setPortalPassword,
    verifyPortalPassword,
    generatePortalPassword,
    validatePortalPin,
    issuePortalEnrollment,
    activatePortalDevice,
    resolvePortalDevice,
    authenticatePortalDevicePin,
    changePortalDevicePin,
    listPortalDevices,
    revokePortalDevice,
    resolvePortalSession,
    roleCaps,
    customerPortalCaps,
    portalContext,
    listAuthorizedSites,
    resolveAuthorizedSite,
    issuePortalOtp,
    verifyPortalOtp,
    portalAuthResponse,
    portalLink,
    configuredBaseUrl,
  };
}

module.exports = { createPortalAccessService };
