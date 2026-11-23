const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { createBackupService } = require('../services/backup');
const { source } = require('./fixtures/order105-tassa-pdf-words.json');

const testKey = 'offline-backup-fixture';
const restoreTool = path.join(__dirname, '..', 'tools', 'restore-backup.js');

function sqliteFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-backup-test-'));
  const dbPath = path.join(dir, 'original.db');
  const db = new Database(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  ensureCoreSchema(db);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('LICENSE_KEY', testKey);
  db.prepare('INSERT INTO intake_log (source,original_filename,status) VALUES (?,?,?)')
    .run('ocr', source.split(': ')[1], 'pending_review');
  return { db, dbPath, dir, service: createBackupService(db, { dbPath }) };
}

function stubUpload(t, { statusCode, body }) {
  return t.mock.method(https, 'request', (options, onResponse) => {
    const request = new EventEmitter();
    request.write = chunk => { request.body = chunk; };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        onResponse(response);
        response.emit('data', body);
        response.emit('end');
      });
    };
    return request;
  });
}

test('גיבוי SQLite מוצפן משוחזר byte-for-byte בעזרת כלי השחזור', async t => {
  const { db, dbPath, dir, service } = sqliteFixture(t);
  const upload = stubUpload(t, { statusCode: 201, body: '{}' });
  const original = fs.readFileSync(dbPath);

  assert.deepEqual(service.status(), {
    lastSuccess: null, lastFile: null, lastError: null, lastErrorAt: null, cloudEnabled: true,
  });
  const result = await service.run();
  assert.equal(result.cloud, true);
  assert.equal(result.local, true);
  assert.equal(upload.mock.callCount(), 1);
  const [{ arguments: [options], result: request }] = upload.mock.calls;
  assert.equal(options.path, '/api/backup/upload');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-License-Key'], testKey);
  assert.equal(options.headers['Content-Length'], request.body.length);

  const boundary = options.headers['Content-Type'].split('boundary=')[1];
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${result.filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  assert.deepEqual(request.body.subarray(0, header.length), header);
  assert.deepEqual(request.body.subarray(-footer.length), footer);
  const encrypted = request.body.subarray(header.length, -footer.length);
  assert.equal(encrypted.length, original.length + 32);
  assert.equal(encrypted.includes(Buffer.from('SQLite format 3')), false);

  const encryptedPath = path.join(dir, result.filename);
  const restoredPath = path.join(dir, 'restored.db');
  const restore = () => spawnSync(process.execPath, [
    restoreTool, '--in', encryptedPath, '--key', testKey,
    '--machine', options.headers['X-Machine-Id'], '--out', restoredPath, '--verify',
  ], { encoding: 'utf8' });
  fs.writeFileSync(encryptedPath, encrypted);
  const restored = restore();
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /integrity_check: ok/);
  assert.deepEqual(fs.readFileSync(restoredPath), original);

  const restoredDb = new Database(restoredPath, { readonly: true });
  try {
    const read = 'SELECT original_filename, status FROM intake_log';
    assert.deepEqual(restoredDb.prepare(read).all(), db.prepare(read).all());
  } finally {
    restoredDb.close();
  }

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  fs.writeFileSync(encryptedPath, tampered);
  fs.rmSync(restoredPath);
  const rejected = restore();
  assert.equal(rejected.status, 1, rejected.stdout);
  assert.equal(fs.existsSync(restoredPath), false);

  const status = service.status();
  assert.equal(status.lastFile, result.filename);
  assert.ok(Number.isFinite(Date.parse(status.lastSuccess)));
  assert.equal(status.lastError, null);
});

test('כשל בהעלאת גיבוי נרשם בסטטוס והשירות מחזיר תוצאה מקומית', async t => {
  const { service } = sqliteFixture(t);
  const upload = stubUpload(t, { statusCode: 503, body: 'Service Unavailable' });
  const result = await service.run();
  assert.deepEqual(result, { local: true, cloud: false, error: 'Upload failed: HTTP 503 — Service Unavailable' });
  assert.equal(upload.mock.callCount(), 1);
  const status = service.status();
  assert.equal(status.lastSuccess, null);
  assert.equal(status.lastFile, null);
  assert.equal(status.lastError, result.error);
  assert.ok(Number.isFinite(Date.parse(status.lastErrorAt)));
});

test('תשובה שאינה JSON נשמרת ככשל העלאה', async t => {
  const { service } = sqliteFixture(t);
  stubUpload(t, { statusCode: 200, body: '<html>Service Unavailable</html>' });
  const result = await service.run();
  assert.deepEqual(result, { local: true, cloud: false, error: 'Upload failed: invalid JSON response' });
  assert.equal(service.status().lastError, result.error);
});

test('בסביבת פיתוח הגיבוי נשאר מקומי', async t => {
  const { service } = sqliteFixture(t);
  process.env.NODE_ENV = 'development';
  const upload = t.mock.method(https, 'request', () => { throw new Error('Unexpected upload'); });
  assert.deepEqual(await service.run(), { local: true, cloud: false });
  assert.equal(upload.mock.callCount(), 0);
});
