'use strict';

function ensureCustomerMergeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_merge_log (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      tax_id TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      backup_file TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_merge_archive (
      old_customer_id INTEGER PRIMARY KEY,
      target_customer_id INTEGER NOT NULL REFERENCES customers(id),
      merge_id TEXT NOT NULL REFERENCES customer_merge_log(id),
      name TEXT NOT NULL,
      tax_id TEXT,
      profile_json TEXT NOT NULL,
      links_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_customer_merge_archive_target
      ON customer_merge_archive(target_customer_id);
  `);
}

module.exports = { ensureCustomerMergeSchema };
