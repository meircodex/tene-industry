'use strict';

/**
 * services/license.js — License Check Service
 *
 * שלושה מצבים:
 *
 *   FREE    — אין LICENSE_KEY. עובד מלא, ללא הגבלה, ללא ענן.
 *             מתאים ללקוחות בחינם / פיילוט / קוד-פתוח.
 *
 *   PAID    — יש LICENSE_KEY, שרת מאשר. גיבוי ענן פעיל.
 *
 *   LOCKED  — LICENSE_KEY קיים אך לא תקף (פג / בוטל / מחשב שגוי).
 *             כל API מחזיר דף נעילה HTML עם הטלפון לתמיכה.
 *
 * הגדרות (settings table או .env):
 *   LICENSE_KEY     — מפתח ייחודי לכל לקוח (ריק = Free)
 *   LICENSE_SERVER  — ברירת מחדל: https://license.tene-ind.com
 *   SUPPORT_PHONE   — מספר לתמיכה בדף הנעילה
 */

const os     = require('os');
const crypto = require('crypto');
const https  = require('https');

const GRACE_PERIOD_DAYS = 7;
const LICENSE_SERVER    = process.env.LICENSE_SERVER || 'https://license.tene-ind.com';

// ── Machine ID ────────────────────────────────────────────────────
function getMachineId() {
  const hostname = os.hostname();
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
    .map(i => i.mac)
    .sort();
  return crypto.createHash('sha256')
    .update(`${hostname}:${macs.join(',')}`)
    .digest('hex')
    .slice(0, 32);
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpsPost(url, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from license server')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('License server timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Lock Page HTML ────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lockPage(message, supportPhone) {
  const phone = String(supportPhone || 'Tene Industry');
  const dialNumber = phone.replace(/[^0-9+-]/g, '');
  const phoneLabel = escapeHtml(phone);
  const contact = /[0-9]/.test(dialNumber)
    ? `<a class="contact" href="tel:${dialNumber}">📞 ${phoneLabel}</a>`
    : `<span class="contact">📞 ${phoneLabel}</span>`;
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>IronBend — נעול</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #1a1a2e;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; direction: rtl;
    }
    .card {
      background: white; border-radius: 20px;
      padding: 48px 40px; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      max-width: 420px; width: 90%;
    }
    .lock { font-size: 72px; margin-bottom: 16px; }
    h1 { font-size: 22px; color: #2c3e50; margin-bottom: 12px; }
    p  { color: #636e72; font-size: 15px; line-height: 1.7; margin-bottom: 24px; }
    .contact {
      background: #e07b39; color: white;
      padding: 14px 32px; border-radius: 12px;
      font-size: 16px; font-weight: 700;
      text-decoration: none; display: inline-block;
    }
    .version { margin-top: 20px; font-size: 12px; color: #b2bec3; }
  </style>
</head>
<body>
  <div class="card">
    <div class="lock">🔒</div>
    <h1>המערכת נעולה</h1>
    <p>${escapeHtml(message)}</p>
    ${contact}
    <div class="version">IronBend — Tene Industry</div>
  </div>
</body>
</html>`;
}

// ── License Service Factory ───────────────────────────────────────
function createLicenseService(db, { post = httpsPost } = {}) {
  if (!db) throw new Error('services/license missing dependency: db');

  const machineId = getMachineId();

  function getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
  }
  function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
  }

  function activeUsersThisMonth() {
    try {
      return db.prepare(`
        SELECT COUNT(*) AS count
        FROM users
        WHERE last_login >= date('now','start of month')
      `).get().count || 0;
    } catch {
      return 0;
    }
  }

  function cacheEntitlements(entitlements) {
    // License feature modules come from shared/module-catalog.json.
    // Industry modules such as modules/steel-rebar are a separate calculation/rendering axis.
    if (!entitlements || typeof entitlements !== 'object') {
      setSetting('license_modules', '');
      setSetting('license_package', '');
      setSetting('license_max_users', '');
      setSetting('license_users_over', '0');
      setSetting('license_active_users', '0');
      return;
    }

    const modules = Array.isArray(entitlements.modules) ? entitlements.modules : null;
    setSetting('license_modules', modules ? JSON.stringify(modules) : '');
    setSetting('license_package', entitlements.package || '');
    setSetting('license_max_users', entitlements.maxUsers ?? '');
  }

  // ── FREE mode ─────────────────────────────────────────────────
  // אין LICENSE_KEY = מצב חינם, עובד מלא ללא הגבלה
  function isFreeMode() {
    const key = getSetting('LICENSE_KEY') || process.env.LICENSE_KEY;
    return !key;
  }

  // ── בדיקה מול שרת ────────────────────────────────────────────
  async function checkRemote(licenseKey) {
    const activeUsers = activeUsersThisMonth();
    return post(`${LICENSE_SERVER}/api/check`, {
      licenseKey,
      machineId,
      activeUsers,
      version: process.env.npm_package_version || '1.0.0',
    });
  }

  function cacheResult(result) {
    setSetting('license_valid',      result.valid ? '1' : '0');
    setSetting('license_expires_at', result.expiresAt || '');
    setSetting('license_customer',   result.customerName || '');
    setSetting('license_checked_at', new Date().toISOString());
    setSetting('license_message',    result.message || '');
    setSetting('license_plan',       result.valid ? 'paid' : 'locked');
    setSetting('license_users_over', result.usersOverLimit ? '1' : '0');
    setSetting('license_active_users', result.activeUsers ?? activeUsersThisMonth());
    cacheEntitlements(result.valid ? result.entitlements : null);
  }

  function isWithinGracePeriod() {
    const checkedAt = getSetting('license_checked_at');
    if (!checkedAt) return false;
    const days = (Date.now() - new Date(checkedAt).getTime()) / 86400000;
    return days <= GRACE_PERIOD_DAYS;
  }

  // ── check() — קרא בהפעלת השרת ────────────────────────────────
  async function check() {
    if (isFreeMode()) {
      setSetting('license_plan', 'free');
      cacheEntitlements(null);
      console.log('[License] Free mode — no license key, full functionality');
      return { valid: true, plan: 'free' };
    }

    const licenseKey = getSetting('LICENSE_KEY') || process.env.LICENSE_KEY;
    try {
      console.log('[License] Checking license...');
      const result = await checkRemote(licenseKey);
      cacheResult(result);
      if (!result.valid) {
        console.warn(`[License] INVALID — ${result.message}`);
      } else {
        console.log(`[License] ✅ Valid (paid) — ${result.customerName}, expires ${result.expiresAt}`);
      }
      return { ...result, plan: result.valid ? 'paid' : 'locked' };
    } catch (err) {
      console.warn(`[License] Server unreachable (${err.message}) — checking grace period`);
      const cachedValid = getSetting('license_valid') === '1';
      if (cachedValid && isWithinGracePeriod()) {
        const days = Math.floor((Date.now() - new Date(getSetting('license_checked_at')).getTime()) / 86400000);
        const left = GRACE_PERIOD_DAYS - days;
        console.warn(`[License] Offline grace — ${left} days remaining`);
        return { valid: true, plan: 'paid', offline: true, graceDaysLeft: left };
      }
      console.error('[License] Grace period expired — system locked');
      cacheResult({ valid: false, message: 'הרישיון לא אומת מעל 7 ימים. צור קשר עם Tene Industry.' });
      return { valid: false, plan: 'locked' };
    }
  }

  // ── middleware ────────────────────────────────────────────────
  function middleware(req, res, next) {
    const plan = getSetting('license_plan') || 'free';

    // Free או Paid תקין — עובר
    if (plan === 'free' || plan === 'paid') return next();

    // Locked — דף HTML נעילה (לא JSON)
    const message = getSetting('license_message') || 'הרישיון פג או אינו תקף.';
    const phone   = getSetting('SUPPORT_PHONE') || process.env.SUPPORT_PHONE || '';
    return res.status(503).send(lockPage(message, phone));
  }

  return {
    check,
    middleware,
    getMachineId: () => machineId,
    getPlan:      () => getSetting('license_plan') || 'free',
  };
}

module.exports = { createLicenseService };
