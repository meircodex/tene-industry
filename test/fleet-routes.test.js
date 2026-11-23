const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');

const { ensureCoreSchema, runCoreMigrations } = require('../db/startup');
const { requireAnyRole } = require('../permissions');
const createFleetRouter = require('../routes/fleet');

async function fleet(t) {
  const db = new Database(':memory:');
  ensureCoreSchema(db);
  runCoreMigrations(db);
  const vehicleId = db.prepare('INSERT INTO vehicles (vehicle_desc) VALUES (?)').run('רכב בדיקה').lastInsertRowid;
  const addDriver = db.prepare('INSERT INTO drivers (name, phone, vehicle_id) VALUES (?, ?, ?)');
  const driverId = addDriver.run('נהג בדיקה', '050-000-0011', vehicleId).lastInsertRowid;
  const otherId = addDriver.run('נהג נוסף', '050-000-0022', null).lastInsertRowid;
  const officeId = db.prepare("INSERT INTO users (username, display_name, role) VALUES (?, ?, 'office')")
    .run('office-test', 'משרד').lastInsertRowid;
  const userId = db.prepare("INSERT INTO users (username, display_name, role, phone) VALUES (?, ?, 'driver', ?)")
    .run('driver-test', 'נהג בדיקה', '+972 50 000 0011').lastInsertRowid;
  assert.notEqual(userId, driverId);

  const broadcasts = [];
  const audits = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get('X-Test-Role');
    if (role) req.auth = { role, sub: String(role === 'driver' ? userId : officeId) };
    next();
  });
  app.use('/api', createFleetRouter({
    db,
    requireAnyRole,
    wsBroadcast: (...args) => broadcasts.push(args),
    auditLog: (...args) => audits.push(args),
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });
  await once(server, 'listening');

  function request(route, { role, method = 'GET', body } = {}) {
    const headers = {};
    if (role) headers['X-Test-Role'] = role;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method, headers, body });
  }

  return { db, request, broadcasts, audits, vehicleId, driverId, otherId, userId };
}

test('driver location requires an authorized role and a unique active driver match', async t => {
  const { db, request, broadcasts, driverId, otherId, userId } = await fleet(t);
  const update = (id, role, body = { lat: 0, lng: 0 }) =>
    request(`/drivers/${id}/location`, { role, method: 'PATCH', body });

  assert.equal((await update(driverId)).status, 401);
  assert.equal((await update(driverId, 'warehouse')).status, 403);
  assert.equal((await update(otherId, 'driver')).status, 403);
  assert.equal((await update('unknown', 'driver')).status, 404);

  db.prepare('UPDATE drivers SET phone=? WHERE id=?').run('0500000011', otherId);
  assert.equal((await update(driverId, 'driver')).status, 403);
  db.prepare('UPDATE drivers SET phone=NULL WHERE id=?').run(otherId);
  const duplicate = db.prepare("INSERT INTO users (username, display_name, role, phone) VALUES (?, ?, 'driver', ?)")
    .run('duplicate-test', 'נהג נוסף', '0500000011').lastInsertRowid;
  assert.equal((await update(driverId, 'driver')).status, 403);
  db.prepare('DELETE FROM users WHERE id=?').run(duplicate);

  db.prepare('UPDATE users SET active=0 WHERE id=?').run(userId);
  assert.equal((await update(driverId, 'driver')).status, 403);
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(userId);
  db.prepare('UPDATE drivers SET active=0 WHERE id=?').run(driverId);
  assert.equal((await update(driverId, 'driver')).status, 403);
  db.prepare('UPDATE drivers SET active=1 WHERE id=?').run(driverId);

  assert.deepEqual(broadcasts, []);
  assert.equal(db.prepare('SELECT current_lat FROM drivers WHERE id=?').get(driverId).current_lat, null);

  for (const body of [
    {}, { lat: null, lng: 0 }, { lat: '0', lng: 0 }, { lat: false, lng: 0 },
    { lat: 90.001, lng: 0 }, { lat: 0, lng: -180.001 }, '{"lat":0,"lng":1e999}',
  ]) {
    assert.equal((await update(driverId, 'driver', body)).status, 400);
  }
  assert.deepEqual(broadcasts, []);
  assert.equal((await update(driverId, 'driver', { lat: -90, lng: 180 })).status, 200);
  assert.equal((await update(otherId, 'office')).status, 200);
  const stored = db.prepare('SELECT current_lat, current_lng, last_location_update FROM drivers WHERE id=?').get(driverId);
  assert.equal(stored.current_lat, -90);
  assert.equal(stored.current_lng, 180);
  assert.ok(Number.isFinite(Date.parse(stored.last_location_update)));
  assert.deepEqual(broadcasts, [
    ['driver_location', { driverId, lat: -90, lng: 180 }],
    ['driver_location', { driverId: otherId, lat: 0, lng: 0 }],
  ]);
});

