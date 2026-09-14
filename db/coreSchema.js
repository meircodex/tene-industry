'use strict';

const { ensureFinanceSchema } = require('./financeSchema');

function tableColumns(db, table) {
  return db.pragma(`table_info(${table})`).map(column => column.name);
}

function ensureColumn(db, table, column, definition) {
  if (tableColumns(db, table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[DB] Migration: ${table}.${column} added`);
}

function ensureMaterialAllocationPlanningV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allocation_plans_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_uid TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      material_requirement_id INTEGER NOT NULL,
      requirement_uid TEXT NOT NULL,
      required_kg NUMERIC NOT NULL CHECK (typeof(required_kg) IN ('integer','real') AND required_kg > 0),
      source_revision TEXT,
      spec_diameter NUMERIC,
      spec_material_type TEXT,
      lifecycle_version INTEGER NOT NULL DEFAULT 2 CHECK (lifecycle_version = 2),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','superseded','cancelled')),
      planned_by INTEGER,
      planned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      released_by INTEGER,
      released_at DATETIME,
      release_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (material_requirement_id) REFERENCES material_requirements_v2(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_allocation_plans_v2_one_active_requirement
      ON allocation_plans_v2(material_requirement_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_allocation_plans_v2_requirement
      ON allocation_plans_v2(material_requirement_id, id);
    CREATE TABLE IF NOT EXISTS allocation_plan_lines_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allocation_plan_id INTEGER NOT NULL,
      raw_material_id INTEGER NOT NULL,
      allocated_kg NUMERIC NOT NULL CHECK (typeof(allocated_kg) IN ('integer','real') AND allocated_kg > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
      allocation_sequence INTEGER NOT NULL,
      released_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (allocation_plan_id) REFERENCES allocation_plans_v2(id),
      FOREIGN KEY (raw_material_id) REFERENCES raw_material(id),
      UNIQUE(allocation_plan_id, raw_material_id)
    );
    CREATE INDEX IF NOT EXISTS idx_allocation_plan_lines_v2_active_lot
      ON allocation_plan_lines_v2(raw_material_id, status);
    CREATE TABLE IF NOT EXISTS allocation_plan_events_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allocation_plan_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('reconciled', 'released')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      actor_id INTEGER,
      details_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (allocation_plan_id) REFERENCES allocation_plans_v2(id)
    );
    CREATE INDEX IF NOT EXISTS idx_allocation_plan_events_v2_plan
      ON allocation_plan_events_v2(allocation_plan_id, id);
  `);
  ensureColumn(db, 'allocation_plans_v2', 'spec_diameter', 'NUMERIC');
  ensureColumn(db, 'allocation_plans_v2', 'spec_material_type', 'TEXT');
}

function ensureMaterialConsumptionV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_consumption_reports_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_uid TEXT NOT NULL UNIQUE,
      material_requirement_id INTEGER NOT NULL,
      requirement_uid TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL DEFAULT 2 CHECK (lifecycle_version=2),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','cancelled','approved')),
      notes TEXT,
      created_by INTEGER,
      cancelled_by INTEGER,
      cancelled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (material_requirement_id) REFERENCES material_requirements_v2(id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_consumption_reports_v2_requirement
      ON material_consumption_reports_v2(material_requirement_id, id);
    CREATE TABLE IF NOT EXISTS material_consumption_report_lines_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      allocation_plan_id INTEGER NOT NULL,
      allocation_plan_line_id INTEGER NOT NULL,
      raw_material_id INTEGER NOT NULL,
      consumed_kg NUMERIC NOT NULL CHECK (typeof(consumed_kg) IN ('integer','real') AND consumed_kg>0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES material_consumption_reports_v2(id),
      FOREIGN KEY (allocation_plan_id) REFERENCES allocation_plans_v2(id),
      FOREIGN KEY (allocation_plan_line_id) REFERENCES allocation_plan_lines_v2(id),
      FOREIGN KEY (raw_material_id) REFERENCES raw_material(id),
      UNIQUE(report_id, allocation_plan_line_id)
    );
    CREATE TABLE IF NOT EXISTS material_consumption_events_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('consumption','reversal')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      report_id INTEGER,
      original_event_id INTEGER,
      material_requirement_id INTEGER NOT NULL,
      requirement_uid TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL DEFAULT 2 CHECK (lifecycle_version=2),
      approved_by INTEGER NOT NULL,
      approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      FOREIGN KEY (report_id) REFERENCES material_consumption_reports_v2(id),
      FOREIGN KEY (original_event_id) REFERENCES material_consumption_events_v2(id),
      FOREIGN KEY (material_requirement_id) REFERENCES material_requirements_v2(id)
    );
    CREATE TABLE IF NOT EXISTS material_consumption_event_lines_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumption_event_id INTEGER NOT NULL,
      original_event_line_id INTEGER,
      allocation_plan_id INTEGER NOT NULL,
      allocation_plan_line_id INTEGER NOT NULL,
      raw_material_id INTEGER NOT NULL,
      consumed_kg NUMERIC NOT NULL CHECK (typeof(consumed_kg) IN ('integer','real') AND consumed_kg>0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (consumption_event_id) REFERENCES material_consumption_events_v2(id),
      FOREIGN KEY (original_event_line_id) REFERENCES material_consumption_event_lines_v2(id),
      FOREIGN KEY (allocation_plan_id) REFERENCES allocation_plans_v2(id),
      FOREIGN KEY (allocation_plan_line_id) REFERENCES allocation_plan_lines_v2(id),
      FOREIGN KEY (raw_material_id) REFERENCES raw_material(id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_consumption_event_lines_v2_allocation
      ON material_consumption_event_lines_v2(allocation_plan_line_id, id);
    CREATE TABLE IF NOT EXISTS material_consumption_report_audit_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created','updated','cancelled','approved')),
      actor_id INTEGER,
      details_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES material_consumption_reports_v2(id)
    );
  `);
}

// The worker-card QR is the physical loading identifier.  These rows freeze
// the issued card projection at the start of one truck-loading session while
// leaving the older package ledger intact for historical documents only.
function ensureProductionCardLoadingSchema(db) {
  ensureColumn(db, 'order_loading_sessions', 'scan_unit', "TEXT NOT NULL DEFAULT 'package' CHECK (scan_unit IN ('package','production_card'))");
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_loading_session_cards (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        INTEGER NOT NULL,
      card_key          TEXT NOT NULL,
      worker_card_token TEXT NOT NULL,
      parent_item_id    INTEGER NOT NULL,
      title             TEXT NOT NULL,
      quantity          REAL NOT NULL DEFAULT 0,
      weight            REAL NOT NULL DEFAULT 0,
      diameter_mm       REAL,
      total_length_mm   REAL,
      state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','loaded')),
      loaded_by         INTEGER,
      loaded_at         DATETIME,
      FOREIGN KEY (session_id) REFERENCES order_loading_sessions(id),
      FOREIGN KEY (parent_item_id) REFERENCES items(id),
      FOREIGN KEY (loaded_by) REFERENCES users(id),
      UNIQUE(session_id, card_key),
      UNIQUE(session_id, worker_card_token)
    );
    CREATE INDEX IF NOT EXISTS idx_loading_session_cards_session
      ON order_loading_session_cards(session_id, state);
    CREATE INDEX IF NOT EXISTS idx_loading_session_cards_token
      ON order_loading_session_cards(worker_card_token);

    CREATE TABLE IF NOT EXISTS order_loading_card_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        INTEGER NOT NULL,
      event_type        TEXT NOT NULL,
      card_key          TEXT,
      scanned_value     TEXT,
      actor_id          INTEGER,
      details_json      JSON,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES order_loading_sessions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loading_card_events_session
      ON order_loading_card_events(session_id, created_at);
  `);
}

