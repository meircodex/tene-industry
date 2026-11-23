'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createBackupService } = require('../services/backup');

function required(name, value) {
  if (!value) throw new Error(`jobs/scheduler missing dependency: ${name}`);
  return value;
}

function createScheduler(deps) {
  const db = required('db', deps.db);
  const intake = required('intake', deps.intake);
  const settingsService = required('settingsService', deps.settingsService);
  const getSetting = required('getSetting', deps.getSetting);
  const createAlert = required('createAlert', deps.createAlert);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const dbPath = required('dbPath', deps.dbPath);
  const isTest = Boolean(deps.isTest);
  const backupDir = deps.backupDir || path.join(deps.rootDir || process.cwd(), 'backups');
  const tasks = [];

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupService = createBackupService(db, { dbPath, intake });

  function schedule(expression, job) {
    if (isTest) return null;
    const task = cron.schedule(expression, job);
    tasks.push(task);
    return task;
  }

  function runOrderAlerts() {
    const urgentMinutes = settingsService.getNum('URGENT_ORDER_WAIT_MINUTES', 30);
    const pendingMinutes = settingsService.getNum('PENDING_APPROVAL_WAIT_MINUTES', 15);
    const urgentDays = urgentMinutes / 1440;
    const pendingDays = pendingMinutes / 1440;

    const urgentLate = db.prepare(`
      SELECT o.id, o.order_num FROM orders o
      WHERE o.priority='דחוף' AND o.status NOT IN ('בייצור','הושלם – ממתין לאיסוף','בדרך ללקוח','סופק – אושר','בוטל')
        AND JULIANDAY('now') - JULIANDAY(o.created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.order_id=o.id AND a.type='urgent_late' AND a.resolved=0)
    `).all(urgentDays);
    urgentLate.forEach(o => createAlert('urgent_late', 'danger', `הזמנה דחופה ${o.order_num} ממתינה לייצור מעל ${urgentMinutes} דקות`, { orderId: o.id }));

    const pendingLong = db.prepare(`
      SELECT o.id, o.order_num FROM orders o
      WHERE o.status='ממתינה לאישור'
        AND JULIANDAY('now') - JULIANDAY(o.created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.order_id=o.id AND a.type='pending_approval' AND a.resolved=0)
    `).all(pendingDays);
    pendingLong.forEach(o => createAlert('pending_approval', 'info', `הזמנה ${o.order_num} ממתינה לאישור מעל ${pendingMinutes} דקות`, { orderId: o.id }));
  }

  async function runEmailPoll() {
    const host = getSetting('EMAIL_IMAP_HOST');
    if (!host) return;
    try {
      const results = await intake.pollEmail(db, {
        host,
        user: getSetting('EMAIL_IMAP_USER'),
        pass: getSetting('EMAIL_IMAP_PASS'),
        port: getSetting('EMAIL_IMAP_PORT') || 993,
        geminiKey: getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY,
      });
      if (results.length) {
        wsBroadcast('new_intake_email', { count: results.length });
        console.log(`[Email] ${results.length} הזמנות חדשות נמצאו`);
      }
    } catch (err) {
      console.error('[Email cron]', err.message);
    }
  }

  async function runNightlyBackup() {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = path.join(backupDir, `ironbend-${stamp}.db`);

      if (!fs.existsSync(dest)) {
        await db.backup(dest);
        console.log(`[Backup] Local backup: ${dest}`);

        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
        if (files.length > 30) fs.unlinkSync(path.join(backupDir, files[0]));
      }

      await backupService.run();
    } catch (err) {
      console.error('[Backup]', err.message);
    }
  }

  schedule('*/5 * * * *', runOrderAlerts);
  schedule('* * * * *', runEmailPoll);
  schedule('0 2 * * *', runNightlyBackup);

  function stop() {
    for (const task of tasks) task.stop?.();
  }

  return { backupDir, backupService, runOrderAlerts, runEmailPoll, runNightlyBackup, stop };
}

module.exports = { createScheduler };
