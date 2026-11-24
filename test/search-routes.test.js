'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { ensureCoreSchema } = require('../db/coreSchema');
const { requireRole } = require('../permissions');
const createSearchRouter = require('../routes/search');

let dir;
let db;
let server;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-search-'));
  db = new Database(path.join(dir, 'test.db'));
  ensureCoreSchema(db);
  db.exec(`
    INSERT INTO customers (id, name) VALUES (1, 'פלדה LOT-1042');
    INSERT INTO orders (id, order_num, customer_id) VALUES (1, 'ORD-LOT-1042', 1);
    INSERT INTO packages (id, package_code, order_id, order_num)
    VALUES (1, 'PKG-20261124-001', 1, 'ORD-LOT-1042');
    INSERT INTO raw_material (id, diameter, lot_number) VALUES (1, 12, 'LOT-1042');
    INSERT INTO incidents (id, title, description)
    VALUES (1, 'בדיקת חומר גלם', 'נדרשת בדיקה לאצווה LOT-1042');

    INSERT INTO raw_material (diameter, lot_number) VALUES
      (12, 'LOT-2042-A'), (12, 'LOT-2042-B'),
      (12, 'LOT-2042-C'), (12, 'LOT-2042-D'), (12, 'LOT-2042');
  `);

  const app = express();
  app.use((req, _res, next) => {
    req.auth = { sub: '1', role: req.get('x-test-role') };
    next();
  });
  app.use('/api', createSearchRouter({ db, requireRole }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

test.after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function search(role, q) {
  const url = new URL(`http://127.0.0.1:${server.address().port}/api/search`);
  if (q !== undefined) url.searchParams.set('q', q);
  return fetch(url, { headers: { 'x-test-role': role } });
}

test('search returns an empty result for missing, empty, and one-character queries', async () => {
  for (const q of [undefined, '', '  ל  ']) {
    const response = await search('viewer', q);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [] });
  }
});

test('viewer and manager can find all five record types with the exact reference first', async () => {
  for (const role of ['viewer', 'manager']) {
    const response = await search(role, '  lot-1042  ');
    assert.equal(response.status, 200, role);
    const { query, results } = await response.json();
    assert.equal(query, 'lot-1042');
    const matches = results.map(({ type, id, ref }) => [type, id, ref]);
    assert.deepEqual(matches[0], ['inventory', 1, 'LOT-1042']);
    assert.deepEqual(matches.slice(1).sort(), [
      ['customer', 1, 'פלדה LOT-1042'],
      ['incident', 1, 'בדיקת חומר גלם'],
      ['order', 1, 'ORD-LOT-1042'],
      ['package', 1, 'PKG-20261124-001'],
    ]);
  }
});

test('an exact lot reference survives the inventory result limit', async () => {
  const response = await search('viewer', 'lot-2042');
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.equal(results.length, 4);
  assert.equal(results[0].ref, 'LOT-2042');
});

test('a customer portal role without viewer access receives 403', async () => {
  const response = await search('customer_admin', 'LOT-1042');
  assert.equal(response.status, 403);
});
