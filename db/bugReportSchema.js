'use strict';

function ensureBugReportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_uid TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL, actual TEXT NOT NULL, expected TEXT NOT NULL,
      page_path TEXT NOT NULL DEFAULT '', order_reference TEXT NOT NULL DEFAULT '', item_reference TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL CHECK(priority IN ('low','normal','urgent')),
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','needs_info','in_progress','awaiting_confirmation','closed')),
      created_by TEXT NOT NULL, created_by_name TEXT NOT NULL,
      handler_name TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT '', resolution_reference TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS bug_report_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL REFERENCES bug_reports(id),
      actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL,
      from_status TEXT NOT NULL, to_status TEXT NOT NULL,
      resolution TEXT NOT NULL DEFAULT '', resolution_reference TEXT NOT NULL DEFAULT '', handler_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS bug_report_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL REFERENCES bug_reports(id),
      event_id INTEGER NOT NULL REFERENCES bug_report_events(id),
      kind TEXT NOT NULL CHECK(kind IN ('before','expected','after')),
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
      data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bug_reports_owner ON bug_reports(created_by,updated_at);
    CREATE INDEX IF NOT EXISTS idx_bug_events_report ON bug_report_events(report_id,id);
    CREATE INDEX IF NOT EXISTS idx_bug_attachments_report ON bug_report_attachments(report_id,event_id);
    CREATE TABLE IF NOT EXISTS fault_agent_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, created_by TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS fault_agent_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL REFERENCES bug_reports(id),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','needs_approval','patch_ready','fixed','failed','cancelled')),
      credential_id INTEGER REFERENCES fault_agent_credentials(id), lease_hash TEXT, lease_until TEXT,
      summary TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fault_active_job ON fault_agent_jobs(report_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS fault_report_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_by TEXT NOT NULL, report_count INTEGER NOT NULL,
      data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS fault_report_restorations (
      backup_id INTEGER PRIMARY KEY REFERENCES fault_report_backups(id), restored_by TEXT NOT NULL,
      restored_count INTEGER NOT NULL, restored_at TEXT NOT NULL
    );
  `);
}
module.exports = { ensureBugReportSchema };
