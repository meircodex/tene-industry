'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { hashPin } = require('../auth-core');
const { ITEM_STATUS } = require('../status-contracts');

const day = '2026-11-15';
const tokens = new Map();
let directory;
let runtime;
let baseUrl;
let machine;
let shiftId;
let stopId;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-production-metrics-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.BACKUP_DIR = path.join(directory, 'backups');

  runtime = require('../server');
  const { db, server } = runtime;

  machine = db.prepare('SELECT id, name FROM machines WHERE retired_at IS NULL ORDER BY id LIMIT 1').get();
  const insertItem = db.prepare(`
    INSERT INTO items (machine_id, machine, status, quantity, total_weight, actual_weight_kg, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertItem.run(machine.id, machine.name, ITEM_STATUS.DONE, 12, 900, 740, `${day}T07:00:00Z`);
  insertItem.run(machine.id, machine.name, ITEM_STATUS.DONE, 8, 380, null, `${day}T08:00:00Z`);
  insertItem.run(machine.id, machine.name, ITEM_STATUS.DONE, 1, 0, null, `${day}T09:00:00Z`);
  insertItem.run(machine.id, machine.name, ITEM_STATUS.DONE, 24, 1500, 1500, '2026-11-14T07:00:00Z');

  shiftId = db.prepare('INSERT INTO shifts (date, machine_id, started_at) VALUES (?, ?, ?)')
    .run(day, machine.id, `${day}T06:00:00Z`).lastInsertRowid;
  stopId = db.prepare('INSERT INTO machine_stops (machine_id, shift_id, started_at) VALUES (?, ?, ?)')
    .run(machine.id, shiftId, `${day}T10:00:00Z`).lastInsertRowid;
  db.prepare(`
    INSERT INTO machine_stops (machine_id, shift_id, started_at, ended_at, duration_min)
    VALUES (?, ?, ?, ?, 15)
  `).run(machine.id, shiftId, `${day}T07:30:00Z`, `${day}T07:45:00Z`);

  await once(server.listen(0, '127.0.0.1'), 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const pin = '1234';
  const pinHash = hashPin(pin, 4);
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, role, pin_hash, active, password_changed_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `);
  for (const role of ['viewer', 'production', 'maintenance', 'office', 'manager', 'admin']) {
    const username = `metrics-${role}`;
    insertUser.run(username, username, role, pinHash);
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    });
    assert.equal(response.status, 200, `login as ${role}`);
    const { access_token: token } = await response.json();
    assert.ok(token);
    tokens.set(role, token);
  }
});

after(async () => {
  try {
    if (runtime) {
      await new Promise((resolve, reject) => {
        runtime.closeServer(error => error ? reject(error) : resolve());
      });
    }
  } finally {
    runtime?.db.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function get(endpoint, role, date = day) {
  const headers = role ? { Authorization: `Bearer ${tokens.get(role)}` } : {};
  const response = await fetch(`${baseUrl}${endpoint}?${new URLSearchParams({ date })}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('GET /kpi/tons-today returns persisted output to a viewer and rejects invalid dates', async () => {
  const endpoint = '/kpi/tons-today';
  assert.equal((await get(endpoint)).status, 401);

  const { status, body } = await get(endpoint, 'viewer');
  assert.equal(status, 200);
  assert.equal(body.date, day);
  assert.equal(body.tons, 1.1);
  assert.equal(body.actual_weight_kg, 1120);
  assert.equal(body.item_count, 2);
  assert.equal(body.estimated_completed_items, 1);
  assert.equal(body.unweighed_completed_items, 1);
  assert.deepEqual(body.source_breakdown, {
    production_event_kg: 0,
    legacy_card_snapshot_kg: 0,
    completed_item_actual_kg: 740,
    completed_item_theoretical_kg: 380,
  });

  for (const date of ['not-a-date', '2026-02-30', '']) {
    const invalid = await get(endpoint, 'viewer', date);
    assert.equal(invalid.status, 400, `date=${JSON.stringify(date)}`);
    assert.equal(invalid.body.error, 'invalid_production_date');
  }
});

test('GET /machines/oee exposes machine output with insufficient OEE data to the allowed roles', async () => {
  const endpoint = '/machines/oee';
  assert.equal((await get(endpoint)).status, 401);
  for (const role of ['viewer', 'office']) {
    assert.equal((await get(endpoint, role)).status, 403, role);
  }

  for (const role of ['production', 'maintenance', 'manager', 'admin']) {
    const { status, body } = await get(endpoint, role);
    assert.equal(status, 200, role);
    const row = body.find(entry => entry.id === machine.id);
    assert.ok(row, `machine is visible to ${role}`);
    assert.equal(row.pieces_today, 21);
    assert.equal(row.tons_today, 1.12);
    assert.equal(row.downtime_min, 15);
    assert.equal(row.oee, null);
    assert.equal(row.measurement_status, 'insufficient_data');
  }
});

test('GET /kpi/shift-summary returns active shifts and stops to the allowed roles', async () => {
  const endpoint = '/kpi/shift-summary';
  assert.equal((await get(endpoint)).status, 401);
  for (const role of ['viewer', 'maintenance']) {
    assert.equal((await get(endpoint, role)).status, 403, role);
  }

  for (const role of ['production', 'office', 'manager', 'admin']) {
    const { status, body } = await get(endpoint, role);
    assert.equal(status, 200, role);
    assert.equal(body.todayTons, 1.1);
    assert.equal(body.todayActualWeightKg, 1120);
    assert.deepEqual(body.activeShifts.map(shift => shift.id), [shiftId]);
    assert.deepEqual(body.activeStops.map(stop => stop.id), [stopId]);
  }
});
