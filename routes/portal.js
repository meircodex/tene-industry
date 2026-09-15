const router = require('express').Router();
const { createPortalAccessService } = require('../services/portalAccess');
const { buildOrderItemUid } = require('../services/orderContracts');
const { itemShapeMetrics } = require('../services/shapeSnapshot');
const { ORDER_STATUS } = require('../status-contracts');
const { projectPortalCustomer, projectPortalOrder, projectPortalOrderDetail } = require('../services/customerPortalProjection');
const { portalShapeDraftToOrderItem } = require('../services/customerPortalShapeDraft');
const productionCards = require('../services/productionCards');
const portalGuarantees = require('../services/portalGuarantees');
const { portalInvoices } = require('../services/customerPortalFinance');
const { evaluatePortalBudget } = require('../services/portalBudget');

function required(name, value) {
  if (!value) throw new Error(`routes/portal missing dependency: ${name}`);
  return value;
}

module.exports = function createPortalRouter(deps) {
  const db = required('db', deps.db);
  const auditLog = required('auditLog', deps.auditLog);
  const customerPortalAuthLimiter = required('customerPortalAuthLimiter', deps.customerPortalAuthLimiter);
  const customerPortalActionLimiter = required('customerPortalActionLimiter', deps.customerPortalActionLimiter);
  const crypto = required('crypto', deps.crypto);
  const intake = required('intake', deps.intake);
  const industry = required('industry', deps.industry);
  const generateOrderNum = required('generateOrderNum', deps.generateOrderNum);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const pricer          = required('pricer',          deps.pricer);
  const settingsService = required('settingsService', deps.settingsService);
  const upload          = required('upload',          deps.upload);
  const PORT = required('PORT', deps.PORT);
  const IS_TEST = Boolean(deps.IS_TEST);

  const portalAccess = createPortalAccessService({ db, crypto, settingsService, PORT });
  function requestPublicBaseUrl(req) {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
  }

  function portalPublicItem(item = {}) {
    const metrics = itemShapeMetrics(item);
    return {
      ...item,
      shapeSnapshot: item.shape_snapshot_json || null,
      shape_svg: productionCards.itemShapeSvg(item),
      total_length_mm: metrics.totalLengthMm || item.total_length_mm,
      weight_per_unit: metrics.unitWeightKg || item.weight_per_unit,
      total_weight: metrics.totalWeightKg || item.total_weight,
    };
  }

  function portalDraftErrorResponse(res, err) {
    const status = Number(err.statusCode || err.status || 400);
    return res.status(status >= 400 && status < 600 ? status : 400).json({
      error: err.message || 'Invalid shape item',
      code: err.code || 'invalid_shape_draft',
    });
  }

  function normalizePortalOrderItems(items = [], ctx = {}) {
    return (items || []).map((item, index) => portalShapeDraftToOrderItem(item, {
      ...ctx,
      itemIndex: index + 1,
    }));
  }
  function portalPayloadFingerprint(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
  function portalIdempotencyKey(value) {
    const key = String(value || '').trim();
    return key ? key.slice(0, 200) : null;
  }
  function portalWastePct() {
    const value = Number(settingsService.get('WASTE_PCT_DEFAULT', 3));
    return Number.isFinite(value) && value >= 0 ? value : 3;
  }
  const {
    normalizePortalPhone,
    resolveCustomer,
    findOrCreatePortalUser,
    issueUserToken,
    setPortalPassword,
    verifyPortalPassword,
    resolvePortalSession,
    roleCaps,
    portalContext,
    resolveAuthorizedSite,
    issuePortalOtp,
    verifyPortalOtp,
    portalAuthResponse,
  } = portalAccess;

  // session(token) -> {customer, user, role}. Only per-user portal tokens are active sessions.
  function session(token) {
    const s = resolvePortalSession(token);
    if (s) {
      const ctx = portalContext(s.customer, s.user);
      return {
        customer: s.customer,
        user: s.user,
        role: ctx.role,
        caps: ctx.caps,
        portal: ctx,
        supportPreview: Boolean(s.supportPreview),
        supportActorUserId: s.supportActorUserId || null,
        supportPreviewExpiresAt: s.supportPreviewExpiresAt || null,
      };
    }
    return upgradeLegacyCustomerToken(token);
  }

  function auditSupportAction(s, action, entityType = 'customer', entityId = null, details = null) {
    if (!s?.supportPreview || !s.supportActorUserId) return;
    let actorName = null;
    try {
      actorName = db.prepare('SELECT display_name FROM users WHERE id=?').get(s.supportActorUserId)?.display_name || null;
    } catch {}
    const portalIdentity = s.user ? `${s.user.name || s.user.phone || 'משתמש'} (#${s.user.id})` : 'ללא משתמש פורטל';
    auditLog(
      entityType,
      entityId || s.customer.id,
      null,
      `portal_support_${action}`,
      null,
      null,
      details ? JSON.stringify(details) : null,
      `פעולה במצב סיוע עבור ${s.customer.name}; זהות פורטל: ${portalIdentity}`,
      s.supportActorUserId,
      actorName
    );
  }

  function upgradeLegacyCustomerToken(token) {
    const customer = resolveCustomer(token);
    if (!customer || !customer.phone) return null;
    const user = findOrCreatePortalUser(customer.id, customer.phone, customer.name);
    const issued = issueUserToken(user);
    const freshUser = db.prepare('SELECT * FROM portal_users WHERE id=?').get(user.id);
    const ctx = portalContext(customer, freshUser);
    return {
      customer,
      user: freshUser,
      role: ctx.role,
      caps: ctx.caps,
      portal: ctx,
      upgradedToken: issued.token,
      upgradedExpiresAt: issued.expiresAt,
      upgradedLink: portalAccess.portalLink(issued.token),
    };
  }

  function publicPortalUser(user, portal) {
    if (!user) return portal.portalUser;
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      default_site_id: portal.defaultSiteId,
    };
  }

  function canViewCustomerFinance(caps = {}) {
    return Boolean(caps.seePrice || caps.canViewBudget || caps.canSetBudget || caps.canViewInvoices || caps.canViewPaymentAlerts);
  }

  function portalBoolFlag(value, fallback = false) {
    if (value === undefined || value === null) return fallback ? 1 : 0;
    if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return 1;
    return 0;
  }

  function portalProjectionCtx(s) {
    return { caps: s?.caps || {}, customer: s?.customer || null, portalUser: s?.user || null };
  }

  function projectOrdersForPortal(orders = [], s) {
    return (orders || []).map(order => projectPortalOrder(order, portalProjectionCtx(s)));
  }

  function projectCustomerForPortal(customer, s, extra = {}) {
    return projectPortalCustomer(customer, { ...portalProjectionCtx(s), ...extra });
  }

  function portalAuthorizedSiteIds(s, rawSiteIds = []) {
    const allowed = new Set((s.portal.sites || []).map(site => Number(site.id)).filter(Boolean));
    const requested = Array.isArray(rawSiteIds) ? rawSiteIds : [rawSiteIds];
    const ids = requested.map(Number).filter(id => Number.isFinite(id) && id > 0);
    const unique = [...new Set(ids)];
    const invalid = unique.find(id => !allowed.has(id));
    if (invalid) return { ok: false, status: 403, error: 'אין הרשאה לשייך לאתר הזה' };
    return { ok: true, ids: unique };
  }

  function portalSafeUserRow(user) {
    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      default_site_id: user.default_site_id,
      can_manage_users: user.can_manage_users,
      can_create_sites: user.can_create_sites,
      can_assign_site_users: user.can_assign_site_users,
      can_create_orders: user.can_create_orders,
      can_approve_orders: user.can_approve_orders,
      can_view_prices: user.can_view_prices,
      can_view_budget: user.can_view_budget,
      can_set_budget: user.can_set_budget,
      can_approve_budget_overrun: user.can_approve_budget_overrun,
      can_view_invoices: user.can_view_invoices,
      can_view_delivery_notes: user.can_view_delivery_notes,
      can_view_payment_alerts: user.can_view_payment_alerts,
    };
  }

  function orderPrintEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function orderAccessWhere(s, alias = 'o', siteId = null) {
    const where = [`${alias}.customer_id=?`];
    const params = [s.customer.id];
    if (siteId) {
      where.push(`${alias}.site_id=?`);
      params.push(Number(siteId));
    } else if (s.user) {
      where.push(`(
        ${alias}.site_id IN (SELECT site_id FROM customer_site_users WHERE portal_user_id=? AND customer_id=?)
        OR ${alias}.site_id=?
      )`);
      params.push(s.user.id, s.customer.id, s.user.default_site_id || 0);
    }
    return { where: where.join(' AND '), params };
  }

  function resolveFinanceSiteId(s, rawSiteId) {
    const siteId = Number(rawSiteId || 0);
    if (!siteId) return { ok: true, siteId: null };
    const resolved = resolveAuthorizedSite(s.customer.id, s.user, siteId);
    if (!resolved.ok) return resolved;
    return { ok: true, siteId: resolved.site?.id || null };
  }

  function parsePaymentTermsDays(text) {
    const raw = String(text || '').trim();
    if (!raw) return 0;
    const match = raw.match(/(?:שוטף\s*\+|net\s*)?(\d{1,3})/i);
    return match ? Math.max(0, Number(match[1]) || 0) : 0;
  }

  function dateOnly(value) {
    if (!value) return new Date().toISOString().slice(0, 10);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    return d.toISOString().slice(0, 10);
  }

  function addDays(value, days) {
    const d = new Date(dateOnly(value));
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
  }

  function paymentDueStatus(dueDate) {
    const today = new Date(dateOnly(new Date()));
    const due = new Date(dateOnly(dueDate));
    const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return { status: 'overdue', days: diffDays };
    if (diffDays === 0) return { status: 'due_now', days: 0 };
    if (diffDays <= 30) return { status: 'due_soon', days: diffDays };
    return { status: 'not_due', days: diffDays };
  }

  function customerPaymentAlerts(s, siteId = null) {
    if (!s.caps.canViewPaymentAlerts && !s.caps.canViewInvoices && !s.caps.seePrice) return [];
    const rows = portalInvoices(db, { customerId: s.customer.id, siteIds: s.portal.sites.map(site => site.id), siteId });
    return rows.filter(row => row.amount > 0 && row.dueDate).map(row => {
      const due = paymentDueStatus(row.dueDate);
      return {
        ...row,
        status: due.status,
        days: due.days,
      };
    }).filter(row => row.status !== 'not_due');
  }

  // Auth: get/create customer by phone (walk-in) or by token
  router.post('/c/auth', customerPortalAuthLimiter, (req, res) => {
    const { name } = req.body;
    const rawPhone = String(req.body.phone || '').trim();
    const phone = normalizePortalPhone(rawPhone);
    if (!phone) return res.status(400).json({ error: 'טלפון חובה' });
    // 1) משתמש פורטל קיים (טלפון אישי) → החברה שלו
    let c = null;
    const pu = portalAccess.resolvePortalUser(phone);
    if (pu) c = db.prepare('SELECT * FROM customers WHERE id=?').get(pu.customer_id);
    // 2) טלפון של חברה (legacy)
    if (!c) c = db.prepare('SELECT * FROM customers WHERE phone=? OR phone=?').get(phone, rawPhone);
    // 3) חדש לגמרי → צריך שם → פותח חברה
    if (!c) {
      if (!name) return res.json({ needName: true }); // ask for name first
      const r = db.prepare('INSERT INTO customers (name,phone,price_tier) VALUES (?,?,?)').run(name, phone, 'list');
      c = db.prepare('SELECT * FROM customers WHERE id=?').get(r.lastInsertRowid);
    }
    const otp = issuePortalOtp({ id: c.id, phone }); // OTP לטלפון שהוקלד (לא בהכרח טלפון החברה)
    if (!IS_TEST) {
      intake.sendWhatsApp(phone, `קוד האימות שלך: ${otp.code}`).catch(e => console.warn('[Portal OTP]', e));
    }
    res.json({
      otpRequired: true,
      expiresAt: otp.expiresAt,
      devOtp: IS_TEST || process.env.NODE_ENV !== 'production' ? otp.code : undefined,
      customer: { id: c.id, name: c.name, phone: c.phone }
    });
  });

  router.post('/c/auth/verify', customerPortalAuthLimiter, (req, res) => {
    const phone = normalizePortalPhone(req.body.phone);
    const verified = verifyPortalOtp(phone, req.body.code);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(verified.customerId);
    if (!c) return res.status(401).json({ error: 'Invalid code' });
    // משתמש פורטל + תפקיד + טוקן פר-משתמש (הטלפון יכול להיות אישי, לא של החברה)
    const user = findOrCreatePortalUser(c.id, phone, c.name);
    if (!user || Number(user.active) !== 1) return res.status(403).json({ error: 'גישת המשתמש מושהית. יש לפנות למנהל המערכת לבדיקת הרשאות.' });
    const { token, expiresAt } = issueUserToken(user);
    const freshUser = db.prepare('SELECT * FROM portal_users WHERE id=?').get(user.id);
    const portal = portalContext(c, freshUser);
    const caps = portal.caps;
    res.json({
      token,
      link: portalAccess.portalLink(token, { baseUrl: requestPublicBaseUrl(req) }),
      expiresAt,
      role: portal.role,
      caps,
      portalUser: publicPortalUser(freshUser, portal),
      sites: portal.sites,
      defaultSiteId: portal.defaultSiteId,
      canChooseSite: portal.canChooseSite,
      customer: {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        address: c.address,
        tax_id: c.tax_id,
        payment_terms: c.payment_terms,
        portal_price_list_visibility: c.portal_price_list_visibility,
        price_tier: caps.seePrice ? c.price_tier : undefined
      }
    });
  });

  router.post('/c/auth/password', customerPortalAuthLimiter, (req, res) => {
    const phone = normalizePortalPhone(req.body.phone);
    const password = String(req.body.password || '');
    if (!phone || !password) return res.status(400).json({ error: 'טלפון וסיסמה חובה' });
    const user = portalAccess.resolvePortalUser(phone);
    if (!user || !verifyPortalPassword(user, password)) {
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(user.customer_id);
    if (!customer) return res.status(401).json({ error: 'לקוח לא פעיל' });
    const { token, expiresAt } = issueUserToken(user);
    const portal = portalContext(customer, user);
    const caps = portal.caps;
    res.json({
      token,
      link: portalAccess.portalLink(token, { baseUrl: requestPublicBaseUrl(req) }),
      expiresAt,
      role: portal.role,
      caps,
      portalUser: publicPortalUser(user, portal),
      sites: portal.sites,
      defaultSiteId: portal.defaultSiteId,
      canChooseSite: portal.canChooseSite,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        contact_name: customer.contact_name,
        contact_phone: customer.contact_phone,
        tax_id: customer.tax_id,
        payment_terms: customer.payment_terms,
        portal_price_list_visibility: customer.portal_price_list_visibility,
        price_tier: caps.seePrice ? customer.price_tier : undefined
      }
    });
  });

  router.post('/c/password/change', customerPortalActionLimiter, (req, res) => {
    const s = session(req.body.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (s.supportPreview) return res.status(403).json({ error: 'במצב סיוע לא משנים את סיסמת הלקוח' });
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (s.user.password_hash && !verifyPortalPassword(s.user, oldPassword)) {
      return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
    }
    const result = setPortalPassword(s.user.id, newPassword);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  // Portal user and field-manager delegation
  router.get('/c/users', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canManageUsers) return res.status(403).json({ error: 'אין הרשאה לנהל משתמשים' });
    const users = db.prepare(`
      SELECT id,phone,name,email,role,active,default_site_id,
             can_manage_users,can_create_sites,can_assign_site_users,can_create_orders,can_approve_orders,
             can_view_prices,can_view_budget,can_set_budget,can_approve_budget_overrun,can_view_invoices,can_view_delivery_notes,can_view_payment_alerts
      FROM portal_users
      WHERE customer_id=?
      ORDER BY active DESC, id
    `).all(s.customer.id).map(portalSafeUserRow);
    const assignments = db.prepare(`
      SELECT su.portal_user_id,su.site_id,su.is_default,cs.name AS site_name
      FROM customer_site_users su
      LEFT JOIN customer_sites cs ON cs.id=su.site_id
      WHERE su.customer_id=?
      ORDER BY su.portal_user_id,su.is_default DESC,cs.name
    `).all(s.customer.id);
    res.json({ users, assignments, sites: s.portal.sites, caps: s.caps });
  });

  router.post('/c/users', customerPortalActionLimiter, (req, res) => {
    const s = session(req.body.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canManageUsers) return res.status(403).json({ error: 'אין הרשאה לנהל משתמשים' });
    const phone = normalizePortalPhone(req.body.phone);
    const name = String(req.body.name || '').trim() || null;
    const email = String(req.body.email || '').trim() || null;
    const allowedRoles = ['orderer','approver','both','finance','field_manager','customer_admin'];
    const role = allowedRoles.includes(req.body.role) ? req.body.role : 'field_manager';
    if (!phone) return res.status(400).json({ error: 'טלפון חובה' });

    const siteResult = portalAuthorizedSiteIds(s, req.body.siteIds || (req.body.defaultSiteId ? [req.body.defaultSiteId] : []));
    if (!siteResult.ok) return res.status(siteResult.status).json({ error: siteResult.error });
    const siteIds = siteResult.ids;
    const defaultSiteIdRaw = Number(req.body.defaultSiteId || siteIds[0] || 0);
    const defaultSiteId = siteIds.includes(defaultSiteIdRaw) ? defaultSiteIdRaw : (siteIds[0] || null);

    const flags = {
      can_manage_users: s.caps.canManageUsers && portalBoolFlag(req.body.canManageUsers) ? 1 : 0,
      can_create_sites: s.caps.canCreateSites && portalBoolFlag(req.body.canCreateSites) ? 1 : 0,
      can_assign_site_users: s.caps.canAssignSiteUsers && portalBoolFlag(req.body.canAssignSiteUsers) ? 1 : 0,
      can_create_orders: portalBoolFlag(req.body.canCreateOrders, true),
      can_approve_orders: s.caps.canApprove && portalBoolFlag(req.body.canApproveOrders) ? 1 : 0,
      can_view_prices: s.caps.seePrice && portalBoolFlag(req.body.canViewPrices) ? 1 : 0,
      can_view_budget: s.caps.canViewBudget && portalBoolFlag(req.body.canViewBudget) ? 1 : 0,
      can_set_budget: s.caps.canSetBudget && portalBoolFlag(req.body.canSetBudget) ? 1 : 0,
      can_approve_budget_overrun: s.caps.canApproveBudgetOverrun && portalBoolFlag(req.body.canApproveBudgetOverrun) ? 1 : 0,
      can_view_invoices: s.caps.canViewInvoices && portalBoolFlag(req.body.canViewInvoices) ? 1 : 0,
      can_view_delivery_notes: portalBoolFlag(req.body.canViewDeliveryNotes, true),
      can_view_payment_alerts: s.caps.canViewPaymentAlerts && portalBoolFlag(req.body.canViewPaymentAlerts) ? 1 : 0,
    };

    const existing = db.prepare('SELECT * FROM portal_users WHERE phone=?').get(phone);
    let userId = existing?.id || null;
    if (existing && existing.customer_id !== s.customer.id) {
      return res.status(409).json({ error: 'הטלפון משויך ללקוח אחר' });
    }
    if (existing) {
      db.prepare(`
        UPDATE portal_users SET
          name=COALESCE(?,name),email=COALESCE(?,email),role=?,active=1,default_site_id=?,
          can_manage_users=?,can_create_sites=?,can_assign_site_users=?,can_create_orders=?,can_approve_orders=?,
          can_view_prices=?,can_view_budget=?,can_set_budget=?,can_approve_budget_overrun=?,can_view_invoices=?,can_view_delivery_notes=?,
          can_view_payment_alerts=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND customer_id=?
        `).run(
        name,email,role,defaultSiteId,
        flags.can_manage_users,flags.can_create_sites,flags.can_assign_site_users,flags.can_create_orders,flags.can_approve_orders,
        flags.can_view_prices,flags.can_view_budget,flags.can_set_budget,flags.can_approve_budget_overrun,flags.can_view_invoices,flags.can_view_delivery_notes,
        flags.can_view_payment_alerts,userId,s.customer.id
      );
    } else {
      const r = db.prepare(`
        INSERT INTO portal_users
          (customer_id,phone,name,email,role,default_site_id,can_manage_users,can_create_sites,can_assign_site_users,
           can_create_orders,can_approve_orders,can_view_prices,can_view_budget,can_set_budget,can_approve_budget_overrun,can_view_invoices,
           can_view_delivery_notes,can_view_payment_alerts)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        s.customer.id,phone,name,email,role,defaultSiteId,
        flags.can_manage_users,flags.can_create_sites,flags.can_assign_site_users,flags.can_create_orders,flags.can_approve_orders,
        flags.can_view_prices,flags.can_view_budget,flags.can_set_budget,flags.can_approve_budget_overrun,flags.can_view_invoices,flags.can_view_delivery_notes,
        flags.can_view_payment_alerts
      );
      userId = r.lastInsertRowid;
    }

    db.prepare('DELETE FROM customer_site_users WHERE customer_id=? AND portal_user_id=?').run(s.customer.id, userId);
    const addSite = db.prepare('INSERT OR IGNORE INTO customer_site_users (customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,?)');
    siteIds.forEach(siteId => addSite.run(s.customer.id, siteId, userId, siteId === defaultSiteId ? 1 : 0));
    db.prepare(`
      INSERT INTO customer_portal_permission_audit (customer_id,actor_portal_user_id,target_portal_user_id,action,after_json)
      VALUES (?,?,?,?,?)
    `).run(s.customer.id, s.user?.id || null, userId, existing ? 'portal_user_updated_by_customer' : 'portal_user_created_by_customer', JSON.stringify({ role, defaultSiteId, siteIds, flags }));
    auditSupportAction(s, existing ? 'portal_user_updated' : 'portal_user_created', 'customer', s.customer.id, { portalUserId: userId, role, siteIds, flags });
    res.json({ success: true, id: userId, updated: Boolean(existing) });
  });

  router.post('/c/users/:id/deactivate', customerPortalActionLimiter, (req, res) => {
    const s = session(req.body.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canManageUsers) return res.status(403).json({ error: 'אין הרשאה לנהל משתמשים' });
    const u = db.prepare('SELECT * FROM portal_users WHERE id=? AND customer_id=?').get(req.params.id, s.customer.id);
    if (!u) return res.status(404).json({ error: 'לא נמצא' });
    if (s.user && Number(u.id) === Number(s.user.id)) return res.status(400).json({ error: 'אי אפשר לבטל את המשתמש הנוכחי' });
    db.prepare('UPDATE portal_users SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
    auditSupportAction(s, 'portal_user_deactivated', 'customer', s.customer.id, { portalUserId: u.id, phone: u.phone });
    res.json({ success: true });
  });

  // Get customer info + recent orders
  router.get('/c/me', customerPortalActionLimiter, (req, res) => {
    const { token } = req.query;
    const s = session(token) || upgradeLegacyCustomerToken(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const c = s.customer;
    let orders = db.prepare(`
      SELECT o.id, o.order_num, o.status, o.created_at, o.total_weight, o.billing_weight,
             o.delivery_date, o.portal_price, o.site_id, cs.name AS site_name
      FROM orders o
      LEFT JOIN customer_sites cs ON cs.id=o.site_id
      WHERE o.customer_id=?
        AND (
          ?=0
          OR o.site_id IS NULL
          OR o.site_id IN (SELECT site_id FROM customer_site_users WHERE portal_user_id=?)
          OR o.site_id=?
        )
      ORDER BY o.created_at DESC LIMIT 20
    `).all(c.id, s.user ? 1 : 0, s.user?.id || 0, s.user?.default_site_id || 0);
    const pendingProfileChangeRequest = db.prepare(`
      SELECT id,status,requested_json,created_at,updated_at
      FROM customer_profile_change_requests
      WHERE customer_id=? AND status='pending'
      ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(c.id) || null;
    const projectedOrders = projectOrdersForPortal(orders, s);
    res.json({
      customer: projectCustomerForPortal(c, s, { pendingProfileChangeRequest }),
      role: s.role,
      caps: s.caps,
      portalUser: publicPortalUser(s.user, s.portal),
      sites: s.portal.sites,
      defaultSiteId: s.portal.defaultSiteId,
      canChooseSite: s.portal.canChooseSite,
      token: s.upgradedToken,
      link: s.upgradedLink,
      expiresAt: s.upgradedExpiresAt,
      supportPreview: Boolean(s.supportPreview),
      supportActorUserId: s.supportActorUserId || null,
      supportPreviewExpiresAt: s.supportPreviewExpiresAt || null,
      actionRequired: projectedOrders.filter(order => order.customerStatus === 'awaiting_customer_approval' || order.customerStatus === 'needs_info'),
      activeOrdersSummary: projectedOrders.slice(0, 5),
      orders: projectedOrders
    }); // BUG-40: ללא price_tier/discount_pct
  });

  router.post('/c/profile', customerPortalActionLimiter, (req, res) => {
    const s = session(req.body.token);
    if (!s) return res.status(401).json({ error: 'Unauthorized' });
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim() || null;
    const address = String(req.body.address || '').trim() || null;
    const contactName = String(req.body.contactName || '').trim() || null;
    const contactPhone = String(req.body.contactPhone || '').trim() || null;
    if (!name) return res.status(400).json({ error: 'Customer name required' });
    const current = db.prepare(`
      SELECT id,name,phone,email,address,contact_name,contact_phone,tax_id,payment_terms,portal_price_list_visibility,portal_profile_locked_at
      FROM customers WHERE id=?
    `).get(s.customer.id);
    if (!current) return res.status(404).json({ error: 'Customer not found' });
    const requested = { name, email, address, contactName, contactPhone };
    const currentPublic = { name: current.name, email: current.email, address: current.address, contactName: current.contact_name, contactPhone: current.contact_phone };
    const unchanged = requested.name === currentPublic.name
      && (requested.email || null) === (currentPublic.email || null)
      && (requested.address || null) === (currentPublic.address || null)
      && (requested.contactName || null) === (currentPublic.contactName || null)
      && (requested.contactPhone || null) === (currentPublic.contactPhone || null);
    if (!current.portal_profile_locked_at) {
      db.prepare('UPDATE customers SET name=?,email=?,address=?,contact_name=?,contact_phone=?,portal_profile_locked_at=CURRENT_TIMESTAMP WHERE id=?').run(name, email, address, contactName, contactPhone, s.customer.id);
      const customer = db.prepare(`
        SELECT id,name,phone,email,address,contact_name,contact_phone,tax_id,payment_terms,portal_price_list_visibility,portal_profile_locked_at
        FROM customers WHERE id=?
      `).get(s.customer.id);
      auditSupportAction(s, 'profile_updated', 'customer', s.customer.id, requested);
      return res.json({ success: true, firstUpdate: true, customer });
    }
    if (unchanged) return res.json({ success: true, unchanged: true, customer: current });
    const pending = db.prepare(`
      SELECT id FROM customer_profile_change_requests
      WHERE customer_id=? AND status='pending'
      ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(s.customer.id);
    if (pending) {
      db.prepare(`
        UPDATE customer_profile_change_requests
        SET portal_user_id=?,current_json=?,requested_json=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(s.user?.id || null, JSON.stringify(currentPublic), JSON.stringify(requested), pending.id);
    } else {
      db.prepare(`
        INSERT INTO customer_profile_change_requests (customer_id,portal_user_id,current_json,requested_json)
        VALUES (?,?,?,?)
      `).run(s.customer.id, s.user?.id || null, JSON.stringify(currentPublic), JSON.stringify(requested));
    }
    const requestRow = db.prepare(`
      SELECT id,status,requested_json,created_at,updated_at
      FROM customer_profile_change_requests
      WHERE customer_id=? AND status='pending'
      ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(s.customer.id);
    auditSupportAction(s, 'profile_change_requested', 'customer', s.customer.id, requested);
    res.json({ success: true, pendingApproval: true, customer: current, request: requestRow });
  });

  router.get('/c/sites', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    res.json({
      sites: s.portal.sites,
      defaultSiteId: s.portal.defaultSiteId,
      canChooseSite: s.portal.canChooseSite,
      caps: s.caps,
    });
  });

  router.post('/c/sites', customerPortalActionLimiter, (req, res) => {
    const s = session(req.body.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canCreateSites) {
      return res.status(403).json({ error: 'אין הרשאה לפתוח אתר' });
    }
    const f = req.body || {};
    const name = String(f.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם אתר חובה' });
    const r = db.prepare(`
      INSERT INTO customer_sites
        (customer_id,name,address,city,status,manager_name,manager_phone,budget_amount,budget_kg,alert_pct,block_over_budget,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    `).run(
      s.customer.id,
      name,
      f.address || null,
      f.city || null,
      'active',
      f.managerName || s.user?.name || null,
      f.managerPhone || s.user?.phone || null,
      s.caps.canSetBudget ? Number(f.budgetAmount || 0) : 0,
      s.caps.canSetBudget ? Number(f.budgetKg || 0) : 0,
      80,
      0
    );
    const siteId = r.lastInsertRowid;
    if (s.user) {
      const currentCount = db.prepare('SELECT COUNT(*) AS c FROM customer_site_users WHERE customer_id=? AND portal_user_id=?')
        .get(s.customer.id, s.user.id).c;
      db.prepare('INSERT OR IGNORE INTO customer_site_users (customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,?)')
        .run(s.customer.id, siteId, s.user.id, currentCount ? 0 : 1);
      if (!s.user.default_site_id) {
        db.prepare('UPDATE portal_users SET default_site_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND customer_id=?')
          .run(siteId, s.user.id, s.customer.id);
      }
    }
    db.prepare(`
      INSERT INTO customer_portal_permission_audit (customer_id,actor_portal_user_id,action,after_json)
      VALUES (?,?,?,?)
    `).run(s.customer.id, s.user?.id || null, 'customer_created_site', JSON.stringify({ siteId, name }));
    auditSupportAction(s, 'site_created', 'customer_site', siteId, { name, city: f.city || null, address: f.address || null });
    res.json({ success: true, id: siteId });
  });

  router.get('/c/sites/:siteId/summary', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const resolved = resolveAuthorizedSite(s.customer.id, s.user, req.params.siteId);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    if (!resolved.site) return res.status(404).json({ error: 'לא נמצא אתר ללקוח' });
    const totals = db.prepare(`
      SELECT COUNT(*) AS order_count,
             COALESCE(SUM(total_weight),0) AS ordered_kg,
             COALESCE(SUM(billing_weight),0) AS billing_kg,
             COALESCE(SUM(portal_price),0) AS spend
      FROM orders
      WHERE customer_id=? AND site_id=?
    `).get(s.customer.id, resolved.site.id);
    const summary = {
      site: resolved.site,
      order_count: totals.order_count || 0,
      ordered_kg: Number(totals.ordered_kg || 0),
      billing_kg: Number(totals.billing_kg || 0),
    };
    if (s.caps.seePrice || s.caps.canViewBudget) {
      summary.spend = Number(totals.spend || 0);
      summary.budget_amount = resolved.site.budget_amount || 0;
      summary.budget_kg = resolved.site.budget_kg || 0;
      summary.money_usage_pct = summary.budget_amount ? Math.round(summary.spend / summary.budget_amount * 100) : 0;
      summary.kg_usage_pct = summary.budget_kg ? Math.round(summary.billing_kg / summary.budget_kg * 100) : 0;
    }
    res.json(summary);
  });

  router.get('/c/finance/summary', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!canViewCustomerFinance(s.caps)) return res.json({ financeHidden: true });
    const resolvedSite = resolveFinanceSiteId(s, req.query.siteId);
    if (!resolvedSite.ok) return res.status(resolvedSite.status).json({ error: resolvedSite.error });
    const access = orderAccessWhere(s, 'o', resolvedSite.siteId);
    const totals = db.prepare(`
      SELECT COUNT(*) AS order_count,
             COALESCE(SUM(o.total_weight),0) AS ordered_kg,
             COALESCE(SUM(o.billing_weight),0) AS billing_kg,
             COALESCE(SUM(o.portal_price),0) AS ordered_amount,
             COALESCE(SUM(CASE WHEN o.status LIKE '%אושרה%' THEN o.billing_weight ELSE 0 END),0) AS approved_kg,
             COALESCE(SUM(CASE WHEN o.status LIKE '%אושרה%' THEN o.portal_price ELSE 0 END),0) AS approved_amount
      FROM orders o
      WHERE ${access.where}
    `).get(...access.params);
    const alerts = customerPaymentAlerts(s, resolvedSite.siteId);
    const dueNow = alerts
      .filter(row => row.status === 'due_now' || row.status === 'overdue')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const dueSoon = alerts
      .filter(row => row.status === 'due_soon')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const overBudgetSites = s.portal.sites.filter(site => {
      if (!site.budget_amount && !site.budget_kg) return false;
      const siteAccess = orderAccessWhere(s, 'o', site.id);
      const row = db.prepare(`
        SELECT COALESCE(SUM(o.billing_weight),0) AS kg, COALESCE(SUM(o.portal_price),0) AS amount
        FROM orders o
        WHERE ${siteAccess.where}
      `).get(...siteAccess.params);
      return (site.budget_amount && Number(row.amount || 0) > site.budget_amount)
        || (site.budget_kg && Number(row.kg || 0) > site.budget_kg);
    }).length;
    const summary = {
      orderCount: totals.order_count || 0,
      orderedKg: Number(totals.ordered_kg || 0),
      billingKg: Number(totals.billing_kg || 0),
      approvedKg: Number(totals.approved_kg || 0),
      paymentTerms: s.customer.payment_terms || '',
      dueAlertsCount: alerts.length,
      overBudgetSites,
      canSeeMoney: Boolean(s.caps.seePrice || s.caps.canViewBudget || s.caps.canViewInvoices),
      source: 'recorded_invoices',
      scope: 'authorized_sites',
    };
    if (summary.canSeeMoney) {
      summary.orderedAmount = Number(totals.ordered_amount || 0);
      summary.approvedAmount = Number(totals.approved_amount || 0);
      summary.openDebt = portalInvoices(db, { customerId: s.customer.id, siteIds: s.portal.sites.map(site => site.id), siteId: resolvedSite.siteId }).reduce((sum, invoice) => sum + invoice.amount, 0);
      summary.openExposure = summary.openDebt;
      summary.dueNow = dueNow;
      summary.dueSoon = dueSoon;
    }
    res.json({ summary, caps: s.caps });
  });

  router.get('/c/finance/sites', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!canViewCustomerFinance(s.caps)) return res.json({ financeHidden: true, sites: [] });
    const sites = s.portal.sites.map(site => {
      const access = orderAccessWhere(s, 'o', site.id);
      const totals = db.prepare(`
        SELECT COUNT(*) AS order_count,
               COALESCE(SUM(o.total_weight),0) AS ordered_kg,
               COALESCE(SUM(o.billing_weight),0) AS billing_kg,
               COALESCE(SUM(o.portal_price),0) AS amount
        FROM orders o
        WHERE ${access.where}
      `).get(...access.params);
      const row = {
        id: site.id,
        name: site.name,
        address: site.address,
        city: site.city,
        managerName: site.manager_name,
        orderCount: totals.order_count || 0,
        orderedKg: Number(totals.ordered_kg || 0),
        billingKg: Number(totals.billing_kg || 0),
      };
      if (s.caps.seePrice || s.caps.canViewBudget || s.caps.canViewInvoices) {
        row.amount = Number(totals.amount || 0);
        row.budgetAmount = Number(site.budget_amount || 0);
        row.budgetKg = Number(site.budget_kg || 0);
        row.moneyUsagePct = row.budgetAmount ? Math.round(row.amount / row.budgetAmount * 100) : 0;
        row.kgUsagePct = row.budgetKg ? Math.round(row.billingKg / row.budgetKg * 100) : 0;
        row.overBudget = Boolean((row.budgetAmount && row.amount > row.budgetAmount) || (row.budgetKg && row.billingKg > row.budgetKg));
      }
      return row;
    });
    res.json({ sites, canSeeMoney: Boolean(s.caps.seePrice || s.caps.canViewBudget || s.caps.canViewInvoices), caps: s.caps });
  });

  router.get('/c/finance/payments-due', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canViewPaymentAlerts && !s.caps.canViewInvoices && !s.caps.seePrice) {
      return res.json({ financeHidden: true, payments: [] });
    }
    const resolvedSite = resolveFinanceSiteId(s, req.query.siteId);
    if (!resolvedSite.ok) return res.status(resolvedSite.status).json({ error: resolvedSite.error });
    const payments = customerPaymentAlerts(s, resolvedSite.siteId);
    res.json({
      payments,
      termsDays: parsePaymentTermsDays(s.customer.payment_terms),
      paymentTerms: s.customer.payment_terms || '',
      canSeeMoney: Boolean(s.caps.seePrice || s.caps.canViewInvoices || s.caps.canViewBudget),
    });
  });

  router.get('/c/orders/history', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const resolvedSite = resolveFinanceSiteId(s, req.query.siteId);
    if (!resolvedSite.ok) return res.status(resolvedSite.status).json({ error: resolvedSite.error });
    const access = orderAccessWhere(s, 'o', resolvedSite.siteId);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.min(100000, Math.max(0, Number(req.query.offset) || 0));
    const status = String(req.query.status || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const extra = [];
    const paramsExtra = [];
    if (status) { extra.push('o.status=?'); paramsExtra.push(status); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { extra.push('DATE(o.created_at)>=?'); paramsExtra.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { extra.push('DATE(o.created_at)<=?'); paramsExtra.push(to); }
    const rows = db.prepare(`
      SELECT o.id,o.order_num,o.status,o.created_at,o.delivery_date,o.delivery_time,o.total_weight,o.billing_weight,
             o.portal_price,o.site_id,cs.name AS site_name
      FROM orders o
      LEFT JOIN customer_sites cs ON cs.id=o.site_id
      WHERE ${access.where}${extra.length ? ' AND ' + extra.join(' AND ') : ''}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...access.params, ...paramsExtra, limit, offset);
    res.json({ orders: projectOrdersForPortal(rows, s), caps: s.caps, limit, offset, hasMore: rows.length === limit });

  });

  // Shapes (public)
  router.get('/c/shapes', customerPortalActionLimiter, (req, res) => {
    res.json(db.prepare('SELECT * FROM shapes WHERE active=1 ORDER BY id').all());
  });

  // Price list for this customer
  router.get('/c/price-list', customerPortalActionLimiter, (req, res) => {
    const { token } = req.query;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.seePrice) return res.json({ priceHidden: true, visibility: 'none', items: [] }); // מזמין לא רואה מחירון
    const c = s.customer;
    const doc = pricer.listPortalPriceList(c);
    if (doc.priceHidden) return res.json(doc);
    res.json({
      ...doc,
      customer: {
        name: c.name,
        tax_id: c.tax_id,
        phone: c.phone,
        email: c.email,
        address: c.address,
        payment_terms: c.payment_terms,
      },
      items: doc.items.map(row => ({
        sku: row.sku,
        description: row.description,
        diameter: row.diameter,
        category: row.category,
        unit: row.unit,
        quantity: row.quantity,
        price_per_kg: row.price_per_kg === null ? null : +row.price_per_kg.toFixed(2),
        price: row.price === null ? null : +row.price.toFixed(2),
        status: row.status,
        requiresPriceListUpdate: row.requiresPriceListUpdate,
        warning: row.warning,
        public_note: row.public_note,
      })),
    });
  });

  router.get('/c/guarantee-documents', customerPortalActionLimiter, (req, res) => {
    const { token } = req.query;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    res.json({ documents: portalGuarantees.list(db, { customerId: s.customer.id }) });
  });

  router.post('/c/guarantee-documents', customerPortalActionLimiter, upload.single('file'), (req, res) => {
    const token = req.body.token || req.query.token;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!req.file) return res.status(400).json({ error: 'חסר קובץ להעלאה' });
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (!allowed.has(req.file.mimetype)) {
      return res.status(400).json({ error: 'אפשר להעלות PDF, JPG או PNG בלבד' });
    }
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const r = db.prepare(`
      INSERT INTO customer_guarantee_documents
        (customer_id, portal_user_id, original_name, file_name, mime_type, data_url, size_bytes, status, notes)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      s.customer.id,
      s.user?.id || null,
      req.file.originalname,
      req.file.originalname,
      req.file.mimetype,
      dataUrl,
      req.file.size || req.file.buffer.length || 0,
      'uploaded_pending_review',
      req.body.notes || null
    );
    wsBroadcast('portal_guarantee_uploaded', {
      customerId: s.customer.id,
      documentId: r.lastInsertRowid,
      fileName: req.file.originalname,
      status: 'uploaded_pending_review',
    });
    auditSupportAction(s, 'guarantee_document_uploaded', 'customer', s.customer.id, { documentId: r.lastInsertRowid, fileName: req.file.originalname });
    res.json({ success: true, id: r.lastInsertRowid, status: 'uploaded_pending_review' });
  });

  // Customer order source documents are stored as bytes, not merely copied into notes.
  router.post('/c/orders/:orderId/source-documents', customerPortalActionLimiter, upload.single('file'), (req, res) => {
    const s = session(req.body.token || req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!req.file) return res.status(400).json({ error: 'חסר קובץ להעלאה' });
    const allowedSourceTypes = new Set(['application/pdf','image/jpeg','image/png','text/csv','text/tab-separated-values','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    if (!allowedSourceTypes.has(req.file.mimetype) || req.file.size > 15 * 1024 * 1024) return res.status(400).json({ error: 'סוג או גודל קובץ מקור אינו נתמך' });
    if (!s.caps.canOrder) return res.status(403).json({ error: 'אין הרשאה לצרף מסמכים להזמנה' });
    const access = orderAccessWhere(s);
    const order = db.prepare(`SELECT o.id FROM orders o WHERE o.id=? AND ${access.where}`).get(req.params.orderId, ...access.params);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = db.prepare(`INSERT INTO customer_portal_order_documents
      (order_id,customer_id,portal_user_id,original_name,mime_type,data_url,size_bytes)
      VALUES (?,?,?,?,?,?,?)`).run(order.id, s.customer.id, s.user?.id || null,
      req.file.originalname, req.file.mimetype || 'application/octet-stream', dataUrl,
      req.file.size || req.file.buffer.length || 0);
    auditSupportAction(s, 'order_source_document_uploaded', 'order', order.id, { documentId: result.lastInsertRowid, fileName: req.file.originalname });
    res.status(201).json({ success: true, documentId: result.lastInsertRowid, originalName: req.file.originalname, sizeBytes: req.file.size || req.file.buffer.length || 0 });
  });

  router.get('/c/orders/:orderId/source-documents', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const access = orderAccessWhere(s);
    const order = db.prepare(`SELECT o.id FROM orders o WHERE o.id=? AND ${access.where}`).get(req.params.orderId, ...access.params);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const documents = db.prepare(`SELECT id,original_name,mime_type,size_bytes,uploaded_at
      FROM customer_portal_order_documents WHERE order_id=? AND customer_id=? ORDER BY id DESC`).all(order.id, s.customer.id)
      .map(doc => ({ ...doc, downloadUrl: `/api/c/orders/${order.id}/source-documents/${doc.id}/download?token=${encodeURIComponent(req.query.token)}` }));
    res.json({ documents });
  });

  router.get('/c/orders/:orderId/source-documents/:documentId/download', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const doc = db.prepare(`SELECT * FROM customer_portal_order_documents
      WHERE id=? AND order_id=? AND customer_id=?`).get(req.params.documentId, req.params.orderId, s.customer.id);
    if (!doc) return res.status(404).send('לא נמצא');
    const access = orderAccessWhere(s);
    if (!db.prepare(`SELECT o.id FROM orders o WHERE o.id=? AND ${access.where}`).get(doc.order_id, ...access.params)) return res.status(404).send('לא נמצא');
    const match = /^data:([^;]+);base64,(.*)$/s.exec(doc.data_url || '');
    if (!match) return res.status(410).send('הקובץ אינו זמין');
    res.type(doc.mime_type || match[1]);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
    res.send(Buffer.from(match[2], 'base64'));
  });

  // Quote — calculate price for items before ordering
  router.post('/c/quote', customerPortalActionLimiter, (req, res) => {
    const { token, items } = req.body; // items: [{diameter, sides[], qty}]
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.seePrice) return res.json({ priceHidden: true }); // מזמין לא רואה הצעת מחיר
    const c = s.customer;

    let portalItems;
    try {
      portalItems = normalizePortalOrderItems(items || [], { canCreateOrders: true });
    } catch (err) {
      return portalDraftErrorResponse(res, err);
    }

    const wastePct = portalWastePct();
    const result = pricer.calcOrderPriceForCustomer(portalItems, c, { wastePct });
    res.json({ ...result, wastePct });
  });

  // Submit order from portal
  router.post('/c/order', customerPortalActionLimiter, async (req, res) => {
    const { token, items, deliveryDate, deliveryTime, deliveryAddress, notes, siteId } = req.body;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'נדרש זיהוי' });
    const c = s.customer;
    if (!s.caps.canOrder) return res.status(403).json({ error: 'Portal user cannot create orders' });
    if (!items?.length) return res.status(400).json({ error: 'חסרים פריטים' });
    const idempotencyKey = portalIdempotencyKey(req.body.idempotency_key ?? req.body.idempotencyKey);
    const idempotencyPayload = { items, deliveryDate, deliveryTime, deliveryAddress, notes, siteId };
    const payloadFingerprint = portalPayloadFingerprint(idempotencyPayload);
    const replaySite = resolveAuthorizedSite(c.id, s.user, siteId);
    if (!replaySite.ok) return res.status(replaySite.status).json({ error: replaySite.error });
    if (idempotencyKey) {
      const replay = db.prepare(`SELECT payload_fingerprint,response_json FROM customer_portal_order_idempotency
        WHERE customer_id=? AND portal_user_id IS ? AND idempotency_key=?`).get(s.customer.id, s.user?.id ?? null, idempotencyKey);
      if (replay) {
        if (replay.payload_fingerprint !== payloadFingerprint) return res.status(409).json({ error: 'idempotency_key_conflict', code: 'idempotency_key_conflict' });
        const saved = JSON.parse(replay.response_json);
        return res.json({ ...saved, token, ...(s.caps.seePrice ? {} : { summary: { totalWeight: saved.summary.totalWeight, billingWeight: saved.summary.billingWeight } }), replay: true });
      }
    }

    let portalItems;
    try {
      portalItems = normalizePortalOrderItems(items, { canCreateOrders: s.caps.canOrder });
    } catch (err) {
      return portalDraftErrorResponse(res, err);
    }

    const resolvedSite = resolveAuthorizedSite(c.id, s.user, siteId);
    if (!resolvedSite.ok) return res.status(resolvedSite.status).json({ error: resolvedSite.error });
    const orderSite = resolvedSite.site;

    // Calculate price via pricer service
    const wastePct = portalWastePct();
    const pricing = pricer.calcOrderPriceForCustomer(portalItems, c, { wastePct });
    const missingPrice = pricing.warnings.find(row => row.requiresPriceListUpdate);
    if (missingPrice) {
      return res.status(409).json({
        error: 'מחירון דורש עדכון',
        status: 'price_list_requires_update',
        requiresPriceListUpdate: true,
        diameter: missingPrice.diameter,
        pricingSource: missingPrice.pricingSource,
        pricingLabel: missingPrice.pricingLabel,
      });
    }
    const totalWeight = portalItems.reduce((sum, item) => sum + item.totalWeight, 0);
    const orderNum = generateOrderNum();
    const confirmToken = crypto.randomBytes(16).toString('hex');

    let responsePayload;
    let sideEffects;
    const createOrderTransaction = db.transaction(() => {
    const budget = evaluatePortalBudget({ db, customerId:c.id, siteId:orderSite?.id || null, amount:pricing.billingPrice, kg:totalWeight * (1 + wastePct / 100), exposeFinancialDetails:Boolean(s.caps.seePrice || s.caps.canViewBudget) });
    if (!budget.ok) { const error = new Error(budget.error); error.budgetResult = budget; throw error; }
    const orderRow = db.prepare(`
      INSERT INTO orders (order_num,customer_id,channel,delivery_date,delivery_time,delivery_address,
        priority,general_notes,total_weight,waste_pct_charged,billing_weight,portal_order,status,confirm_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'ממתינה לאישור לקוח',?)
    `).run(orderNum, c.id, 'פורטל לקוח', deliveryDate, deliveryTime, deliveryAddress,
           'רגיל', notes, 0, wastePct, 0, confirmToken);

    const orderId = orderRow.lastInsertRowid;
    if (orderSite?.id) {
      db.prepare('UPDATE orders SET site_id=? WHERE id=? AND customer_id=?').run(orderSite.id, orderId, c.id);
    }
    const palletRow = db.prepare('INSERT INTO pallets (order_id,pallet_num,max_weight) VALUES (?,1,9999)').run(orderId);
    const palletId = palletRow.lastInsertRowid;

    const itemLines = [];
    portalItems.forEach(item => {
      const totalLengthMm = item.totalLengthMm;
      const weight = item.totalWeight;
      const itemRow = db.prepare(`INSERT INTO items (pallet_id,order_id,shape_snapshot_json,shape_id,shape_name,diameter,segments,total_length_mm,quantity,weight_per_unit,total_weight,note,struct_element)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(palletId, orderId, item.shapeSnapshotJson, item.shapeId, item.shapeName, item.diameter, item.segments, totalLengthMm,
             item.quantity, item.weightPerUnit, weight, item.note || '', item.elementName || '');
      db.prepare('UPDATE items SET item_uid=? WHERE id=?').run(buildOrderItemUid(orderId, itemRow.lastInsertRowid), itemRow.lastInsertRowid);
      const itemCustomerDescription = String(item.note || '').trim();
      itemLines.push(`${item.quantity || 1} x D${item.diameter} ${item.elementName || item.shapeName || 'shape'} - ${Math.round(totalLengthMm / 10)} cm${itemCustomerDescription ? ' - ' + itemCustomerDescription : ''}`);
    });
    const billingWeight = totalWeight * (1 + wastePct/100);
    const portalPrice   = pricing.billingPrice;
    db.prepare('UPDATE orders SET total_weight=?,billing_weight=?,portal_price=? WHERE id=?')
      .run(totalWeight, billingWeight, portalPrice, orderId);
    db.prepare('UPDATE orders SET created_by_portal_user_id=?, pricing_snapshot_json=? WHERE id=?')
      .run(s.user?.id || null, JSON.stringify({ wastePct, ...pricing }), orderId);
    db.prepare('UPDATE pallets SET total_weight=? WHERE id=?').run(totalWeight, palletId);

    // Send WhatsApp confirmation with approve link (non-blocking)
    const approveLink = `${portalAccess.configuredBaseUrl(requestPublicBaseUrl(req))}/api/c/approve/${encodeURIComponent(confirmToken)}`;
    const delivInfo = deliveryDate ? `📅 אספקה: ${deliveryDate}${deliveryTime ? ' ' + deliveryTime : ''}` : '';
    const addrInfo  = deliveryAddress ? `📍 ${deliveryAddress}` : '';
    const waMsg = `📋 *הזמנה ${orderNum} – ממתינה לאישורך*\n\nשלום ${c.name},\nקיבלנו את הזמנתך:\n\n${itemLines.join('\n')}\n\n⚖️ משקל לחיוב: ${billingWeight.toFixed(2)} ק"ג\n💰 סה"כ: ₪${portalPrice.toFixed(2)}\n${delivInfo}\n${addrInfo}\n\n*לאישור פרטי ההזמנה ושליחה לבדיקה – לחץ כאן:*\n${approveLink}\n\n_⚠️ ייצור יתחיל רק לאחר בדיקה ואישור פנימי של טנא_`;

    sideEffects = { orderNum, orderId, waMsg, siteId: orderSite?.id || null, itemCount: portalItems.length, totalWeight, portalPrice };

    responsePayload = {
      success: true, orderNum, orderId,
      summary: {
        totalWeight: +totalWeight.toFixed(2),
        billingWeight: +billingWeight.toFixed(2),
        ...(s.caps.seePrice ? { portalPrice: +portalPrice.toFixed(2) } : {})
      },
      token,
      awaitingApproval: true
    };
    if (idempotencyKey) {
      const persistedResponse = { ...responsePayload }; delete persistedResponse.token;
      db.prepare(`INSERT INTO customer_portal_order_idempotency
        (customer_id,portal_user_id,idempotency_key,payload_fingerprint,order_id,response_json)
        VALUES (?,?,?,?,?,?)`).run(c.id, s.user?.id ?? null, idempotencyKey, payloadFingerprint, orderId, JSON.stringify(persistedResponse));
    }
    return responsePayload;
    });
    try {
      createOrderTransaction();
    } catch (err) {
      if (err.budgetResult) return res.status(err.budgetResult.status || 409).json(err.budgetResult);
      if (idempotencyKey && /UNIQUE|constraint/i.test(String(err.message || ''))) {
        const replay = db.prepare(`SELECT payload_fingerprint,response_json FROM customer_portal_order_idempotency
          WHERE customer_id=? AND portal_user_id IS ? AND idempotency_key=?`).get(c.id, s.user?.id ?? null, idempotencyKey);
        if (replay?.payload_fingerprint !== payloadFingerprint) return res.status(409).json({ error: 'idempotency_key_conflict', code: 'idempotency_key_conflict' });
        if (replay) return res.json({ ...JSON.parse(replay.response_json), token, replay: true });
      }
      throw err;
    }
    wsBroadcast('new_order', { orderNum: sideEffects.orderNum, orderId: sideEffects.orderId, channel: 'פורטל לקוח', status: 'ממתינה לאישור לקוח' });
    if (c.phone) intake.sendWhatsApp(c.phone, sideEffects.waMsg).catch(e => console.warn('[Order confirm WA]', e));
    auditSupportAction(s, 'order_created', 'order', sideEffects.orderId, { orderNum: sideEffects.orderNum, siteId: sideEffects.siteId, itemCount: sideEffects.itemCount, totalWeight: sideEffects.totalWeight, portalPrice: sideEffects.portalPrice });
    res.json(responsePayload);
  });

  // Customer order approval (link from WhatsApp)
  router.get('/c/approve/:token', customerPortalActionLimiter, (req, res) => {
    const order = db.prepare('SELECT o.*,c.name as customer_name,c.phone FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.confirm_token=?').get(req.params.token);
    if (!order) return res.status(404).send(approvalPage('לא נמצא', 'קישור לא תקין או פג תוקף.', false));
    if (order.status !== 'ממתינה לאישור לקוח') {
      return res.send(approvalPage('כבר אושרה', `הזמנה ${order.order_num} כבר אושרה ובטיפול!`, true));
    }
    db.prepare('UPDATE orders SET status=?, confirm_token=NULL WHERE id=?').run(ORDER_STATUS.PENDING_APPROVAL, order.id);
    wsBroadcast('order_status', { id: order.id, status: ORDER_STATUS.PENDING_APPROVAL, orderNum: order.order_num });
    // Notify office/finance via WA to the notify phone; customer confirmation is not production approval.
    const notifyPhone = db.prepare("SELECT value FROM settings WHERE key='WHATSAPP_NOTIFY_PHONE'").get()?.value;
    if (notifyPhone) {
      const msg = `📋 הזמנה ${order.order_num} אושרה ע"י הלקוח ${order.customer_name||''} – ממתינה לבדיקה ואישור פנימי.`;
      intake.sendWhatsApp(notifyPhone, msg).catch(()=>{});
    }
    return res.send(approvalPage('✅ פרטי ההזמנה אושרו', `הזמנה ${order.order_num} נשלחה לבדיקה פנימית.\nנעדכן לאחר אישור טנא להמשך עבודה.`, true));
  });

  // Also allow approval from portal (POST)
  router.post('/c/approve', customerPortalActionLimiter, (req, res) => {
    const { token, orderId } = req.body;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    if (!s.caps.canApprove) return res.status(403).json({ error: 'רק מאשר (כספים) יכול לאשר הזמנה' });
    const c = s.customer;
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND customer_id=? AND status=?').get(orderId, c.id, 'ממתינה לאישור לקוח');
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה או כבר אושרה' });
    const authorizedSite = resolveAuthorizedSite(c.id, s.user, order.site_id);
    if (!authorizedSite.ok) return res.status(authorizedSite.status).json({ error: authorizedSite.error });
    db.prepare('UPDATE orders SET status=?, confirm_token=NULL WHERE id=?').run(ORDER_STATUS.PENDING_APPROVAL, orderId);
    wsBroadcast('order_status', { id: orderId, status: ORDER_STATUS.PENDING_APPROVAL, orderNum: order.order_num });
    const notifyPhone = db.prepare("SELECT value FROM settings WHERE key='WHATSAPP_NOTIFY_PHONE'").get()?.value;
    if (notifyPhone) {
      intake.sendWhatsApp(notifyPhone, `📋 הזמנה ${order.order_num} אושרה ע"י הלקוח – ממתינה לבדיקה ואישור פנימי.`).catch(()=>{});
    }
    const projected = projectPortalOrder({ ...order, status: ORDER_STATUS.PENDING_APPROVAL }, portalProjectionCtx(s));
    auditSupportAction(s, 'order_approved', 'order', orderId, { orderNum: order.order_num, status: ORDER_STATUS.PENDING_APPROVAL });
    res.json({ success: true, status: projected.status, customerStatus: projected.customerStatus, customerStatusLabel: projected.customerStatusLabel, productionApproved: false });
  });

  function approvalPage(title, msg, success) {
    const color = success ? '#27ae60' : '#e74c3c';
    const icon  = success ? '✅' : '❌';
    return `<!DOCTYPE html><html lang="he" dir="rtl">
    <head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${title}</title>
    <style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;direction:rtl}
    .box{background:#fff;border-radius:20px;padding:40px 32px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.1);max-width:380px;width:90%}
    .icon{font-size:64px;margin-bottom:16px}
    h1{font-size:22px;color:${color};margin-bottom:12px}
    p{color:#555;font-size:15px;line-height:1.6;white-space:pre-line}
    a{display:inline-block;margin-top:24px;padding:12px 28px;background:#e07b39;color:#fff;border-radius:12px;text-decoration:none;font-weight:700}
    </style></head>
    <body><div class="box">
      <div class="icon">${icon}</div>
      <h1>${title}</h1>
      <p>${msg}</p>
      <a href="/">חזרה לדף הבית</a>
    </div></body></html>`;
  }

  // Customer order history
  router.get('/c/orders/:orderId/print', customerPortalActionLimiter, (req, res) => {
    const s = session(req.query.token);
    if (!s) return res.status(401).send('לא מורשה');
    const access = orderAccessWhere(s, 'o');
    const order = db.prepare(`
      SELECT o.id,o.order_num,o.status,o.created_at,o.delivery_date,o.delivery_address,o.delivery_time,
             o.general_notes AS notes,o.total_weight,o.billing_weight,o.portal_price,o.site_id,cs.name AS site_name
      FROM orders o
      LEFT JOIN customer_sites cs ON cs.id=o.site_id
      WHERE o.id=? AND ${access.where}
    `).get(req.params.orderId, ...access.params);
    if (!order) return res.status(404).send('לא נמצא');
    const safePrintOrder = projectPortalOrder(order, portalProjectionCtx(s));
    const pallets = db.prepare("SELECT id,pallet_num,'' AS notes FROM pallets WHERE order_id=?").all(order.id);
    const rows = [];
    pallets.forEach(pallet => {
      const items = db.prepare(`
        SELECT id,shape_snapshot_json,shape_name,diameter,total_length_mm,quantity,weight_per_unit,total_weight,
               segments,struct_element,struct_floor,sheet_num,note
        FROM items WHERE pallet_id=?
      `).all(pallet.id);
      items.forEach(item => rows.push({ pallet, item: portalPublicItem(item) }));
    });
    const canSeeMoney = Boolean(s.caps.seePrice);
    const itemRows = rows.map(({ item }, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${orderPrintEsc(item.shape_name || 'ישר')}</td>
        <td>${orderPrintEsc(item.diameter || '')}</td>
        <td>${orderPrintEsc(item.total_length_mm == null ? '' : Number(item.total_length_mm) / 10)}</td>
        <td>${orderPrintEsc(item.quantity || '')}</td>
        <td>${orderPrintEsc(item.total_weight ? Number(item.total_weight).toFixed(1) : '')}</td>
        <td>${orderPrintEsc([item.struct_floor,item.struct_element,item.note].filter(Boolean).join(' / '))}</td>
      </tr>
    `).join('');
    const priceHtml = canSeeMoney && order.portal_price ? `
      <div class="totals"><span>משקל לחיוב: ${orderPrintEsc(Number(order.billing_weight || 0).toFixed(2))} ק"ג</span><b>סה"כ לפני מע"מ: ₪${orderPrintEsc(Number(order.portal_price || 0).toLocaleString('he-IL', { minimumFractionDigits: 2 }))}</b></div>
    ` : '';
    res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>הזמנה ${orderPrintEsc(order.order_num)}</title>
      <style>
        body{font-family:Arial,'Segoe UI',sans-serif;margin:0;background:#eef3f8;color:#111827;direction:rtl}
        .page{max-width:920px;margin:24px auto;background:#fff;padding:30px;border:1px solid #d8e2ee}
        .top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:3px solid #0b2a4d;padding-bottom:16px}
        h1{margin:0 0 8px;font-size:28px}.muted{color:#667085;font-size:13px}.logo{height:62px}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.box{border:1px solid #d8e2ee;border-radius:8px;padding:10px}
        table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #d8e2ee;padding:8px;text-align:right;font-size:13px}th{background:#f4f7fb}
        .totals{display:flex;justify-content:space-between;gap:16px;margin-top:18px;border-top:2px solid #0b2a4d;padding-top:12px;font-size:16px}
        .actions{display:flex;justify-content:flex-start;margin:18px 0}.actions button{background:#e46a00;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
        @media print{body{background:#fff}.page{margin:0;max-width:none;border:0}.actions{display:none}}
      </style>
    </head><body><div class="page">
      <div class="actions"><button onclick="window.print()">הדפס / שמור PDF</button></div>
      <div class="top">
        <div><h1>הזמנה ${orderPrintEsc(order.order_num)}</h1><div class="muted">${orderPrintEsc(order.created_at || '')}</div></div>
        <img class="logo" src="/brand/tene-logo.png" alt="טנא">
      </div>
      <div class="grid">
        <div class="box"><b>לקוח</b><br>${orderPrintEsc(s.customer.name || '')}<br>${orderPrintEsc(s.customer.tax_id ? 'ח.פ ' + s.customer.tax_id : '')}</div>
        <div class="box"><b>אתר / אספקה</b><br>${orderPrintEsc(order.site_name || 'ללא אתר')}<br>${orderPrintEsc([order.delivery_date,order.delivery_time,order.delivery_address].filter(Boolean).join(' / '))}</div>
        <div class="box"><b>סטטוס</b><br>${orderPrintEsc(safePrintOrder.status || '')}</div>
        <div class="box"><b>משקל</b><br>${orderPrintEsc(Number(order.billing_weight || order.total_weight || 0).toFixed(1))} ק"ג</div>
      </div>
      <table><thead><tr><th>#</th><th>צורה</th><th>קוטר ברזל (מ"מ)</th><th>אורך (ס"מ)</th><th>כמות</th><th>משקל ק"ג</th><th>שייך ל / תיאור</th></tr></thead><tbody>${itemRows || '<tr><td colspan="7">אין פריטים להצגה</td></tr>'}</tbody></table>
      ${priceHtml}
    </div></body></html>`);
  });

  router.get('/c/orders/:orderId', customerPortalActionLimiter, (req, res) => {
    const { token } = req.query;
    const s = session(token);
    if (!s) return res.status(401).json({ error: 'לא מורשה' });
    const c = s.customer;
    // BUG-42: limited projection — no cost/internal fields exposed to portal
    const order = db.prepare(`
      SELECT o.id,o.order_num,o.status,o.created_at,o.delivery_date,o.delivery_address,o.delivery_time,
             o.general_notes AS notes,o.total_weight,o.billing_weight,o.portal_price,o.site_id,cs.name AS site_name
      FROM orders o
      LEFT JOIN customer_sites cs ON cs.id=o.site_id
      WHERE o.id=? AND ${orderAccessWhere(s, 'o').where}
    `).get(req.params.orderId, ...orderAccessWhere(s, 'o').params);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    const pallets = db.prepare("SELECT id,pallet_num,'' AS notes FROM pallets WHERE order_id=?").all(order.id);
    pallets.forEach(p => {
      p.items = db.prepare(`
        SELECT id,item_uid,shape_snapshot_json,shape_name,diameter,total_length_mm,quantity,weight_per_unit,total_weight,
               segments,struct_element,struct_floor,sheet_num,note
        FROM items WHERE pallet_id=?
      `).all(p.id).map(portalPublicItem);
    });
    const projected = projectPortalOrderDetail(order, pallets, [], portalProjectionCtx(s));
    projected.role = s.role;
    projected.caps = s.caps;
    res.json(projected);
  });

  // ── AI PREDICTION ─────────────────────────────────────────────────


  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'portal',
  label: 'פורטל לקוח',
  consumes: [
    { table: 'customers' },
    { table: 'orders' },
    { table: 'customer_sites' },
    { table: 'customer_site_users' },
    { table: 'pricing_price_books' },
    { table: 'pricing_price_items' },
    { table: 'customer_guarantee_documents' },
  ],
  produces: [
    { event: 'new_order' },
    { event: 'order_status' },
    { event: 'portal_guarantee_uploaded' },
  ],
};

