const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-production-boundaries-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'production-boundaries.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

const { closeServer, db, server } = require('../server');
const { hashPin, sha256 } = require('../auth-core');
const statusContracts = require('../status-contracts');

let baseUrl;
const APPROVED_DEVICE_CREDENTIAL = 'DEV-BOUNDARY.test-device-secret';

function seedApprovedDevice() {
  db.prepare(`
    INSERT INTO device_enrollment_requests
      (request_uid,credential_hash,requester_name,device_name,status,reviewed_at)
    VALUES (?,?,?,?, 'approved',CURRENT_TIMESTAMP)
  `).run('DEV-BOUNDARY', sha256(APPROVED_DEVICE_CREDENTIAL), 'Boundary Worker', 'Boundary Phone');
}

function seedUser(username, role, pin) {
  db.prepare(`
    INSERT INTO users (username,display_name,role,pin,pin_hash,active,password_changed_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(username, username, role, pin, hashPin(pin, 4), 1, new Date().toISOString());
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, options);
}

async function token(username, pin) {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-IronBend-Device': APPROVED_DEVICE_CREDENTIAL,
    'Content-Type': 'application/json',
  };
}

function seedCustomer() {
  return db.prepare(`
    INSERT INTO customers (name,phone,email,price_tier,discount_pct)
    VALUES (?,?,?,?,?)
  `).run('Production Boundary Customer', '0500000000', 'production-boundary@example.com', 'retail', 0).lastInsertRowid;
}

function seedOrderWithItem(orderNum, orderStatus, itemStatus = statusContracts.ITEM_STATUS.WAITING) {
  const customerId = seedCustomer();
  const orderId = db.prepare(`
    INSERT INTO orders (order_num,customer_id,channel,status,total_weight,billing_weight)
    VALUES (?,?,?,?,?,?)
  `).run(orderNum, customerId, 'manual', orderStatus, 12.5, 12.5).lastInsertRowid;
  const palletId = db.prepare('INSERT INTO pallets (order_id,pallet_num,total_weight) VALUES (?,?,?)')
    .run(orderId, 1, 12.5).lastInsertRowid;
  const itemId = db.prepare(`
    INSERT INTO items
      (pallet_id,order_id,item_uid,shape_snapshot_json,shape_id,shape_name,diameter,segments,total_length_mm,quantity,production_qty,weight_per_unit,total_weight,status,machine)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    palletId,
    orderId,
    `order-${orderId}:item-seed`,
    JSON.stringify({ shapeName: 'straight', validation: { valid: true }, machineOutput: { generic: {} } }),
    'straight',
    'straight',
    12,
    JSON.stringify([{ length_mm: 1000, angle_deg: 0 }]),
    1000,
    5,
    5,
    2.5,
    12.5,
    itemStatus,
    'M1'
  ).lastInsertRowid;
  return { orderId, itemId, orderNum, palletId };
}

