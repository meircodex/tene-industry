'use strict';

// Additive rollout metadata only. Never changes a lot, usage or issued document.
function ensureInventoryWeightSchema(db) {
  if (!db.pragma('table_info(inventory_reservations)').some(c => c.name === 'pending_weight_source')) {
    db.exec('ALTER TABLE inventory_reservations ADD COLUMN pending_weight_source TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_weight_rollout (id INTEGER PRIMARY KEY CHECK(id=1),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS inventory_weight_review_items (item_id INTEGER PRIMARY KEY REFERENCES items(id),reason TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  if (db.prepare('SELECT 1 FROM inventory_weight_rollout WHERE id=1').get()) return;
  db.transaction(() => {
    const completion = require('../services/inventoryItemCompletion');
    const {itemShapeMetrics} = require('../services/shapeSnapshot');
    const insert = db.prepare('INSERT OR IGNORE INTO inventory_weight_review_items(item_id,reason) VALUES(?,?)');
    if (completion.policy(db)) for (const row of db.prepare(`SELECT DISTINCT i.id FROM items i JOIN inventory_reservations r ON r.item_id=i.id
        WHERE i.status IN ('הושלם','הועמס','נשלח','סופק')`).all()) {
      const item = completion.itemRecord(db,row.id);
      if (completion.eligibility(db,item) || Number(item.inventory_lifecycle_version) !== 1) continue;
      const expected = itemShapeMetrics(item).totalWeightKg;
      const state = completion.state(db,item.id);
      if (expected > Number(state?.consumed_kg || 0) + 0.001) insert.run(item.id,state ? 'historical_weight_difference' : 'historical_completion_unposted');
    }
    db.prepare('INSERT INTO inventory_weight_rollout(id) VALUES(1)').run();
  }).immediate();
}
module.exports = {ensureInventoryWeightSchema};
