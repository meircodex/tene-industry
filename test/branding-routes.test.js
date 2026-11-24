'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('GET /api/branding זמין ללא התחברות ומחזיר רק שדות מיתוג ציבוריים', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-branding-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_PATH: path.join(tmpDir, 'test.db'),
    BACKUP_DIR: path.join(tmpDir, 'backups'),
  });

  const { closeServer, db, server } = require('../server');
  t.after(async () => {
    try {
      await new Promise((resolve, reject) => {
        closeServer((error) => error ? reject(error) : resolve());
      });
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const privateSettingMarker = randomUUID();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('WHATSAPP_APP_SECRET', privateSettingMarker);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/branding`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  const cacheDirectives = response.headers.get('cache-control')?.split(',').map((directive) => directive.trim());
  assert.ok(cacheDirectives?.includes('public'));
  const body = await response.text();
  assert.ok(!body.includes(privateSettingMarker), 'הגדרה פרטית נכללה בתגובת המיתוג');
  assert.deepEqual(JSON.parse(body), {
    name: 'טנא תעשיות ברזל בע"מ',
    logoUrl: '/brand/tene-pdf-logo.jpg',
    primaryColor: '#2E75B6',
    supportPhone: '',
  });
});
