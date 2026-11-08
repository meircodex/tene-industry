const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { calculateMaterialStockPosition, calculatePurchaseRecommendations, reserveMaterialForOrder, releaseReservationsForItems, releaseAllReservationsForOrder, consumeReservationsForProduction } = require('../services/inventoryReservation');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE raw_material (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      diameter NUMERIC,
      material_type TEXT,
      weight_received NUMERIC,
      weight_used NUMERIC DEFAULT 0,
      weight_scrapped NUMERIC DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      diameter NUMERIC,
      material_type TEXT,
      quantity_ton NUMERIC,
      received_weight NUMERIC DEFAULT 0,
      status TEXT,
      received_at DATETIME
    );

    CREATE TABLE inventory_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_id INTEGER,
      diameter NUMERIC,
      material_type TEXT,
      reserved_kg NUMERIC DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

test('calculateMaterialStockPosition reads active reservations from inventory_reservations', () => {
  const db = createDb();

  db.prepare(`
    INSERT INTO raw_material (diameter, material_type, weight_received, weight_used, weight_scrapped, active)
    VALUES (12, 'coil', 1000, 100, 25, 1)
  `).run();

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(101, 1, 12, 'coil', 250, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(102, 2, 12, 'coil', 90, 'released');

  const position = calculateMaterialStockPosition(db, { diameter: 12, material_type: 'coil' });

  assert.equal(position.physicalStockKg, 875);
  assert.equal(position.reservedKg, 250);
  assert.equal(position.availableKg, 625);
  assert.equal(position.shortageKg, 0);

  db.close();
});
test('calculatePurchaseRecommendations returns procurement stock recommendation', () => {
  const db = createDb();

  db.prepare(`
    INSERT INTO raw_material (diameter, material_type, weight_received, weight_used, weight_scrapped, active)
    VALUES (12, 'coil', 500, 0, 0, 1)
  `).run();

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(151, 41, 12, 'coil', 800, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(152, 42, 12, 'coil', 200, 'released');

  db.prepare(`
    INSERT INTO purchase_orders (diameter, material_type, quantity_ton, received_weight, status, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(12, 'coil', 0.2, 50, 'ordered', null);

  db.prepare(`
    INSERT INTO purchase_orders (diameter, material_type, quantity_ton, received_weight, status, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(12, 'coil', 0.4, 0, 'cancelled', null);

  db.prepare(`
    INSERT INTO purchase_orders (diameter, material_type, quantity_ton, received_weight, status, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(12, 'coil', 0.5, 0, 'ordered', '2026-07-01');

  const recommendation = calculatePurchaseRecommendations(db, { diameter: 12, material_type: 'coil' });

  assert.deepEqual(recommendation, {
    physicalStockKg: 500,
    reservedKg: 800,
    availableKg: -300,
    incomingKg: 150,
    shortageKg: 300,
    recommendedPurchaseKg: 150,
  });

  db.close();
});
test('reserveMaterialForOrder inserts active reservations for order items', () => {
  const db = createDb();

  const shapeSnapshot = {
    contractVersion: 2,
    shapeVersion: 1,
    shapeId: 'straight-bar',
    shapeType: 'straight_bar',
    family: 'bars',
    data: { diameterMm: 10, lengthMm: 1000 },
    calculated: { weightKg: 5 },
    machineOutput: { generic: {}, machineProfiles: {} },
    validation: { valid: true, errors: [], warnings: [] },
  };

  const result = reserveMaterialForOrder(db, {
    order_id: 77,
    items: [
      { id: 701, diameter: 12, material_type: 'coil', total_weight: 250 },
      { item_id: 702, diameter: 10, materialType: 'straight', quantity: 3, shapeSnapshot },
      { id: 703, diameter: 8, total_weight: 0 },
    ],
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.reservedKg, 265);

  const rows = db.prepare('SELECT order_id,item_id,diameter,material_type,reserved_kg,status FROM inventory_reservations ORDER BY id').all();
  assert.deepEqual(rows, [
    { order_id: 77, item_id: 701, diameter: 12, material_type: 'coil', reserved_kg: 250, status: 'active' },
    { order_id: 77, item_id: 702, diameter: 10, material_type: 'straight', reserved_kg: 15, status: 'active' },
  ]);

  db.close();
});
test('releaseReservationsForItems releases active reservations for selected items', () => {
  const db = createDb();

  db.prepare(`
    INSERT INTO raw_material (diameter, material_type, weight_received, weight_used, weight_scrapped, active)
    VALUES (12, 'coil', 1000, 0, 0, 1)
  `).run();

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(201, 10, 12, 'coil', 100, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(201, 11, 12, 'coil', 75, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(201, 12, 12, 'coil', 25, 'released');

  const result = releaseReservationsForItems(db, { item_ids: [10, '10', 12, null, 'bad'] });

  assert.deepEqual(result, { item_ids: [10, 12], released: 1 });

  const rows = db.prepare('SELECT item_id,status FROM inventory_reservations ORDER BY item_id').all();
  assert.deepEqual(rows, [
    { item_id: 10, status: 'released' },
    { item_id: 11, status: 'active' },
    { item_id: 12, status: 'released' },
  ]);

  const position = calculateMaterialStockPosition(db, { diameter: 12, material_type: 'coil' });
  assert.equal(position.reservedKg, 75);
  assert.equal(position.availableKg, 925);

  db.close();
});
test('releaseAllReservationsForOrder releases all active reservations for one order', () => {
  const db = createDb();

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(301, 21, 12, 'coil', 100, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(301, 22, 12, 'coil', 75, 'active');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(301, 23, 12, 'coil', 25, 'released');

  db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(302, 24, 12, 'coil', 50, 'active');

  const result = releaseAllReservationsForOrder(db, { order_id: 301 });

  assert.deepEqual(result, { order_id: 301, released: 2 });

  const rows = db.prepare('SELECT order_id,item_id,status FROM inventory_reservations ORDER BY id').all();
  assert.deepEqual(rows, [
    { order_id: 301, item_id: 21, status: 'released' },
    { order_id: 301, item_id: 22, status: 'released' },
    { order_id: 301, item_id: 23, status: 'released' },
    { order_id: 302, item_id: 24, status: 'active' },
  ]);

  db.close();
});
test('consumeReservationsForProduction consumes matching reservations and stores actual weight', () => {
  const db = createDb();

  const insertReservation = db.prepare(`
    INSERT INTO inventory_reservations (order_id, item_id, diameter, material_type, reserved_kg, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertReservation.run(401, 31, 12, 'coil', 100, 'active');
  insertReservation.run(401, 32, 12, 'coil', 75, 'released');
  insertReservation.run(401, 33, 12, 'coil', 25, 'consumed');
  insertReservation.run(402, 34, 12, 'coil', 50, 'active');

  const result = consumeReservationsForProduction(db, {
    order_id: 401,
    item_ids: [31, 32, 999],
    actual_weight_kg: 160.4567,
  });

  assert.deepEqual(result, {
    order_id: 401,
    item_ids: [31, 32, 999],
    consumed: 1,
    actual_weight_kg: 160.457,
  });

  const rows = db.prepare('SELECT order_id,item_id,reserved_kg,status FROM inventory_reservations ORDER BY id').all();
  assert.deepEqual(rows, [
    { order_id: 401, item_id: 31, reserved_kg: 160.457, status: 'consumed' },
    { order_id: 401, item_id: 32, reserved_kg: 75, status: 'released' },
    { order_id: 401, item_id: 33, reserved_kg: 25, status: 'consumed' },
    { order_id: 402, item_id: 34, reserved_kg: 50, status: 'active' },
  ]);

  db.close();
});