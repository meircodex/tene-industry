'use strict';

const { ensureCoreSchema, ensureMaterialRequirementV2Schema } = require('./coreSchema');
const { seedCoreData } = require('./seed');
const { ensureVehicleCompatibility } = require('./vehicleMigrations');
const { seedLegacyDiameterCatalog } = require('../services/materialCatalog');
const { ensureCustomerIdentityConstraints } = require('../services/customerIdentity');
const { ensureCustomerMergeSchema } = require('./customerMergeSchema');

function ensureRawMaterialVerificationStatusConstraint(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='raw_material'").get()?.sql || '';
  if (sql.includes("CHECK (verification_status IN ('approved','pending_verification','rejected'))")) return;

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true });
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE raw_material__verification_status_check (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          material_type TEXT DEFAULT 'coil',
          diameter INTEGER NOT NULL,
          catalog_item_id INTEGER,
          verification_status TEXT NOT NULL DEFAULT 'approved' CHECK (verification_status IN ('approved','pending_verification','rejected')),
          supplier_id INTEGER,
          lot_number TEXT,
          certificate_num TEXT,
          grade TEXT DEFAULT 'B500B',
          standard_code TEXT,
          nominal_length_mm INTEGER,
          spec_exception INTEGER NOT NULL DEFAULT 0,
          received_date TEXT,
          weight_received REAL DEFAULT 0,
          weight_used REAL DEFAULT 0,
          weight_scrapped REAL DEFAULT 0,
          purchase_price REAL DEFAULT 0,
          warehouse_loc TEXT,
          bending_shape_name TEXT,
          bending_shape_segments TEXT,
          bending_shape_source TEXT,
          bending_shape_confidence REAL,
          notes TEXT,
          active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
          FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
        );
        INSERT INTO raw_material__verification_status_check
          SELECT id,material_type,diameter,catalog_item_id,verification_status,supplier_id,lot_number,certificate_num,
                 grade,standard_code,nominal_length_mm,spec_exception,received_date,weight_received,weight_used,
                 weight_scrapped,purchase_price,warehouse_loc,bending_shape_name,bending_shape_segments,
                 bending_shape_source,bending_shape_confidence,notes,active,created_at
          FROM raw_material;
        DROP TABLE raw_material;
        ALTER TABLE raw_material__verification_status_check RENAME TO raw_material;
      `);
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

function runCoreMigrations(db) {
  ensureCustomerMergeSchema(db);
  // ── MIGRATIONS (safe column additions) ────────────────────────────
  function addCol(table, col, def) {
    const cols = db.pragma(`table_info(${table})`).map(c => c.name);
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      console.log(`[DB] Migration: ${table}.${col} added`);
    }
  }
  addCol('customers',  'email',              'TEXT');
  addCol('customers',  'notes',              'TEXT');
  addCol('customers',  'tax_id',             'TEXT');
  ensureCustomerIdentityConstraints(db);
  addCol('customers',  'payment_terms',      'TEXT');
  addCol('customers',  'portal_price_list_visibility', "TEXT DEFAULT 'none'"); // 'none' | 'general' | 'customer'
  addCol('customers',  'portal_can_manage_users', 'INTEGER DEFAULT 0');
  addCol('customers',  'portal_can_create_sites', 'INTEGER DEFAULT 0');
  addCol('customers',  'portal_can_set_budgets',  'INTEGER DEFAULT 0');
  addCol('customers',  'portal_can_expose_prices','INTEGER DEFAULT 0');
  addCol('drivers',    'vehicle_desc',       'TEXT');       // e.g. "משאית מרצדס 2018"
  addCol('drivers',    'license_plate',      'TEXT');       // plate number
  addCol('drivers',    'license_expiry',     'TEXT');       // YYYY-MM-DD
  addCol('drivers',    'notes',              'TEXT');
  addCol('drivers',    'vehicle_make',       'TEXT');
  addCol('drivers',    'vehicle_model',      'TEXT');
  addCol('drivers',    'vehicle_year',       'INTEGER');
  addCol('drivers',    'test_expiry',        'TEXT');
  addCol('drivers',    'insurance_expiry',   'TEXT');
  addCol('drivers',    'next_service_date',  'TEXT');
  addCol('drivers',    'next_service_km',    'INTEGER');
  addCol('drivers',    'odometer_km',        'INTEGER DEFAULT 0');
  addCol('drivers',    'vehicle_status',     "TEXT DEFAULT 'active'");
  addCol('drivers',    'vehicle_id',         'INTEGER');
  addCol('vehicles',   'vehicle_desc',       'TEXT');
  addCol('vehicles',   'license_plate',      'TEXT');
  addCol('vehicles',   'vehicle_make',       'TEXT');
  addCol('vehicles',   'vehicle_model',      'TEXT');
  addCol('vehicles',   'vehicle_year',       'INTEGER');
  addCol('vehicles',   'test_expiry',        'TEXT');
  addCol('vehicles',   'insurance_expiry',   'TEXT');
  addCol('vehicles',   'next_service_date',  'TEXT');
  addCol('vehicles',   'next_service_km',    'INTEGER');
  addCol('vehicles',   'odometer_km',        'INTEGER DEFAULT 0');
  addCol('vehicles',   'vehicle_status',     "TEXT DEFAULT 'active'");
  addCol('vehicles',   'active',             'INTEGER DEFAULT 1');
  addCol('vehicles',   'notes',              'TEXT');
  addCol('vehicle_events', 'vehicle_id',      'INTEGER');
  addCol('orders',     'waste_pct_charged',  'REAL DEFAULT 3');
  addCol('orders',     'billing_weight',     'REAL DEFAULT 0');
  addCol('orders',     'priority_order_id',  'TEXT');
  addCol('orders',     'inventory_lifecycle_version', 'INTEGER NOT NULL DEFAULT 1 CHECK (inventory_lifecycle_version IN (1, 2))');
  addCol('orders',     'created_by',         'INTEGER');
  addCol('orders',     'stable_order_id',    'TEXT');
  addCol('orders',     'quote_id',           'INTEGER');
  addCol('orders',     'quote_num',          'TEXT');
  addCol('orders',     'approved_by',        'INTEGER');
  addCol('orders',     'approved_at',        'TEXT');
  addCol('pallets',    'status',             "TEXT DEFAULT 'ממתין'");
  addCol('items',      'order_id',           'INTEGER');
  addCol('items',      'item_uid',           'TEXT');
  addCol('items',      'shape_snapshot_json','TEXT');
  addCol('items',      'segments',           'JSON');
  addCol('items',      'spiral_diameter_mm', 'REAL');
  addCol('items',      'spiral_turns',       'REAL');
  addCol('items',      'total_length_mm',    'REAL DEFAULT 0');
  addCol('items',      'production_qty',     'INTEGER DEFAULT 0');
  addCol('items',      'weight_per_unit',    'REAL DEFAULT 0');
  addCol('items',      'actual_waste',       'INTEGER DEFAULT 0');
  addCol('items',      'actual_weight_kg',   'REAL');
  addCol('items',      'weight_deviation_pct','REAL');
  addCol('items',      'review_status',      'TEXT');
  addCol('items',      'review_notes',       'TEXT');
  addCol('items',      'reviewed_by',        'INTEGER');
  addCol('items',      'reviewed_at',        'TEXT');
  addCol('items',      'worker_id',          'INTEGER');
  addCol('machines',   'label',              'TEXT');
  addCol('machines',   'slave_id',           'INTEGER DEFAULT 1');
  addCol('machines',   'min_diameter',       'REAL DEFAULT 8');
  addCol('machines',   'max_diameter',       'REAL DEFAULT 12');
  addCol('machines',   'single_min_diameter','REAL DEFAULT 8');
  addCol('machines',   'single_max_diameter','REAL DEFAULT 32');
  addCol('machines',   'double_min_diameter','REAL DEFAULT 8');
  addCol('machines',   'double_max_diameter','REAL DEFAULT 16');
  addCol('machines',   'conn_mode',          "TEXT DEFAULT 'tcp'");   // 'tcp' or 'rtu'
  addCol('machines',   'tcp_host',           'TEXT');                  // IP of USR-N510 / gateway
  addCol('machines',   'tcp_port',           'INTEGER DEFAULT 502');   // Modbus TCP port
  addCol('machines',   'rtu_port',           'TEXT');                  // COM3 / /dev/ttyUSB0
  addCol('machines',   'baud_rate',          'INTEGER DEFAULT 9600');  // baud rate for RTU
  addCol('machines',   'parity',             "TEXT DEFAULT 'none'");   // none / odd / even
  addCol('machines',   'stop_bits',          'INTEGER DEFAULT 1');      // 1 or 2
  addCol('customers',  'company_id',         'INTEGER DEFAULT 1');
  addCol('orders',     'company_id',         'INTEGER DEFAULT 1');
  addCol('customers',  'portal_token',       'TEXT');              // unique link token
  addCol('customers',  'portal_token_created_at',  'TEXT');
  addCol('customers',  'portal_token_expires_at',  'TEXT');
  addCol('customers',  'portal_token_revoked_at',  'TEXT');
  addCol('customers',  'price_tier',         "TEXT DEFAULT 'list'"); // 'list' | 'customer'
  addCol('customers',  'discount_pct',       'REAL DEFAULT 0');    // extra % off
  addCol('orders',     'portal_order',       'INTEGER DEFAULT 0'); // 1 = placed by customer portal
  addCol('orders',     'portal_price',       'REAL DEFAULT 0');   // calculated price in ILS
  addCol('orders',     'confirm_token',      'TEXT');             // one-time approval token
  addCol('orders',     'created_by_portal_user_id', 'INTEGER');   // portal actor identity
  addCol('orders',     'pricing_snapshot_json', 'TEXT');          // immutable customer quote inputs/result
  addCol('customers',  'price_approved_at',  'TEXT');             // last time customer approved the price list
  addCol('customers',  'portal_profile_locked_at', 'TEXT');       // first customer profile edit locks future changes for approval
  addCol('orders',     'site_id',            'INTEGER');          // delivery site
  addCol('orders',     'project_id',         'INTEGER');          // project reference
  addCol('orders',     'locked',             'INTEGER DEFAULT 0'); // locked after shipment
  addCol('orders',     'locked_by',          'INTEGER');
  addCol('orders',     'locked_at',          'TEXT');
  addCol('items',      'qc_status',          "TEXT DEFAULT 'לא נבדק'"); // 'לא נבדק'|'עבר'|'נכשל'
  addCol('items',      'batch_id',           'INTEGER');          // raw material batch used
  addCol('items',      'total_weight',       'REAL DEFAULT 0');   // alias for weight column (compat)

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_portal_order_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      portal_user_id INTEGER,
      idempotency_key TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_id, portal_user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_portal_order_idempotency_order
      ON customer_portal_order_idempotency(order_id);
    CREATE TABLE IF NOT EXISTS customer_portal_order_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      portal_user_id INTEGER,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data_url TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_portal_order_documents_order ON customer_portal_order_documents(order_id);
  `);
  addCol('machines',   'oee_score',          'REAL DEFAULT 0');   // OEE %
  addCol('machines',   'tons_today',         'REAL DEFAULT 0');   // tons produced today
  addCol('orders',     'cost_material',      'REAL DEFAULT 0');   // cost of steel used
  addCol('orders',     'cost_labor',         'REAL DEFAULT 0');   // estimated labor cost
  addCol('orders',     'sale_price',         'REAL DEFAULT 0');   // actual sale price ILS
  addCol('intake_log', 'source_system',     'TEXT');
  addCol('intake_log', 'external_id',        'TEXT');
  addCol('intake_log', 'original_filename',  'TEXT');
  addCol('intake_log', 'original_mime',      'TEXT');
  addCol('intake_log', 'original_data_url',  'TEXT');
  addCol('items',      'package_id',         'INTEGER');          // package assignment
  addCol('items',      'zone',               'TEXT');             // warehouse zone
  addCol('items',      'machine_id',         'INTEGER');          // FK to machines table
  addCol('items',      'is_3d',              'INTEGER DEFAULT 0'); // 1 = true 3D product (out-of-plane bends)
  addCol('machines',   'can_3d',             'INTEGER DEFAULT 0'); // 1 = machine supports 3D bending
  addCol('raw_material','bending_shape_name','TEXT');
  addCol('raw_material','bending_shape_segments','TEXT');
  addCol('raw_material','bending_shape_source','TEXT');
  addCol('raw_material','bending_shape_confidence','REAL');
  addCol('raw_material_usage','allocation_policy','TEXT');
  addCol('raw_material','catalog_item_id','INTEGER');
  addCol('raw_material','verification_status',"TEXT NOT NULL DEFAULT 'approved'");
  addCol('raw_material','standard_code','TEXT');
  addCol('raw_material','nominal_length_mm','INTEGER');
  addCol('raw_material','spec_exception','INTEGER NOT NULL DEFAULT 0');

  try { db.prepare("UPDATE raw_material SET verification_status='approved' WHERE verification_status IS NULL OR verification_status='' ").run(); } catch {}
  ensureRawMaterialVerificationStatusConstraint(db);
  try { seedLegacyDiameterCatalog(db); } catch (err) { console.warn('[DB] material diameter catalog seed warn:', err.message); }

  ensureMaterialRequirementV2Schema(db);

  try { db.prepare("UPDATE orders SET stable_order_id=order_num WHERE stable_order_id IS NULL OR stable_order_id=''").run(); } catch {}
  try { db.prepare("UPDATE items SET order_id=(SELECT pallets.order_id FROM pallets WHERE pallets.id=items.pallet_id) WHERE order_id IS NULL").run(); } catch {}
  try { db.prepare("UPDATE items SET item_uid='order-' || COALESCE(order_id, '') || ':item-' || id WHERE item_uid IS NULL OR item_uid=''").run(); } catch {}

  db.exec(`
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
  `);

  db.exec(`
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
  `);
  ensureVehicleCompatibility(db);
  db.exec(`
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
      role TEXT NOT NULL DEFAULT 'both',
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

    CREATE TABLE IF NOT EXISTS order_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      preview_data JSON,
      status TEXT DEFAULT 'preview',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME
    );
  `);

  addCol('customer_sites', 'city', 'TEXT');
  addCol('customer_sites', 'status', "TEXT DEFAULT 'active'");
  addCol('customer_sites', 'manager_name', 'TEXT');
  addCol('customer_sites', 'manager_phone', 'TEXT');
  addCol('customer_sites', 'budget_amount', 'REAL DEFAULT 0');
  addCol('customer_sites', 'budget_kg', 'REAL DEFAULT 0');
  addCol('customer_sites', 'alert_pct', 'REAL DEFAULT 80');
  addCol('customer_sites', 'block_over_budget', 'INTEGER DEFAULT 0');
  addCol('customer_sites', 'updated_at', 'TEXT');
  addCol('portal_users', 'email', 'TEXT');
  addCol('portal_users', 'can_manage_users', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_create_sites', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_assign_site_users', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_create_orders', 'INTEGER DEFAULT 1');
  addCol('portal_users', 'can_approve_orders', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_view_prices', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_view_budget', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_set_budget', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_approve_budget_overrun', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_view_invoices', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'can_view_delivery_notes', 'INTEGER DEFAULT 1');
  addCol('portal_users', 'can_view_payment_alerts', 'INTEGER DEFAULT 0');
  addCol('portal_users', 'default_site_id', 'INTEGER');
  addCol('portal_users', 'updated_at', 'TEXT');
  addCol('customer_guarantee_documents', 'valid_until', 'TEXT');
  addCol('customer_guarantee_documents', 'reviewed_by_user_id', 'INTEGER');
  addCol('order_imports', 'source_system', 'TEXT');
  addCol('order_imports', 'external_id', 'TEXT');
  addCol('order_imports', 'order_ids_json', 'TEXT');

  db.exec(`
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
  `);

  try {
    db.prepare("UPDATE pricing_price_items SET description='עיבוד טבעות', unit='unit' WHERE description='חישוקים'").run();
    db.prepare("UPDATE pricing_price_items SET description='עיבוד ספירלות עד קוטר 12 כולל' WHERE description='עיבוד ספירלות טבעות עד קוטר 12 כולל'").run();
  } catch (error) {
    console.warn('[DB] Migration warning: ring price-list terminology was not updated:', error.message);
  }

  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_log_source_identity
      ON intake_log(source_system, external_id)
      WHERE source_system IS NOT NULL AND external_id IS NOT NULL`);
  } catch (error) {
    console.warn('[DB] Migration warning: intake_log source identity index was not created:', error.message);
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_imports_source_identity
      ON order_imports(source_system, external_id)
      WHERE source_system IS NOT NULL AND external_id IS NOT NULL`);
  } catch (error) {
    console.warn('[DB] Migration warning: order_imports source identity index was not created:', error.message);
  }

}

module.exports = {
  ensureCoreSchema,
  runCoreMigrations,
  seedCoreData,
};
