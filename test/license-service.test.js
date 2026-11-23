const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { createLicenseService } = require('../services/license');

const DAY_MS = 24 * 60 * 60 * 1000;
const LICENSE_KEY = 'local-test-license';

delete process.env.LICENSE_KEY;
delete process.env.SUPPORT_PHONE;

function setup(t, post, settings = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureCoreSchema(db);

  const writeSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settings)) writeSetting.run(key, value);

  const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  return {
    db,
    service: createLicenseService(db, { post }),
    getSetting: key => readSetting.get(key)?.value,
  };
}

function assertAllowed(service) {
  let nextCalls = 0;
  service.middleware({}, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
}

function lockResponse(service) {
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  service.middleware({}, response, () => assert.fail('Locked requests must stop at the middleware'));
  return response;
}

test('free mode skips the license server and clears cached entitlements', async (t) => {
  const post = t.mock.fn();
  const { service, getSetting } = setup(t, post, { license_modules: '["orders"]' });

  assert.deepEqual(await service.check(), { valid: true, plan: 'free' });
  assert.equal(post.mock.callCount(), 0);
  assert.equal(service.getPlan(), 'free');
  assert.equal(getSetting('license_modules'), '');
  assertAllowed(service);
});

test('a valid license permits requests and caches entitlements in settings', async (t) => {
  const entitlements = { modules: ['orders'], package: 'basic', maxUsers: 2 };
  const result = { valid: true, entitlements, activeUsers: 1 };
  const post = t.mock.fn(async () => result);
  const { db, service, getSetting } = setup(t, post, { LICENSE_KEY });
  db.prepare("INSERT INTO users (username, display_name, last_login) VALUES (?, ?, datetime('now'))")
    .run('operator', 'מפעיל');

  assert.deepEqual(await service.check(), { ...result, plan: 'paid' });
  assert.equal(post.mock.callCount(), 1);
  const [url, request] = post.mock.calls[0].arguments;
  assert.equal(new URL(url).pathname, '/api/check');
  assert.equal(request.licenseKey, LICENSE_KEY);
  assert.equal(request.machineId, service.getMachineId());
  assert.equal(request.activeUsers, 1);
  assert.equal(getSetting('license_valid'), '1');
  assert.deepEqual(JSON.parse(getSetting('license_modules')), entitlements.modules);
  assert.equal(getSetting('license_package'), entitlements.package);
  assert.equal(getSetting('license_max_users'), '2');
  assert.equal(getSetting('license_active_users'), '1');
  assertAllowed(service);
});

test('an invalid license returns a Hebrew RTL 503 page with escaped text and a filtered phone link', async (t) => {
  const message = `רישיון > 7 ימים & נדרש "אימות" מחדש < 'תמיכה'`;
  const result = { valid: false, message };
  const post = t.mock.fn(async () => result);
  const { service, getSetting } = setup(t, post, {
    LICENSE_KEY,
    SUPPORT_PHONE: `+972 (3) 555-0100 "תמיכה" & <מרכז> 'ראשי'`,
    license_modules: '["orders"]',
  });

  assert.deepEqual(await service.check(), { ...result, plan: 'locked' });
  assert.equal(getSetting('license_valid'), '0');
  assert.equal(getSetting('license_message'), message);
  assert.equal(getSetting('license_modules'), '');

  const { statusCode, body } = lockResponse(service);
  assert.equal(statusCode, 503);
  assert.ok(body.includes('<html lang="he" dir="rtl">'));
  assert.ok(body.includes('<h1>המערכת נעולה</h1>'));
  assert.ok(body.includes('<p>רישיון &gt; 7 ימים &amp; נדרש &quot;אימות&quot; מחדש &lt; &#39;תמיכה&#39;</p>'));
  assert.ok(body.includes('<a class="contact" href="tel:+9723555-0100">📞 +972 (3) 555-0100 &quot;תמיכה&quot; &amp; &lt;מרכז&gt; &#39;ראשי&#39;</a>'));
});

test('a locked page without a support number displays the fallback contact label', (t) => {
  const { service } = setup(t, t.mock.fn(), { license_plan: 'locked' });

  const { statusCode, body } = lockResponse(service);
  assert.equal(statusCode, 503);
  assert.ok(body.includes('<p>הרישיון פג או אינו תקף.</p>'));
  assert.ok(body.includes('<span class="contact">📞 Tene Industry</span>'));
  assert.doesNotMatch(body, /href="tel:/);
});

test('an offline license at the seven-day limit keeps the last valid check and cached entitlements', async (t) => {
  const now = Date.UTC(2026, 0, 8);
  t.mock.method(Date, 'now', () => now);
  const checkedAt = new Date(now - 7 * DAY_MS).toISOString();
  const post = t.mock.fn(async () => { throw new Error('License server unavailable'); });
  const { service, getSetting } = setup(t, post, {
    LICENSE_KEY,
    license_plan: 'paid',
    license_valid: '1',
    license_checked_at: checkedAt,
    license_modules: '["orders"]',
  });

  assert.deepEqual(await service.check(), { valid: true, plan: 'paid', offline: true, graceDaysLeft: 0 });
  assert.equal(getSetting('license_checked_at'), checkedAt);
  assert.deepEqual(JSON.parse(getSetting('license_modules')), ['orders']);
  assertAllowed(service);
});

test('an offline license past seven days locks the system', async (t) => {
  const now = Date.UTC(2026, 0, 8);
  t.mock.method(Date, 'now', () => now);
  const post = t.mock.fn(async () => { throw new Error('License server unavailable'); });
  const { service, getSetting } = setup(t, post, {
    LICENSE_KEY,
    license_plan: 'paid',
    license_valid: '1',
    license_checked_at: new Date(now - 7 * DAY_MS - 1).toISOString(),
    license_modules: '["orders"]',
  });

  assert.deepEqual(await service.check(), { valid: false, plan: 'locked' });
  assert.equal(getSetting('license_valid'), '0');
  assert.equal(getSetting('license_modules'), '');
  const { statusCode, body } = lockResponse(service);
  assert.equal(statusCode, 503);
  assert.ok(body.includes('הרישיון לא אומת מעל 7 ימים.'));
});
