'use strict';

function ensureInventoryAccountingSchema(db) {
  const add = (table, name, definition) => {
    if (!db.pragma(`table_info(${table})`).some(column => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  add('raw_material', 'stock_adjustment_kg', 'REAL NOT NULL DEFAULT 0');
  // Existing reservations must not be charged again: they may already have usage.
  add('inventory_reservations', 'consumption_mode', "TEXT NOT NULL DEFAULT 'legacy' CHECK(consumption_mode IN ('legacy','on_completion'))");
  add('inventory_reservations', 'preferred_raw_material_id', 'INTEGER REFERENCES raw_material(id)');
  add('inventory_reservations','pending_actual_kg','REAL');
  add('purchase_orders','quantity_units','INTEGER');
  add('purchase_orders','received_units','INTEGER NOT NULL DEFAULT 0');
  add('purchase_orders','specification_key','TEXT');
  add('purchase_orders','specification_json','TEXT');
  add('purchase_orders','unit_price','REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_mesh_stock (
      specification_key TEXT PRIMARY KEY,specification_json TEXT NOT NULL,quantity_units INTEGER NOT NULL DEFAULT 0 CHECK(quantity_units>=0),revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS inventory_mesh_receipts (
      id INTEGER PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,payload_fingerprint TEXT NOT NULL,specification_key TEXT NOT NULL,specification_json TEXT NOT NULL,
      quantity_units INTEGER NOT NULL CHECK(quantity_units>0),supplier_id INTEGER,delivery_note_num TEXT,status TEXT NOT NULL DEFAULT 'draft',created_by INTEGER,approved_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS inventory_mesh_demands (
      id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),item_id INTEGER NOT NULL REFERENCES items(id),specification_key TEXT NOT NULL,specification_json TEXT NOT NULL,
      quantity_units INTEGER NOT NULL CHECK(quantity_units>0),status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_active_item ON inventory_mesh_demands(item_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS inventory_mesh_movements (
      id INTEGER PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,specification_key TEXT NOT NULL REFERENCES inventory_mesh_stock(specification_key),
      delta_units INTEGER NOT NULL,before_units INTEGER NOT NULL,actor_id INTEGER,reason TEXT NOT NULL,source_item_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inventory_stocktakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      counted_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inventory_stocktake_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id INTEGER NOT NULL REFERENCES inventory_stocktakes(id),
      raw_material_id INTEGER NOT NULL REFERENCES raw_material(id),
      expected_kg REAL NOT NULL,
      counted_kg REAL NOT NULL CHECK(counted_kg>=0),
      adjustment_kg REAL NOT NULL,
      before_snapshot_json TEXT NOT NULL,
      post_count_net_kg REAL NOT NULL DEFAULT 0,
      reconciliation_note TEXT,
      UNIQUE(stocktake_id,raw_material_id)
    );
    CREATE TABLE IF NOT EXISTS inventory_completion_consumptions (
      reservation_id INTEGER PRIMARY KEY REFERENCES inventory_reservations(id),
      consumed_kg REAL NOT NULL CHECK(consumed_kg>=0),
      allocations_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_stocktake_lot ON inventory_stocktake_lines(raw_material_id,id);
  `);
  add('inventory_stocktake_lines','post_count_net_kg','REAL NOT NULL DEFAULT 0');
  add('inventory_stocktake_lines','reconciliation_note','TEXT');
}

module.exports = { ensureInventoryAccountingSchema };