// A cancellation is an inventory event, not a destructive edit.  Finished
// goods are intentionally kept outside raw_material: a produced bar cannot
// become raw coil again just because its sales order was cancelled.
function ensureOrderCancellationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finished_goods_warehouses (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_code    TEXT NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      requires_location INTEGER NOT NULL DEFAULT 1 CHECK (requires_location IN (0,1)),
      active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_cancellation_transactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      cancellation_uid    TEXT NOT NULL UNIQUE,
      order_id            INTEGER NOT NULL,
      scope_type          TEXT NOT NULL CHECK (scope_type IN ('order','item')),
      idempotency_key     TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      reason              TEXT NOT NULL,
      actor_id            INTEGER,
      actor_name          TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_order_cancellation_transactions_order
      ON order_cancellation_transactions(order_id, id);

    -- One row freezes the reconciliation used to cancel one order item.  The
    -- unique item constraint is the last line of defence against a second
    -- disposition silently double-counting physical output.
    CREATE TABLE IF NOT EXISTS order_cancellation_item_dispositions (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      cancellation_transaction_id INTEGER NOT NULL,
      order_id                  INTEGER NOT NULL,
      source_order_item_id      INTEGER NOT NULL UNIQUE,
      ordered_qty               REAL NOT NULL,
      recorded_produced_qty     REAL NOT NULL DEFAULT 0,
      confirmed_produced_qty    REAL NOT NULL,
      erroneous_production_correction_qty REAL NOT NULL DEFAULT 0,
      delivered_qty             REAL NOT NULL DEFAULT 0,
      packed_qty                REAL NOT NULL DEFAULT 0,
      picked_qty                REAL NOT NULL DEFAULT 0,
      previous_stock_qty        REAL NOT NULL DEFAULT 0,
      previous_scrap_qty        REAL NOT NULL DEFAULT 0,
      eligible_produced_qty     REAL NOT NULL DEFAULT 0,
      stock_disposition_qty     REAL NOT NULL DEFAULT 0,
      scrap_disposition_qty     REAL NOT NULL DEFAULT 0,
      cancelled_unproduced_qty  REAL NOT NULL DEFAULT 0,
      production_state          TEXT NOT NULL CHECK (production_state IN ('NOT_PRODUCED','PARTIALLY_PRODUCED','FULLY_PRODUCED')),
      disposition_type          TEXT NOT NULL CHECK (disposition_type IN ('NONE','FINISHED_GOODS_STOCK','SCRAP','SPLIT_STOCK_AND_SCRAP')),
      source_production_refs_json TEXT NOT NULL DEFAULT '{}',
      reconciliation_json       TEXT NOT NULL DEFAULT '{}',
      created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cancellation_item_dispositions_order
      ON order_cancellation_item_dispositions(order_id, source_order_item_id);

    -- A correction changes the business interpretation of an erroneous
    -- production record.  It never deletes or edits the original card/output
    -- event, and it is deliberately separate from physical stock or scrap.
    CREATE TABLE IF NOT EXISTS production_record_correction_events (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_uid             TEXT NOT NULL UNIQUE,
      correction_type            TEXT NOT NULL CHECK (correction_type IN ('ERRONEOUS_PRODUCTION_RECORD')),
      cancellation_transaction_id INTEGER NOT NULL,
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      recorded_produced_qty      REAL NOT NULL,
      correction_qty             REAL NOT NULL CHECK (correction_qty > 0),
      effective_produced_qty_before REAL NOT NULL,
      effective_produced_qty_after  REAL NOT NULL,
      reason                     TEXT NOT NULL,
      source_production_refs_json TEXT NOT NULL DEFAULT '{}',
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (actor_id) REFERENCES users(id),
      UNIQUE(cancellation_transaction_id, source_order_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_production_record_corrections_item
      ON production_record_correction_events(source_order_item_id, id);

    -- Lots remain source-level records even when availability is aggregated by
    -- physical_spec_fingerprint in a read model.
    CREATE TABLE IF NOT EXISTS finished_goods_lots (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_uid                    TEXT NOT NULL UNIQUE,
      warehouse_id               INTEGER NOT NULL,
      location_code              TEXT,
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      cancellation_transaction_id INTEGER NOT NULL,
      source_production_refs_json TEXT NOT NULL,
      physical_spec_json         TEXT NOT NULL,
      physical_spec_fingerprint  TEXT NOT NULL,
      produced_quantity          REAL NOT NULL CHECK (produced_quantity > 0),
      available_quantity         REAL NOT NULL CHECK (available_quantity >= 0),
      calculated_weight_kg       REAL,
      measured_weight_kg         REAL,
      production_date            TEXT,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (warehouse_id) REFERENCES finished_goods_warehouses(id),
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_finished_goods_lots_availability
      ON finished_goods_lots(warehouse_id, location_code, physical_spec_fingerprint, available_quantity);
    CREATE INDEX IF NOT EXISTS idx_finished_goods_lots_source
      ON finished_goods_lots(source_order_id, source_order_item_id);

    CREATE TABLE IF NOT EXISTS finished_goods_movements (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_uid               TEXT NOT NULL UNIQUE,
      movement_type              TEXT NOT NULL CHECK (movement_type IN ('cancellation_to_stock')),
      lot_id                     INTEGER NOT NULL,
      warehouse_id               INTEGER NOT NULL,
      location_code              TEXT,
      quantity                   REAL NOT NULL CHECK (quantity > 0),
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      cancellation_transaction_id INTEGER NOT NULL,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lot_id) REFERENCES finished_goods_lots(id),
      FOREIGN KEY (warehouse_id) REFERENCES finished_goods_warehouses(id),
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    -- This is deliberately separate from raw material and only ever receives
    -- append-only write-off rows.
    CREATE TABLE IF NOT EXISTS finished_goods_scrap_movements (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_uid               TEXT NOT NULL UNIQUE,
      movement_type              TEXT NOT NULL CHECK (movement_type IN ('cancellation_scrap_write_off')),
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      cancellation_transaction_id INTEGER NOT NULL,
      source_production_refs_json TEXT NOT NULL,
      quantity                   REAL NOT NULL CHECK (quantity > 0),
      calculated_weight_kg       REAL,
      measured_weight_kg         REAL,
      reason                     TEXT NOT NULL,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_finished_goods_scrap_source
      ON finished_goods_scrap_movements(source_order_id, source_order_item_id);

    CREATE TABLE IF NOT EXISTS inventory_reservation_release_events (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_reservation_id      INTEGER NOT NULL UNIQUE,
      cancellation_transaction_id INTEGER NOT NULL,
      order_id                   INTEGER NOT NULL,
      item_id                    INTEGER,
      reserved_kg_before          REAL NOT NULL,
      released_kg                REAL NOT NULL,
      retained_for_production_kg REAL NOT NULL,
      reason                     TEXT NOT NULL,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_reservation_id) REFERENCES inventory_reservations(id),
      FOREIGN KEY (cancellation_transaction_id) REFERENCES order_cancellation_transactions(id),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    CREATE TRIGGER IF NOT EXISTS finished_goods_movements_no_update
      BEFORE UPDATE ON finished_goods_movements
      BEGIN SELECT RAISE(ABORT, 'finished_goods_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS finished_goods_movements_no_delete
      BEFORE DELETE ON finished_goods_movements
      BEGIN SELECT RAISE(ABORT, 'finished_goods_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS finished_goods_scrap_movements_no_update
      BEFORE UPDATE ON finished_goods_scrap_movements
      BEGIN SELECT RAISE(ABORT, 'finished_goods_scrap_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS finished_goods_scrap_movements_no_delete
      BEFORE DELETE ON finished_goods_scrap_movements
      BEGIN SELECT RAISE(ABORT, 'finished_goods_scrap_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS production_record_corrections_no_update
      BEFORE UPDATE ON production_record_correction_events
      BEGIN SELECT RAISE(ABORT, 'production_record_corrections_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS production_record_corrections_no_delete
      BEFORE DELETE ON production_record_correction_events
      BEGIN SELECT RAISE(ABORT, 'production_record_corrections_are_append_only'); END;

    -- Historical reconciliation is intentionally distinct from cancellation:
    -- it changes no order status and never masquerades as a new cancellation.
    CREATE TABLE IF NOT EXISTS historical_production_reconciliation_transactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_uid  TEXT NOT NULL UNIQUE,
      order_id            INTEGER NOT NULL,
      idempotency_key     TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      reason              TEXT NOT NULL,
      actor_id            INTEGER,
      actor_name          TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_reconciliation_order
      ON historical_production_reconciliation_transactions(order_id, id);

    -- One immutable event freezes both the correction of legacy evidence and
    -- the physical disposition that made its effective truth complete.
    CREATE TABLE IF NOT EXISTS historical_production_reconciliation_items (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_transaction_id INTEGER NOT NULL,
      order_id                   INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL UNIQUE,
      ordered_qty                REAL NOT NULL,
      recorded_produced_qty      REAL NOT NULL,
      effective_produced_qty_before REAL NOT NULL,
      production_correction_qty  REAL NOT NULL DEFAULT 0,
      effective_produced_qty_after REAL NOT NULL,
      delivered_qty              REAL NOT NULL DEFAULT 0,
      packed_qty                 REAL NOT NULL DEFAULT 0,
      picked_qty                 REAL NOT NULL DEFAULT 0,
      previous_stock_qty         REAL NOT NULL DEFAULT 0,
      previous_scrap_qty         REAL NOT NULL DEFAULT 0,
      eligible_produced_qty      REAL NOT NULL DEFAULT 0,
      stock_disposition_qty      REAL NOT NULL DEFAULT 0,
      scrap_disposition_qty      REAL NOT NULL DEFAULT 0,
      unreconciled_physical_qty  REAL NOT NULL DEFAULT 0,
      production_reality         TEXT NOT NULL CHECK (production_reality IN ('PRODUCED_AS_RECORDED','NOT_ACTUALLY_PRODUCED','PARTIALLY_PRODUCED')),
      source_production_refs_json TEXT NOT NULL DEFAULT '{}',
      reconciliation_json        TEXT NOT NULL DEFAULT '{}',
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reconciliation_transaction_id) REFERENCES historical_production_reconciliation_transactions(id),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_reconciliation_items_order
      ON historical_production_reconciliation_items(order_id, source_order_item_id);

    CREATE TABLE IF NOT EXISTS historical_finished_goods_lots (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_uid                    TEXT NOT NULL UNIQUE,
      warehouse_id               INTEGER NOT NULL,
      location_code              TEXT,
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      reconciliation_transaction_id INTEGER NOT NULL,
      source_production_refs_json TEXT NOT NULL,
      physical_spec_json         TEXT NOT NULL,
      physical_spec_fingerprint  TEXT NOT NULL,
      produced_quantity          REAL NOT NULL CHECK (produced_quantity > 0),
      available_quantity         REAL NOT NULL CHECK (available_quantity >= 0),
      calculated_weight_kg       REAL,
      measured_weight_kg         REAL,
      production_date            TEXT,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (warehouse_id) REFERENCES finished_goods_warehouses(id),
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (reconciliation_transaction_id) REFERENCES historical_production_reconciliation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_finished_goods_lots_availability
      ON historical_finished_goods_lots(warehouse_id, location_code, physical_spec_fingerprint, available_quantity);
    CREATE INDEX IF NOT EXISTS idx_historical_finished_goods_lots_source
      ON historical_finished_goods_lots(source_order_id, source_order_item_id);

    CREATE TABLE IF NOT EXISTS historical_finished_goods_movements (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_uid               TEXT NOT NULL UNIQUE,
      movement_type              TEXT NOT NULL CHECK (movement_type IN ('historical_reconciliation_to_stock')),
      lot_id                     INTEGER NOT NULL,
      warehouse_id               INTEGER NOT NULL,
      location_code              TEXT,
      quantity                   REAL NOT NULL CHECK (quantity > 0),
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      reconciliation_transaction_id INTEGER NOT NULL,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lot_id) REFERENCES historical_finished_goods_lots(id),
      FOREIGN KEY (warehouse_id) REFERENCES finished_goods_warehouses(id),
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (reconciliation_transaction_id) REFERENCES historical_production_reconciliation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS historical_finished_goods_scrap_movements (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_uid               TEXT NOT NULL UNIQUE,
      movement_type              TEXT NOT NULL CHECK (movement_type IN ('historical_reconciliation_scrap_write_off')),
      source_order_id            INTEGER NOT NULL,
      source_order_item_id       INTEGER NOT NULL,
      reconciliation_transaction_id INTEGER NOT NULL,
      source_production_refs_json TEXT NOT NULL,
      quantity                   REAL NOT NULL CHECK (quantity > 0),
      calculated_weight_kg       REAL,
      measured_weight_kg         REAL,
      reason                     TEXT NOT NULL,
      actor_id                   INTEGER,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_order_id) REFERENCES orders(id),
      FOREIGN KEY (source_order_item_id) REFERENCES items(id),
      FOREIGN KEY (reconciliation_transaction_id) REFERENCES historical_production_reconciliation_transactions(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_finished_goods_scrap_source
      ON historical_finished_goods_scrap_movements(source_order_id, source_order_item_id);

    CREATE TRIGGER IF NOT EXISTS historical_finished_goods_movements_no_update
      BEFORE UPDATE ON historical_finished_goods_movements
      BEGIN SELECT RAISE(ABORT, 'historical_finished_goods_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS historical_finished_goods_movements_no_delete
      BEFORE DELETE ON historical_finished_goods_movements
      BEGIN SELECT RAISE(ABORT, 'historical_finished_goods_movements_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS historical_finished_goods_scrap_no_update
      BEFORE UPDATE ON historical_finished_goods_scrap_movements
      BEGIN SELECT RAISE(ABORT, 'historical_finished_goods_scrap_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS historical_finished_goods_scrap_no_delete
      BEFORE DELETE ON historical_finished_goods_scrap_movements
      BEGIN SELECT RAISE(ABORT, 'historical_finished_goods_scrap_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS historical_reconciliation_items_no_update
      BEFORE UPDATE ON historical_production_reconciliation_items
      BEGIN SELECT RAISE(ABORT, 'historical_reconciliation_items_are_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS historical_reconciliation_items_no_delete
      BEFORE DELETE ON historical_production_reconciliation_items
      BEGIN SELECT RAISE(ABORT, 'historical_reconciliation_items_are_append_only'); END;

    -- Inventory reads intentionally span both immutable sources.  A
    -- historical reconciliation must be available to operations just like a
    -- cancellation lot, while the source lot and its transaction stay
    -- individually traceable instead of being overwritten by an aggregate.
    CREATE VIEW IF NOT EXISTS finished_goods_source_lot_availability AS
      SELECT
        'cancellation' AS source_type,
        l.id AS lot_id,
        l.lot_uid,
        l.warehouse_id,
        l.location_code,
        l.source_order_id,
        l.source_order_item_id,
        l.cancellation_transaction_id AS source_transaction_id,
        l.physical_spec_fingerprint,
        l.physical_spec_json,
        l.produced_quantity,
        l.available_quantity,
        l.created_at
      FROM finished_goods_lots l
      UNION ALL
      SELECT
        'historical_reconciliation' AS source_type,
        l.id AS lot_id,
        l.lot_uid,
        l.warehouse_id,
        l.location_code,
        l.source_order_id,
        l.source_order_item_id,
        l.reconciliation_transaction_id AS source_transaction_id,
        l.physical_spec_fingerprint,
        l.physical_spec_json,
        l.produced_quantity,
        l.available_quantity,
        l.created_at
      FROM historical_finished_goods_lots l;

    CREATE VIEW IF NOT EXISTS finished_goods_availability AS
      SELECT warehouse_id, location_code, physical_spec_fingerprint,
             SUM(available_quantity) AS available_quantity,
             COUNT(*) AS source_lot_count
      FROM finished_goods_source_lot_availability
      GROUP BY warehouse_id, location_code, physical_spec_fingerprint;
  `);

  ensureColumn(db, 'items', 'cancelled_at', 'DATETIME');
  ensureColumn(db, 'items', 'cancelled_by', 'INTEGER');
  ensureColumn(db, 'items', 'cancellation_reason', 'TEXT');
  ensureColumn(db, 'items', 'production_stopped_at', 'DATETIME');
  ensureColumn(db, 'items', 'cancelled_unproduced_qty', 'REAL');
  ensureColumn(db, 'order_cancellation_item_dispositions', 'recorded_produced_qty', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'order_cancellation_item_dispositions', 'erroneous_production_correction_qty', 'REAL NOT NULL DEFAULT 0');

  // The default is explicit and requires a location.  Additional warehouses
  // can set requires_location=0 where their configuration permits it.
  db.prepare(`
    INSERT OR IGNORE INTO finished_goods_warehouses (warehouse_code,name,requires_location,active)
    VALUES ('finished-goods-main','מוצרים מוגמרים',1,1)
  `).run();
}

function ensurePendingRawMaterialReceiptV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_raw_material_receipts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_uid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','cancelled')),
      source_type TEXT NOT NULL CHECK (source_type IN ('manual','ocr','purchase_order')),
      source_ref TEXT,
      supplier_id INTEGER,
      supplier_name TEXT,
      delivery_note_num TEXT,
      notes TEXT,
      created_by INTEGER,
      decided_by INTEGER,
      decision_notes TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_receipts_v2_status ON pending_raw_material_receipts_v2(status, id);
    CREATE TABLE IF NOT EXISTS pending_raw_material_receipt_lines_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      source_line_ref TEXT,
      material_type TEXT NOT NULL CHECK (material_type IN ('coil','straight','bent')),
      diameter NUMERIC NOT NULL,
      lot_number TEXT,
      certificate_num TEXT,
      grade TEXT DEFAULT 'B500B',
      standard_code TEXT,
      nominal_length_mm INTEGER,
      weight_received NUMERIC NOT NULL CHECK (typeof(weight_received) IN ('integer','real') AND weight_received > 0),
      purchase_price NUMERIC DEFAULT 0,
      warehouse_loc TEXT,
      bending_shape_name TEXT,
      bending_shape_segments TEXT,
      bending_shape_source TEXT,
      bending_shape_confidence REAL,
      notes TEXT,
      catalog_item_id INTEGER,
      spec_snapshot_json TEXT,
      spec_exceptions_json TEXT,
      created_raw_material_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (receipt_id) REFERENCES pending_raw_material_receipts_v2(id),
      FOREIGN KEY (created_raw_material_id) REFERENCES raw_material(id),
      UNIQUE(receipt_id, source_line_ref)
    );
    CREATE TABLE IF NOT EXISTS pending_raw_material_receipt_events_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created','updated','approved','rejected','cancelled')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      actor_id INTEGER,
      details_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (receipt_id) REFERENCES pending_raw_material_receipts_v2(id)
    );
  `);
  ensureColumn(db, 'pending_raw_material_receipt_lines_v2', 'catalog_item_id', 'INTEGER');
  ensureColumn(db, 'pending_raw_material_receipt_lines_v2', 'spec_snapshot_json', 'TEXT');
  ensureColumn(db, 'pending_raw_material_receipt_lines_v2', 'spec_exceptions_json', 'TEXT');
}

function ensureProcurementRecommendationV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procurement_recommendations_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_uid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','cancelled')),
      freshness_status TEXT NOT NULL DEFAULT 'current' CHECK (freshness_status IN ('current','stale')),
      catalog_item_id INTEGER,
      spec_snapshot_json TEXT NOT NULL,
      spec_identity_status TEXT NOT NULL CHECK (spec_identity_status IN ('complete','partial','review_required')),
      recommended_kg NUMERIC NOT NULL CHECK (typeof(recommended_kg) IN ('integer','real') AND recommended_kg>0),
      coverage_snapshot_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      created_by INTEGER,
      approved_by INTEGER,
      decision_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME,
      FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_procurement_recommendations_v2_status
      ON procurement_recommendations_v2(status, freshness_status, id);
    CREATE TABLE IF NOT EXISTS procurement_recommendation_requirement_links_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      material_requirement_id INTEGER NOT NULL,
      requirement_uid TEXT NOT NULL,
      requirement_revision_snapshot TEXT,
      required_kg_snapshot NUMERIC NOT NULL,
      recommended_kg NUMERIC NOT NULL CHECK (typeof(recommended_kg) IN ('integer','real') AND recommended_kg>0),
      spec_snapshot_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recommendation_id) REFERENCES procurement_recommendations_v2(id),
      FOREIGN KEY (material_requirement_id) REFERENCES material_requirements_v2(id),
      UNIQUE(recommendation_id, material_requirement_id)
    );
    CREATE INDEX IF NOT EXISTS idx_procurement_recommendation_links_requirement
      ON procurement_recommendation_requirement_links_v2(material_requirement_id, id);
    CREATE TABLE IF NOT EXISTS procurement_recommendation_events_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created','updated','refreshed','approved','rejected','cancelled','stale_detected')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      actor_id INTEGER,
      details_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recommendation_id) REFERENCES procurement_recommendations_v2(id)
    );
    CREATE INDEX IF NOT EXISTS idx_procurement_recommendation_events_v2_recommendation
      ON procurement_recommendation_events_v2(recommendation_id, id);
  `);
}

function ensureMaterialRequirementV2Schema(db) {
  ensureColumn(
    db,
    'orders',
    'inventory_lifecycle_version',
    'INTEGER NOT NULL DEFAULT 1 CHECK (inventory_lifecycle_version IN (1, 2))'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS material_requirements_v2 (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_uid   TEXT NOT NULL UNIQUE,
      order_id          INTEGER NOT NULL,
      item_id           INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL DEFAULT 2 CHECK (lifecycle_version = 2),
      diameter          NUMERIC NOT NULL CHECK (typeof(diameter) IN ('integer', 'real') AND diameter > 0),
      material_type     TEXT NOT NULL CHECK (material_type IN ('coil', 'straight')),
      required_kg       NUMERIC NOT NULL CHECK (typeof(required_kg) IN ('integer', 'real') AND required_kg > 0),
      need_by_date      TEXT,
      need_by_source    TEXT NOT NULL CHECK (need_by_source IN ('manual_override', 'planned_production', 'order_delivery_date', 'unknown')),
      priority_snapshot TEXT,
      status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'superseded')),
      source            TEXT NOT NULL CHECK (source IN ('order_item', 'manual', 'import')),
      source_revision   TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_material_requirements_v2_current_item
      ON material_requirements_v2(order_id, item_id)
      WHERE status = 'open';

    CREATE INDEX IF NOT EXISTS idx_material_requirements_v2_order
      ON material_requirements_v2(order_id, id);
  `);
}

function intakeSourceIdentityDuplicates(db) {
  return db.prepare(`
    SELECT source_system, external_id, COUNT(*) AS count
    FROM intake_log
    WHERE source_system IS NOT NULL AND source_system <> ''
      AND external_id IS NOT NULL AND external_id <> ''
    GROUP BY source_system, external_id
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 5
  `).all();
}

function warnSkippedIntakeSourceIdentityIndex(reason, duplicates = []) {
  const sample = duplicates
    .map(row => `${row.source_system}/${row.external_id} (${row.count})`)
    .join(', ');
  console.warn(
    '[DB] Migration warning: intake_log source identity unique index was not created: ' +
    reason +
    (sample ? `. Duplicate sample: ${sample}` : '')
  );
}

function ensureIntakeSourceIdentityIndex(db) {
  ensureColumn(db, 'intake_log', 'source_system', 'TEXT');
  ensureColumn(db, 'intake_log', 'external_id', 'TEXT');
  const duplicates = intakeSourceIdentityDuplicates(db);
  if (duplicates.length) {
    warnSkippedIntakeSourceIdentityIndex('existing duplicate source_system/external_id values must be reviewed first', duplicates);
    return;
  }
  const sql = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_log_source_identity
      ON intake_log(source_system, external_id)
      WHERE source_system IS NOT NULL AND external_id IS NOT NULL;
  `;
  try {
    db.exec(sql);
  } catch (error) {
    const currentDuplicates = intakeSourceIdentityDuplicates(db);
    if (/UNIQUE constraint failed|constraint failed/i.test(String(error.message || '')) && currentDuplicates.length) {
      warnSkippedIntakeSourceIdentityIndex(error.message, currentDuplicates);
      return;
    }
    throw error;
  }
}
function ensureCoreSchema(db) {
  // ── SCHEMA ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      tax_id TEXT,
      payment_terms TEXT,
      portal_price_list_visibility TEXT DEFAULT 'none',
      portal_can_manage_users INTEGER DEFAULT 0,
      portal_can_create_sites INTEGER DEFAULT 0,
      portal_can_set_budgets INTEGER DEFAULT 0,
      portal_can_expose_prices INTEGER DEFAULT 0,
      contact_name TEXT,
      contact_phone TEXT,
      priority_id TEXT,
      notes TEXT,
      portal_profile_locked_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_portal_otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      consumed_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS customer_guarantee_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      portal_user_id INTEGER,
      original_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      data_url TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'uploaded_pending_review',
      notes TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      reviewed_by TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS customer_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      status TEXT DEFAULT 'active',
      manager_name TEXT,
      manager_phone TEXT,
      budget_amount REAL DEFAULT 0,
      budget_kg REAL DEFAULT 0,
      alert_pct REAL DEFAULT 80,
      block_over_budget INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS portal_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'both' CHECK (role IN ('orderer','approver','both','finance','field_manager','customer_admin')),
      active INTEGER NOT NULL DEFAULT 1,
      token TEXT,
      token_expires_at TEXT,
      password_hash TEXT,
      password_changed_at TEXT,
      can_manage_users INTEGER DEFAULT 0,
      can_create_sites INTEGER DEFAULT 0,
      can_assign_site_users INTEGER DEFAULT 0,
      can_create_orders INTEGER DEFAULT 1,
      can_approve_orders INTEGER DEFAULT 0,
      can_view_prices INTEGER DEFAULT 0,
      can_view_budget INTEGER DEFAULT 0,
      can_set_budget INTEGER DEFAULT 0,
      can_approve_budget_overrun INTEGER DEFAULT 0,
      can_view_invoices INTEGER DEFAULT 0,
      can_view_delivery_notes INTEGER DEFAULT 1,
      can_view_payment_alerts INTEGER DEFAULT 0,
      default_site_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (default_site_id) REFERENCES customer_sites(id)
    );

    CREATE TABLE IF NOT EXISTS customer_site_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      site_id INTEGER NOT NULL,
      portal_user_id INTEGER NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, portal_user_id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (site_id) REFERENCES customer_sites(id),
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id)
    );

    CREATE TABLE IF NOT EXISTS customer_portal_permission_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      actor_portal_user_id INTEGER,
      target_portal_user_id INTEGER,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (actor_portal_user_id) REFERENCES portal_users(id),
      FOREIGN KEY (target_portal_user_id) REFERENCES portal_users(id)
    );

    CREATE TABLE IF NOT EXISTS customer_profile_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      portal_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      current_json TEXT,
      requested_json TEXT NOT NULL,
      notes TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_num TEXT UNIQUE NOT NULL,
      stable_order_id TEXT,
      quote_id INTEGER,
      quote_num TEXT,
      customer_id INTEGER,
      channel TEXT DEFAULT 'טלפון',
      delivery_date TEXT,
      delivery_time TEXT,
      delivery_address TEXT,
      priority TEXT DEFAULT 'רגיל',
      status TEXT DEFAULT 'ממתינה לאישור',
      total_weight REAL DEFAULT 0,
      waste_pct_charged REAL DEFAULT 3,
      billing_weight REAL DEFAULT 0,
      sale_price REAL DEFAULT 0,
      driver_notes TEXT,
      general_notes TEXT,
      priority_order_id TEXT,
      inventory_lifecycle_version INTEGER NOT NULL DEFAULT 1 CHECK (inventory_lifecycle_version IN (1, 2)),
      created_by INTEGER,
      approved_by INTEGER,
      approved_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS order_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_num TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('draft','pending_approval','approved','rejected','cancelled','converted')),
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      customer_email TEXT,
      payload_json TEXT NOT NULL,
      pricing_snapshot_json TEXT,
      total_weight REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      created_by INTEGER,
      approved_by INTEGER,
      approved_at TEXT,
      converted_order_id INTEGER UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (converted_order_id) REFERENCES orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_order_quotes_status_created
      ON order_quotes(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_quotes_customer
      ON order_quotes(customer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS order_sequences (
      prefix TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      pallet_num INTEGER,
      max_weight REAL DEFAULT 500,
      total_weight REAL DEFAULT 0,
      status TEXT DEFAULT 'ממתין',
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pallet_id INTEGER,
      order_id INTEGER,
      item_uid TEXT,
      shape_snapshot_json TEXT,
      shape_id TEXT,
      shape_name TEXT,
      diameter REAL,
      spiral_diameter_mm REAL,
      spiral_turns REAL,
      segments JSON,
      total_length_mm REAL DEFAULT 0,
      quantity INTEGER DEFAULT 1,
      production_qty INTEGER DEFAULT 0,
      weight_per_unit REAL DEFAULT 0,
      total_weight REAL DEFAULT 0,
      struct_element TEXT,
      struct_floor TEXT,
      sheet_num TEXT,
      machine TEXT,
      status TEXT DEFAULT 'ממתין',
      started_at DATETIME,
      completed_at DATETIME,
      worker_id INTEGER,
      produced_qty INTEGER DEFAULT 0,
      actual_waste INTEGER DEFAULT 0,
      actual_weight_kg REAL,
      weight_deviation_pct REAL,
      review_status TEXT,
      review_notes TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      note TEXT,
      FOREIGN KEY (pallet_id) REFERENCES pallets(id)
    );

    CREATE TABLE IF NOT EXISTS production_card_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      card_index INTEGER NOT NULL,
      card_total INTEGER NOT NULL DEFAULT 1,
      card_qty INTEGER DEFAULT 0,
      target_weight_kg REAL DEFAULT 0,
      actual_weight_kg REAL NOT NULL,
      weight_deviation_pct REAL,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(item_id, card_index, card_total),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- Append-only measured-output ledger. Item and card records retain their
    -- current value; this table preserves the real daily change that was
    -- reported so a later correction cannot rewrite a past production day.
    CREATE TABLE IF NOT EXISTS production_output_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL UNIQUE,
      item_id INTEGER NOT NULL,
      order_id INTEGER,
      source TEXT NOT NULL,
      before_weight_kg REAL NOT NULL,
      after_weight_kg REAL NOT NULL,
      delta_weight_kg REAL NOT NULL,
      production_day TEXT NOT NULL,
      occurred_at DATETIME NOT NULL,
      actor_id INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_production_output_events_day_item
      ON production_output_events(production_day, item_id, id);

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT,
      port TEXT,
      slave_id INTEGER DEFAULT 1,
      min_diameter REAL DEFAULT 8,
      max_diameter REAL DEFAULT 12,
      single_min_diameter REAL DEFAULT 8,
      single_max_diameter REAL DEFAULT 32,
      double_min_diameter REAL DEFAULT 8,
      double_max_diameter REAL DEFAULT 16,
      status TEXT DEFAULT 'לא מחובר',
      current_order_num TEXT,
      current_item_id INTEGER,
      counter INTEGER DEFAULT 0,
      last_seen DATETIME
    );

    CREATE TABLE IF NOT EXISTS shapes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bends INTEGER DEFAULT 0,
      sides_default JSON,
      angles_default JSON,
      emoji TEXT DEFAULT '⬡',
      description TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'ייצור',
      language TEXT DEFAULT 'he',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER,
      worker_id INTEGER,
      item_id INTEGER,
      order_num TEXT,
      action TEXT,
      counter_at_scan INTEGER DEFAULT 0,
      waste_calculated INTEGER DEFAULT 0,
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      active INTEGER DEFAULT 1,
      current_lat REAL,
      current_lng REAL,
      last_location_update DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_desc TEXT,
      license_plate TEXT UNIQUE,
      vehicle_make TEXT,
      vehicle_model TEXT,
      vehicle_year INTEGER,
      test_expiry TEXT,
      insurance_expiry TEXT,
      next_service_date TEXT,
      next_service_km INTEGER,
      odometer_km INTEGER DEFAULT 0,
      vehicle_status TEXT DEFAULT 'active',
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER,
      vehicle_id INTEGER,
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      odometer_km INTEGER,
      amount REAL DEFAULT 0,
      vendor TEXT,
      reference TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id),
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      title TEXT,
      file_name TEXT,
      mime_type TEXT,
      data_url TEXT,
      expiry_date TEXT,
      notes TEXT,
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      driver_id INTEGER,
      scheduled_date TEXT,
      status TEXT DEFAULT 'ממתין',
      departed_at DATETIME,
      delivered_at DATETIME,
      signature_data TEXT,
      photo_url TEXT,
      notes TEXT,
      problem_type TEXT,
      problem_notes TEXT,
      delivery_lat REAL,
      delivery_lng REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      level TEXT DEFAULT 'warning',
      message TEXT,
      order_id INTEGER,
      machine_id INTEGER,
      resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS intake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      source_system TEXT,
      external_id TEXT,
      raw_content TEXT,
      parsed_data JSON,
      original_filename TEXT,
      original_mime TEXT,
      original_data_url TEXT,
      order_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS intake_training_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      document_type TEXT DEFAULT 'general',
      problem_text TEXT NOT NULL,
      correction_text TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS external_shape_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_system TEXT NOT NULL,
      external_code TEXT NOT NULL,
      label TEXT,
      shape_type TEXT NOT NULL,
      internal_shape_code TEXT NOT NULL,
      parameter_mapping TEXT DEFAULT '{}',
      confidence TEXT DEFAULT 'learned',
      created_by TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_system, external_code)
    );

    CREATE TABLE IF NOT EXISTS inventory_receipt_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT DEFAULT 'supplier_delivery_note',
      original_filename TEXT,
      original_mime TEXT,
      original_data_url TEXT,
      supplier_id INTEGER,
      supplier_name TEXT,
      delivery_note_num TEXT,
      parsed_data JSON,
      status TEXT DEFAULT 'pending_review',
      raw_material_ids TEXT,
      reviewed_by INTEGER,
      review_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS companies (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      short_name TEXT,
      ownership_pct REAL DEFAULT 100,
      erp_type TEXT DEFAULT 'none',
      color TEXT DEFAULT '#e07b39',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── RAW MATERIAL INVENTORY ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS suppliers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      phone       TEXT,
      contact     TEXT,
      email       TEXT,
      address     TEXT,
      payment_terms TEXT,
      notes       TEXT,
      active      INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS raw_material (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      material_type   TEXT DEFAULT 'coil',  -- 'coil' | 'straight' | 'bent'
      diameter        INTEGER NOT NULL,
      catalog_item_id INTEGER,
      verification_status TEXT NOT NULL DEFAULT 'approved' CHECK (verification_status IN ('approved','pending_verification','rejected')),
      supplier_id     INTEGER,
      lot_number      TEXT,
      certificate_num TEXT,
      grade           TEXT DEFAULT 'B500B', -- steel grade
      standard_code   TEXT,
      nominal_length_mm INTEGER,
      spec_exception  INTEGER NOT NULL DEFAULT 0,
      received_date   TEXT,
      weight_received REAL DEFAULT 0,       -- kg received
      weight_used     REAL DEFAULT 0,       -- kg consumed so far
      weight_scrapped REAL DEFAULT 0,       -- kg scrapped/waste
      purchase_price  REAL DEFAULT 0,       -- ₪/ton
      warehouse_loc   TEXT,                 -- e.g. "מדף A3"
      bending_shape_name TEXT,
      bending_shape_segments TEXT,
      bending_shape_source TEXT,
      bending_shape_confidence REAL,
      notes           TEXT,
      active          INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
    );

    CREATE TABLE IF NOT EXISTS product_masters (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      master_code     TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT '',
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS catalog_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      sku                   TEXT NOT NULL UNIQUE,
      product_master_id     INTEGER REFERENCES product_masters(id),
      item_kind             TEXT NOT NULL CHECK (item_kind IN ('raw_material','finished_product')),
      name                  TEXT NOT NULL,
      category              TEXT NOT NULL DEFAULT '',
      supply_form           TEXT CHECK (supply_form IN ('coil','straight','bent')),
      diameter_key          TEXT,
      steel_grade           TEXT,
      standard_code         TEXT,
      nominal_length_mm     INTEGER,
      nominal_kg_per_meter  NUMERIC,
      nominal_unit_weight_kg NUMERIC,
      active                INTEGER NOT NULL DEFAULT 1,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS diameter_catalog (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      diameter_key     TEXT NOT NULL UNIQUE,
      diameter_display TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('active','inactive','pending_approval','rejected')),
      source           TEXT NOT NULL DEFAULT 'manual',
      created_by       INTEGER,
      approved_by      INTEGER,
      approved_at      DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS raw_material_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_material_id INTEGER,
      order_id        INTEGER,
      item_id         INTEGER,
      weight_used     REAL DEFAULT 0,
      allocation_policy TEXT,
      used_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (raw_material_id) REFERENCES raw_material(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL,
      item_id         INTEGER,
      diameter        NUMERIC,
      material_type   TEXT,
      reserved_kg     NUMERIC DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- ── AUDIT LOG ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,  -- 'order' | 'item' | 'customer' | 'delivery' etc.
      entity_id   INTEGER,
      entity_ref  TEXT,           -- e.g. order_num
      action      TEXT NOT NULL,  -- 'status_change' | 'create' | 'update' | 'delete'
      field_name  TEXT,           -- which field changed
      old_value   TEXT,
      new_value   TEXT,
      user_id     INTEGER,
      user_name   TEXT,
      notes       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── USERS / ROLES ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role        TEXT DEFAULT 'operator',  -- 'admin' | 'manager' | 'operator' | 'driver' | 'quality'
      pin         TEXT,                     -- 4-digit PIN for tablet login
      phone       TEXT,
      active      INTEGER DEFAULT 1,
      last_login  DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── QUALITY CONTROL ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS quality_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER,
      order_id      INTEGER,
      order_num     TEXT,
      inspector_id  INTEGER,
      check_type    TEXT DEFAULT 'length',  -- 'length' | 'angle' | 'visual' | 'full'
      sample_qty    INTEGER DEFAULT 1,
      pass_qty      INTEGER DEFAULT 0,
      fail_qty      INTEGER DEFAULT 0,
      deviation_mm  REAL DEFAULT 0,
      deviation_deg REAL DEFAULT 0,
      result        TEXT DEFAULT 'pass',    -- 'pass' | 'fail' | 'conditional'
      action_taken  TEXT,                   -- 'accepted' | 'rejected' | 'rework'
      photo_url     TEXT,
      notes         TEXT,
      checked_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- ── MAINTENANCE ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    INTEGER,
      log_type      TEXT DEFAULT 'breakdown',  -- 'breakdown' | 'preventive' | 'repair' | 'inspection'
      description   TEXT,
      reported_by   INTEGER,
      assigned_to   INTEGER,
      status        TEXT DEFAULT 'פתוחה',  -- 'פתוחה' | 'בטיפול' | 'סגורה'
      priority      TEXT DEFAULT 'רגיל',   -- 'דחוף' | 'גבוה' | 'רגיל' | 'נמוך'
      downtime_min  INTEGER DEFAULT 0,      -- minutes machine was down
      root_cause    TEXT,
      fix_notes     TEXT,
      parts_used    TEXT,
      cost          REAL DEFAULT 0,
      started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at   DATETIME,
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );

    -- ── PROJECTS & SITES ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id   INTEGER,
      name          TEXT NOT NULL,
      project_num   TEXT,           -- internal project number
      status        TEXT DEFAULT 'פעיל',   -- 'פעיל' | 'הושלם' | 'עצור' | 'ביטול'
      start_date    TEXT,
      end_date      TEXT,
      total_budget  REAL DEFAULT 0,
      contact_name  TEXT,
      contact_phone TEXT,
      notes         TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS sites (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER,
      customer_id   INTEGER,
      name          TEXT NOT NULL,
      address       TEXT,
      lat           REAL,
      lng           REAL,
      contact_name  TEXT,
      contact_phone TEXT,
      access_notes  TEXT,
      active        INTEGER DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- ── CREDIT ACCOUNTS ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS credit_accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id   INTEGER UNIQUE,
      credit_limit  REAL DEFAULT 0,         -- ₪ max outstanding
      current_debt  REAL DEFAULT 0,         -- ₪ current open balance
      payment_terms INTEGER DEFAULT 30,     -- days (net 30, net 60 etc)
      blocked       INTEGER DEFAULT 0,      -- 1 = blocked from new orders
      block_reason  TEXT,
      last_payment  TEXT,
      notes         TEXT,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id   INTEGER,
      order_id      INTEGER,
      type          TEXT,   -- 'charge' | 'payment' | 'credit_note'
      amount        REAL DEFAULT 0,
      description   TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- ── SHIFTS & OPERATORS ────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shifts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_type    TEXT DEFAULT 'morning',  -- 'morning'|'afternoon'|'night'
      date          TEXT NOT NULL,           -- YYYY-MM-DD
      operator_id   INTEGER,                 -- users.id
      machine_id    INTEGER,
      started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at      DATETIME,
      total_pieces  INTEGER DEFAULT 0,
      total_weight  REAL DEFAULT 0,
      notes         TEXT,
      FOREIGN KEY (operator_id) REFERENCES users(id),
      FOREIGN KEY (machine_id)  REFERENCES machines(id)
    );

    CREATE TABLE IF NOT EXISTS downtime_reasons (
      code  TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT DEFAULT '#888'
    );

    CREATE TABLE IF NOT EXISTS machine_stops (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    INTEGER,
      shift_id      INTEGER,
      reason_code   TEXT,   -- FK to downtime_reasons.code
      started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at      DATETIME,
      duration_min  INTEGER DEFAULT 0,
      notes         TEXT,
      reported_by   INTEGER,
      FOREIGN KEY (machine_id) REFERENCES machines(id),
      FOREIGN KEY (shift_id)   REFERENCES shifts(id)
    );

    -- ── STEEL PRICE HISTORY ────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS steel_price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      diameter      INTEGER NOT NULL,
      price_per_ton REAL NOT NULL,      -- ₪ per ton (purchase price)
      supplier_id   INTEGER,
      effective_date TEXT NOT NULL,     -- YYYY-MM-DD
      notes         TEXT,
      created_by    INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    -- ── PACKAGES (physical bundles with QR) ────────────────────────
    CREATE TABLE IF NOT EXISTS packages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      package_code  TEXT UNIQUE,        -- human-readable PKG-YYYYMMDD-NNN
      qr_data       TEXT,               -- JSON or URL for QR scan
      order_id      INTEGER,
      order_num     TEXT,
      item_ids      JSON,               -- array of item IDs in package
      quantity      INTEGER DEFAULT 0,
      weight        REAL DEFAULT 0,
      diameter      REAL,
      zone          TEXT,               -- warehouse zone e.g. "A3"
      status        TEXT DEFAULT 'packed', -- 'packed'|'staged'|'shipped'
      packed_by     INTEGER,
      packed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      shipped_at    DATETIME,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- ── ORDER LOADING SESSIONS (outbound package verification) ────────
    -- A loading session freezes the list of physical package labels that
    -- must be loaded for one order.  It deliberately does not alter the
    -- production scan flow or the order/delivery lifecycle.
    CREATE TABLE IF NOT EXISTS order_loading_sessions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uid        TEXT NOT NULL UNIQUE,
      order_id           INTEGER NOT NULL,
      order_num          TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
      expected_count     INTEGER NOT NULL DEFAULT 0,
      expected_weight    REAL NOT NULL DEFAULT 0,
      started_by         INTEGER,
      started_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_by       INTEGER,
      completed_at       DATETIME,
      departure_type     TEXT CHECK (departure_type IN ('full','partial')),
      departure_reason   TEXT,
      delivery_note_id   INTEGER,
      loading_group_uid  TEXT,
      cancelled_by       INTEGER,
      cancelled_at       DATETIME,
      cancel_reason      TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (started_by) REFERENCES users(id),
      FOREIGN KEY (completed_by) REFERENCES users(id),
      FOREIGN KEY (cancelled_by) REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_loading_session_one_active_order
      ON order_loading_sessions(order_id) WHERE status='active';

    CREATE TABLE IF NOT EXISTS order_loading_session_packages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         INTEGER NOT NULL,
      package_id         INTEGER NOT NULL,
      package_code       TEXT NOT NULL,
      item_ids_json      JSON,
      quantity           REAL NOT NULL DEFAULT 0,
      weight             REAL NOT NULL DEFAULT 0,
      state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','loaded')),
      loaded_by          INTEGER,
      loaded_at          DATETIME,
      UNIQUE(session_id, package_id),
      UNIQUE(session_id, package_code),
      FOREIGN KEY (session_id) REFERENCES order_loading_sessions(id),
      FOREIGN KEY (package_id) REFERENCES packages(id),
      FOREIGN KEY (loaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_loading_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         INTEGER NOT NULL,
      event_type         TEXT NOT NULL CHECK (event_type IN ('started','package_loaded','duplicate_scan','wrong_order_scan','unknown_scan','completed','cancelled')),
      package_id         INTEGER,
      scanned_value      TEXT,
      actor_id           INTEGER,
      details_json       JSON,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES order_loading_sessions(id),
      FOREIGN KEY (package_id) REFERENCES packages(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_loading_session_packages_session
      ON order_loading_session_packages(session_id, state);
    CREATE INDEX IF NOT EXISTS idx_loading_events_session
      ON order_loading_events(session_id, created_at);

    -- ── INVOICES (Israeli standard, כרך ט) ───────────────────────
    CREATE TABLE IF NOT EXISTS invoices (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_num      TEXT UNIQUE,      -- חשבונית מס' (sequential)
      invoice_type     TEXT DEFAULT 'tax_invoice', -- 'tax_invoice'|'receipt'|'credit_note'|'proforma'
      order_id         INTEGER,
      order_num        TEXT,
      customer_id      INTEGER,
      customer_name    TEXT,
      customer_vat_id  TEXT,             -- ח.פ / ע.מ
      issue_date       TEXT,             -- YYYY-MM-DD
      due_date         TEXT,
      items_json       JSON,             -- line items snapshot
      subtotal         REAL DEFAULT 0,   -- סכום לפני מע"מ
      vat_rate         REAL DEFAULT 0.18,-- 18%
      vat_amount       REAL DEFAULT 0,
      total            REAL DEFAULT 0,   -- סה"כ כולל מע"מ
      paid_amount      REAL DEFAULT 0,
      status           TEXT DEFAULT 'פתוחה', -- 'פתוחה'|'שולמה'|'חלקית'|'ביטול'
      payment_method   TEXT,             -- 'העברה'|'שיק'|'מזומן'|'אשראי'
      payment_ref      TEXT,
      notes            TEXT,
      created_by       INTEGER,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- ── DELIVERY NOTES ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS delivery_notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      note_num      TEXT UNIQUE,        -- DN-YYYYMMDD-NNN
      order_id      INTEGER,
      order_num     TEXT,
      delivery_id   INTEGER,
      customer_id   INTEGER,
      packages_json JSON,               -- snapshot of packages
      items_json    JSON,               -- snapshot of items
      total_weight  REAL DEFAULT 0,
      driver_id     INTEGER,
      signed_by     TEXT,
      signature_data TEXT,
      issued_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at  DATETIME,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- A delivery note may cover several orders on the same truck.  The
    -- legacy order_id/order_num columns remain populated for single-order
    -- notes and backward compatibility; this junction is the authoritative
    -- order list for consolidated notes.
    CREATE TABLE IF NOT EXISTS delivery_note_orders (
      delivery_note_id INTEGER NOT NULL,
      order_id         INTEGER NOT NULL,
      order_num        TEXT NOT NULL,
      customer_id      INTEGER,
      items_json       JSON,
      total_weight     REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (delivery_note_id, order_id),
      FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_note_orders_order
      ON delivery_note_orders(order_id, delivery_note_id);

    CREATE TABLE IF NOT EXISTS export_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      destination   TEXT DEFAULT 'generic',
      entity_type   TEXT,
      entity_id     INTEGER,
      export_format TEXT,
      payload_json  TEXT,
      status        TEXT,
      external_ref  TEXT,
      error_message TEXT,
      exported_by   INTEGER,
      exported_at   DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── PRODUCTION EVENTS ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS production_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type    TEXT NOT NULL,  -- 'MachineStarted'|'MachineStopped'|'ItemComplete'|'ScrapExceeded'|'QualityFailed'|'InventoryLow'
      machine_id    INTEGER,
      item_id       INTEGER,
      order_num     TEXT,
      operator_id   INTEGER,
      shift_id      INTEGER,
      payload       JSON,           -- extra data specific to event type
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── MACHINE STATE LOG ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS machine_state_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id  INTEGER NOT NULL,
      from_state  TEXT,
      to_state    TEXT NOT NULL,
      reason      TEXT,
      operator_id INTEGER,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );

    -- ── INCIDENTS / WAR ROOM ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS incidents (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL,
      machine_id       INTEGER,
      severity         TEXT DEFAULT 'בינוני',
      description      TEXT,
      assigned_to      TEXT,
      status           TEXT DEFAULT 'פתוח',
      financial_impact REAL DEFAULT 0,
      timeline         JSON DEFAULT '[]',
      opened_by        TEXT,
      resolved_at      DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── NCR – Non-Conformance Reports ─────────────────────────────
    CREATE TABLE IF NOT EXISTS ncr (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ncr_num           TEXT UNIQUE,
      order_id          INTEGER,
      order_num         TEXT,
      machine_id        INTEGER,
      description       TEXT NOT NULL,
      severity          TEXT DEFAULT 'בינוני',
      root_cause        TEXT,
      disposition       TEXT,
      quantity_affected INTEGER DEFAULT 0,
      diameter          REAL,
      assigned_to       TEXT,
      status            TEXT DEFAULT 'פתוח',
      closed_by         TEXT,
      closed_at         DATETIME,
      notes             TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── CAPA – Corrective & Preventive Actions ─────────────────────
    CREATE TABLE IF NOT EXISTS capa (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      capa_num            TEXT UNIQUE,
      ncr_id              INTEGER,
      title               TEXT NOT NULL,
      type                TEXT DEFAULT 'מתקן',
      problem_description TEXT,
      root_cause          TEXT,
      actions             JSON DEFAULT '[]',
      owner               TEXT,
      due_date            TEXT,
      verification_method TEXT,
      status              TEXT DEFAULT 'פתוח',
      completion_pct      INTEGER DEFAULT 0,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ncr_id) REFERENCES ncr(id)
    );

    -- ── LOTO – Lockout / Tagout ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS loto (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id       INTEGER NOT NULL,
      locked_by        TEXT NOT NULL,
      reason           TEXT,
      reason_detail    TEXT,
      safety_notes     TEXT,
      status           TEXT DEFAULT 'פעיל',
      released_by      TEXT,
      release_confirmed INTEGER DEFAULT 0,
      release_notes    TEXT,
      released_at      DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );

    -- ── PREVENTIVE MAINTENANCE SCHEDULE ───────────────────────────
    CREATE TABLE IF NOT EXISTS pm_schedule (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id  INTEGER NOT NULL,
      pm_type     TEXT NOT NULL,
      frequency   TEXT DEFAULT 'חודשי',
      last_done   TEXT,
      next_due    TEXT,
      instructions TEXT,
      active      INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── PURCHASE ORDERS ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      po_num          TEXT UNIQUE,
      supplier_id     INTEGER,
      diameter        INTEGER,
      material_type   TEXT DEFAULT 'coil',
      quantity_ton    REAL,
      price_per_ton   REAL,
      total_amount    REAL,
      expected_date   TEXT,
      status          TEXT DEFAULT 'טיוטה',
      notes           TEXT,
      received_weight REAL,
      heat_number     TEXT,
      certificate_num TEXT,
      received_at     DATETIME,
      created_by      TEXT,
      approved_by     TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
  `);

  ensureIntakeSourceIdentityIndex(db);

  ensureMaterialRequirementV2Schema(db);
  ensureMaterialAllocationPlanningV2Schema(db);
  ensureMaterialConsumptionV2Schema(db);
  ensurePendingRawMaterialReceiptV2Schema(db);
  ensureProcurementRecommendationV2Schema(db);
  ensureProductionCardLoadingSchema(db);
  ensureOrderCancellationSchema(db);

  // A completed loading session is one physical truck departure.  These
  // additive columns keep the delivery note and partial/full outcome
  // immutable without changing the legacy deliveries table.
  ensureColumn(db, 'order_loading_sessions', 'departure_type', "TEXT CHECK (departure_type IN ('full','partial'))");
  ensureColumn(db, 'order_loading_sessions', 'departure_reason', 'TEXT');
  ensureColumn(db, 'order_loading_sessions', 'delivery_note_id', 'INTEGER');
  ensureColumn(db, 'order_loading_sessions', 'loading_group_uid', 'TEXT');
  // Several per-order sessions may deliberately point to one consolidated
  // truck delivery note.  The old unique index encoded the former one-order
  // limitation, so replace it with a normal lookup index.
  db.exec('DROP INDEX IF EXISTS idx_loading_session_delivery_note');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loading_session_delivery_note
    ON order_loading_sessions(delivery_note_id) WHERE delivery_note_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loading_sessions_group
    ON order_loading_sessions(loading_group_uid, status)`);

  // price_category: how this item is billed in the price book
  // 'straight_standard' = bar at 6m/12m (material only)
  // 'straight_cut'      = straight bar cut to custom length (material + cutting)
  // 'bent'              = has bends (material + cutting + bending)
  // 'per_unit'          = stirrups, chairs, birds — charged per piece
  ensureColumn(db, 'items', 'price_category', "TEXT DEFAULT 'auto'");

  ensureFinanceSchema(db);
}

module.exports = {
  ensureCoreSchema,
  ensureMaterialRequirementV2Schema,
  ensureMaterialAllocationPlanningV2Schema,
  ensureMaterialConsumptionV2Schema,
  ensurePendingRawMaterialReceiptV2Schema,
  ensureProcurementRecommendationV2Schema,
  ensureProductionCardLoadingSchema,
  ensureOrderCancellationSchema,
};
