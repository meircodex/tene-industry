'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-worker-card-receipts-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'worker-card-receipts-test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'worker-card-receipts.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

const { closeServer, db, server } = require('../server');
const { ORDER_STATUS, ITEM_STATUS } = require('../status-contracts');

let baseUrl;

function seedCard(name, orderStatus = ORDER_STATUS.APPROVED_WAITING_PRODUCTION, itemStatus = ITEM_STATUS.WAITING) {
  const orderNum = `RECEIPT-${name}`;
  const customerId = db.prepare('INSERT INTO customers (name) VALUES (?)').run('Receipt test customer').lastInsertRowid;
  const orderId = db.prepare(`
    INSERT INTO orders (order_num,customer_id,channel,status,total_weight,billing_weight)
    VALUES (?,?, 'manual',?,12.5,12.5)
  `).run(orderNum, customerId, orderStatus).lastInsertRowid;
  const palletId = db.prepare('INSERT INTO pallets (order_id,pallet_num,total_weight) VALUES (?,1,12.5)').run(orderId).lastInsertRowid;
  const itemId = db.prepare(`
    INSERT INTO items
      (pallet_id,order_id,item_uid,shape_snapshot_json,shape_id,shape_name,diameter,segments,total_length_mm,
       quantity,production_qty,weight_per_unit,total_weight,status,machine)
    VALUES (?,?,?,?, 'straight','straight',12,?,1000,5,5,2.5,12.5,?,'M1')
  `).run(
    palletId, orderId, `receipt-order-${orderId}:item`,
    JSON.stringify({ shapeName: 'straight', validation: { valid: true }, machineOutput: { generic: {} } }),
    JSON.stringify([{ length_mm: 1000, angle_deg: 0 }]), itemStatus,
  ).lastInsertRowid;
  return { itemId: Number(itemId), orderId: Number(orderId), card: `${orderNum}-${String(itemId).padStart(6, '0')}` };
}

function request(url, options = {}) {
  return fetch(`${baseUrl}${url}`, options);
}

