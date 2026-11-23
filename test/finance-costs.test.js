'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const { openFinanceDb } = require('./helpers/finance-db');
const { createAuthService, ensureAuthSchema, hashPin } = require('../auth-core');
const { createAuthMiddleware } = require('../middleware/auth');
const { getRolePermission, requireAnyRole, requireRole } = require('../permissions');
const createFinanceCostsRouter = require('../routes/financeCosts');
const { createSettingsService } = require('../services/settings');
const industry = require('../modules/steel-rebar');

async function start(t) {
  const db = openFinanceDb(t);
  ensureAuthSchema(db);
  const authService = createAuthService(db, { jwtSecret: randomBytes(32).toString('hex') });
  const { optionalAuth } = createAuthMiddleware({ authService, getRolePermission });
  const roles = [['finance', 'הנהלת חשבונות'], ['manager', 'מנהל מפעל'], ['admin', 'מנהל מערכת'], ['office', 'משרד']];
  const tokens = {};
  const pin = '1234';
  const pinHash = hashPin(pin, 4);
  for (const [role, name] of roles) {
    db.prepare('INSERT INTO users (username, display_name, role, pin_hash) VALUES (?, ?, ?, ?)').run(role, name, role, pinHash);
    const session = authService.authenticate({ username: role, pin });
    assert.equal(session.ok, true);
    tokens[role] = session.accessToken;
  }

  const settingsService = createSettingsService(db);
  settingsService.set('LABOR_COST_PER_HOUR', 100);
  settingsService.set('MACHINE_COST_PER_TON', 50);
  settingsService.set('SCRAP_COST_PCT', 2);
  settingsService.set('OVERHEAD_COST_FACTOR', 0.10);
  const events = [];
  const app = express();
  app.use(express.json());
  app.use('/api', optionalAuth, createFinanceCostsRouter({
    db, industry, settingsService, requireRole, requireAnyRole,
    wsBroadcast: (name, payload) => events.push({ name, payload }),
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  // Close HTTP before the database cleanup registered by openFinanceDb.
  return {
    db,
    events,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    async request(route, { method = 'GET', body, role = 'finance', status = 200, user } = {}) {
      const headers = {};
      if (role) headers.Authorization = `Bearer ${tokens[role]}`;
      if (user) headers['X-User'] = user;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
        method, headers, body: JSON.stringify(body),
      });
      const payload = await response.text();
      assert.equal(response.status, status, `${method} ${route}: ${payload}`);
      return JSON.parse(payload);
    },
  };
}

test('finance costs HTTP routes', async t => {
  const { db, request, events, close } = await start(t);
  try {
    db.exec(`
      INSERT INTO customers (id, name) VALUES (1, 'קבלן שלד'), (2, 'קבלן תשתיות');
      INSERT INTO orders (id, order_num, customer_id, total_weight, status, created_at) VALUES
        (11, 'ORD-011', 1, 1000, 'נמסרה', '2026-04-08 23:59:59'),
        (12, 'ORD-012', 1, 500, 'בייצור', '2026-04-08 07:00:00'),
        (13, 'ORD-013', 2, 200, 'נמסרה', '2026-04-08 08:00:00'),
        (14, 'ORD-014', 1, 100, 'נמסרה', '2026-04-09 00:00:00'),
        (15, 'ORD-015', 1, 950, 'נמסרה', '2026-04-07 23:59:59'),
        (16, 'ORD-016', 1, 0, 'בייצור', '2026-04-09 09:00:00');
    `);
    const costs = '/orders/11/costs';

    await t.test('role checks run before reads and writes', async () => {
      for (const [route, method, body] of [
        [costs, 'GET'], [`${costs}/recalculate`, 'POST', {}],
        [`${costs}/lock`, 'PATCH', { lock: true }], [`${costs}/snapshots`, 'GET'],
        [`${costs}/billing`, 'PATCH', { billed_amount: 6000 }], [`${costs}/billing`, 'GET'],
        ['/profitability', 'GET'], ['/profitability/by-customer', 'GET'],
        ['/steel-prices', 'GET'], ['/steel-prices', 'POST', { diameter: 12, price_per_ton: 4000 }],
      ]) {
        await request(route, { method, body, role: null, status: 401 });
        await request(route, { method, body, role: 'office', status: 403 });
      }
      await request(`${costs}/lock`, { method: 'PATCH', body: { lock: true }, status: 403 });
      await request('/profitability', { role: 'manager' });
      await request('/profitability', { role: 'admin' });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_costs').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM financial_events').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM steel_price_history').get().n, 0);
      assert.deepEqual(events, []);
    });

    await t.test('cost calculation persists and locks protect costs and billing until unlocked', async () => {
      await request('/orders/999/costs', { status: 404 });
      await request('/orders/999/costs/lock', { method: 'PATCH', role: 'manager', body: { lock: true }, status: 404 });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM financial_events').get().n, 0);
      await request('/orders/999/costs/recalculate', { method: 'POST', body: {}, status: 404 });
      assert.equal(await request(`${costs}/billing`), null);
      await request(`${costs}/billing`, { method: 'PATCH', body: {}, status: 400 });
      assert.deepEqual(await request(`${costs}/snapshots`), []);
      const original = await request(costs);
      assert.deepEqual(
        [original.material_cost, original.labor_cost, original.machine_cost, original.scrap_cost,
          original.overhead_cost, original.total_cost, original.tons_delivered, original.cost_per_ton,
          original.revenue, original.margin_pct, original.confidence],
        [3800, 920, 50, 76, 484.6, 5330.6, 1, 5330.6, 0, null, 'low'],
      );
      await request('/steel-prices', { method: 'POST', body: { diameter: 12, price_per_ton: 4000, effective_date: '2026-04-08' } });
      assert.deepEqual(await request(costs), original);

      const reason = 'אישור חודש אפריל';
      const user = 'manager';
      assert.deepEqual(await request(`${costs}/lock`, { method: 'PATCH', role: 'manager', user, body: { lock: true, reason } }), { success: true, locked: true });
      const locked = await request(costs);
      assert.equal(locked.locked, 1);
      assert.equal(locked.locked_by, user);
      assert.equal(locked.notes, reason);
      assert.ok(locked.locked_at);
      await request(`${costs}/recalculate`, { method: 'POST', role: 'admin', body: {}, status: 403 });
      await request(`${costs}/billing`, { method: 'PATCH', body: { billed_amount: 7000 }, status: 403 });
      assert.equal(await request(`${costs}/billing`), null);
      assert.deepEqual(await request(costs), locked);
      assert.deepEqual(await request(`${costs}/snapshots`), []);
      assert.deepEqual(events, []);

      const unlockReason = 'עדכון חשבונית';
      assert.deepEqual(await request(`${costs}/lock`, { method: 'PATCH', role: 'admin', user: 'admin', body: { lock: false, reason: unlockReason } }), { success: true, locked: false });
      const unlocked = await request(costs);
      assert.equal(unlocked.locked_by, null);
      assert.deepEqual(db.prepare('SELECT event_type, entity_id, description, created_by FROM financial_events ORDER BY id').all(), [
        { event_type: 'cost_locked', entity_id: 11, description: reason, created_by: user },
        { event_type: 'cost_unlocked', entity_id: 11, description: unlockReason, created_by: 'admin' },
      ]);
      const calc = await request(`${costs}/recalculate`, { method: 'POST', user: 'finance', body: { reason: 'עדכון מחיר פלדה' } });
      assert.equal(calc.recalculated, true);
      assert.equal(calc.material_cost, 4000);
      assert.equal(calc.total_cost, 5555);
      assert.equal(calc.confidence, 'high');
      const [snapshot] = await request(`${costs}/snapshots`);
      assert.deepEqual(snapshot.snapshot, unlocked);
      assert.equal(snapshot.reason, 'עדכון מחיר פלדה');
      assert.equal(snapshot.created_by, 'finance');
      assert.deepEqual(events, [{ name: 'cost_update', payload: { orderId: 11, margin_pct: null, gross_margin: -5555 } }]);

      const updated = await request(`${costs}/billing`, { method: 'PATCH', body: {
        billed_amount: 7000, billed_date: '2026-04-10', priority_invoice_ref: 'INV-011', billing_notes: 'חיוב סופי',
      } });
      assert.equal(updated.costs.revenue_source, 'billed');
      assert.equal(updated.costs.revenue, 7000);
      assert.equal(updated.costs.gross_margin, 1445);
      const billing = await request(`${costs}/billing`);
      assert.equal(billing.billed_by, 'הנהלת חשבונות');
      assert.equal(billing.billing_notes, 'חיוב סופי');
      assert.equal(billing.priority_invoice_ref, 'INV-011');
      assert.equal((await request(costs)).revenue, 7000);
    });

    await t.test('profitability filters by day, customer and status and totals actual billing', async () => {
      const query = 'from=2026-04-08&to=2026-04-08';
      const report = await request(`/profitability?${query}`);
      assert.deepEqual(report.orders.map(row => row.id), [11, 13, 12]);
      assert.deepEqual(report.summary, {
        total_orders: 3, billed_orders: 1, total_revenue: 7000, total_cost: 5555,
        total_gross_margin: 1445, total_weight_tons: 1.7, avg_margin_pct: (1445 / 7000) * 100,
      });
      const filtered = await request(`/profitability?${query}&customer_id=1&status=${encodeURIComponent('נמסרה')}`);
      assert.deepEqual(filtered.orders.map(row => [row.id, row.customer_name, row.priority_invoice_ref]), [[11, 'קבלן שלד', 'INV-011']]);
      const customers = await request(`/profitability/by-customer?${query}`);
      assert.deepEqual(customers, [
        { customer_id: 1, customer_name: 'קבלן שלד', order_count: 2, total_revenue: 7000, total_cost: 5555,
          total_margin: 1445, total_tons: 1, avg_margin_pct: (1445 / 7000) * 100 },
        { customer_id: 2, customer_name: 'קבלן תשתיות', order_count: 1, total_revenue: null, total_cost: null,
          total_margin: null, total_tons: null, avg_margin_pct: null },
      ]);
      const empty = await request('/profitability?from=2026-05-01');
      assert.equal(empty.summary.avg_margin_pct, null);
      assert.deepEqual(empty.orders, []);
    });

    await t.test('recalculation uses item weights, processing rates and per-unit prices', async () => {
      db.exec(`
        INSERT INTO pricing_price_books (id, code, name, customer_id, status)
          VALUES (1, 'PB-1', 'מחירון קבלן', 1, 'active');
        INSERT INTO pricing_price_items (price_book_id, sku, description, diameter, unit, price_before_vat) VALUES
          (1, 'MAT-12', 'פלדה 12 מ״מ', 12, 'kg', 6),
          (1, 'MAT-14-20', 'פלדה 14-20 מ״מ', NULL, 'kg', 7),
          (1, 'CUT', 'חיתוך', NULL, 'kg', 0.5),
          (1, 'BEND', 'כיפוף', NULL, 'kg', 1),
          (1, 'HOOP', 'חישוק', NULL, 'יח', 8);
        INSERT INTO pallets (id, order_id, pallet_num) VALUES (1, 12, 1);
        INSERT INTO items (pallet_id, order_id, shape_name, diameter, segments, total_length_mm, quantity,
          total_weight, price_category) VALUES
          (1, 12, 'מוט', 12, '[{"length_mm":6000}]', 6000, 20, 100, 'auto'),
          (1, 12, 'מוט חתוך', 16, '[{"length_mm":4000}]', 4000, 10, 50, 'auto'),
          (1, 12, 'מוט מכופף', 12, '[{"length_mm":1000},{"length_mm":900}]', 1900, 10, 25, 'auto'),
          (1, 12, 'חישוק', 8, '[{"length_mm":300},{"length_mm":300}]', 600, 10, 5, 'per_unit');
      `);
      const calc = await request('/orders/12/costs/recalculate', { method: 'POST', body: {} });
      assert.equal(calc.revenue_source, 'price_book');
      assert.equal(calc.revenue, 1242.5);
      assert.equal(calc.tons_delivered, 0.18);
      assert.equal(calc.material_cost, 720);
      assert.ok(Math.abs(calc.labor_cost - 147.6) < 1e-9);
      assert.deepEqual(await request('/orders/12/costs/snapshots'), []);
      const zero = await request('/orders/16/costs');
      assert.deepEqual([zero.total_cost, zero.cost_per_ton, zero.margin_pct], [0, 0, null]);
    });

    await t.test('steel prices keep dated history and list the most recent row per diameter', async () => {
      const post = (body, status = 200) => request('/steel-prices', { method: 'POST', body, status });
      await post({ diameter: 12, price_per_ton: 0 }, 400);
      await post({ diameter: 12, price_per_ton: 'לא מספר' }, 400);
      await post({ diameter: 12, price_per_ton: 3900, effective_date: '2026-04-07' });
      const latest = await post({ diameter: '12', price_per_ton: '4100', effective_date: '2026-04-08', notes: 'עדכון ספק' });
      const small = await post({ diameter: 8, price_per_ton: 4050 });
      const general = await post({ price_per_ton: 4200, effective_date: '2026-04-09' });
      const rows = await request('/steel-prices');
      assert.deepEqual(rows.map(row => [row.id, row.diameter, row.price_per_ton]), [
        [small.id, 8, 4050], [latest.id, 12, 4100], [general.id, null, 4200],
      ]);
      assert.equal(rows[0].effective_date, new Date().toISOString().slice(0, 10));
      assert.equal(rows[1].notes, 'עדכון ספק');
      assert.equal(rows[1].created_by, db.prepare("SELECT id FROM users WHERE role = 'finance'").get().id);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM steel_price_history').get().n, 5);
    });
  } finally {
    await close();
  }
});
