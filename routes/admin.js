const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/admin missing dependency: ${name}`);
  return value;
}

module.exports = function createAdminRouter(deps) {
  const getDb = required('getDb', deps.getDb);
  const setDb = required('setDb', deps.setDb);
  const Database = required('Database', deps.Database);
  const fs = required('fs', deps.fs);
  const requireRole = required('requireRole', deps.requireRole);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const hashPin = required('hashPin', deps.hashPin);
  const getOpenAiApiKey = required('getOpenAiApiKey', deps.getOpenAiApiKey);
  const getSetting = required('getSetting', deps.getSetting);
  const upload = required('upload', deps.upload);
  const DB_PATH = required('DB_PATH', deps.DB_PATH);
  const snapshotDatabaseFiles = required('snapshotDatabaseFiles', deps.snapshotDatabaseFiles);
  const modbus = required('modbus', deps.modbus);
  const ai = required('ai', deps.ai);
  const statusContracts = required('statusContracts', deps.statusContracts);
  const moduleMap = required('moduleMap', deps.moduleMap);

  const db = () => getDb();
  const settingsService = required('settingsService', deps.settingsService);

  function cleanPin(value, { required = false } = {}) {
    const pin = value == null ? '' : String(value).trim();
    if (!pin && !required) return null;
    if (!/^\d{4}$/.test(pin)) return { error: 'PIN חייב להכיל 4 ספרות' };
    return pin;
  }

  function uniqueTemporaryPin() {
    const users = db().prepare("SELECT pin,pin_hash FROM users WHERE COALESCE(pin_hash,'')<>'' OR COALESCE(pin,'')<>''").all();
    for (let attempt = 0; attempt < 100; attempt++) {
      const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const inUse = users.some(user => user.pin_hash
        ? bcrypt.compareSync(pin, user.pin_hash)
        : String(user.pin || '') === pin);
      if (!inUse) return pin;
    }
    throw new Error('לא ניתן ליצור PIN ייחודי. נסה שוב.');
  }

  function validateUploadedDatabase(req, res, next) {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Database file is required' });
    const tempPath = `${DB_PATH}.validation-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, req.file.buffer);
      const uploadedDb = new Database(tempPath, { readonly: true, fileMustExist: true });
      try {
        const integrity = uploadedDb.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity}`);
        const existing = new Set(uploadedDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        const missing = ['customers', 'orders', 'pallets', 'items', 'users'].filter(table => !existing.has(table));
        if (missing.length) throw new Error(`Missing required tables: ${missing.join(', ')}`);
      } finally {
        uploadedDb.close();
      }
      next();
    } catch (error) {
      res.status(400).json({ ok: false, error: `Invalid database upload: ${error.message}` });
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  function allowDatabaseUpload(req, res, next) {
    if (process.env.ALLOW_DATABASE_UPLOAD !== 'true') {
      return res.status(403).json({ ok: false, error: 'Database upload is disabled. Enable ALLOW_DATABASE_UPLOAD only during a supervised maintenance window.' });
    }
    next();
  }

  router.get('/settings', requireRole('admin'), (req, res) => {
    const rows = db().prepare('SELECT key, value FROM settings').all();
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    const keys = [
      'WHATSAPP_TOKEN','WHATSAPP_PHONE_ID','WHATSAPP_VERIFY_TOKEN','WHATSAPP_NOTIFY_PHONE',
      'EMAIL_IMAP_HOST','EMAIL_IMAP_PORT','EMAIL_IMAP_USER','EMAIL_IMAP_PASS',
      'PRIORITY_BASE_URL','PRIORITY_USER','PRIORITY_PASS','PRIORITY_COMPANY',
      'MAVEN_API_URL','MAVEN_API_TOKEN',
      'OPENAI_API_KEY','OPENAI_MODEL','INTAKE_AI_ENABLED',
      'GOOGLE_VISION_API_KEY',
      'MODULE_MACHINES','MODULE_WHATSAPP','MODULE_EMAIL','MODULE_OCR',
      'MODULE_PRIORITY','MODULE_MAVEN','MODULE_AI','MODULE_ALERTS',
    ];
    const result = {};
    keys.forEach(k => {
      if (k === 'OPENAI_API_KEY') {
        result[k] = getOpenAiApiKey() ? '••••••••' : '';
      } else {
        result[k] = map[k] ?? process.env[k] ?? '';
      }
    });
    res.json(result);
  });

  router.post('/settings', requireRole('admin'), (req, res) => {
    const upsert = db().prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    );
    // Block vendor_only keys — customer admin must not write license/API secrets
    const getVendorOnly = db().prepare(
      "SELECT vendor_only FROM setting_definitions WHERE key=?"
    );
    const blocked = Object.keys(req.body).filter(k => {
      const def = getVendorOnly.get(k);
      return def && def.vendor_only === 1;
    });
    if (blocked.length > 0) {
      return res.status(403).json({ error: 'אין הרשאה לשנות פרמטרים אלה', blocked });
    }
    const save = db().transaction(entries => {
      for (const [k, v] of Object.entries(entries)) {
        upsert.run(k, v ?? '');
      }
    });
    save(req.body);
    res.json({ success: true, saved: Object.keys(req.body).length });
  });

  router.post('/settings/test/:service', requireRole('admin'), async (req, res) => {
    const svc = req.params.service;
    try {
      if (svc === 'whatsapp') {
        const token = getSetting('WHATSAPP_TOKEN');
        const phoneId = getSetting('WHATSAPP_PHONE_ID');
        if (!token || !phoneId) return res.json({ ok: false, msg: 'Token ו-Phone ID חסרים' });
        const axios = require('axios');
        const r = await axios.get(
          `https://graph.facebook.com/v18.0/${phoneId}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        return res.json({ ok: true, msg: `מחובר: ${r.data?.display_phone_number || r.data?.id}` });
      }
      if (svc === 'email') {
        const host = getSetting('EMAIL_IMAP_HOST');
        const user = getSetting('EMAIL_IMAP_USER');
        const pass = getSetting('EMAIL_IMAP_PASS');
        if (!host || !user || !pass) return res.json({ ok: false, msg: 'Host/User/Pass חסרים' });
        let ImapFlow;
        try { ImapFlow = require('imapflow'); } catch { return res.json({ ok: false, msg: 'imapflow לא מותקן (npm install imapflow)' }); }
        const client = new ImapFlow.ImapFlow({
          host, port: Number(getSetting('EMAIL_IMAP_PORT') || 993),
          secure: true, auth: { user, pass }, logger: false,
        });
        await client.connect();
        await client.logout();
        return res.json({ ok: true, msg: `מחובר לתיבה: ${user}` });
      }
      if (svc === 'priority') {
        const base = getSetting('PRIORITY_BASE_URL');
        const user = getSetting('PRIORITY_USER');
        const pass = getSetting('PRIORITY_PASS');
        if (!base) return res.json({ ok: false, msg: 'Base URL חסר' });
        const axios = require('axios');
        const r = await axios.get(`${base}/CUSTOMERS?$top=1`, {
          auth: { username: user, password: pass }, timeout: 8000,
        });
        return res.json({ ok: true, msg: `Priority מגיב (${r.status})` });
      }
      if (svc === 'vision') {
        const key = getOpenAiApiKey();
        if (getSetting('INTAKE_AI_ENABLED') !== 'true') return res.json({ ok: false, msg: 'OpenAI OCR מוגדר אבל כבוי' });
        if (!key) return res.json({ ok: false, msg: 'API Key חסר' });
        return res.json({ ok: true, msg: 'API Key הוגדר ✓ (בדיקה אמיתית דורשת תמונה)' });
      }
      res.json({ ok: false, msg: 'שירות לא מוכר' });
    } catch (err) {
      res.json({ ok: false, msg: err.message });
    }
  });

  router.get('/audit-log', requireRole('manager'), (req, res) => {
    const { entity_type, entity_id, limit = 200, offset = 0 } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (entity_type) { sql += ' AND entity_type=?'; params.push(entity_type); }
    if (entity_id) { sql += ' AND entity_id=?'; params.push(entity_id); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    res.json(db().prepare(sql).all(...params));
  });

  router.get('/users', requireRole('admin'), (req, res) => {
    res.json(db().prepare(`
      SELECT id,username,display_name,role,phone,active,last_login,created_at,
             CASE WHEN COALESCE(pin_hash,'')<>'' OR COALESCE(pin,'')<>'' THEN 1 ELSE 0 END AS pin_configured
      FROM users ORDER BY role,display_name
    `).all());
  });

  router.get('/kiosk/operators', requireAnyRole(['kiosk', 'production', 'manager', 'admin']), (req, res) => {
    res.json(db().prepare(`
      SELECT id,username,display_name,role,active
      FROM users
      WHERE active=1 AND role IN ('operator','kiosk','production','manager','admin')
      ORDER BY role,display_name
    `).all());
  });

  router.post('/users', requireRole('admin'), (req, res) => {
    const { username, display_name, role, pin, phone } = req.body;
    if (!username || !display_name) return res.status(400).json({ error: 'שם משתמש ושם תצוגה חובה' });
    const clean = cleanPin(pin);
    if (clean?.error) return res.status(400).json({ error: clean.error });
    try {
      const r = db().prepare('INSERT INTO users (username,display_name,role,pin,pin_hash,phone,password_changed_at) VALUES (?,?,?,?,?,?,?)')
        .run(username, display_name, role || 'operator', null, hashPin(clean), phone || null, clean ? new Date().toISOString() : null);
      res.json({ id: r.lastInsertRowid });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'שם משתמש קיים' });
      throw e;
    }
  });

  router.patch('/users/:id', requireRole('admin'), (req, res) => {
    const f = req.body;
    const clean = Object.hasOwn(f, 'pin') ? cleanPin(f.pin) : null;
    if (clean?.error) return res.status(400).json({ error: clean.error });
    const changingPin = Boolean(clean);
    db().prepare('UPDATE users SET display_name=COALESCE(?,display_name),role=COALESCE(?,role),pin=CASE WHEN ? THEN NULL ELSE pin END,pin_hash=COALESCE(?,pin_hash),phone=COALESCE(?,phone),active=COALESCE(?,active),password_changed_at=CASE WHEN ? THEN ? ELSE password_changed_at END WHERE id=?')
      .run(f.display_name || null, f.role || null, changingPin ? 1 : 0, hashPin(clean), f.phone || null, f.active ?? null, changingPin ? 1 : 0, changingPin ? new Date().toISOString() : null, req.params.id);
    res.json({ success: true });
  });

  router.post('/users/:id/reset-pin', requireRole('admin'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = db().prepare('SELECT id,username,display_name FROM users WHERE id=?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'המשתמש לא נמצא' });
    const temporaryPin = uniqueTemporaryPin();
    const changedAt = new Date().toISOString();
    db().transaction(() => {
      db().prepare('UPDATE users SET pin=NULL,pin_hash=?,failed_attempts=0,locked_until=NULL,password_changed_at=? WHERE id=?')
        .run(hashPin(temporaryPin), changedAt, user.id);
      db().prepare('INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,notes,user_id,user_name) VALUES (?,?,?,?,?,?,?)')
        .run('user', user.id, user.username, 'pin_reset', 'איפוס PIN על ידי מנהל; הקוד לא נשמר ביומן', Number(req.auth?.sub) || null, req.auth?.display_name || null);
    })();
    res.json({ success: true, user: { id: user.id, display_name: user.display_name }, temporaryPin });
  });

  router.get('/admin/data-audit', requireAnyRole(['manager', 'admin']), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const summary = {
      orders: db().prepare('SELECT COUNT(*) as c FROM orders').get().c,
      pallets: db().prepare('SELECT COUNT(*) as c FROM pallets').get().c,
      items: db().prepare('SELECT COUNT(*) as c FROM items').get().c,
      packages: db().prepare('SELECT COUNT(*) as c FROM packages').get().c,
    };
    const recentOrders = db().prepare(`
      SELECT o.id, o.order_num, o.status, o.created_at, c.name AS customer_name,
             COUNT(i.id) AS item_count,
             COALESCE(SUM(i.quantity), 0) AS qty_total,
             ROUND(COALESCE(SUM(i.total_weight), 0), 3) AS item_weight,
             ROUND(COALESCE(o.total_weight, 0), 3) AS order_weight
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN pallets p ON p.order_id = o.id
      LEFT JOIN items i ON i.pallet_id = p.id
      GROUP BY o.id
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?
    `).all(limit);
    const ordersWithoutItems = db().prepare(`
      SELECT o.id, o.order_num, o.status, o.created_at, c.name AS customer_name,
             ROUND(COALESCE(o.total_weight, 0), 3) AS order_weight
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN pallets p ON p.order_id = o.id
      LEFT JOIN items i ON i.pallet_id = p.id
      GROUP BY o.id
      HAVING COUNT(i.id) = 0
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?
    `).all(limit);
    const palletsWithoutOrders = db().prepare(`
      SELECT p.id, p.order_id, p.pallet_num, p.total_weight, p.status
      FROM pallets p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE o.id IS NULL
      ORDER BY p.id DESC
      LIMIT ?
    `).all(limit);
    const itemsWithoutPallets = db().prepare(`
      SELECT i.id, i.pallet_id, i.shape_name, i.diameter, i.quantity, i.status, i.machine
      FROM items i
      LEFT JOIN pallets p ON p.id = i.pallet_id
      WHERE p.id IS NULL
      ORDER BY i.id DESC
      LIMIT ?
    `).all(limit);
    const palletsWithoutItems = db().prepare(`
      SELECT p.id, p.order_id, p.pallet_num, p.total_weight, p.status, o.order_num
      FROM pallets p
      LEFT JOIN orders o ON o.id = p.order_id
      LEFT JOIN items i ON i.pallet_id = p.id
      GROUP BY p.id
      HAVING COUNT(i.id) = 0
      ORDER BY p.id DESC
      LIMIT ?
    `).all(limit);
    const itemsMissingMachine = db().prepare(`
      SELECT i.id, o.order_num, i.shape_name, i.diameter, i.quantity, i.status
      FROM items i
      JOIN pallets p ON p.id = i.pallet_id
      JOIN orders o ON o.id = p.order_id
      WHERE (i.machine IS NULL OR i.machine = '')
        AND i.status IN (?, ?)
      ORDER BY i.id DESC
      LIMIT ?
    `).all(statusContracts.ITEM_STATUS.WAITING, statusContracts.ITEM_STATUS.IN_PRODUCTION, limit);
    const orderStatus = db().prepare(`
      SELECT status, COUNT(*) AS count
      FROM orders
      GROUP BY status
      ORDER BY count DESC
    `).all();
    const itemStatus = db().prepare(`
      SELECT status, COUNT(*) AS count
      FROM items
      GROUP BY status
      ORDER BY count DESC
    `).all();
    res.json({
      ok: true,
      summary,
      recent_orders: recentOrders,
      anomalies: {
        orders_without_items: ordersWithoutItems,
        pallets_without_orders: palletsWithoutOrders,
        pallets_without_items: palletsWithoutItems,
        items_without_pallets: itemsWithoutPallets,
        items_missing_machine: itemsMissingMachine,
      },
      status_breakdown: { orders: orderStatus, items: itemStatus },
    });
  });

  router.get('/admin/module-map', requireAnyRole(['manager', 'admin']), (req, res) => {
    res.json(moduleMap.snapshot());
  });

  router.get('/admin/database/download', requireRole('admin'), async (req, res) => {
    const downloadPath = `${DB_PATH}.download-${Date.now()}.tmp`;
    try {
      if (!fs.existsSync(DB_PATH)) {
        return res.status(404).json({ ok: false, error: 'קובץ בסיס הנתונים לא נמצא' });
      }
      await db().backup(downloadPath);
      res.download(downloadPath, 'ironbend.db', () => {
        if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      });
    } catch (e) {
      if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/admin/database/upload', requireRole('admin'), allowDatabaseUpload, upload.single('dbFile'), validateUploadedDatabase, async (req, res) => { // BUG-20
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'לא הועלה קובץ' });
      }

      console.log('[Database Migration] מתחיל תהליך שחזור בסיס נתונים מהעלאה...');
      try { db().pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
      try {
        db().close();
        console.log('[Database Migration] חיבור בסיס הנתונים הישן נסגר בבטחה');
      } catch (err) {
        console.warn('[Database Migration] שגיאה בסגירת בסיס הנתונים:', err.message);
      }

      if (fs.existsSync(DB_PATH)) {
        const backupPath = `${DB_PATH}.bak.before-upload-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        snapshotDatabaseFiles(DB_PATH, backupPath);
        console.log(`[Database Migration] גובה קובץ ישן ל-${backupPath}`);
      }

      for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      }
      fs.writeFileSync(DB_PATH, req.file.buffer);
      console.log(`[Database Migration] נכתב קובץ בסיס נתונים חדש ל-${DB_PATH}`);

      const nextDb = new Database(DB_PATH);
      nextDb.pragma('journal_mode = WAL');
      nextDb.pragma('foreign_keys = ON');
      setDb(nextDb);
      modbus.init(nextDb);
      ai.init(nextDb);
      console.log('[Database Migration] בסיס הנתונים החדש נטען ואותחל בהצלחה!');

      res.json({ ok: true, message: 'בסיס הנתונים שוחזר בהצלחה והשרת אותחל מחדש!' });
    } catch (e) {
      console.error('[Database Migration] שגיאה בשחזור:', e);
      try {
        const fallbackDb = new Database(DB_PATH);
        fallbackDb.pragma('journal_mode = WAL');
        fallbackDb.pragma('foreign_keys = ON');
        setDb(fallbackDb);
        modbus.init(fallbackDb);
        ai.init(fallbackDb);
      } catch (_) {}
      res.status(500).json({ ok: false, error: `שגיאה בשחזור בסיס הנתונים: ${e.message}` });
    }
  });

  // ── Settings Control Room ────────────────────────────────────────

  // GET /api/admin/settings — מנהל לקוח רואה רק מה שמותר לו
  router.get('/admin/settings', requireRole('admin'), (req, res) => {
    res.json(settingsService.listForCustomer());
  });

  // PATCH /api/admin/settings/:key — מנהל לקוח משנה ערך
  router.patch('/admin/settings/:key', requireRole('admin'), (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value required' });

    // בדוק שיש הרשאת edit
    const def = db().prepare(
      "SELECT customer_permission, vendor_only, value_type, min_value, max_value FROM setting_definitions WHERE key=?"
    ).get(key);
    if (!def) return res.status(404).json({ error: 'Setting not found' });
    if (def.vendor_only || def.customer_permission !== 'edit') {
      return res.status(403).json({ error: 'אין הרשאה לשנות פרמטר זה' });
    }

    // ולידציה לפי type
    if (def.value_type === 'number' || def.value_type === 'percent' ||
        def.value_type === 'currency' || def.value_type === 'minutes' || def.value_type === 'days') {
      const num = Number(value);
      if (isNaN(num)) return res.status(400).json({ error: 'ערך חייב להיות מספר' });
      if (def.min_value != null && num < def.min_value)
        return res.status(400).json({ error: `ערך מינימלי: ${def.min_value}` });
      if (def.max_value != null && num > def.max_value)
        return res.status(400).json({ error: `ערך מקסימלי: ${def.max_value}` });
    }
    if (def.value_type === 'boolean' && !['true','false','1','0'].includes(String(value))) {
      return res.status(400).json({ error: 'ערך בוליאני חייב להיות true/false' });
    }

    settingsService.set(key, value, { updatedBy: req.userId || null });
    res.json({ success: true, key, value });
  });

  return router;
};

module.exports.manifest = {
  id: 'admin',
  label: 'ניהול מערכת',
  screens: [
    { id: 'admin', path: '/admin.html', label: 'ניהול מערכת', icon: '⚙️', group: 'ניהול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit' },
  },
  consumes: [{ table: 'settings' }, { table: 'users' }, { table: 'audit_log' }],
  produces: [],
};
