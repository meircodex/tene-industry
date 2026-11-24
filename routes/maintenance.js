const router = require('express').Router();
const { itemShapeMetrics } = require('../services/shapeSnapshot');

function required(name, value) {
  if (!value) throw new Error(`routes/maintenance missing dependency: ${name}`);
  return value;
}

function productionLoadByMachine(db) {
  const rows = db.prepare(`
    SELECT machine,machine_id,shape_snapshot_json,total_length_mm,quantity,weight_per_unit,total_weight,status
    FROM items
    WHERE (machine IS NOT NULL OR machine_id IS NOT NULL)
      AND COALESCE(status,'') NOT IN ('\u05d1\u05d5\u05e6\u05e2','\u05e1\u05d5\u05e4\u05e7','done','supplied')
  `).all();
  return rows.reduce((map, item) => {
    const keys = [item.machine, item.machine_id].map(value => String(value || '').trim()).filter(Boolean);
    if (!keys.length) return map;
    const metrics = itemShapeMetrics(item);
    for (const key of keys) {
      const current = map.get(key) || { current_item_count: 0, current_weight_kg: 0 };
      current.current_item_count += 1;
      current.current_weight_kg += metrics.totalWeightKg || 0;
      map.set(key, current);
    }
    return map;
  }, new Map());
}

function attachMachineLoad(rows, loadMap) {
  return rows.map(row => {
    const load = loadMap.get(String(row.id || '')) || loadMap.get(String(row.label || '')) || loadMap.get(String(row.name || '')) || {};
    return {
      ...row,
      current_item_count: load.current_item_count || 0,
      current_weight_kg: Math.round((load.current_weight_kg || 0) * 1000) / 1000,
    };
  });
}

