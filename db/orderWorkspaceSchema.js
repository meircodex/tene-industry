'use strict';
function ensureOrderWorkspaceSchema(db) {
  const columns=new Set(db.pragma('table_info(orders)').map(c=>c.name));
  for(const [name,type] of Object.entries({payment_status:"TEXT NOT NULL DEFAULT 'unpaid'",paid_marked_at:'TEXT',paid_marked_by:'TEXT',deleted_at:'TEXT',deleted_by:'TEXT',deletion_reason:'TEXT',workspace_version:'INTEGER NOT NULL DEFAULT 1'})) {
    if(!columns.has(name))db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS order_workspace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, order_num TEXT NOT NULL,
    action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
    reason TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ); CREATE INDEX IF NOT EXISTS idx_orders_workspace ON orders(deleted_at,payment_status${columns.has('status')?',status':''});
  CREATE INDEX IF NOT EXISTS idx_order_workspace_events ON order_workspace_events(order_id,id);`);
}
module.exports={ensureOrderWorkspaceSchema};
