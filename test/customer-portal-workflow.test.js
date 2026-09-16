'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { portalShapeDraftToOrderItem } = require('../services/customerPortalShapeDraft');

test('customer portal order lifecycle is idempotent and records actor/pricing snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-portal-workflow-'));
  Object.assign(process.env, { NODE_ENV:'test', JWT_SECRET:'portal-workflow-tests', BCRYPT_ROUNDS:'4', DB_PATH:path.join(dir,'db.sqlite'), BACKUP_DIR:path.join(dir,'backups') });
  const intake = require('../intake'); const oldSend = intake.sendWhatsApp; let waCount = 0; intake.sendWhatsApp = async () => { waCount += 1; };
  const { server, db, closeServer } = require('../server');
  t.after(async () => { await new Promise(r => closeServer(r)); db.close(); intake.sendWhatsApp = oldSend; fs.rmSync(dir,{recursive:true,force:true}); });
  await new Promise(r => server.listen(0,'127.0.0.1',r)); const base = `http://127.0.0.1:${server.address().port}`;
  const customerId = db.prepare("INSERT INTO customers(name,phone,price_tier,portal_can_expose_prices) VALUES ('Workflow','0501234567', 'list', 1)").run().lastInsertRowid;
  const token = 'workflow-token'; const userId = db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,active,token,token_expires_at,can_create_orders,can_view_prices,can_approve_orders) VALUES (?,'0500000000','Workflow User','customer_admin',1,?,'2099-01-01',1,1,1)").run(customerId,token).lastInsertRowid;
  const siteId = db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?,'Workflow Site','active')").run(customerId).lastInsertRowid;
  db.prepare('INSERT INTO customer_site_users(customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,1)').run(customerId,siteId,userId);
  const book = db.prepare("INSERT INTO pricing_price_books(code,name,price_type,status) VALUES ('WF','Workflow','general','active')").run().lastInsertRowid;
  db.prepare("INSERT INTO pricing_price_items(price_book_id,sku,diameter,description,price_before_vat) VALUES (?,?,?,'bar',5)").run(book,'D12',12);
  const payload = { token, idempotency_key:'workflow-key', siteId, items:[{ shapeName:'ישר', elementName:'Workflow beam', diameter:12, sides:[1000], angles:[], qty:2 }] };
  async function post(body) { const r=await fetch(base+'/api/c/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return { status:r.status, body:await r.json() }; }
  const first = await post(payload); assert.equal(first.status,200); const replay = await post(payload); assert.equal(replay.status,200); assert.equal(replay.body.replay,true); assert.equal(replay.body.orderId,first.body.orderId);
  const conflict = await post({...payload,items:[{...payload.items[0],qty:3}]}); assert.equal(conflict.status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id=?').get(customerId).n,1);
  const row = db.prepare('SELECT created_by_portal_user_id,pricing_snapshot_json FROM orders WHERE id=?').get(first.body.orderId); assert.equal(row.created_by_portal_user_id,userId); assert.ok(JSON.parse(row.pricing_snapshot_json).billingPrice > 0);
  db.prepare('UPDATE portal_users SET can_view_prices=0 WHERE id=?').run(userId);
  const hiddenReplay = await post(payload); assert.equal(hiddenReplay.status,200); assert.equal(hiddenReplay.body.summary.portalPrice,undefined);
  db.prepare('UPDATE portal_users SET can_view_prices=1 WHERE id=?').run(userId);
  const rollbackKey = { ...payload, idempotency_key:'rollback-key', items:[{...payload.items[0], sides:[-1]}] };
  assert.equal((await post(rollbackKey)).status,400);
  const retry = await post({ ...payload, idempotency_key:'rollback-key' }); assert.equal(retry.status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id=?').get(customerId).n,2);
  db.prepare('UPDATE customer_sites SET budget_amount=1,budget_kg=1,block_over_budget=1 WHERE id=?').run(siteId);
  const beforeBlocked = db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id=?').get(customerId).n;
  const blocked = await post({ ...payload, idempotency_key:'blocked-budget-key' }); assert.equal(blocked.status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id=?').get(customerId).n,beforeBlocked); assert.equal(waCount,2);
  const bytes = Buffer.from([0,1,2,250,255]); const form = new FormData(); form.append('token', token); form.append('file', new Blob([bytes], { type:'application/pdf' }), 'source.pdf');
  const uploaded = await fetch(`${base}/api/c/orders/${first.body.orderId}/source-documents`, { method:'POST', body:form }); assert.equal(uploaded.status,201); const documentId=(await uploaded.json()).documentId;
  const downloaded = await fetch(`${base}/api/c/orders/${first.body.orderId}/source-documents/${documentId}/download?token=${token}`); assert.equal(downloaded.status,200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
  assert.equal((await fetch(`${base}/api/c/orders/${first.body.orderId}/source-documents/${documentId}/download?token=wrong`)).status,401);
  const otherSite = db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?,'Other Site','active')").run(customerId).lastInsertRowid;
  const otherOrder = db.prepare("INSERT INTO orders(order_num,customer_id,site_id,status) VALUES ('DOC-OTHER',?,?,'ממתינה לאישור לקוח')").run(customerId,otherSite).lastInsertRowid;
  const otherForm = new FormData(); otherForm.append('token',token); otherForm.append('file',new Blob([bytes],{type:'application/pdf'}),'other.pdf');
  assert.equal((await fetch(`${base}/api/c/orders/${otherOrder}/source-documents`,{method:'POST',body:otherForm})).status,201);
  const history = await fetch(`${base}/api/c/orders/history?token=${token}&from=2000-01-01&to=2099-01-01&status=%D7%9E%D7%9E%D7%AA%D7%99%D7%A0%D7%94%20%D7%9C%D7%90%D7%99%D7%A9%D7%95%D7%A8%20%D7%9C%D7%A7%D7%95%D7%97&limit=1&offset=0`); assert.equal(history.status,200); const historyBody=await history.json(); assert.equal(historyBody.limit,1); assert.equal(historyBody.offset,0); assert.equal(historyBody.orders.length,1); assert.equal(historyBody.hasMore,true);
});

test('portal lifts preserve canonical weighed package semantics', () => {
  const snapshot = { contract:'SHAPE_DATA_CONTRACT_V2', contractVersion:2, shapeVersion:1, shapeId:'lift-1', shapeType:'lift_package', family:'lifts', displayName:'חבילת ליפטים', source:'shape-editor', data:{ diameter:12, barLength:1200, weighedKg:18.5 }, calculated:{ totalLengthMm:1200, weightKg:18.5, weighedKg:18.5 }, machineOutput:{ generic:{ family:'lifts', shapeType:'lift_package', diameter:12, barLength:1200, weighedKg:18.5 } }, validation:{ valid:true, errors:[], warnings:[] } };
  const item = portalShapeDraftToOrderItem({ shapeSnapshot:snapshot, quantity:2, elementName:'Lift package' });
  assert.equal(item.quantity,2); assert.equal(item.totalWeight,18.5); assert.equal(item.shapeSnapshot.family,'lifts'); assert.equal(item.weightPerUnit,9.25);
});