module.exports = function createMaintenanceRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  // ── MAINTENANCE
  router.get('/maintenance', requireAnyRole(['maintenance', 'production', 'office', 'manager', 'admin']), (req, res) => {
    const { machine_id, status, limit=100 } = req.query;
    let sql = 'SELECT m.*,mc.name as machine_name,mc.label as machine_label,u.display_name as reported_by_name,u2.display_name as assigned_to_name FROM maintenance_logs m LEFT JOIN machines mc ON m.machine_id=mc.id LEFT JOIN users u ON m.reported_by=u.id LEFT JOIN users u2 ON m.assigned_to=u2.id WHERE 1=1';
    const params = [];
    if (machine_id) { sql+=' AND m.machine_id=?'; params.push(machine_id); }
    if (status)     { sql+=' AND m.status=?';     params.push(status); }
    sql+=' ORDER BY m.started_at DESC LIMIT ?'; params.push(Number(limit));
    res.json(db.prepare(sql).all(...params));
  });
  router.post('/maintenance', requireAnyRole(['maintenance', 'production', 'manager', 'admin']), (req, res) => {
    const f = req.body || {};
    if (!f.machine_id||!f.description) return res.status(400).json({ error: 'מכונה ותיאור חובה' });
    if (f.log_type==='breakdown') {
      db.prepare("UPDATE machines SET status='תקלה' WHERE id=?").run(f.machine_id);
      wsBroadcast('machine_update',{ machineId:f.machine_id, status:'תקלה' });
    }
    const r = db.prepare('INSERT INTO maintenance_logs (machine_id,log_type,description,reported_by,priority,parts_used,cost) VALUES (?,?,?,?,?,?,?)')
      .run(f.machine_id,f.log_type||'breakdown',f.description,f.reported_by||null,f.priority||'רגיל',f.parts_used||null,f.cost||0);
    res.json({ id: r.lastInsertRowid });
  });
  router.patch('/maintenance/:id', requireAnyRole(['maintenance', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    const log = db.prepare('SELECT * FROM maintenance_logs WHERE id=?').get(req.params.id);
    if (!log) return res.status(404).json({ error: 'לא נמצא' });
    const resolvedAt = f.status==='סגורה' ? new Date().toISOString() : null;
    db.prepare('UPDATE maintenance_logs SET status=COALESCE(?,status),assigned_to=COALESCE(?,assigned_to),downtime_min=COALESCE(?,downtime_min),root_cause=COALESCE(?,root_cause),fix_notes=COALESCE(?,fix_notes),parts_used=COALESCE(?,parts_used),cost=COALESCE(?,cost),resolved_at=COALESCE(?,resolved_at) WHERE id=?')
      .run(f.status||null,f.assigned_to||null,f.downtime_min||null,f.root_cause||null,f.fix_notes||null,f.parts_used||null,f.cost||null,resolvedAt,req.params.id);
    if (f.status==='סגורה'&&log.log_type==='breakdown') db.prepare("UPDATE machines SET status='מחובר' WHERE id=?").run(log.machine_id);
    res.json({ success: true });
  });
  router.get('/maintenance/stats', requireAnyRole(['maintenance', 'production', 'office', 'manager', 'admin']), (req, res) => {
    const loadMap = productionLoadByMachine(db);
    const byMachine = db.prepare('SELECT mc.id,mc.label,mc.name,COUNT(*) as events,SUM(m.downtime_min) as total_down FROM maintenance_logs m LEFT JOIN machines mc ON m.machine_id=mc.id GROUP BY m.machine_id ORDER BY total_down DESC').all();
    res.json({
      open:        db.prepare("SELECT COUNT(*) as c FROM maintenance_logs WHERE status!='\u05e1\u05d2\u05d5\u05e8\u05d4'").get().c,
      breakdowns:  db.prepare("SELECT COUNT(*) as c FROM maintenance_logs WHERE log_type='breakdown'").get().c,
      avgDowntime: db.prepare('SELECT ROUND(AVG(downtime_min),0) as avg FROM maintenance_logs WHERE downtime_min>0').get().avg||0,
      activeProductionLoad: attachMachineLoad(db.prepare('SELECT id,label,name FROM machines WHERE retired_at IS NULL').all(), loadMap),
      byMachine:   attachMachineLoad(byMachine, loadMap),
    });
  });

  // ── LOTO – Lockout / Tagout ───────────────────────────────────────
  router.get('/loto', requireAnyRole(['maintenance', 'production', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare(`
      SELECT l.*, m.name as machine_name
      FROM loto l
      LEFT JOIN machines m ON l.machine_id = m.id
      ORDER BY l.created_at DESC
    `).all());
  });

  router.post('/loto', requireAnyRole(['maintenance', 'manager', 'admin']), (req, res) => {
    const { machine_id, locked_by, reason, reason_detail, safety_notes } = req.body;
    const existing = db.prepare("SELECT id FROM loto WHERE machine_id=? AND status='פעיל'").get(machine_id);
    if (existing) return res.status(409).json({ error: 'המכונה כבר נעולה' });
    const r = db.prepare(`
      INSERT INTO loto (machine_id,locked_by,reason,reason_detail,safety_notes)
      VALUES (?,?,?,?,?)
    `).run(machine_id, locked_by, reason || 'תחזוקה', reason_detail || '', safety_notes || '');
    db.prepare("UPDATE machines SET status='נעול LOTO' WHERE id=?").run(machine_id);
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/loto/:id/release', requireAnyRole(['maintenance', 'manager', 'admin']), (req, res) => {
    const loto = db.prepare('SELECT * FROM loto WHERE id=?').get(req.params.id);
    if (!loto) return res.status(404).json({ error: 'לא נמצא' });
    if (!req.body) return res.status(400).json({ error: 'פרטי שחרור חסרים' });
    const { released_by, release_notes } = req.body;
    db.prepare(`
      UPDATE loto
      SET status='שוחרר', released_by=?, release_notes=?,
          release_confirmed=1, released_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(released_by || '', release_notes || '', req.params.id);
    db.prepare("UPDATE machines SET status='לא מחובר' WHERE id=?").run(loto.machine_id);
    res.json({ ok: true });
  });

  // ── PREVENTIVE MAINTENANCE SCHEDULE ──────────────────────────────
  router.get('/pm-schedule', requireAnyRole(['maintenance', 'production', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare(`
      SELECT p.*, m.name as machine_name
      FROM pm_schedule p
      LEFT JOIN machines m ON p.machine_id = m.id
      WHERE p.active = 1
      ORDER BY p.next_due ASC
    `).all());
  });

  router.post('/pm-schedule', requireAnyRole(['maintenance', 'manager', 'admin']), (req, res) => {
    const { machine_id, pm_type, frequency, last_done, next_due, instructions } = req.body;
    db.prepare(`
      INSERT OR REPLACE INTO pm_schedule (machine_id,pm_type,frequency,last_done,next_due,instructions)
      VALUES (?,?,?,?,?,?)
    `).run(machine_id, pm_type, frequency || 'חודשי', last_done || null, next_due || null, instructions || '');
    res.json({ ok: true });
  });


  return router;
};

module.exports.manifest = {
  id: 'maintenance',
  label: 'תחזוקה',
  screens: [
    { id: 'maintenance', path: '/maintenance.html', label: 'תחזוקה', icon: '🛠️', group: 'בקרה' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', quality: 'read', maintenance: 'edit' },
  },
  consumes: [{ table: 'maintenance_logs' }, { table: 'machines' }, { table: 'loto' }, { table: 'pm_schedule' }],
  produces: [
    { table: 'worker_fault_reports' },
    { table: 'worker_help_documents' },{ event: 'machine_update' }],
};

