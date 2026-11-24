'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { createSettingsService } = require('../services/settings');
const { createScheduler } = require('../jobs/scheduler');

function setup(t) {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-scheduler-'));
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  ensureCoreSchema(db);
  const settingsService = createSettingsService(db);
  const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertAlert = db.prepare('INSERT INTO alerts (type, level, message, order_id) VALUES (?, ?, ?, ?)');
  const pollEmail = t.mock.fn(async () => []);
  const wsBroadcast = t.mock.fn();
  const scheduler = createScheduler({
    db,
    intake: { pollEmail },
    settingsService,
    getSetting: key => readSetting.get(key)?.value ?? null,
    createAlert: (type, level, message, { orderId }) => insertAlert.run(type, level, message, orderId),
    wsBroadcast,
    dbPath: db.name,
    backupDir,
    isTest: true,
  });
  const upload = t.mock.method(scheduler.backupService, 'run', async () => {});
  t.mock.method(console, 'log', () => {});

  return { db, settingsService, scheduler, pollEmail, wsBroadcast, upload };
}

test('order alerts use default and configured thresholds and appear once per unresolved alert', t => {
  const { db, settingsService, scheduler } = setup(t);
  const insert = db.prepare(`
    INSERT INTO orders (order_num, priority, status, created_at)
    VALUES (?, ?, ?, DATETIME('now', ?))
  `);
  insert.run('1', 'דחוף', 'ממתינה לאישור', '-31 minutes');
  insert.run('2', 'דחוף', 'ממתינה לאישור', '-29 minutes');
  insert.run('3', 'רגיל', 'ממתינה לאישור', '-14 minutes');
  insert.run('4', 'דחוף', 'בייצור', '-60 minutes');
  insert.run('5', 'רגיל', 'ממתינה לאישור', '-16 minutes');

  const alerts = db.prepare(`
    SELECT o.order_num, a.type, a.level, a.message FROM alerts a
    JOIN orders o ON o.id = a.order_id ORDER BY a.id
  `).raw();
  scheduler.runOrderAlerts();
  scheduler.runOrderAlerts();
  const defaultAlerts = [
    ['1', 'urgent_late', 'danger', 'הזמנה דחופה 1 ממתינה לייצור מעל 30 דקות'],
    ['1', 'pending_approval', 'info', 'הזמנה 1 ממתינה לאישור מעל 15 דקות'],
    ['2', 'pending_approval', 'info', 'הזמנה 2 ממתינה לאישור מעל 15 דקות'],
    ['5', 'pending_approval', 'info', 'הזמנה 5 ממתינה לאישור מעל 15 דקות'],
  ];
  assert.deepEqual(alerts.all(), defaultAlerts);

  settingsService.set('URGENT_ORDER_WAIT_MINUTES', 28);
  settingsService.set('PENDING_APPROVAL_WAIT_MINUTES', 13);
  db.prepare("UPDATE alerts SET resolved = 1 WHERE order_id = 1 AND type = 'urgent_late'").run();
  scheduler.runOrderAlerts();
  scheduler.runOrderAlerts();
  assert.deepEqual(alerts.all(), [
    ...defaultAlerts,
    ['1', 'urgent_late', 'danger', 'הזמנה דחופה 1 ממתינה לייצור מעל 28 דקות'],
    ['2', 'urgent_late', 'danger', 'הזמנה דחופה 2 ממתינה לייצור מעל 28 דקות'],
    ['3', 'pending_approval', 'info', 'הזמנה 3 ממתינה לאישור מעל 13 דקות'],
  ]);
});

test('email polling skips a missing host and broadcasts only when intake returns results', async t => {
  const { db, settingsService, scheduler, pollEmail, wsBroadcast } = setup(t);
  await scheduler.runEmailPoll();
  assert.equal(pollEmail.mock.callCount(), 0);

  settingsService.set('EMAIL_IMAP_HOST', 'mail.example.invalid');
  await scheduler.runEmailPoll();
  assert.equal(pollEmail.mock.callCount(), 1);
  const [pollDb, options] = pollEmail.mock.calls[0].arguments;
  assert.equal(pollDb, db);
  assert.equal(options.host, 'mail.example.invalid');
  assert.equal(options.port, 993);
  assert.equal(wsBroadcast.mock.callCount(), 0);

  pollEmail.mock.mockImplementationOnce(async () => [{ id: 1 }, { id: 2 }]);
  await scheduler.runEmailPoll();
  assert.deepEqual(wsBroadcast.mock.calls.map(call => call.arguments), [['new_intake_email', { count: 2 }]]);
});

test('email intake and backup upload failures are logged and swallowed', async t => {
  const { settingsService, scheduler, pollEmail, wsBroadcast, upload } = setup(t);
  settingsService.set('EMAIL_IMAP_HOST', 'mail.example.invalid');
  pollEmail.mock.mockImplementationOnce(async () => { throw new Error('IMAP unavailable'); });
  upload.mock.mockImplementationOnce(async () => { throw new Error('upload unavailable'); });
  const logError = t.mock.method(console, 'error', () => {});

  await scheduler.runEmailPoll();
  await scheduler.runNightlyBackup();

  assert.equal(wsBroadcast.mock.callCount(), 0);
  assert.equal(upload.mock.callCount(), 1);
  assert.deepEqual(logError.mock.calls.map(call => call.arguments), [
    ['[Email cron]', 'IMAP unavailable'],
    ['[Backup]', 'upload unavailable'],
  ]);
});

test('nightly backup keeps the 30 newest databases and uploads again on a same-day rerun', async t => {
  const { db, scheduler, upload } = setup(t);
  const { backupDir } = scheduler;
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-24T02:00:00Z') });
  const oldFiles = Array.from({ length: 30 }, (_, index) => `ironbend-2026-10-${String(index + 1).padStart(2, '0')}.db`);
  const oldest = path.join(backupDir, oldFiles[0]);
  await db.backup(oldest);
  for (const file of oldFiles.slice(1)) fs.copyFileSync(oldest, path.join(backupDir, file));
  fs.writeFileSync(path.join(backupDir, 'README.txt'), 'גיבויים');
  db.prepare('INSERT INTO orders (order_num) VALUES (?)').run('1');

  const current = 'ironbend-2026-11-24.db';
  const expectedFiles = ['README.txt', ...oldFiles.slice(1), current];
  await scheduler.runNightlyBackup();
  assert.deepEqual(fs.readdirSync(backupDir).sort(), expectedFiles);
  assert.equal(upload.mock.callCount(), 1);

  db.prepare('INSERT INTO orders (order_num) VALUES (?)').run('2');
  await scheduler.runNightlyBackup();
  assert.deepEqual(fs.readdirSync(backupDir).sort(), expectedFiles);
  assert.equal(upload.mock.callCount(), 2);

  const snapshot = new Database(path.join(backupDir, current), { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(snapshot.prepare('SELECT order_num FROM orders ORDER BY id').pluck().all(), ['1']);
  } finally {
    snapshot.close();
  }
});
