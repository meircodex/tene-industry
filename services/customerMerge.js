'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateCustomerTaxId, normalizeCustomerTaxId, findCustomersByTaxId, customerIdentityError } = require('./customerIdentity');

const RELATED = Object.freeze({
  orders: 'הזמנות', order_quotes: 'הצעות מחיר', projects: 'פרויקטים', sites: 'אתרים',
  customer_sites: 'אתרי פורטל', portal_users: 'משתמשי פורטל', customer_site_users: 'שיוכי משתמשים לאתרים',
  customer_portal_otps: 'קודי כניסה', customer_guarantee_documents: 'מסמכי ערבויות',
  customer_profile_change_requests: 'בקשות שינוי פרטים', customer_portal_permission_audit: 'יומן הרשאות',
  invoices: 'חשבוניות', delivery_notes: 'תעודות משלוח', delivery_note_orders: 'שיוכי תעודות משלוח',
  credit_transactions: 'תנועות אשראי', credit_accounts: 'חשבונות אשראי', customer_credit: 'בקרת אשראי',
  pricing_price_books: 'מחירונים',
});
const CREDIT = {
  credit_accounts: { amounts: ['current_debt'], config: ['credit_limit', 'payment_terms', 'blocked', 'block_reason'], date: 'last_payment' },
  customer_credit: { amounts: ['open_debt', 'wip_value', 'total_exposure'], config: ['credit_limit', 'payment_terms', 'credit_status'], date: 'last_payment_date' },
};
const PROFILE_FIELDS = ['email', 'address', 'phone', 'contact_name', 'contact_phone', 'payment_terms', 'priority_id'];
const quoteIdentifier = value => '"' + String(value).replace(/"/g, '""') + '"';
const fail = (code, message, status = 409) => { throw customerIdentityError(code, message, status); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const publicCustomer = row => ({ id: row.id, name: row.name, tax_id: row.tax_id, phone: row.phone, email: row.email });
const archivedProfile = row => Object.fromEntries(Object.entries(row).filter(([key]) => !/token|password|secret|pin/i.test(key)));

function createCustomerMergeService(db, options = {}) {
  const secret = options.secret || process.env.JWT_SECRET;
  const backupDir = options.backupDir || process.env.BACKUP_DIR || (db.name && db.name !== ':memory:' ? path.join(path.dirname(path.resolve(db.name)), 'backups') : null);

  function inspect({ sourceId, targetId, taxId }) {
    sourceId = Number(sourceId); targetId = Number(targetId);
    if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) {
      fail('invalid_merge_selection', 'יש לבחור שני כרטיסי לקוח שונים', 400);
    }
    const source = db.prepare('SELECT * FROM customers WHERE id=?').get(sourceId);
    const target = db.prepare('SELECT * FROM customers WHERE id=?').get(targetId);
    if (!source || !target) fail('merge_customer_not_found', 'אחד הכרטיסים אינו קיים או שכבר אוחד. יש לרענן.', 404);
    taxId = validateCustomerTaxId(taxId || target.tax_id || source.tax_id, { required: true });
    const blockers = [];
    for (const customer of [source, target]) {
      if (normalizeCustomerTaxId(customer.tax_id) && normalizeCustomerTaxId(customer.tax_id) !== taxId) blockers.push(`הח.פ בכרטיס #${customer.id} אינו תואם. אין לאחד לקוחות בעלי מזהים שונים.`);
    }
    if (Number(source.company_id || 1) !== Number(target.company_id || 1)) blockers.push('הכרטיסים שייכים לחברות מערכת שונות.');
    if (!normalizeCustomerTaxId(target.tax_id) && findCustomersByTaxId(db, taxId).some(row => ![sourceId, targetId].includes(row.id))) blockers.push('הח.פ משויך גם לכרטיס אחר. יש לבחור אותו ככרטיס הראשי.');
    for (const field of ['price_tier', 'discount_pct', 'payment_terms', 'priority_id']) {
      const a = String(source[field] ?? '').trim(), b = String(target[field] ?? '').trim();
      if (a && b && a !== b) blockers.push(`יש הבדל בהגדרה ${({ price_tier: 'סוג מחירון', discount_pct: 'אחוז הנחה', payment_terms: 'תנאי תשלום', priority_id: 'קוד Priority' })[field]}. יש להסדיר בכרטיסים לפני האיחוד.`);
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const related = {}, links = {}, counts = [], state = crypto.createHash('sha256');
    state.update(JSON.stringify([source, target]));
    for (const table of tables) {
      const columns = db.pragma(`table_info(${quoteIdentifier(table)})`);
      const customerRefs = db.pragma(`foreign_key_list(${quoteIdentifier(table)})`).filter(ref => ref.table === 'customers');
      if (table === 'customer_merge_archive') continue;
      if (!(table in RELATED)) {
        const refs = new Set(customerRefs.map(ref => ref.from));
        if (columns.some(column => column.name === 'customer_id')) refs.add('customer_id');
        for (const column of refs) {
          if (db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)}=? LIMIT 1`).get(sourceId)) blockers.push(`קיים קשר נוסף בטבלה ${table}. נדרשת תמיכה בקשר זה לפני איחוד.`);
        }
        continue;
      }
      // Explicit whitelist: a new schema relationship must not be silently lost.
      if (customerRefs.some(ref => ref.from !== 'customer_id')) blockers.push(`בטבלה ${table} קיים קשר לקוח נוסף שאינו נתמך.`);
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE customer_id IN (?,?) ORDER BY rowid`).all(sourceId, targetId);
      related[table] = rows;
      state.update(table).update(JSON.stringify(rows));
      const sourceRows = rows.filter(row => Number(row.customer_id) === sourceId);
      links[table] = sourceRows.map(row => row.id != null ? { id: row.id } : { delivery_note_id: row.delivery_note_id, order_id: row.order_id });
      if (sourceRows.length) counts.push({ table, label: RELATED[table], source: sourceRows.length, target: rows.length - sourceRows.length });
    }
    const aliases = db.prepare('SELECT * FROM customer_merge_archive WHERE target_customer_id IN (?,?) ORDER BY old_customer_id').all(sourceId, targetId);
    state.update(JSON.stringify(aliases));
    const creditPlans = {};
    for (const [table, config] of Object.entries(CREDIT)) {
      const rows = related[table] || [], from = rows.find(row => row.customer_id === sourceId), to = rows.find(row => row.customer_id === targetId);
      if (rows.some(row => config.amounts.some(field => !Number.isFinite(Number(row[field] || 0))))) blockers.push(`יש ערך כספי לא תקין ב${RELATED[table]}. יש לתקנו לפני האיחוד.`);
      if (!from || !to) continue;
      if (config.config.some(field => String(from[field] ?? '') !== String(to[field] ?? ''))) blockers.push(`קיימת סתירה בתנאי ${RELATED[table]}. יש להסדיר את המסגרת והתנאים לפני האיחוד.`);
      if (config.amounts.some(field => Number(from[field] || 0) !== 0) && config.amounts.some(field => Number(to[field] || 0) !== 0)) blockers.push(`בשני הכרטיסים יש יתרות ב${RELATED[table]}. נדרשת בדיקת כספים; היתרות לא יחוברו אוטומטית.`);
      for (const child of tables) {
        if (db.pragma(`foreign_key_list(${quoteIdentifier(child)})`).some(ref => ref.table === table)) blockers.push(`קיים קשר לחשבון ${RELATED[table]} בטבלה ${child}; יש להסדירו לפני איחוד.`);
      }
      const values = Object.fromEntries(config.amounts.map(field => [field, Number(to[field] || 0) || Number(from[field] || 0)]));
      values[config.date] = [to[config.date], from[config.date]].filter(Boolean).sort().at(-1) || null;
      values.notes = [to.notes, from.notes ? `מכרטיס #${sourceId}: ${from.notes}` : null].filter(Boolean).join('\n');
      creditPlans[table] = { sourceId: from.id, targetId: to.id, values };
    }
    const books = (related.pricing_price_books || []).filter(row => row.status === 'active');
    if (books.some(row => row.customer_id === sourceId) && books.some(row => row.customer_id === targetId)) blockers.push('לשני הכרטיסים יש מחירון לקוח פעיל. יש לבחור מחירון פעיל אחד לפני האיחוד.');
    if ((related.invoices || []).some(row => normalizeCustomerTaxId(row.customer_vat_id) && normalizeCustomerTaxId(row.customer_vat_id) !== taxId)) blockers.push('בחלק מהחשבוניות רשום ח.פ אחר. יש לבדוק את שיוך החשבוניות לפני איחוד.');
    const quotes = related.order_quotes || [];
    for (const quote of quotes.filter(row => !['converted', 'cancelled', 'rejected'].includes(row.status))) {
      try {
        const payload = JSON.parse(quote.payload_json);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.customer) throw new Error('invalid');
        if (payload.customer.id && ![sourceId, targetId].includes(Number(payload.customer.id))) throw new Error('conflicting customer');
      } catch { blockers.push(`הצעת מחיר #${quote.id} מכילה פרטי לקוח לא עקביים. יש לבדוק אותה לפני האיחוד.`); }
    }
    const activeUsers = (related.portal_users || []).filter(row => row.customer_id === sourceId && row.active === 1).length;
    const sourceContacts = ['name', ...PROFILE_FIELDS, 'notes'].filter(field => source[field]).map(field => ({ field, value: source[field] }));
    return { source, target, taxId, blockers: [...new Set(blockers)], counts, related, links, aliases, creditPlans, activeUsers, sourceContacts, fingerprint: state.digest('hex') };
  }

  function sign(payload) {
    if (!secret) fail('merge_unavailable', 'חסר מפתח שרת לאישור האיחוד', 503);
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
  }
  function verify(token, actorId) {
    try {
      if (!secret || typeof token !== 'string' || token.length > 4096) throw new Error('invalid');
      const [body, signature, extra] = token.split('.');
      const expected = crypto.createHmac('sha256', secret).update(body).digest();
      const actual = Buffer.from(signature || '', 'base64url');
      if (extra || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('invalid');
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (parsed.actorId !== Number(actorId) || parsed.expiresAt <= Date.now()) throw new Error('expired');
      return parsed;
    } catch { fail('invalid_merge_preview', 'תצוגת האיחוד פגה או אינה תקינה. יש לטעון תצוגה חדשה.', 409); }
  }

  function preview(input, actorId) {
    if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) fail('merge_actor_required', 'נדרש מנהל מזוהה', 403);
    const plan = inspect(input);
    return {
      source: publicCustomer(plan.source), target: publicCustomer(plan.target), taxId: plan.taxId,
      counts: plan.counts, blockers: plan.blockers, canMerge: !plan.blockers.length,
      sourceContacts: plan.sourceContacts, activePortalUsersToSuspend: plan.activeUsers,
      warnings: [
        'פרטי הכרטיס הראשי נשמרים. פרטי קשר חסרים יושלמו; יתר פרטי הכרטיס הישן יישמרו בהערות ובארכיון.',
        'ייווצר גיבוי מקומי לפני האיחוד. הכרטיס הישן יועבר לארכיון ולא יופיע כלקוח פעיל.',
        'משתמשי הפורטל בכרטיס הישן יושהו וקודי הכניסה יבוטלו. מנהל יצטרך לבדוק הרשאות ולהפעילם מחדש.',
        'בקשות שינוי פרטים ממתינות מהכרטיס הישן ייסגרו. סכומי הזמנות וחשבוניות לא ישתנו.',
      ],
      token: plan.blockers.length ? null : sign({ sourceId: plan.source.id, targetId: plan.target.id, taxId: plan.taxId, fingerprint: plan.fingerprint, actorId: Number(actorId), expiresAt: Date.now() + 5 * 60 * 1000, nonce: crypto.randomUUID() }),
    };
  }

  async function merge(input, actorId) {
    const approved = verify(input.token, actorId);
    if (input.acknowledge !== true || normalizeCustomerTaxId(input.confirmTaxId) !== approved.taxId) fail('merge_confirmation_required', 'יש לאשר שהכרטיסים שייכים לאותו לקוח ולהקליד את הח.פ.', 400);
    const requestKey = digest(input.token);
    const previous = db.prepare('SELECT summary_json FROM customer_merge_log WHERE request_key=?').get(requestKey);
    if (previous) return { ...JSON.parse(previous.summary_json), alreadyMerged: true };
    const initial = inspect(approved);
    if (initial.blockers.length || initial.fingerprint !== approved.fingerprint) fail('stale_merge_preview', 'הנתונים השתנו מאז התצוגה המקדימה. יש לבדוק ולאשר שוב.');
    if (!backupDir) fail('merge_backup_unavailable', 'לא הוגדרה תיקיית גיבוי; האיחוד לא בוצע.', 503);
    const mergeId = crypto.randomUUID();
    const backupName = `customer-merge-${mergeId}.db`;
    const backupPath = path.join(path.resolve(backupDir), backupName);
    try {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await db.backup(backupPath);
      await fs.chmod(backupPath, 0o600);
    } catch { fail('merge_backup_failed', 'הגיבוי נכשל. לא בוצע איחוד ולא שונו כרטיסים.', 503); }

    return db.transaction(() => {
      const repeated = db.prepare('SELECT summary_json FROM customer_merge_log WHERE request_key=?').get(requestKey);
      if (repeated) return { ...JSON.parse(repeated.summary_json), alreadyMerged: true };
      const plan = inspect(approved);
      if (plan.blockers.length || plan.fingerprint !== approved.fingerprint) fail('stale_merge_preview', 'הנתונים השתנו במהלך ההכנה. לא בוצע איחוד; יש לאשר תצוגה חדשה.');
      const sourceId = plan.source.id, targetId = plan.target.id;
      const result = { success: true, mergeId, sourceId, targetId, taxId: plan.taxId, moved: plan.counts, archived: true, backupCreated: true, suspendedPortalUsers: plan.activeUsers };
      const before = { source: archivedProfile(plan.source), target: archivedProfile(plan.target), credit: Object.fromEntries(Object.keys(CREDIT).map(table => [table, plan.related[table] || []])), quotes: (plan.related.order_quotes || []).map(row => ({ id: row.id, payload_json: row.payload_json })) };
      db.prepare('INSERT INTO customer_merge_log (id,request_key,source_id,target_id,tax_id,actor_id,backup_file,summary_json,before_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(mergeId, requestKey, sourceId, targetId, plan.taxId, Number(actorId), backupPath, JSON.stringify(result), JSON.stringify(before));
      db.prepare('INSERT INTO customer_merge_archive (old_customer_id,target_customer_id,merge_id,name,tax_id,profile_json,links_json) VALUES (?,?,?,?,?,?,?)')
        .run(sourceId, targetId, mergeId, plan.source.name, plan.source.tax_id, JSON.stringify(archivedProfile(plan.source)), JSON.stringify(plan.links));
      db.prepare('UPDATE customer_merge_archive SET target_customer_id=? WHERE target_customer_id=?').run(targetId, sourceId);
      db.prepare('UPDATE portal_users SET active=0,token=NULL,token_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE customer_id=?').run(sourceId);
      db.prepare('UPDATE customer_portal_otps SET consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP) WHERE customer_id=?').run(sourceId);
      db.prepare("UPDATE customer_profile_change_requests SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,notes=COALESCE(notes,'') || '\nנסגר בעקבות איחוד לקוחות' WHERE customer_id=? AND status='pending'").run(Number(actorId), sourceId);
      for (const [table, creditPlan] of Object.entries(plan.creditPlans)) {
        const entries = Object.entries(creditPlan.values);
        db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${entries.map(([key]) => quoteIdentifier(key) + '=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([, value]) => value), creditPlan.targetId);
        db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE id=?`).run(creditPlan.sourceId);
      }
      for (const table of Object.keys(plan.related)) db.prepare(`UPDATE ${quoteIdentifier(table)} SET customer_id=? WHERE customer_id=?`).run(targetId, sourceId);
      for (const quote of (plan.related.order_quotes || []).filter(row => !['converted', 'cancelled', 'rejected'].includes(row.status))) {
        const payload = JSON.parse(quote.payload_json);
        payload.customer = { ...payload.customer, id: targetId, name: plan.target.name, taxId: plan.taxId };
        db.prepare('UPDATE order_quotes SET payload_json=?,customer_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(payload), plan.target.name, quote.id);
      }
      // The customer row is retained in the archive and the complete pre-merge
      // database backup. All live references have moved before removing it.
      db.prepare('DELETE FROM customers WHERE id=?').run(sourceId);
      const profile = Object.fromEntries(PROFILE_FIELDS.map(field => [field, plan.target[field] || plan.source[field] || null]));
      profile.tax_id = plan.taxId;
      profile.notes = [plan.target.notes, `אוחד כרטיס #${sourceId}: ${plan.source.name}`, ...plan.sourceContacts.filter(row => row.field !== 'name').map(row => `${row.field}: ${row.value}`)].filter(Boolean).join('\n');
      const entries = Object.entries(profile);
      db.prepare(`UPDATE customers SET ${entries.map(([key]) => quoteIdentifier(key) + '=?').join(',')} WHERE id=?`).run(...entries.map(([, value]) => value), targetId);
      db.prepare('INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,old_value,new_value,notes,user_id) VALUES (?,?,?,?,?,?,?,?)')
        .run('customer', targetId, plan.taxId, 'customer_merge', String(sourceId), String(targetId), `איחוד מתועד ${mergeId}; נוצר גיבוי מקומי`, Number(actorId));
      return result;
    }).immediate();
  }

  return { preview, merge };
}

module.exports = { createCustomerMergeService, RELATED };
