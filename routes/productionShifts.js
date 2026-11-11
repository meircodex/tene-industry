const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/productionShifts missing dependency: ${name}`);
  return value;
}

module.exports = function createProductionShiftsRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);

  router.get('/shifts', requireAnyRole(['production', 'kiosk', 'office', 'manager', 'admin']), (req, res) => {
    const { date, machine_id, limit = 50 } = req.query;
    let q = `SELECT s.*, u.display_name as operator_name, m.name as machine_name
             FROM shifts s
             LEFT JOIN users u ON s.operator_id=u.id
             LEFT JOIN machines m ON s.machine_id=m.id`;
    const wheres = [], params = [];
    if (date)       { wheres.push("s.date=?");       params.push(date); }
    if (machine_id) { wheres.push("s.machine_id=?"); params.push(machine_id); }
    if (wheres.length) q += ' WHERE ' + wheres.join(' AND ');
    q += ' ORDER BY s.started_at DESC LIMIT ?';
    params.push(Number(limit));
    res.json(db.prepare(q).all(...params));
  });

  router.post('/shifts', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const { shift_type, date, operator_id, machine_id, notes } = req.body;
    const today = date || new Date().toISOString().slice(0, 10);
    const r = db.prepare(`INSERT INTO shifts (shift_type,date,operator_id,machine_id,notes) VALUES (?,?,?,?,?)`)
      .run(shift_type || 'morning', today, operator_id || null, machine_id || null, notes || null);
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/shifts/:id/end', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const { total_pieces, total_weight, notes } = req.body;
    db.prepare(`UPDATE shifts SET ended_at=CURRENT_TIMESTAMP, total_pieces=COALESCE(?,total_pieces), total_weight=COALESCE(?,total_weight), notes=COALESCE(?,notes) WHERE id=?`)
      .run(total_pieces ?? null, total_weight ?? null, notes || null, req.params.id);
    res.json({ ok: true });
  });

  // Downtime reasons
  router.get('/downtime-reasons', requireAnyRole(['production', 'kiosk', 'maintenance', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare('SELECT * FROM downtime_reasons ORDER BY label').all());
  });

  // Machine stops
  router.get('/machine-stops', requireAnyRole(['production', 'kiosk', 'maintenance', 'manager', 'admin']), (req, res) => {
    const { machine_id, shift_id, active } = req.query;
    let q = `SELECT ms.*, dr.label as reason_label, dr.color as reason_color,
             u.display_name as reported_by_name
             FROM machine_stops ms
             LEFT JOIN downtime_reasons dr ON ms.reason_code=dr.code
             LEFT JOIN users u ON ms.reported_by=u.id`;
    const wheres = [], params = [];
    if (machine_id) { wheres.push('ms.machine_id=?'); params.push(machine_id); }
    if (shift_id)   { wheres.push('ms.shift_id=?');   params.push(shift_id); }
    if (active === '1') { wheres.push('ms.ended_at IS NULL'); }
    if (wheres.length) q += ' WHERE ' + wheres.join(' AND ');
    q += ' ORDER BY ms.started_at DESC LIMIT 100';
    res.json(db.prepare(q).all(...params));
  });

  router.post('/machine-stops', requireAnyRole(['production', 'kiosk', 'maintenance', 'manager', 'admin']), (req, res) => {
    const { machine_id, shift_id, reason_code, notes, reported_by } = req.body;
    const r = db.prepare(`INSERT INTO machine_stops (machine_id,shift_id,reason_code,notes,reported_by) VALUES (?,?,?,?,?)`)
      .run(machine_id, shift_id || null, reason_code, notes || null, reported_by || null);
    // fire event
    db.prepare(`INSERT INTO production_events (event_type,machine_id,operator_id,payload) VALUES (?,?,?,?)`)
      .run('MachineStopped', machine_id, reported_by || null, JSON.stringify({ reason_code, notes }));
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/machine-stops/:id/end', requireAnyRole(['production', 'kiosk', 'maintenance', 'manager', 'admin']), (req, res) => {
    const stop = db.prepare('SELECT * FROM machine_stops WHERE id=?').get(req.params.id);
    if (!stop) return res.status(404).json({ error: 'not found' });
    const durMin = stop.started_at
      ? Math.round((Date.now() - new Date(stop.started_at).getTime()) / 60000)
      : 0;
    db.prepare(`UPDATE machine_stops SET ended_at=CURRENT_TIMESTAMP, duration_min=? WHERE id=?`)
      .run(durMin, req.params.id);
    res.json({ ok: true, duration_min: durMin });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "production-shifts",
  "label": "Production Shifts",
  "consumes": [
    {
      "table": "machine_stops"
    },
    {
      "table": "production_logs"
    }
  ],
  "produces": [
    {
      "event": "machine_update"
    }
  ]
};
