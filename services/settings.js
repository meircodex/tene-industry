'use strict';

/**
 * services/settings.js — Control Room Settings Service
 *
 * שלוש שכבות:
 *   vendor_only=1  → רק Tene Industry יכול לשנות (API keys, license)
 *   customer_permission='edit'   → מנהל לקוח יכול לשנות
 *   customer_permission='read'   → מנהל לקוח רואה, לא משנה
 *   customer_permission='hidden' → לא מוצג כלל
 *
 * שימוש:
 *   const settings = createSettingsService(db);
 *   const wastePct = settings.getNum('WASTE_PCT_DEFAULT', 3);
 *   const forAdmin = settings.listForCustomer(); // רק מה שמותר לו
 */

function createSettingsService(db) {
  if (!db) throw new Error('services/settings missing dependency: db');

  // ── Schema migration — מריץ פעם אחת ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS setting_groups (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      icon       TEXT DEFAULT '⚙️',
      sort_order INTEGER DEFAULT 99
    );

    CREATE TABLE IF NOT EXISTS setting_definitions (
      key               TEXT PRIMARY KEY,
      group_id          INTEGER REFERENCES setting_groups(id),
      label             TEXT NOT NULL,
      description       TEXT,
      value_type        TEXT NOT NULL DEFAULT 'string'
                          CHECK (value_type IN ('string','number','boolean','percent','currency','minutes','days','phone','url','password','select')),
      default_value     TEXT,
      min_value         REAL,
      max_value         REAL,
      select_options    TEXT,     -- JSON array e.g. '["list","customer"]'
      unit              TEXT,     -- %, ₪, דקות, ימים...
      vendor_only       INTEGER NOT NULL DEFAULT 0,
      customer_permission TEXT NOT NULL DEFAULT 'hidden'
                          CHECK (customer_permission IN ('edit','read','hidden')),
      sort_order        INTEGER DEFAULT 99
    );
  `);

  // ── הוסף עמודות חסרות ל-settings קיים ──────────────────────────
  try { db.exec(`ALTER TABLE settings ADD COLUMN updated_by TEXT`); } catch {}
  try { db.exec(`ALTER TABLE settings ADD COLUMN customer_permission TEXT DEFAULT 'hidden'`); } catch {}

  // ── Seed groups ──────────────────────────────────────────────────
  const groupSeed = db.prepare(`
    INSERT OR IGNORE INTO setting_groups (id, name, icon, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  [
    [1, 'ייצור',         '🔧', 1],
    [2, 'כספים',         '💰', 2],
    [3, 'התראות',        '⚠️', 3],
    [4, 'פורטל לקוחות', '🌐', 4],
    [5, 'AI / OCR',      '🤖', 5],
    [6, 'WhatsApp',      '💬', 6],
    [7, 'מייל',          '📧', 7],
    [8, 'Priority ERP',  '🔗', 8],
    [9, 'מערכת',         '🖥️', 9],
    [10, 'מיתוג',        '🎨', 10],
  ].forEach(r => groupSeed.run(...r));

  // ── Seed definitions ─────────────────────────────────────────────
  const defSeed = db.prepare(`
    INSERT OR IGNORE INTO setting_definitions
      (key, group_id, label, description, value_type, default_value,
       min_value, max_value, unit, vendor_only, customer_permission, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // key, group_id, label, description, type, default, min, max, unit, vendor_only, customer_permission, sort
  const defs = [
    // ── ייצור ────────────────────────────────────────────────────
    ['WASTE_PCT_DEFAULT',              1, 'אחוז פסולת ברירת מחדל',     'אחוז waste שמחושב על כל הזמנה',             'percent',  '3',    0,   30, '%',     0, 'edit',   1],
    ['URGENT_ORDER_WAIT_MINUTES',      1, 'זמן המתנה לדחוף',           'כמה דקות עד התראה על הזמנה דחופה',          'minutes',  '30',   5,  120, 'דקות', 0, 'edit',   2],
    ['PENDING_APPROVAL_WAIT_MINUTES',  1, 'זמן המתנה לאישור',          'כמה דקות עד התראה על הזמנה ממתינה',         'minutes',  '15',   5,   60, 'דקות', 0, 'edit',   3],

    // ── מיתוג (white-label — הלקוח יכול לערוך) ───────────────────
    ['BRAND_NAME',                     10, 'שם המערכת',                 'השם שמוצג ללקוח בכותרת ובלשונית',           'string',   'טנא תעשיות ברזל בע"מ',  null, null, null, 0, 'edit', 1],
    ['BRAND_LOGO_URL',                 10, 'לוגו (קישור)',              'נתיב או קישור ללוגו המוצג',                 'url',      '/brand/tene-pdf-logo.jpg', null, null, null, 0, 'edit', 2],
    ['BRAND_PRIMARY_COLOR',            10, 'צבע ראשי',                  'צבע מותג ראשי (hex, למשל #2E75B6)',          'string',   '#2E75B6',              null, null, null, 0, 'edit', 3],
    ['BRAND_SUPPORT_PHONE',            10, 'טלפון תמיכה',               'מספר תמיכה שמוצג ללקוח',                    'phone',    '',                     null, null, null, 0, 'edit', 4],

    // ── כספים ────────────────────────────────────────────────────
    ['LABOR_COST_PER_HOUR',            2, 'עלות עבודה לשעה',           'עלות עובד לשעת עבודה',                      'currency', '120',  0, 9999, '₪',    0, 'edit',   1],
    ['OVERHEAD_COST_FACTOR',           2, 'מקדם תקורה',                'מקדם עלויות תקורה (0–1)',                    'number',   '0.15', 0,    1, null,   0, 'edit',   2],
    ['SCRAP_COST_PCT',                 2, 'אחוז עלות פסולת',           'אחוז מהחומר שנחשב כפסולת לעלות',            'percent',  '3',    0,   20, '%',     0, 'edit',   3],

    // ── התראות ───────────────────────────────────────────────────
    ['WEIGHT_TOLERANCE_WARNING_PCT',   3, 'סף אזהרת משקל',             'חריגת משקל באחוזים — רמת אזהרה',            'percent',  '5',    1,   50, '%',     0, 'edit',   1],
    ['WEIGHT_TOLERANCE_CRITICAL_PCT',  3, 'סף קריטי משקל',             'חריגת משקל באחוזים — רמה קריטית',           'percent',  '10',   1,   50, '%',     0, 'edit',   2],
    ['ALERT_WEIGHT_MODULES',           3, 'מודולים לקבלת התראת משקל',  'quality,finance',                            'string',   'quality,finance', null, null, null, 0, 'edit', 3],

    // ── פורטל ────────────────────────────────────────────────────
    ['PORTAL_OTP_TTL_MINUTES',         4, 'תוקף קוד OTP',              'כמה דקות קוד הOTP תקף',                     'minutes',  '10',   2,   60, 'דקות', 0, 'edit',   1],
    ['PORTAL_TOKEN_TTL_DAYS',          4, 'תוקף טוקן לקוח',            'כמה ימים טוקן הפורטל תקף',                  'days',     '90',   1,  365, 'ימים', 0, 'edit',   2],
    ['PORTAL_WASTE_PCT',               4, 'אחוז פסולת בפורטל',         'waste% שמחושב על הזמנות מהפורטל',           'percent',  '3',    0,   20, '%',     0, 'edit',   3],

    // ── AI / OCR ─────────────────────────────────────────────────
    ['INTAKE_AI_ENABLED',              5, 'OCR/AI מופעל',              'האם לאפשר זיהוי מסמכים ותמונות',            'boolean',  'false', null, null, null, 0, 'hidden', 1],
    ['OPENAI_API_KEY',                 5, 'מפתח OpenAI',               'API Key של OpenAI',                          'password', '',  null, null, null,   1, 'hidden', 2],
    ['OPENAI_MODEL',                   5, 'מודל OpenAI',               'מודל AI לשימוש',                             'string',   'gpt-4o-mini', null, null, null, 1, 'hidden', 3],
    ['GOOGLE_VISION_API_KEY',          5, 'מפתח Google Vision',        'API Key של Google Vision',                   'password', '',  null, null, null,   1, 'hidden', 4],
    ['GEMINI_API_KEY',                 5, 'מפתח Gemini',               'API Key של Google Gemini',                   'password', '',  null, null, null,   1, 'hidden', 5],

    // ── WhatsApp ─────────────────────────────────────────────────
    ['WHATSAPP_TOKEN',                 6, 'WhatsApp Token',            'טוקן API של WhatsApp Business',              'password', '',  null, null, null,   1, 'hidden', 1],
    ['WHATSAPP_PHONE_ID',              6, 'WhatsApp Phone ID',         'מזהה מספר הטלפון',                          'string',   '',  null, null, null,   1, 'hidden', 2],
    ['WHATSAPP_VERIFY_TOKEN',          6, 'WhatsApp Verify Token',     'טוקן אימות webhook של Meta',                'password', '',  null, null, null,   1, 'hidden', 3],
    ['WHATSAPP_APP_SECRET',            6, 'WhatsApp App Secret',       'סוד אפליקציה לחתימת webhook',               'password', '',  null, null, null,   1, 'hidden', 4],
    ['WHATSAPP_NOTIFY_PHONE',          6, 'טלפון התראות מפעל',        'מספר WA לקבלת התראות פנימיות',              'phone',    '',  null, null, null,   0, 'hidden', 5],

    // ── מייל ─────────────────────────────────────────────────────
    ['EMAIL_IMAP_HOST',                7, 'שרת IMAP',                  'שרת מייל לקריאת הזמנות',                    'string',   '',  null, null, null,   1, 'hidden', 1],
    ['EMAIL_IMAP_USER',                7, 'משתמש מייל',                'כתובת המייל',                               'string',   '',  null, null, null,   1, 'hidden', 2],
    ['EMAIL_IMAP_PASS',                7, 'סיסמת מייל',                'סיסמה',                                     'password', '',  null, null, null,   1, 'hidden', 3],
    ['EMAIL_IMAP_PORT',                7, 'פורט IMAP',                 'ברירת מחדל: 993',                           'number',   '993', 1, 65535, null, 1, 'hidden', 4],

    // ── Priority ERP ─────────────────────────────────────────────
    ['PRIORITY_BASE_URL',              8, 'כתובת שרת Priority',        'URL בסיס ל-Priority ERP',                   'url',      '',  null, null, null,   1, 'hidden', 1],
    ['PRIORITY_USER',                  8, 'משתמש Priority',            'שם משתמש',                                  'string',   '',  null, null, null,   1, 'hidden', 2],
    ['PRIORITY_PASS',                  8, 'סיסמת Priority',            'סיסמה',                                     'password', '',  null, null, null,   1, 'hidden', 3],

    // ── מערכת ────────────────────────────────────────────────────
    ['BASE_URL',                       9, 'כתובת בסיס המערכת',         'URL חיצוני לקישורים (WA וכד\')',            'url',      '',  null, null, null,   0, 'read',   1],
    ['SUPPORT_PHONE',                  9, 'טלפון תמיכה',               'מספר לתמיכה בדף הנעילה',                    'phone',    '',  null, null, null,   0, 'read',   2],
    ['LICENSE_KEY',                    9, 'מפתח רישיון',               'מפתח ייחודי לקוח מ-Tene Industry',          'password', '',  null, null, null,   1, 'hidden', 3],
    ['LICENSE_SERVER',                 9, 'שרת רישיונות',              'כתובת שרת Tene Industry',                   'url',      'https://license.tene-ind.com', null, null, null, 1, 'hidden', 4],
    ['ACTIVE_INDUSTRY_MODULE',        9, 'מודול תעשייה פעיל',         'איזה מודול תעשייה המערכת מריצה',              'string',   'steel-rebar', null, null, null, 1, 'read',   5],
    ['QR_ACCESS_MODE',                9, 'מצב סריקת QR',               'open=סריקה חופשית; secure=מכשירים אישיים מאושרים בלבד', 'string', 'open', null, null, null, 0, 'edit', 6],
  ];

  defs.forEach(d => defSeed.run(...d));

  // ── Public API ────────────────────────────────────────────────────

  /** קרא ערך — fallback לברירת מחדל מה-definition */
  function get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (row?.value != null) return row.value;
    const def = db.prepare('SELECT default_value FROM setting_definitions WHERE key=?').get(key);
    return def?.default_value ?? fallback;
  }

  /** קרא ערך מספרי */
  function getNum(key, fallback = 0) {
    return Number(get(key, fallback)) || fallback;
  }

  /** קרא ערך בוליאני */
  function getBool(key, fallback = false) {
    const v = get(key, String(fallback));
    return v === 'true' || v === '1';
  }

  /** שמור ערך עם audit */
  function set(key, value, { updatedBy = null } = {}) {
    // On a brand-new database this service is constructed just before the
    // legacy core creates `settings`, so the eager ALTER above may have had
    // nothing to alter yet. Keep writes self-healing for that startup order.
    try { db.exec(`ALTER TABLE settings ADD COLUMN updated_by TEXT`); } catch {}
    db.prepare(`
      INSERT INTO settings (key, value, updated_at, updated_by)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at,
        updated_by=excluded.updated_by
    `).run(key, String(value), updatedBy);
  }

  /** רשימה לתצוגת מנהל לקוח — רק מה שמותר */
  function listForCustomer() {
    return db.prepare(`
      SELECT
        d.key, d.label, d.description, d.value_type,
        d.unit, d.min_value, d.max_value, d.select_options,
        d.customer_permission, d.sort_order,
        g.name AS group_name, g.icon AS group_icon, g.sort_order AS group_sort,
        COALESCE(s.value, d.default_value) AS value
      FROM setting_definitions d
      LEFT JOIN setting_groups g ON g.id = d.group_id
      LEFT JOIN settings s ON s.key = d.key
      WHERE d.customer_permission IN ('edit','read')
        AND d.vendor_only = 0
      ORDER BY g.sort_order, d.sort_order
    `).all();
  }

  /** רשימה מלאה לתצוגת vendor (אתה) */
  function listAll() {
    return db.prepare(`
      SELECT
        d.key, d.label, d.description, d.value_type,
        d.unit, d.min_value, d.max_value, d.vendor_only,
        d.customer_permission, d.sort_order,
        g.name AS group_name, g.icon AS group_icon,
        COALESCE(s.value, d.default_value) AS value
      FROM setting_definitions d
      LEFT JOIN setting_groups g ON g.id = d.group_id
      LEFT JOIN settings s ON s.key = d.key
      ORDER BY g.sort_order, d.sort_order
    `).all();
  }

  /** שנה customer_permission לפרמטר (vendor בלבד) */
  function setPermission(key, permission) {
    const valid = ['edit', 'read', 'hidden'];
    if (!valid.includes(permission)) throw new Error(`Invalid permission: ${permission}`);
    db.prepare('UPDATE setting_definitions SET customer_permission=? WHERE key=?').run(permission, key);
  }

  return { get, getNum, getBool, set, listForCustomer, listAll, setPermission };
}

module.exports = { createSettingsService };