test('production enforces order item ownership boundaries', async (t) => {
  seedUser('production-boundary', 'production', '9101');
  seedUser('production-reports', 'manager', '9102');
  seedApprovedDevice();
  db.prepare('INSERT INTO machines (id,name,label,status,counter) VALUES (?,?,?,?,?)')
    .run(501, 'Boundary Machine', 'Boundary Machine', 'ready', 0);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const production = await token('production-boundary', '9101');
  const reportsManager = await token('production-reports', '9102');
  const headers = authHeaders(production);

  await t.test('scan/start rejects items whose order is not approved or planned', async () => {
    const draft = seedOrderWithItem('PB-DRAFT-SCAN', statusContracts.ORDER_STATUS.PENDING_APPROVAL);
    const response = await request('/api/scan', {
      method: 'POST',
      headers,
      body: JSON.stringify({ qrData: `${draft.orderNum}|${draft.itemId}`, machineId: 501, workerId: 1 }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'item_not_released_to_production');
    const item = db.prepare('SELECT status,started_at,worker_id FROM items WHERE id=?').get(draft.itemId);
    assert.equal(item.status, statusContracts.ITEM_STATUS.WAITING);
    assert.equal(item.started_at, null);
    assert.equal(item.worker_id, null);
    const machine = db.prepare('SELECT current_item_id FROM machines WHERE id=?').get(501);
    assert.equal(machine.current_item_id, null);
  });

  await t.test('production card preview renders but locks printing until approved or planned', async () => {
    const draft = seedOrderWithItem('PB-DRAFT-CARDS', statusContracts.ORDER_STATUS.PENDING_APPROVAL);
    const response = await request(`/api/orders/${draft.orderId}/print-cards`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-production-cards-preview-only'), '1');
    const html = await response.text();
    assert.match(html, /cards-grid/);
    assert.match(html, /preview-locked/);
    assert.match(html, /PREVIEW_ONLY\s*=\s*true/);
    assert.match(html, /print-blocked-page/);
    assert.doesNotMatch(html, /class="print-btn" onclick="printCards\(\)"/);
  });

  await t.test('production card printing accepts legacy approved order status', async () => {
    const approved = seedOrderWithItem('PB-LEGACY-APPROVED-CARDS', 'approved');
    const response = await request(`/api/orders/${approved.orderId}/print-cards`, { headers });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /cards-grid/);
  });

  await t.test('production card weight capture rejects orders that are not approved or planned', async () => {
    const draft = seedOrderWithItem('PB-DRAFT-CARD-WEIGHT', statusContracts.ORDER_STATUS.PENDING_APPROVAL);
    const response = await request(`/api/orders/${draft.orderId}/production-card-weight`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ item_id: draft.itemId, card_index: 1, card_total: 1, card_qty: 5, actual_weight_kg: 12 }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'order_not_released_to_production_cards');
    const saved = db.prepare('SELECT COUNT(*) AS n FROM production_card_weights WHERE item_id=?').get(draft.itemId);
    assert.equal(saved.n, 0);
    const item = db.prepare('SELECT actual_weight_kg,weight_deviation_pct FROM items WHERE id=?').get(draft.itemId);
    assert.equal(item.actual_weight_kg, null);
    assert.equal(item.weight_deviation_pct, null);
  });

  await t.test('production card measured weight writes one daily actual-output delta', async () => {
    const approved = seedOrderWithItem('PB-ACTUAL-CARD-WEIGHT', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const response = await request(`/api/orders/${approved.orderId}/production-card-weight`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ item_id: approved.itemId, card_index: 1, card_total: 1, card_qty: 5, actual_weight_kg: 12.75 }),
    });
    assert.equal(response.status, 200);
    const item = db.prepare('SELECT actual_weight_kg FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.actual_weight_kg, 12.75);
    const event = db.prepare(`
      SELECT source,before_weight_kg,after_weight_kg,delta_weight_kg,production_day
      FROM production_output_events WHERE item_id=?
    `).get(approved.itemId);
    assert.deepEqual({
      source: event.source,
      before: event.before_weight_kg,
      after: event.after_weight_kg,
      delta: event.delta_weight_kg,
    }, { source: 'production_card_weight', before: 0, after: 12.75, delta: 12.75 });
    assert.match(event.production_day, /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test('production item patch rejects non-production fields and preserves owned data', async () => {
    const approved = seedOrderWithItem('PB-APPROVED-PATCH', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const before = db.prepare('SELECT quantity,segments,shape_snapshot_json,total_weight,package_id,zone FROM items WHERE id=?').get(approved.itemId);
    const response = await request(`/api/items/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        quantity: 99,
        segments: [{ length_mm: 1 }],
        shapeSnapshot: { changed: true },
        total_weight: 999,
        finance: { pricingSnapshot: { lineTotal: 1 } },
        package_id: 123,
        zone: 'Z9',
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'non_production_fields_forbidden');
    assert.ok(body.fields.includes('quantity'));
    assert.ok(body.fields.includes('segments'));
    assert.ok(body.fields.includes('shapeSnapshot'));
    assert.ok(body.fields.includes('total_weight'));
    assert.ok(body.fields.includes('finance'));
    assert.ok(body.fields.includes('package_id'));
    assert.ok(body.fields.includes('zone'));
    const after = db.prepare('SELECT quantity,segments,shape_snapshot_json,total_weight,package_id,zone FROM items WHERE id=?').get(approved.itemId);
    assert.deepEqual(after, before);
  });

  await t.test('partial produced quantity starts released item without completing the order', async () => {
    const approved = seedOrderWithItem('PB-PARTIAL-UNIT-PROGRESS', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const response = await request(`/api/items/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ produced_qty: 3 }),
    });
    assert.equal(response.status, 200);
    const item = db.prepare('SELECT produced_qty,status,quantity FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.produced_qty, 3);
    assert.equal(item.status, statusContracts.ITEM_STATUS.IN_PRODUCTION);
    assert.equal(item.quantity, 5);
    const order = db.prepare('SELECT status FROM orders WHERE id=?').get(approved.orderId);
    assert.equal(order.status, statusContracts.ORDER_STATUS.IN_PRODUCTION);
  });

  await t.test('full produced quantity completes released item and order', async () => {
    const approved = seedOrderWithItem('PB-FULL-UNIT-PROGRESS', statusContracts.ORDER_STATUS.IN_PRODUCTION, statusContracts.ITEM_STATUS.IN_PRODUCTION);
    db.prepare(`
      INSERT INTO inventory_reservations (order_id,item_id,diameter,material_type,reserved_kg,status)
      VALUES (?,?,?,?,?,?)
    `).run(approved.orderId, approved.itemId, 12, 'coil', 12.5, 'active');

    const response = await request(`/api/items/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ produced_qty: 5, actual_weight_kg: 11.75 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.consumedReservations.consumed, 1);
    const item = db.prepare('SELECT produced_qty,status FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.produced_qty, 5);
    assert.equal(item.status, statusContracts.ITEM_STATUS.DONE);
    const reservation = db.prepare('SELECT status,reserved_kg FROM inventory_reservations WHERE item_id=?').get(approved.itemId);
    assert.equal(reservation.status, 'consumed');
    assert.equal(reservation.reserved_kg, 11.75);
    const order = db.prepare('SELECT status FROM orders WHERE id=?').get(approved.orderId);
    assert.equal(order.status, statusContracts.ORDER_STATUS.DONE_WAITING_PICKUP);
  });

  await t.test('produced quantity cannot exceed requested quantity', async () => {
    const approved = seedOrderWithItem('PB-OVER-UNIT-PROGRESS', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const response = await request(`/api/items/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ produced_qty: 6 }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'produced_qty_exceeds_quantity');
    const item = db.prepare('SELECT produced_qty,status FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.produced_qty, 0);
    assert.equal(item.status, statusContracts.ITEM_STATUS.WAITING);
  });

  await t.test('secure-mode worker card requires an activated device', async () => {
    db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('QR_ACCESS_MODE','secure',CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value='secure',updated_at=CURRENT_TIMESTAMP`).run();
    const approved = seedOrderWithItem('PB-PUBLIC-WORKER-CARD', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const card = `${approved.orderNum}-${String(approved.itemId).padStart(6, '0')}`;
    assert.equal((await request(`/api/worker-card?card=${encodeURIComponent(card)}`)).status, 403);
    const withoutDevice = await request(`/api/worker-card?card=${encodeURIComponent(card)}`, {
      headers: { Authorization: `Bearer ${production}` },
    });
    assert.equal(withoutDevice.status, 403);
    assert.equal((await withoutDevice.json()).error, 'device_activation_required');

    const view = await request(`/api/worker-card?card=${encodeURIComponent(card)}`, { headers });
    assert.equal(view.status, 200);
    const body = await view.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, approved.itemId);
    assert.ok(body.items[0].shape_svg);

    const response = await request(`/api/worker-card/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ card, produced_qty: 2, actual_weight_kg: 10, note: 'public scan update' }),
    });
    assert.equal(response.status, 200);
    const item = db.prepare('SELECT produced_qty,actual_weight_kg,note,status FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.produced_qty, 2);
    assert.equal(item.actual_weight_kg, 10);
    assert.equal(item.note, 'public scan update');
    assert.equal(item.status, statusContracts.ITEM_STATUS.IN_PRODUCTION);
    const event = db.prepare('SELECT source,delta_weight_kg FROM production_output_events WHERE item_id=?').get(approved.itemId);
    assert.deepEqual(event, { source: 'public_worker_card', delta_weight_kg: 10 });
    const activity = db.prepare(`
      SELECT action,actor_name,device_name,details_json
      FROM worker_card_activity WHERE item_id=? ORDER BY id
    `).all(approved.itemId);
    assert.deepEqual(activity.map(row => [row.action, row.actor_name, row.device_name]), [
      ['opened', 'production-boundary', 'Boundary Phone'],
      ['updated', 'production-boundary', 'Boundary Phone'],
    ]);
    assert.deepEqual(JSON.parse(activity[1].details_json), {
      from_status: statusContracts.ITEM_STATUS.WAITING,
      to_status: statusContracts.ITEM_STATUS.IN_PRODUCTION,
      produced_qty: 2,
      actual_weight_kg: 10,
      note_updated: true,
    });

    const today = new Date().toISOString().slice(0, 10);
    const reportResponse = await request(`/api/reports/worker-card-activity?from=${today}&to=${today}`, {
      headers: authHeaders(reportsManager),
    });
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    const reportRow = report.rows.find(row => row.item_id === approved.itemId && row.action === 'updated');
    assert.equal(reportRow.actor_name, 'production-boundary');
    assert.equal(reportRow.device_name, 'Boundary Phone');
    assert.equal(reportRow.details.produced_qty, 2);
  });

  await t.test('approved-device worker card rejects mismatched tokens and non-production fields', async () => {
    const approved = seedOrderWithItem('PB-PUBLIC-WORKER-FORBID', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const wrongCard = `OTHER-${String(approved.itemId + 1).padStart(6, '0')}`;
    const mismatch = await request(`/api/worker-card/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ card: wrongCard, produced_qty: 1 }),
    });
    assert.equal(mismatch.status, 403);

    const card = `${approved.orderNum}-${String(approved.itemId).padStart(6, '0')}`;
    const forbidden = await request(`/api/worker-card/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ card, quantity: 999 }),
    });
    assert.equal(forbidden.status, 400);
    const body = await forbidden.json();
    assert.equal(body.error, 'non_production_fields_forbidden');
    assert.ok(body.fields.includes('quantity'));
  });
  await t.test('production item patch still allows production-owned execution fields', async () => {
    const approved = seedOrderWithItem('PB-APPROVED-PRODUCTION', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const response = await request(`/api/items/${approved.itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ produced_qty: 4, actual_waste: 1, actual_weight_kg: 10, note: 'production note' }),
    });
    assert.equal(response.status, 200);
    const item = db.prepare('SELECT produced_qty,actual_waste,actual_weight_kg,note,quantity FROM items WHERE id=?').get(approved.itemId);
    assert.equal(item.produced_qty, 4);
    assert.equal(item.actual_waste, 1);
    assert.equal(item.actual_weight_kg, 10);
    assert.equal(item.note, 'production note');
    assert.equal(item.quantity, 5);
  });

  await t.test('item status update moves approved order into production automatically', async () => {
    const approved = seedOrderWithItem('PB-AUTO-IN-PRODUCTION', statusContracts.ORDER_STATUS.APPROVED_WAITING_PRODUCTION);
    const response = await request(`/api/items/${approved.itemId}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: statusContracts.ITEM_STATUS.IN_PRODUCTION }),
    });
    assert.equal(response.status, 200);
    const order = db.prepare('SELECT status FROM orders WHERE id=?').get(approved.orderId);
    assert.equal(order.status, statusContracts.ORDER_STATUS.IN_PRODUCTION);
  });

  await t.test('last completed production item completes the order automatically', async () => {
    const approved = seedOrderWithItem('PB-AUTO-DONE', statusContracts.ORDER_STATUS.IN_PRODUCTION, statusContracts.ITEM_STATUS.IN_PRODUCTION);
    const response = await request(`/api/items/${approved.itemId}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: statusContracts.ITEM_STATUS.DONE }),
    });
    assert.equal(response.status, 200);
    const order = db.prepare('SELECT status FROM orders WHERE id=?').get(approved.orderId);
    assert.equal(order.status, statusContracts.ORDER_STATUS.DONE_WAITING_PICKUP);
  });
});
