'use strict';
function ensureQualityWeighingSchema(db){
 db.exec(`
 CREATE TABLE IF NOT EXISTS quality_weighings(
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  selection_fingerprint TEXT NOT NULL, expected_weight_kg REAL NOT NULL CHECK(expected_weight_kg>0),
  actual_weight_kg REAL NOT NULL CHECK(actual_weight_kg>0), delta_kg REAL NOT NULL, delta_pct REAL NOT NULL,
  inspector_id INTEGER NOT NULL, inspector_name TEXT NOT NULL, checked_day TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), schema_version INTEGER NOT NULL DEFAULT 1
 );
 CREATE TABLE IF NOT EXISTS quality_weighing_orders(
  weighing_id INTEGER NOT NULL REFERENCES quality_weighings(id), order_id INTEGER NOT NULL,
  order_num TEXT NOT NULL, customer_id INTEGER, customer_name TEXT, order_status TEXT, scope TEXT NOT NULL,
  expected_weight_kg REAL NOT NULL, PRIMARY KEY(weighing_id,order_id)
 );
 CREATE TABLE IF NOT EXISTS quality_weighing_lines(
  weighing_id INTEGER NOT NULL REFERENCES quality_weighings(id), order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK(quantity>0), order_quantity REAL NOT NULL, expected_weight_kg REAL NOT NULL,
  unit_weight_kg REAL NOT NULL, weight_source TEXT NOT NULL, shape_name TEXT, diameter REAL,
  machine TEXT, item_status TEXT, specification_json TEXT NOT NULL, PRIMARY KEY(weighing_id,item_id)
 );
 CREATE TABLE IF NOT EXISTS quality_weighing_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, weighing_id INTEGER NOT NULL REFERENCES quality_weighings(id),
  event_type TEXT NOT NULL, actor_id INTEGER NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 );
 CREATE INDEX IF NOT EXISTS quality_weighings_date ON quality_weighings(checked_at,id);
 CREATE INDEX IF NOT EXISTS quality_weighing_order_lookup ON quality_weighing_orders(order_id,weighing_id);
 CREATE INDEX IF NOT EXISTS quality_weighing_customer_lookup ON quality_weighing_orders(customer_id,weighing_id);
 `);
}
module.exports={ensureQualityWeighingSchema};
