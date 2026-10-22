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
  for (const role of ['office', 'production', 'manager']) {
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

  const orderPreview = async (f, status) => {
    const response = await request(`/orders/${f.order}/status-correction-preview?status=${encodeURIComponent(status)}`, 'GET', undefined, 'manager');
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const orderPatch = (f, p, mode = 'keep_documents', role = 'manager') => request(`/orders/${f.order}/status`, 'PATCH', {
    status: p.target_status, expected_status: p.current_status, correction_fingerprint: p.fingerprint,
    correction_reason: 'תיקון הזמנה שנבחרה בטעות', correction_mode: mode,
  }, role);
  await t.test('order rollback returns all advanced items together and permits real production after a certificate', async () => {
    const f = await fixture({ count: 2 });
    db.prepare("UPDATE orders SET status='סופק – אושר' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='סופק' WHERE order_id=?").run(f.order);
    const before = db.prepare('SELECT * FROM items WHERE order_id=? ORDER BY id').all(f.order);
    const p = await orderPreview(f, 'בתור ייצור');
    assert.equal(p.affected_items.length, 2);
    assert.equal((await orderPatch(f, p, 'keep_documents', 'office')).status, 200);
    assert.equal(orderStatus(f), 'בתור ייצור');
    for (const item of db.prepare('SELECT * FROM items WHERE order_id=?').all(f.order)) {
      assert.equal(item.status, 'ממתין'); assert.equal(item.completed_at, null);
      assert.equal(item.produced_qty, before.find(row => row.id === item.id).produced_qty);
    }
    assert.deepEqual(db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(f.note.id), f.note);
    assert.equal(progress(f).shipped_unit_count, 20);
    const queue = await (await request('/production-queue')).json();
    assert.equal(queue.items.filter(item => item.order_id === f.order).length, 2);
    assert.equal((await patch(f, { status: 'בייצור', expected_status: 'ממתין' })).status, 200);
    assert.equal(readItem(f).status, 'בייצור');
  });
  await t.test('order rollback caps each advanced item at the requested stage without advancing unfinished items', async () => {
    for (const [target, itemStatus] of [['ממתינה לאישור','ממתין'],['ממתינה לאישור לקוח','ממתין'],['בתור ייצור','ממתין'],['בייצור','בייצור'],['הושלם – ממתין לאיסוף','הושלם'],['בהעמסה','הועמס'],['בדרך ללקוח','נשלח'],['נשלחה','נשלח']]) {
      const f = await fixture({ count: 2 });
      db.prepare("UPDATE orders SET status='סופק – אושר' WHERE id=?").run(f.order);
      db.prepare("UPDATE items SET status='סופק' WHERE id=?").run(f.item);
      db.prepare("UPDATE items SET status='ממתין' WHERE id=?").run(f.ids[1]);
      const p = await orderPreview(f, target);
      assert.equal((await orderPatch(f, p)).status, 200, target);
      assert.equal(orderStatus(f), target); assert.equal(readItem(f).status, itemStatus);
      assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.ids[1]).status, 'ממתין');
    }
  });
  await t.test('one order correction can cancel an unshipped certificate and release the quantities', async () => {
    const f = await fixture({ count: 2 }); const p = await orderPreview(f, 'בתור ייצור');
    assert.equal(p.can_cancel_certificates, true);
    const response = await orderPatch(f, p, 'cancel_unshipped_certificate', 'office');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).cancelled_certificate_ids, [f.note.id]);
    assert.equal(progress(f).remaining_unit_count, 20); assert.equal(orderStatus(f), 'בתור ייצור');
    assert.ok(db.prepare('SELECT * FROM items WHERE order_id=?').all(f.order).every(item => item.status === 'ממתין'));
  });
  await t.test('stale preview, failed item write and wrong cancellation role leave the whole order unchanged', async () => {
    const f = await fixture({ count: 2 }); let p = await orderPreview(f, 'בתור ייצור');
    db.prepare('UPDATE items SET quantity=11 WHERE id=?').run(f.ids[1]);
    assert.equal((await orderPatch(f, p)).status, 409); assert.equal(orderStatus(f), 'נשלחה');
    p = await orderPreview(f, 'בתור ייצור');
    assert.equal((await orderPatch(f, p, 'cancel_unshipped_certificate', 'production')).status, 403);
    db.exec(`CREATE TEMP TRIGGER fail_order_correction BEFORE UPDATE OF status ON items WHEN NEW.id=${f.ids[1]} AND NEW.status='ממתין' BEGIN SELECT RAISE(ABORT,'QA rollback'); END`);
    try { assert.equal((await orderPatch(f, p, 'cancel_unshipped_certificate')).status, 409); }
    finally { db.exec('DROP TRIGGER fail_order_correction'); }
    assert.equal(orderStatus(f), 'נשלחה'); assert.equal(readItem(f).status, 'נשלח');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_note_cancellations WHERE note_id=?').get(f.note.id).n, 0);
  });
  await t.test('signed or invoiced documents can stay valid while the whole order goes back to work', async () => {
    for (const kind of ['signature', 'invoice']) {
      const f = await fixture();
      if (kind === 'signature') db.prepare("UPDATE delivery_notes SET signed_by='QA customer' WHERE id=?").run(f.note.id);
      else db.prepare('INSERT INTO invoices(order_id,invoice_num) VALUES(?,?)').run(f.order, 'ORDER-ROLLBACK-' + f.order);
      const p = await orderPreview(f, 'בתור ייצור'); assert.equal(p.can_cancel_certificates, false);
      assert.equal((await orderPatch(f, p, 'cancel_unshipped_certificate')).status, 409);
      assert.equal((await orderPatch(f, p)).status, 200); assert.equal(readItem(f).status, 'ממתין');
      assert.equal(progress(f).shipped_unit_count, 10);
    }
  });
  await t.test('order rollback cancels an active loading snapshot, preserves scans and enables restart', async () => {
    const f = await fixture();
    db.prepare("UPDATE orders SET status='בהעמסה' WHERE id=?").run(f.order);
    const sid = db.prepare("INSERT INTO order_loading_sessions(session_uid,order_id,order_num,status,scan_unit) VALUES(?,?,'QA','active','production_card')").run('QA-ORDER-ACTIVE-' + f.order, f.order).lastInsertRowid;
    db.prepare("INSERT INTO order_loading_card_events(session_id,event_type,details_json) VALUES(?,'card_loaded','{}')").run(sid);
    const p = await orderPreview(f, 'בתור ייצור'); assert.deepEqual(p.cancelled_loading_session_ids, [Number(sid)]);
    assert.equal(p.can_cancel_certificates, true);
    assert.equal((await orderPatch(f, p, 'cancel_unshipped_certificate')).status, 200);
    assert.equal(db.prepare('SELECT status FROM order_loading_sessions WHERE id=?').get(sid).status, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM order_loading_card_events WHERE session_id=?').get(sid).n, 2);
    assert.equal((await patch(f, { status: 'בייצור' })).status, 200);
  });
  await t.test('legacy approved orders appear in the single queue and approval permissions remain enforced', async () => {
    const f = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='אושרה – ממתין לייצור' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='ממתין' WHERE id=?").run(f.item);
    assert.equal((await (await request(`/orders/${f.order}`)).json()).status, 'בתור ייצור');
    const list = await (await request('/orders?status=' + encodeURIComponent('בתור ייצור'))).json();
    assert.ok(list.some(order => order.id === f.order && order.status === 'בתור ייצור'));
    assert.equal((await patch(f, { status: 'בייצור' })).status, 200);
    const pending = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='ממתינה לאישור' WHERE id=?").run(pending.order);
    db.prepare("UPDATE items SET status='ממתין' WHERE id=?").run(pending.item);
    assert.equal((await request(`/orders/${pending.order}/status`, 'PATCH', { status: 'בתור ייצור' })).status, 403);
    assert.equal((await request(`/orders/${pending.order}/status`, 'PATCH', { status: 'אושרה – ממתין לייצור' }, 'manager')).status, 200);
    assert.equal(orderStatus(pending), 'בתור ייצור');
    assert.ok(db.prepare('SELECT approved_by FROM orders WHERE id=?').get(pending.order).approved_by);
    const returned = await fixture();
    const ip = await preview(returned); await patch(returned, correction(ip));
    const queue = await (await request('/production-queue')).json();
    assert.ok(queue.items.some(item => item.id === returned.item && item.order_status === 'אספקה חלקית'));
  });


  await t.test('cancelled and stopped items, paid state and completed loading history survive order correction', async () => {
    const f = await fixture({ certificate: false, count: 3 });
    db.prepare("UPDATE orders SET status='נשלחה',payment_status='paid' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='בוטל',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(f.ids[1]);
    db.prepare("UPDATE items SET production_stopped_at=CURRENT_TIMESTAMP WHERE id=?").run(f.ids[2]);
    const sid = db.prepare("INSERT INTO order_loading_sessions(session_uid,order_id,order_num,status) VALUES(?,?,'QA','completed')").run('QA-COMPLETED-' + f.order, f.order).lastInsertRowid;
    const p = await orderPreview(f, 'בתור ייצור'); assert.equal(p.affected_items.length, 1);
    assert.equal((await orderPatch(f, p)).status, 200);
    assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.ids[1]).status, 'בוטל');
    assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(f.ids[2]).status, 'הועמס');
    assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(f.order).payment_status, 'paid');
    assert.equal(db.prepare('SELECT status FROM order_loading_sessions WHERE id=?').get(sid).status, 'completed');
  });
  await t.test('returning one order from a shared active truck leaves the other order loadable', async () => {
    const a = await fixture({ certificate: false }), b = await fixture({ certificate: false });
    for (const f of [a,b]) {
      db.prepare("UPDATE orders SET status='הושלם – ממתין לאיסוף',delivery_address='QA site' WHERE id=?").run(f.order);
      db.prepare("UPDATE items SET status='הושלם' WHERE id=?").run(f.item);
    }
    const start = await request('/loading/multi-order-card-sessions', 'POST', {order_ids:[a.order,b.order]}, 'manager');
    assert.equal(start.status, 201, await start.clone().text());
    const state = await start.json();
    const p = await orderPreview(a, 'בתור ייצור');
    const scanned = await request('/loading/multi-order-card-sessions/' + state.group_uid + '/scan', 'POST', {qr_data:state.cards.find(card => card.order_id === a.order).worker_card_token}, 'manager');
    assert.equal(scanned.status, 200);
    assert.equal((await orderPatch(a, p)).status, 409, 'a new loading scan invalidates the correction preview');
    assert.equal((await orderPatch(a, await orderPreview(a, 'בתור ייצור'))).status, 200);
    const remaining = await request('/loading/multi-order-card-sessions/' + state.group_uid, 'GET', undefined, 'manager');
    assert.equal(remaining.status, 200, await remaining.clone().text());
    const next = await remaining.json();
    assert.equal(next.order_count, 1); assert.equal(next.orders[0].id, b.order);
    assert.equal(next.cards.length, 1); assert.equal(next.cards[0].parent_item_id, b.item);
    const scan = await request('/loading/multi-order-card-sessions/' + state.group_uid + '/scan', 'POST', {qr_data:next.cards[0].worker_card_token}, 'manager');
    assert.equal(scan.status, 200, await scan.clone().text());
    const finish = await request('/loading/multi-order-card-sessions/' + state.group_uid + '/complete', 'POST', {}, 'manager');
    assert.equal(finish.status, 200, await finish.clone().text());
    assert.equal(orderStatus(a), 'בתור ייצור'); assert.equal(orderStatus(b), 'בדרך ללקוח');
  });


  await t.test('phone marks loaded, stays visible, and permits issuing a delivery certificate', async () => {
    db.prepare("INSERT INTO settings(key,value) VALUES('QR_ACCESS_MODE','open') ON CONFLICT(key) DO UPDATE SET value='open'").run();
    const f = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='הושלם – ממתין לאיסוף' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='הושלם' WHERE id=?").run(f.item);
    const phone = body => request(`/worker-card/${f.item}/status`, 'PATCH', { card: String(f.item), ...body }, 'manager');
    for (const status of ['סופק','נשלח']) {
      const rejected = await phone({ status }); assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error, 'worker_loading_status_only');
    }
    const loaded = await phone({ status: 'הועמס', expected_status: 'הושלם' });
    assert.equal(loaded.status, 200, await loaded.clone().text());
    assert.equal((await loaded.json()).item.status, 'הועמס');
    assert.equal((await phone({ status:'ממתין',expected_status:'הושלם' })).status, 409);
    const saved = await request(`/worker-card/${f.item}`, 'PATCH', {card:String(f.item),produced_qty:10,note:'טעינה אושרה'}, 'manager');
    assert.equal(saved.status, 200); assert.equal(readItem(f).status, 'הועמס');
    const queue = await (await request('/production-queue?visual=1')).json();
    assert.ok(queue.items.some(item => item.id === f.item && item.status === 'הועמס'));
    const document = await (await request(`/orders/${f.order}/delivery-certificate-preview`)).json();
    assert.equal(document.loaded_unit_count, 10);
    const issued = await request(`/orders/${f.order}/delivery-certificate?certificate_mode=source&issue_key=${document.issue_key}&selection_fingerprint=${document.selection_fingerprint}`);
    assert.equal(issued.status, 200); assert.equal(readItem(f).status, 'נשלח');
    assert.equal((await phone({ status:'ממתין',expected_status:'נשלח' })).status, 200);
    assert.equal(orderStatus(f), 'אספקה חלקית'); assert.equal(progress(f).shipped_unit_count, 10);
    assert.equal((await phone({ status:'בייצור',expected_status:'ממתין' })).status, 200);
  });
  await t.test('phone can correct an old accidental delivered state and restart without a dead-end order', async () => {
    const f = await fixture({ certificate: false });
    db.prepare("UPDATE orders SET status='סופק – אושר' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='סופק' WHERE id=?").run(f.item);
    const phone = status => request(`/worker-card/${f.item}/status`, 'PATCH', {card:String(f.item),status}, 'manager');
    assert.equal((await phone('הועמס')).status, 200); assert.equal(readItem(f).status, 'הועמס');
    const document = await (await request(`/orders/${f.order}/delivery-certificate-preview`)).json();
    assert.equal(document.loaded_unit_count, 10);
    const issued = await request(`/orders/${f.order}/delivery-certificate?certificate_mode=source&issue_key=${document.issue_key}&selection_fingerprint=${document.selection_fingerprint}`);
    assert.equal(issued.status, 200, await issued.clone().text());
    assert.equal((await phone('ממתין')).status, 200); assert.equal(orderStatus(f), 'אספקה חלקית');
    assert.equal((await phone('בייצור')).status, 200);
    db.prepare("UPDATE orders SET status='ממתינה לאישור' WHERE id=?").run(f.order);
    db.prepare("UPDATE items SET status='הועמס' WHERE id=?").run(f.item);
    assert.equal((await phone('בייצור')).status, 409, 'a backward correction does not bypass approval');
  });

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no orphaned rows after corrections');
});
