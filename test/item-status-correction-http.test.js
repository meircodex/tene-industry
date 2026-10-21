'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-status-correction-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-status-correction-test';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(folder, 'qa.db');
process.env.BACKUP_DIR = path.join(folder, 'backups');
const { db, server, closeServer } = require('../server');
const { hashPin } = require('../auth-core');
const { buildDeliveryCertificateProgress } = require('../services/deliveryCertificateProgress');

test('item rollback reconciles work and explicitly cancels unshipped certificates atomically', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => closeServer(resolve)); db.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const role of ['office', 'production']) {
    db.prepare('INSERT INTO users(username,display_name,role,pin_hash,active,password_changed_at) VALUES(?,?,?,?,1,?)').run('qa-' + role, role, role, hashPin('1234', 4), new Date().toISOString());
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa-' + role, pin: '1234' }) });
    tokens[role] = (await login.json()).access_token;
  }
  const request = (url, method = 'GET', body, role = 'office') => fetch(base + '/api' + url, { method, headers: { Authorization: 'Bearer ' + tokens[role], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const customer = db.prepare("INSERT INTO customers(name) VALUES('LOCAL TEST')").run().lastInsertRowid;
  let serial = 0;
  async function fixture({ certificate = true, count = 1 } = {}) {
    const order = Number(db.prepare("INSERT INTO orders(order_num,customer_id,status) VALUES(?,?,'בייצור')").run('STATUS-QA-' + ++serial, customer).lastInsertRowid);
    const pallet = db.prepare('INSERT INTO pallets(order_id,pallet_num) VALUES(?,1)').run(order).lastInsertRowid;
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(Number(db.prepare("INSERT INTO items(pallet_id,order_id,quantity,diameter,total_length_mm,total_weight,segments,status,produced_qty,started_at,completed_at) VALUES(?,?,10,12,2000,20,'[]','הועמס',10,'2026-10-20 08:00','2026-10-20 09:00')").run(pallet, order).lastInsertRowid));
    if (certificate) {
      const preview = await (await request(`/orders/${order}/delivery-certificate-preview`)).json();
      const response = await request(`/orders/${order}/delivery-certificate?certificate_mode=source&issue_key=${preview.issue_key}&selection_fingerprint=${preview.selection_fingerprint}`);
      assert.equal(response.status, 200, await response.clone().text());
    }
    return { order, item: ids[0], ids, note: db.prepare('SELECT * FROM delivery_notes WHERE order_id=?').get(order) };
  }
  const readItem = f => db.prepare('SELECT * FROM items WHERE id=?').get(f.item);
  const orderStatus = f => db.prepare('SELECT status FROM orders WHERE id=?').get(f.order).status;
  const progress = f => buildDeliveryCertificateProgress(db, f.order, db.prepare('SELECT * FROM items WHERE order_id=?').all(f.order));
  async function preview(f, status = 'ממתין') {
    const response = await request(`/items/${f.item}/status-correction-preview?status=${encodeURIComponent(status)}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const patch = (f, body, role) => request(`/items/${f.item}/status`, 'PATCH', body, role);
  const correction = (p, mode = 'keep_documents') => ({ status: p.target_status, expected_status: p.current_status, correction_reason: 'תיקון לצורך המשך עבודה', correction_mode: mode, correction_fingerprint: p.fingerprint });

  await t.test('keep certificate, reopen shipped order, restart production without erasing delivered quantities', async () => {
    const f = await fixture(); const before = readItem(f); const p = await preview(f);
    assert.equal(p.documented_qty, 10); assert.equal(p.can_cancel_certificates, true);
    assert.equal((await patch(f, correction(p))).status, 200);
    assert.equal(readItem(f).status, 'ממתין'); assert.equal(readItem(f).produced_qty, before.produced_qty);
    assert.equal(orderStatus(f), 'אספקה חלקית'); assert.equal(progress(f).shipped_unit_count, 10);
    assert.deepEqual(db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(f.note.id), f.note);
    assert.equal((await patch(f, { status: 'בייצור', expected_status: 'ממתין' })).status, 200);
    assert.equal(readItem(f).status, 'בייצור');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type='order' AND entity_id=? AND action='item_status_correction'").get(f.order).n, 1);
  });
  await t.test('one confirmation cancels the entire selected certificate, restores sibling and enables a new source', async () => {
    const f = await fixture({ count: 2 }); const p = await preview(f);
    assert.equal(p.certificates[0].affected_items.length, 2);
    const response = await patch(f, correction(p, 'cancel_unshipped_certificate'));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).cancelled_certificate_ids, [f.note.id]);
    assert.equal(readItem(f).status, 'ממתין'); assert.equal(orderStatus(f), 'בתור ייצור');
    assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.ids[1]).status, 'הועמס');
    assert.equal(progress(f).remaining_unit_count, 20);
    assert.deepEqual(db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(f.note.id), f.note);
    assert.equal((await patch(f, { status: 'בייצור' })).status, 200);
    assert.equal((await patch(f, { status: 'הועמס' })).status, 200);
    const next = await (await request(`/orders/${f.order}/delivery-certificate-preview`)).json();
    assert.equal(next.loaded_unit_count, 20);
    const issue = await request(`/orders/${f.order}/delivery-certificate?certificate_mode=source&issue_key=${next.issue_key}&selection_fingerprint=${next.selection_fingerprint}`);
    assert.equal(issue.status, 200); assert.equal(progress(f).remaining_unit_count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_note_replacements WHERE cancelled_note_id=?').get(f.note.id).n, 1);
  });
  await t.test('stale preview or new invoice cannot partially cancel or change status', async () => {
    const f = await fixture(); const p = await preview(f);
    db.prepare('UPDATE items SET quantity=11 WHERE id=?').run(f.item);
    assert.equal((await patch(f, correction(p, 'cancel_unshipped_certificate'))).status, 409);
    assert.equal(readItem(f).status, 'נשלח'); assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_note_cancellations WHERE note_id=?').get(f.note.id).n, 0);
    const fresh = await preview(f);
    db.prepare('INSERT INTO invoices(order_id,invoice_num) VALUES(?,?)').run(f.order, 'STATUS-QA-INVOICE');
    assert.equal((await patch(f, correction(fresh, 'cancel_unshipped_certificate'))).status, 409);
    assert.equal(readItem(f).status, 'נשלח');
  });
  await t.test('signed delivery can return to work, but cannot be voided as unshipped', async () => {
    const f = await fixture(); db.prepare("UPDATE delivery_notes SET signed_by='customer' WHERE id=?").run(f.note.id);
    const p = await preview(f, 'הושלם'); assert.equal(p.can_cancel_certificates, false); assert.match(p.certificates[0].blocked_reason, /אישור מסירה/);
    assert.equal((await patch(f, correction(p, 'cancel_unshipped_certificate'))).status, 409);
    assert.equal((await patch(f, correction(p))).status, 200); assert.equal(progress(f).shipped_unit_count, 10);
  });
  await t.test('document cancellation requires office role; stale status is rejected for forward changes too', async () => {
    const f = await fixture(); const p = await preview(f);
    assert.equal((await fetch(base + `/api/items/${f.item}/status-correction-preview?status=${encodeURIComponent('ממתין')}`)).status, 401);
    assert.equal((await patch(f, correction(p, 'cancel_unshipped_certificate'), 'production')).status, 403);
    assert.equal((await patch(f, { status: 'סופק', expected_status: 'הועמס' })).status, 409);
    assert.equal(readItem(f).status, 'נשלח');
  });
  await t.test('failure after document cancellation rolls back every write', async () => {
    const f = await fixture(); const p = await preview(f);
    db.exec(`CREATE TEMP TRIGGER fail_status_correction BEFORE UPDATE OF status ON items WHEN NEW.id=${f.item} AND NEW.status='ממתין' BEGIN SELECT RAISE(ABORT,'QA atomic failure'); END`);
    try {
      assert.equal((await patch(f, correction(p, 'cancel_unshipped_certificate'))).status, 409);
      assert.equal(readItem(f).status, 'נשלח'); assert.equal(orderStatus(f), 'נשלחה');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_note_cancellations WHERE note_id=?').get(f.note.id).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type='delivery_note' AND entity_id=? AND action='cancel_for_correction'").get(f.note.id).n, 0);
    } finally { db.exec('DROP TRIGGER fail_status_correction'); }
  });
  await t.test('previously stuck corrections can restart but approval and cancellation gates remain', async () => {
    const f = await fixture();
    db.prepare("UPDATE items SET status='ממתין' WHERE id=?").run(f.item);
    db.prepare("INSERT INTO audit_log(entity_type,entity_id,action,field_name,old_value,new_value) VALUES('item',?,'item_status_correction','status','נשלח','ממתין')").run(f.item);
    assert.equal((await patch(f, { status: 'בייצור' })).status, 200); assert.equal(orderStatus(f), 'אספקה חלקית');
    const pending = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='ממתינה לאישור' WHERE id=?").run(pending.order);
    db.prepare("UPDATE items SET status='ממתין' WHERE id=?").run(pending.item);
    assert.equal((await patch(pending, { status: 'בייצור' })).status, 409);
    db.prepare("UPDATE orders SET status='בוטלה' WHERE id=?").run(pending.order);
    assert.equal((await patch(pending, { status: 'הושלם' })).status, 409);
  });
  await t.test('completed to hold/waiting/production and loaded to completed keep the work queue usable', async () => {
    for (const status of ['ממתין', 'בייצור', 'בהמתנה', 'הושלם']) {
      const f = await fixture({ certificate: false });
      db.prepare("UPDATE orders SET status='הושלם – ממתין לאיסוף' WHERE id=?").run(f.order);
      const p = await preview(f, status);
      assert.equal((await patch(f, correction(p))).status, 200);
      assert.equal(orderStatus(f), status === 'הושלם' ? 'הושלם – ממתין לאיסוף' : status === 'בייצור' ? 'בייצור' : 'בתור ייצור');
      if (status === 'בהמתנה') assert.equal((await patch(f, { status: 'בייצור' })).status, 200);
    }
  });
  await t.test('active loading remains owned by warehouse while a corrected item can restart', async () => {
    const f = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='בהעמסה' WHERE id=?").run(f.order);
    db.prepare("INSERT INTO order_loading_sessions(session_uid,order_id,order_num,status) VALUES(?,?,'QA','active')").run('QA-ACTIVE-' + f.order, f.order);
    const p = await preview(f);
    assert.equal((await patch(f, correction(p))).status, 200);
    assert.equal(orderStatus(f), 'בהעמסה');
    assert.equal((await patch(f, { status: 'בייצור' })).status, 200);
    assert.equal(orderStatus(f), 'בהעמסה');
  });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no orphaned rows after corrections');
});