test('vehicle documents enforce format and size before storage and preserve metadata-only entries', async t => {
  const { db, request, broadcasts, audits, vehicleId } = await fleet(t);
  const route = `/vehicles/${vehicleId}/documents`;
  const fixture = relativePath => readFileSync(path.join(__dirname, '..', relativePath));
  const pdf = fixture('test/fixtures/fault-two-pages.pdf');
  const jpeg = fixture('public/brand/tene-pdf-logo.jpg');
  const png = fixture('public/icon-192.png');
  function upload(file, mime, { role = 'office', target = route } = {}) {
    const body = new FormData();
    body.set('document_type', 'test');
    if (file) body.set('file', new Blob([file], { type: mime }), 'document');
    return request(target, { role, method: 'POST', body });
  }

  assert.equal((await upload(pdf, 'application/pdf', { role: 'driver' })).status, 403);
  assert.equal((await upload(pdf, 'application/pdf', { target: '/vehicles/999/documents' })).status, 404);
  assert.equal((await upload(pdf, 'text/plain')).status, 415);
  assert.equal((await upload(jpeg, 'application/pdf')).status, 415);
  const cap = 5 * 1024 * 1024;
  assert.equal((await upload(Buffer.concat([pdf, Buffer.alloc(cap)], cap + 1), 'application/pdf')).status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vehicle_documents').get().count, 0);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(audits, []);

  for (const [bytes, mime] of [
    [pdf, 'application/pdf'], [jpeg, 'image/jpeg'], [png, 'image/png'],
    [Buffer.concat([pdf, Buffer.alloc(cap)], cap), 'application/pdf'],
  ]) {
    const response = await upload(bytes, mime);
    assert.equal(response.status, 200);
    const { id } = await response.json();
    const row = db.prepare('SELECT mime_type, data_url FROM vehicle_documents WHERE id=?').get(id);
    assert.equal(row.mime_type, mime);
    assert.deepEqual(Buffer.from(row.data_url.split(',')[1], 'base64'), bytes);
  }
  const metadata = await upload();
  assert.equal(metadata.status, 200);
  assert.equal(db.prepare('SELECT data_url FROM vehicle_documents WHERE id=?').get((await metadata.json()).id).data_url, null);
  const list = await request(route, { role: 'warehouse' });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).every(row => !Object.hasOwn(row, 'data_url')));
  assert.equal(broadcasts.length, 5);
  assert.equal(audits.length, 5);
});

test('fleet vehicle events preserve role checks, links, ordering and odometer updates', async t => {
  const { db, request, broadcasts, audits, vehicleId, driverId, otherId } = await fleet(t);
  const vehicleEvents = `/vehicles/${vehicleId}/events`;
  const driverEvents = `/drivers/${driverId}/vehicle-events`;
  const postEvent = (route, role, date, km) =>
    request(route, { role, method: 'POST', body: { event_type: 'maintenance', event_date: date, odometer_km: km } });

  assert.equal((await postEvent(vehicleEvents, 'warehouse', '2026-06-01', 100)).status, 403);
  assert.equal((await postEvent(driverEvents, 'driver', '2026-06-01', 100)).status, 403);
  for (const route of ['/vehicles/999/events', '/drivers/999/vehicle-events']) {
    assert.equal((await request(route, { role: 'driver' })).status, 404);
    assert.equal((await postEvent(route, 'office', '2026-06-01', 100)).status, 404);
  }

  for (const [method, route] of [
    ['GET', '/vehicles/999/documents'], ['PATCH', '/vehicles/999'],
    ['PATCH', '/drivers/999'], ['DELETE', '/drivers/999'],
  ]) {
    const body = method === 'PATCH' ? {} : undefined;
    assert.equal((await request(route, { role: 'office', method, body })).status, 404);
  }
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(audits, []);

  assert.equal((await postEvent(vehicleEvents, 'office', '2026-06-01', 100)).status, 200);
  assert.deepEqual(broadcasts, [['vehicle_updated', { id: vehicleId, action: 'event' }]]);
  assert.equal((await postEvent(driverEvents, 'manager', '2026-06-02', 125)).status, 200);
  const unassignedEvents = `/drivers/${otherId}/vehicle-events`;
  assert.equal((await postEvent(unassignedEvents, 'office', '2026-06-03', 25)).status, 200);

  const events = await (await request(vehicleEvents, { role: 'warehouse' })).json();
  assert.deepEqual(events.map(event => [event.driver_id, event.vehicle_id, event.odometer_km]), [
    [driverId, vehicleId, 125], [driverId, vehicleId, 100],
  ]);
  assert.deepEqual(await (await request(driverEvents, { role: 'driver' })).json(), events);
  const unassigned = await (await request(unassignedEvents, { role: 'driver' })).json();
  assert.equal(unassigned[0].vehicle_id, null);
  assert.equal(db.prepare('SELECT odometer_km FROM vehicles WHERE id=?').get(vehicleId).odometer_km, 125);
  assert.equal(db.prepare('SELECT odometer_km FROM drivers WHERE id=?').get(driverId).odometer_km, 125);
  assert.equal(audits.length, 3);
});
