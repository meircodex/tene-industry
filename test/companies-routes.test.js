'use strict';

const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ROLE_PERMISSIONS } = require('../permissions');

test('companies and holdings routes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-companies-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(tmpDir, 'companies.db');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

  const { closeServer, db, server } = require('../server');
  const { hashPin } = require('../auth-core');
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = new Map();
  function request(method, pathname, role, body) {
    const headers = {};
    if (role) headers.Authorization = `Bearer ${tokens.get(role)}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(baseUrl + pathname, { method, headers, body: JSON.stringify(body) });
  }

  const insertUser = db.prepare(
    'INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)'
  );
  const roles = Object.keys(ROLE_PERMISSIONS);
  for (const role of roles) {
    const username = `companies-test-${role}`;
    const pin = String(randomInt(1000, 10000));
    insertUser.run(username, username, role, hashPin(pin, 4));
    const login = await request('POST', '/auth/login', null, { username, pin });
    assert.equal(login.status, 200, `login for ${role}`);
    const { access_token: token } = await login.json();
    assert.ok(token, `access token for ${role}`);
    tokens.set(role, token);
  }

  const activeCompanies = db.prepare('SELECT id, name, ownership_pct FROM companies ORDER BY id').all();
  const [full, half] = activeCompanies;
  const inactiveId = db.prepare('INSERT INTO companies (name, active) VALUES (?, 0)')
    .run('חברה לא פעילה').lastInsertRowid;

  await t.test('GET /companies lists only active companies for office, finance, manager and admin', async () => {
    const allowed = ['office', 'finance', 'manager', 'admin'];
    for (const role of [null, ...roles]) {
      const response = await request('GET', '/companies', role);
      assert.equal(response.status, role ? (allowed.includes(role) ? 200 : 403) : 401, String(role));
      const body = await response.json();
      if (allowed.includes(role)) {
        assert.deepEqual(body.map(({ id, name, ownership_pct }) => ({ id, name, ownership_pct })), activeCompanies);
      }
    }
  });

  await t.test('GET /holdings limits access and weights each total by ownership', async () => {
    assert.equal(full.ownership_pct, 100);
    assert.equal(half.ownership_pct, 50);
    db.prepare(`
      INSERT INTO orders (order_num, company_id, status, priority, total_weight, billing_weight, created_at)
      VALUES
        ('HOLDINGS-1', ?, 'בייצור', 'דחוף', 80, 100, date('now')),
        ('HOLDINGS-2', ?, 'הושלם – ממתין לאיסוף', 'דחוף', 120, 150, date('now')),
        ('HOLDINGS-3', ?, 'ממתינה לאישור', 'רגיל', 60, 70, date('now', '-1 day')),
        ('HOLDINGS-4', ?, 'סופק – אושר', 'דחוף', 900, 950, date('now', '-31 days')),
        ('HOLDINGS-5', ?, 'בייצור', 'דחוף', 400, 500, date('now'))
    `).run(full.id, half.id, half.id, half.id, inactiveId);

    const fullTotals = {
      ordersToday: 1, weightToday: 80, inProduction: 1, completedToday: 0, urgentOpen: 1, revenueProxy: 100
    };
    const halfTotals = {
      ordersToday: 1, weightToday: 120, inProduction: 0, completedToday: 1, urgentOpen: 1, revenueProxy: 220
    };
    const allowed = ['finance', 'manager', 'admin'];
    for (const role of [null, ...roles]) {
      const response = await request('GET', '/holdings', role);
      assert.equal(response.status, role ? (allowed.includes(role) ? 200 : 403) : 401, String(role));
      const body = await response.json();
      if (!allowed.includes(role)) continue;

      assert.deepEqual(body.companies.map(company => company.id).sort((a, b) => a - b), [full.id, half.id]);
      const totals = Object.keys(fullTotals);
      const fullCompany = body.companies.find(company => company.id === full.id);
      const halfCompany = body.companies.find(company => company.id === half.id);
      for (const key of totals) {
        assert.equal(fullCompany[key], fullTotals[key], `full company ${key}`);
        assert.equal(halfCompany[key], halfTotals[key], `half-owned company ${key}`);
      }
      assert.equal(fullCompany.pending, 0);
      assert.equal(halfCompany.pending, 1);
      assert.deepEqual(fullCompany.weighted, fullTotals);
      assert.deepEqual(halfCompany.weighted, {
        ordersToday: 0.5, weightToday: 60, inProduction: 0, completedToday: 0.5, urgentOpen: 0.5, revenueProxy: 110
      });
      assert.deepEqual(body.consolidated, {
        ordersToday: 1.5, weightToday: 140, inProduction: 1, completedToday: 0.5, urgentOpen: 1.5, revenueProxy: 210
      });
    }
  });

  await t.test('POST and PATCH allow only manager and admin and persist successful writes', async () => {
    const name = 'חברה חדשה';
    const existingUrl = `/companies/${full.id}`;
    for (const role of [null, ...roles.filter(role => role !== 'manager' && role !== 'admin')]) {
      const status = role ? 403 : 401;
      const create = await request('POST', '/companies', role, { name });
      assert.equal(create.status, status, `POST as ${role}`);
      await create.json();
      const update = await request('PATCH', existingUrl, role, { name });
      assert.equal(update.status, status, `PATCH as ${role}`);
      await update.json();
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM companies WHERE name = ?').get(name).count, 0);
    assert.equal(db.prepare('SELECT name FROM companies WHERE id = ?').get(full.id).name, full.name);

    for (const role of ['manager', 'admin']) {
      const response = await request('POST', '/companies', role, { name });
      assert.equal(response.status, 200, `POST as ${role}`);
      const { id } = await response.json();
      const company = db.prepare('SELECT name, short_name, ownership_pct, erp_type, color FROM companies WHERE id = ?');
      assert.deepEqual(company.get(id), {
        name, short_name: name, ownership_pct: 100, erp_type: 'none', color: '#e07b39'
      });
      const patch = await request('PATCH', `/companies/${id}`, role, { ownership_pct: 0 });
      assert.equal(patch.status, 200, `PATCH as ${role}`);
      assert.equal((await patch.json()).success, true);
      assert.deepEqual(company.get(id), {
        name, short_name: name, ownership_pct: 0, erp_type: 'none', color: '#e07b39'
      });
    }
  });

  await t.test('POST rejects a missing or blank name with 400', async () => {
    for (const body of [undefined, {}, { name: null }, { name: '' }, { name: '   ' }, { name: 123 }]) {
      const response = await request('POST', '/companies', 'manager', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok((await response.json()).error);
    }
  });

  await t.test('PATCH returns 404 for a company ID absent from SQLite', async () => {
    const { id } = db.prepare('SELECT MAX(id) + 1 AS id FROM companies').get();
    const response = await request('PATCH', `/companies/${id}`, 'admin', { name: 'עדכון שם' });
    assert.equal(response.status, 404);
    assert.ok((await response.json()).error);
  });
});