async function patch(card, payload, suffix = '') {
  const response = await request(`/api/worker-card/${card.itemId}${suffix}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card: card.card, ...payload }),
  });
  const responseText = await response.text();
  let body;
  try { body = JSON.parse(responseText); } catch { body = { response_text: responseText }; }
  return { status: response.status, body };
}

function itemSnapshot(card) {
  return db.prepare(`
    SELECT produced_qty,actual_weight_kg,weight_deviation_pct,note,status,started_at,completed_at
    FROM items WHERE id=?
  `).get(card.itemId);
}

function activityCount(card) {
  return db.prepare('SELECT COUNT(*) AS count FROM worker_card_activity WHERE item_id=?').get(card.itemId).count;
}

function outputCount(card) {
  return db.prepare('SELECT COUNT(*) AS count FROM production_output_events WHERE item_id=?').get(card.itemId).count;
}

function assertPersistedReceipt(receipt, card, action, requestId) {
  assert.ok(Number.isSafeInteger(receipt?.id) && receipt.id > 0, 'confirmation identifies a persisted activity row');
  assert.equal(receipt.item_id, card.itemId);
  assert.equal(receipt.action, action);
  assert.ok(receipt.occurred_at, 'confirmation includes the server-saved time');
  const row = db.prepare('SELECT id,item_id,action,occurred_at FROM worker_card_activity WHERE id=?').get(receipt.id);
  assert.ok(row);
  assert.equal(row.item_id, card.itemId);
  assert.equal(row.action, action);
  const storedTime = row.occurred_at.replace(' ', 'T');
  const receiptTime = receipt.occurred_at.replace(' ', 'T');
  assert.equal(Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(receiptTime) ? receiptTime : `${receiptTime}Z`),
    Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(storedTime) ? storedTime : `${storedTime}Z`));
  if (requestId !== undefined) assert.equal(receipt.request_id, requestId);
}

test('public worker cards confirm only persisted scans and atomic, retry-safe saves', async (t) => {
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('QR_ACCESS_MODE','open',CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value='open',updated_at=CURRENT_TIMESTAMP`).run();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('an unauthenticated scan returns an uncached persisted opened receipt', async () => {
    const card = seedCard('OPEN');
    const response = await request(`/api/worker-card?card=${encodeURIComponent(card.card)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    const body = await response.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, card.itemId);
    assertPersistedReceipt(body.scan_receipt, card, 'opened');
    assert.equal(activityCount(card), 1);
    assert.equal(itemSnapshot(card).produced_qty, 0, 'scan confirmation must not imply production was updated');
  });

  await t.test('invalid and missing cards never receive an opened receipt', async () => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM worker_card_activity').get().count;
    for (const [token, expectedStatus] of [['not-a-card', 400], ['RECEIPT-MISSING-999999999', 404]]) {
      const response = await request(`/api/worker-card?card=${encodeURIComponent(token)}`);
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      assert.equal(body.scan_receipt, undefined);
      assert.equal(body.receipt, undefined);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM worker_card_activity').get().count, before);
  });

  await t.test('saving fields confirms the saved item and replays one durable receipt', async () => {
    const card = seedCard('FIELDS');
    const payload = { produced_qty: 2, actual_weight_kg: 10, note: 'Confirmed fields', request_id: 'receipt-fields-request-first' };
    const first = await patch(card, payload);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    assertPersistedReceipt(first.body.receipt, card, 'updated', payload.request_id);
    assert.equal(first.body.item.id, card.itemId);
    assert.equal(first.body.item.produced_qty, 2);
    assert.equal(first.body.item.actual_weight_kg, 10);
    assert.equal(first.body.item.note, 'Confirmed fields');
    assert.equal(first.body.item.status, ITEM_STATUS.IN_PRODUCTION);
    const saved = itemSnapshot(card);
    assert.equal(activityCount(card), 1);
    assert.equal(outputCount(card), 1);

    const replay = await patch(card, payload);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.receipt, first.body.receipt);
    assert.deepEqual(itemSnapshot(card), saved);
    assert.equal(activityCount(card), 1);
    assert.equal(outputCount(card), 1);

    const conflict = await patch(card, { ...payload, produced_qty: 3 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'worker_request_conflict');
    assert.equal(conflict.body.receipt, undefined);
    assert.deepEqual(itemSnapshot(card), saved);
    assert.equal(activityCount(card), 1);

    const advanced = await patch(card, { produced_qty: 4, request_id: 'receipt-fields-request-later' });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
    const lateReplay = await patch(card, payload);
    assert.equal(lateReplay.status, 200, 'a lost response is recoverable even after quantity advances');
    assert.deepEqual(lateReplay.body.receipt, first.body.receipt);
    assert.equal(itemSnapshot(card).produced_qty, 4);
    assert.equal(activityCount(card), 2);
    assert.equal(outputCount(card), 1);
  });

  await t.test('status requests replay before backward-status validation and reject changed payloads', async () => {
    const card = seedCard('STATUS');
    const payload = { status: ITEM_STATUS.IN_PRODUCTION, request_id: 'receipt-status-request-first' };
    const first = await patch(card, payload, '/status');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assertPersistedReceipt(first.body.receipt, card, 'status_changed', payload.request_id);
    assert.equal(first.body.item.status, ITEM_STATUS.IN_PRODUCTION);
    const done = await patch(card, { status: ITEM_STATUS.DONE, request_id: 'receipt-status-request-later' }, '/status');
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const completed = itemSnapshot(card);
    const replay = await patch(card, payload, '/status');
    assert.equal(replay.status, 200, 'replaying an already committed request does not attempt a backward transition');
    assert.deepEqual(replay.body.receipt, first.body.receipt);
    assert.deepEqual(itemSnapshot(card), completed);
    assert.equal(activityCount(card), 2);
    const conflict = await patch(card, { ...payload, status: ITEM_STATUS.DONE }, '/status');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'worker_request_conflict');
    assert.deepEqual(itemSnapshot(card), completed);
    assert.equal(activityCount(card), 2);
  });

  await t.test('a no-field save still receives a real receipt and old clients may omit request_id', async () => {
    const card = seedCard('NOOP');
    const before = itemSnapshot(card);
    const requestId = 'receipt-noop-request-first';
    const saved = await patch(card, { request_id: requestId });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assertPersistedReceipt(saved.body.receipt, card, 'updated', requestId);
    assert.deepEqual(itemSnapshot(card), before);
    const replay = await patch(card, { request_id: requestId });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.receipt, saved.body.receipt);
    assert.equal(activityCount(card), 1);
    const legacy = await patch(card, { note: 'Legacy client' });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assertPersistedReceipt(legacy.body.receipt, card, 'updated');
    assert.equal(itemSnapshot(card).note, 'Legacy client');
  });

  await t.test('a failed status receipt rolls back item and order transitions', async () => {
    const card = seedCard('STATUS-ROLLBACK');
    const before = itemSnapshot(card);
    const orderBefore = db.prepare('SELECT status FROM orders WHERE id=?').get(card.orderId).status;
    const payload = { status: ITEM_STATUS.IN_PRODUCTION, request_id: 'receipt-status-rollback-request' };
    db.exec(`CREATE TRIGGER reject_status_receipt BEFORE INSERT ON worker_card_activity
      WHEN NEW.item_id=${card.itemId} BEGIN SELECT RAISE(ABORT,'test_status_receipt_failure'); END`);
    try {
      const response = await patch(card, payload, '/status');
      assert.equal(response.status, 500);
      assert.equal(response.body.receipt, undefined);
      assert.deepEqual(itemSnapshot(card), before);
      assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(card.orderId).status, orderBefore);
      assert.equal(activityCount(card), 0);
    } finally { db.exec('DROP TRIGGER reject_status_receipt'); }
    const retried = await patch(card, payload, '/status');
    assert.equal(retried.status, 200, 'a rolled-back request may be safely retried with its original identifier');
    assertPersistedReceipt(retried.body.receipt, card, 'status_changed', payload.request_id);
    assert.equal(activityCount(card), 1);
  });

  await t.test('a failed field receipt rolls back quantity, weight evidence, order and reservations', async () => {
    const card = seedCard('FIELDS-ROLLBACK');
    db.prepare(`INSERT INTO inventory_reservations (order_id,item_id,diameter,material_type,reserved_kg,status)
      VALUES (?,?,12,'coil',12.5,'active')`).run(card.orderId, card.itemId);
    const before = itemSnapshot(card);
    const orderBefore = db.prepare('SELECT status FROM orders WHERE id=?').get(card.orderId).status;
    const reservationBefore = db.prepare('SELECT status,reserved_kg FROM inventory_reservations WHERE item_id=?').get(card.itemId);
    const payload = { produced_qty: 5, actual_weight_kg: 11.75, note: 'Must roll back', request_id: 'receipt-fields-rollback-request' };
    db.exec(`CREATE TRIGGER reject_field_receipt BEFORE INSERT ON worker_card_activity
      WHEN NEW.item_id=${card.itemId} BEGIN SELECT RAISE(ABORT,'test_field_receipt_failure'); END`);
    try {
      const response = await patch(card, payload);
      assert.equal(response.status, 500);
      assert.equal(response.body.receipt, undefined);
      assert.deepEqual(itemSnapshot(card), before);
      assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(card.orderId).status, orderBefore);
      assert.deepEqual(db.prepare('SELECT status,reserved_kg FROM inventory_reservations WHERE item_id=?').get(card.itemId), reservationBefore);
      assert.equal(outputCount(card), 0);
      assert.equal(activityCount(card), 0);
    } finally { db.exec('DROP TRIGGER reject_field_receipt'); }
    const retried = await patch(card, payload);
    assert.equal(retried.status, 200, 'retry after rollback commits the whole save exactly once');
    assertPersistedReceipt(retried.body.receipt, card, 'updated', payload.request_id);
    assert.equal(itemSnapshot(card).produced_qty, 5);
    assert.equal(itemSnapshot(card).actual_weight_kg, 11.75);
    assert.equal(outputCount(card), 1);
    assert.equal(activityCount(card), 1);
    assert.deepEqual(db.prepare('SELECT status,reserved_kg FROM inventory_reservations WHERE item_id=?').get(card.itemId),
      { status: 'consumed', reserved_kg: 11.75 });
  });

  await t.test('invalid request identifiers and production guards never issue save receipts', async () => {
    const card = seedCard('GUARDS');
    const before = itemSnapshot(card);
    for (const requestId of ['short', 'invalid request id with spaces', 'x'.repeat(101)]) {
      const response = await patch(card, { produced_qty: 2, request_id: requestId });
      assert.equal(response.status, 400);
      assert.equal(response.body.receipt, undefined);
    }
    const over = await patch(card, { produced_qty: 6, request_id: 'receipt-guard-over-quantity' });
    assert.equal(over.status, 400);
    assert.equal(over.body.error, 'produced_qty_exceeds_quantity');
    assert.equal(over.body.receipt, undefined);
    const wrongCard = await patch(card, { card: `RECEIPT-WRONG-${card.itemId + 1}`, produced_qty: 2 });
    assert.equal(wrongCard.status, 403);
    assert.equal(wrongCard.body.receipt, undefined);
    assert.deepEqual(itemSnapshot(card), before);
    assert.equal(activityCount(card), 0);
    assert.equal(outputCount(card), 0);
    const blocked = seedCard('UNRELEASED', ORDER_STATUS.PENDING_APPROVAL);
    const blockedBefore = itemSnapshot(blocked);
    const start = await patch(blocked, { status: ITEM_STATUS.IN_PRODUCTION, request_id: 'receipt-guard-unreleased-start' }, '/status');
    assert.equal(start.status, 409);
    assert.equal(start.body.error, 'item_not_released_to_production');
    assert.equal(start.body.receipt, undefined);
    assert.deepEqual(itemSnapshot(blocked), blockedBefore);
    assert.equal(activityCount(blocked), 0);
  });
});
