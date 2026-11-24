'use strict';

/**
 * services/backup.js — Cloud Backup Service
 *
 * כל לילה ב-02:00:
 *   1. גיבוי מקומי קיים (server.js) — ממשיך לרוץ
 *   2. הגיבוי מוצפן עם AES-256-GCM
 *   3. עולה לשרת Tene Industry
 *
 * הלקוח לא צריך שום חשבון ענן.
 * כל הגיבויים מרוכזים אצל Tene Industry.
 *
 * הצפנה: מפתח = HMAC-SHA256(LICENSE_KEY + machineId)
 * כך שרק הגרסה הנכונה של הלקוח יכולה לפענח.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const LICENSE_SERVER = process.env.LICENSE_SERVER || 'https://license.tene-ind.com';
const ALGO           = 'aes-256-gcm';

// ── הצפנה ────────────────────────────────────────────────────────
function deriveKey(licenseKey, machineId) {
  return crypto.createHmac('sha256', licenseKey)
    .update(machineId)
    .digest(); // 32 bytes — מפתח AES-256
}

function encrypt(buffer, key) {
  const iv        = crypto.randomBytes(16);
  const cipher    = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  // פורמט: [iv 16b][authTag 16b][data]
  return Buffer.concat([iv, authTag, encrypted]);
}

// ── העלאה לשרת ───────────────────────────────────────────────────
function uploadToServer(encryptedBuffer, { licenseKey, machineId, filename }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${LICENSE_SERVER}/api/backup/upload`);
    const boundary = `----BackupBoundary${Date.now()}`;

    // multipart/form-data פשוט
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer  = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body    = Buffer.concat([header, encryptedBuffer, footer]);

    const req = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'X-License-Key':  licenseKey,
        'X-Machine-Id':   machineId,
      },
      timeout: 60000, // 60 שניות — מספיק גם לקבצים גדולים
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch {
            reject(new Error('Upload failed: invalid JSON response'));
          }
        } else {
          reject(new Error(`Upload failed: HTTP ${res.statusCode} — ${raw}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Backup Service Factory ────────────────────────────────────────
function createBackupService(db, { dbPath, intake }) {
  if (!db)     throw new Error('services/backup missing dependency: db');
  if (!dbPath) throw new Error('services/backup missing dependency: dbPath');

  function getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
  }

  function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
  }

  function getMachineId() {
    const os   = require('os');
    const macs = Object.values(os.networkInterfaces())
      .flat()
      .filter(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
      .map(i => i.mac)
      .sort();
    return crypto.createHash('sha256')
      .update(`${os.hostname()}:${macs.join(',')}`)
      .digest('hex')
      .slice(0, 32);
  }

  // ── run() — קרא מה-cron ───────────────────────────────────────
  async function run() {
    const licenseKey = getSetting('LICENSE_KEY') || process.env.LICENSE_KEY;

    // פיתוח או ללא license — גיבוי מקומי בלבד
    if (!licenseKey || process.env.NODE_ENV === 'development') {
      console.log('[Backup] Development mode — local backup only, skipping cloud upload');
      return { local: true, cloud: false };
    }

    const stamp    = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const filename = `backup_${stamp}.db.enc`;
    const machineId = getMachineId();

    try {
      // קרא את הDB מהדיסק
      const rawBuffer = fs.readFileSync(dbPath);

      // הצפן
      const key            = deriveKey(licenseKey, machineId);
      const encryptedBuffer = encrypt(rawBuffer, key);

      console.log(`[Backup] Uploading ${filename} (${(encryptedBuffer.length / 1024).toFixed(0)} KB)...`);

      // העלה
      const result = await uploadToServer(encryptedBuffer, { licenseKey, machineId, filename });

      console.log(`[Backup] ✅ Cloud backup complete — ${filename}`);
      setSetting('backup_last_success', new Date().toISOString());
      setSetting('backup_last_file',    filename);

      return { local: true, cloud: true, filename };

    } catch (err) {
      console.error(`[Backup] ❌ Cloud upload failed: ${err.message}`);
      setSetting('backup_last_error',   err.message);
      setSetting('backup_last_error_at', new Date().toISOString());

      // הודע לך (בעל התוכנה) — לא ללקוח
      const notifyPhone = process.env.TENE_NOTIFY_PHONE;
      if (notifyPhone && intake) {
        const customer = getSetting('license_customer') || 'לקוח לא ידוע';
        intake.sendWhatsApp(notifyPhone,
          `⚠️ גיבוי ענן נכשל אצל: ${customer}\nשגיאה: ${err.message}`
        ).catch(() => {});
      }

      return { local: true, cloud: false, error: err.message };
    }
  }

  // ── status() — למסך ה-Admin ───────────────────────────────────
  function status() {
    return {
      lastSuccess:  getSetting('backup_last_success'),
      lastFile:     getSetting('backup_last_file'),
      lastError:    getSetting('backup_last_error'),
      lastErrorAt:  getSetting('backup_last_error_at'),
      cloudEnabled: Boolean(getSetting('LICENSE_KEY') || process.env.LICENSE_KEY),
    };
  }

  return { run, status };
}

module.exports = { createBackupService };
