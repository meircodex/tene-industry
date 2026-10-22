'use strict';

// Warehouse-owned operation: abandon an uncompleted loading snapshot, preserving
// every scan/event. Completed departures and their documents are never reversed.
function cancelActiveLoadingForCorrection(db, { orderId, actorId, reason }) {
  const sessions = db.prepare("SELECT * FROM order_loading_sessions WHERE order_id=? AND status='active'").all(orderId);
  for (const session of sessions) {
    db.prepare(`UPDATE order_loading_sessions SET status='cancelled',cancelled_by=?,
      cancelled_at=CURRENT_TIMESTAMP,cancel_reason=? WHERE id=? AND status='active'`)
      .run(actorId || null, reason, session.id);
    const table = session.scan_unit === 'production_card' ? 'order_loading_card_events' : 'order_loading_events';
    db.prepare(`INSERT INTO ${table}(session_id,event_type,actor_id,details_json) VALUES(?,?,?,?)`)
      .run(session.id, 'cancelled', actorId || null, JSON.stringify({ source: 'order_status_correction', reason }));
  }
  return sessions.map(session => session.id);
}

module.exports = { cancelActiveLoadingForCorrection };
