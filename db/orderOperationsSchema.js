'use strict';
function ensureOperationSchema(db){db.exec(`
 CREATE TABLE IF NOT EXISTS direct_order_drafts(
 id INTEGER PRIMARY KEY AUTOINCREMENT,request_uid TEXT NOT NULL UNIQUE,
 source_system TEXT,external_id TEXT,payload_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'draft',order_id INTEGER REFERENCES orders(id),created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_order_source ON direct_order_drafts(source_system,external_id) WHERE source_system IS NOT NULL AND external_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS consolidated_delivery_operations(
 note_id INTEGER PRIMARY KEY REFERENCES delivery_notes(id),request_uid TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);}
module.exports={ensureOperationSchema};
