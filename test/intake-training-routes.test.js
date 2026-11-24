const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { ensureCoreSchema } = require('../db/coreSchema');
const { ROLE_PERMISSIONS, requireAnyRole } = require('../permissions');
const createIntakeTrainingRouter = require('../routes/intakeTraining');

const example = {
  title: 'קליטת שורת ברזל',
  problem_text: 'בשורה 12 6000 4 לא זוהתה הכמות.',
  correction_text: 'קוטר 12 מ״מ, אורך 6000 מ״מ, כמות 4.',
};

test('intake training routes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-intake-training-'));
  let db;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  db = new Database(path.join(tmpDir, 'test.db'));
  ensureCoreSchema(db);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get('x-test-role');
    if (role) req.auth = { role };
    next();
  });
  app.use('/api', createIntakeTrainingRouter({ db, requireAnyRole }));
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}/api/intake/training`;

  async function request(method, role, { id, body } = {}) {
    const headers = new Headers();
    if (role) headers.set('x-test-role', role);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(id === undefined ? url : `${url}/${id}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data };
  }

  await t.test('GET, POST and DELETE require manager or admin', async () => {
    const deniedRoles = Object.keys(ROLE_PERMISSIONS).filter(role => role !== 'manager' && role !== 'admin');
    for (const { method, options } of [
      { method: 'GET' },
      { method: 'POST', options: { body: example } },
      { method: 'DELETE', options: { id: 1 } },
    ]) {
      assert.equal((await request(method, undefined, options)).status, 401, method);
      for (const role of deniedRoles) {
        assert.equal((await request(method, role, options)).status, 403, `${method} as ${role}`);
      }
    }
  });

  await t.test('POST rejects each missing required field and an absent body', async () => {
    for (const field of Object.keys(example)) {
      const body = { ...example };
      delete body[field];
      assert.equal((await request('POST', 'manager', { body })).status, 400, field);
    }
    assert.equal((await request('POST', 'admin')).status, 400);
    assert.deepEqual(await request('GET', 'admin'), { status: 200, data: [] });
  });

  for (const role of ['manager', 'admin']) {
    await t.test(`${role} can create, list and delete training examples`, async () => {
      const created = await request('POST', role, { body: example });
      assert.equal(created.status, 200);
      assert.equal(created.data.success, true);
      const { id } = created.data;
      assert.ok(Number.isInteger(id));

      const listed = await request('GET', role);
      assert.equal(listed.status, 200);
      const row = listed.data.find(row => row.id === id);
      assert.ok(row);
      assert.equal(row.active, 1);
      assert.equal(row.document_type, 'general');
      for (const [field, value] of Object.entries(example)) {
        assert.equal(row[field], value);
      }

      assert.deepEqual(await request('DELETE', role, { id }), { status: 200, data: { success: true } });
      const afterDelete = await request('GET', role);
      assert.equal(afterDelete.status, 200);
      assert.ok(afterDelete.data.every(row => row.id !== id));
      assert.equal((await request('DELETE', role, { id })).status, 404);
    });
  }

  await t.test('DELETE returns 404 for an ID that never existed', async () => {
    assert.equal((await request('DELETE', 'manager', { id: 999999 })).status, 404);
  });
});
