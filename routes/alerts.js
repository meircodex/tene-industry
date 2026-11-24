const router = require('express').Router();

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/alerts missing dependency: ${name}`);
  return value;
}

module.exports = function createAlertsRouter(deps) {
  const db = required('db', deps.db);
  const requireRole = required('requireRole', deps.requireRole);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  router.get('/alerts', requireRole('viewer'), (req, res) => {
    res.json(db.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY created_at DESC LIMIT 50').all());
  });

  router.post('/alerts', requireAnyRole(['office', 'production', 'kiosk', 'maintenance', 'quality', 'manager', 'admin']), (req, res) => {
    const { message, level = 'warning', entity_type } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const r = db.prepare(`INSERT INTO alerts (type,level,message,resolved) VALUES (?,?,?,0)`)
      .run(entity_type || 'system', level, message);
    wsBroadcast('alert', { id: r.lastInsertRowid, level, message });
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/alerts/:id/resolve', requireAnyRole(['office', 'production', 'maintenance', 'quality', 'manager', 'admin']), (req, res) => {
    const { changes } = db.prepare('UPDATE alerts SET resolved=1 WHERE id=?').run(req.params.id);
    if (!changes) return res.status(404).json({ error: 'ההתראה לא נמצאה' });
    res.json({ success: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'alerts',
  label: 'התראות',
  consumes: [{ table: 'alerts' }],
  produces: [{ event: 'alert' }],
};
