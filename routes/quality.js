const router = require('express').Router();
const { itemShapeMetrics } = require('../services/shapeSnapshot');

function required(name, value) {
  if (!value) throw new Error(`routes/quality missing dependency: ${name}`);
  return value;
}

function enrichQualityCheck(row = {}) {
  const metrics = itemShapeMetrics({
    quantity: row.item_quantity,
    shape_snapshot_json: row.shape_snapshot_json,
    total_length_mm: row.item_total_length_mm,
    weight_per_unit: row.item_weight_per_unit,
    total_weight: row.item_total_weight,
  });
  return {
    ...row,
    order_id: row.order_id || row.item_order_id || null,
    order_num: row.order_num || row.item_order_num || null,
    item_shape_name: row.item_shape_name || null,
    item_diameter: row.item_diameter || null,
    shape_v2_total_length_mm: metrics.totalLengthMm || null,
    shape_v2_unit_weight_kg: metrics.unitWeightKg || null,
    shape_v2_total_weight_kg: metrics.totalWeightKg || null,
  };
}

function qualityItemContext(db, itemId) {
  if (!itemId) return null;
  return db.prepare(`
    SELECT i.id,i.order_id,i.shape_snapshot_json,i.shape_name,i.diameter,i.total_length_mm,i.quantity,i.weight_per_unit,i.total_weight,o.order_num
    FROM items i
    LEFT JOIN orders o ON o.id=i.order_id
    WHERE i.id=?
  `).get(itemId) || null;
}

module.exports = function createQualityRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  router.use(require('./qualityWeighings')({db,requireAnyRole}));
  router.get('/quality', requireAnyRole(['quality', 'production', 'office', 'manager', 'admin']), (req, res) => {
    const { order_id, item_id, result, limit=100 } = req.query;
    let sql = `SELECT q.*,u.display_name as inspector_name,
             i.order_id as item_order_id,i.shape_snapshot_json,i.shape_name as item_shape_name,
             i.diameter as item_diameter,i.total_length_mm as item_total_length_mm,
             i.quantity as item_quantity,i.weight_per_unit as item_weight_per_unit,i.total_weight as item_total_weight,
             o.order_num as item_order_num
      FROM quality_checks q
      LEFT JOIN users u ON q.inspector_id=u.id
      LEFT JOIN items i ON i.id=q.item_id
      LEFT JOIN orders o ON o.id=i.order_id
      WHERE 1=1`;
    const params = [];
    if (order_id) { sql+=' AND q.order_id=?'; params.push(order_id); }
    if (item_id)  { sql+=' AND q.item_id=?';  params.push(item_id); }
    if (result)   { sql+=' AND q.result=?';   params.push(result); }
    sql+=' ORDER BY q.checked_at DESC LIMIT ?'; params.push(Number(limit));
    res.json(db.prepare(sql).all(...params).map(enrichQualityCheck));
  });
  router.post('/quality', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    if (!f.item_id) return res.status(400).json({ error: 'item_id is required' });
    const itemContext = qualityItemContext(db, f.item_id);
    const metrics = itemShapeMetrics(itemContext || {});
    const orderId = f.order_id || itemContext?.order_id || null;
    const orderNum = f.order_num || itemContext?.order_num || null;
    const normalizedNotes = [
      f.notes || '',
      metrics.totalLengthMm ? `Shape V2 length: ${Math.round(metrics.totalLengthMm * 100) / 1000} cm` : '',
      metrics.totalWeightKg ? `Shape V2 weight: ${Math.round(metrics.totalWeightKg * 1000) / 1000}kg` : '',
    ].filter(Boolean).join(' | ');
    const r = db.prepare('INSERT INTO quality_checks (item_id,order_id,order_num,inspector_id,check_type,sample_qty,pass_qty,fail_qty,deviation_mm,deviation_deg,result,action_taken,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.item_id,orderId,orderNum,f.inspector_id||null,f.check_type||'length',f.sample_qty||1,f.pass_qty||0,f.fail_qty||0,f.deviation_mm||0,f.deviation_deg||0,f.result||'pass',f.action_taken||null,normalizedNotes||null);
    db.prepare('UPDATE items SET qc_status=? WHERE id=?').run(f.result==='pass'?'עבר':'נכשל',f.item_id);
    res.json({ id: r.lastInsertRowid });
  });
  router.get('/quality/stats', requireAnyRole(['quality', 'production', 'office', 'manager', 'admin']), (req, res) => {
    res.json({
      total:   db.prepare('SELECT COUNT(*) as c FROM quality_checks').get().c,
      passed:  db.prepare("SELECT COUNT(*) as c FROM quality_checks WHERE result='pass'").get().c,
      failed:  db.prepare("SELECT COUNT(*) as c FROM quality_checks WHERE result='fail'").get().c,
      byType:  db.prepare('SELECT check_type,COUNT(*) as c,AVG(deviation_mm) as avg_dev FROM quality_checks GROUP BY check_type').all(),
      affectedWeightKg: db.prepare(`
        SELECT i.* FROM quality_checks q
        JOIN items i ON i.id=q.item_id
        WHERE q.result!='pass'
      `).all().reduce((sum, item) => sum + (itemShapeMetrics(item).totalWeightKg || 0), 0),
    });
  });

  router.get('/incidents', requireAnyRole(['quality', 'maintenance', 'production', 'office', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT i.*, m.name as machine_name
      FROM incidents i
      LEFT JOIN machines m ON i.machine_id = m.id
      ORDER BY
        CASE i.status WHEN 'פתוח' THEN 0 WHEN 'בטיפול' THEN 1 ELSE 2 END,
        i.created_at DESC
    `).all();
    res.json(rows);
  });

  router.post('/incidents', requireAnyRole(['quality', 'maintenance', 'production', 'manager', 'admin']), (req, res) => {
    const { title, machine_id, severity, description, assigned_to, financial_impact, opened_by } = req.body;
    const r = db.prepare(`
      INSERT INTO incidents (title,machine_id,severity,description,assigned_to,financial_impact,opened_by,timeline)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      title, machine_id || null, severity || 'בינוני',
      description || '', assigned_to || '', financial_impact || 0, opened_by || '',
      JSON.stringify([{ ts: new Date().toISOString(), text: 'אירוע נפתח' }])
    );
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/incidents/:id', requireAnyRole(['quality', 'maintenance', 'manager', 'admin']), (req, res) => {
    const { status, update_text, assigned_to, financial_impact } = req.body;
    const inc = db.prepare('SELECT * FROM incidents WHERE id=?').get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    let timeline = JSON.parse(inc.timeline || '[]');
    if (update_text) timeline.push({ ts: new Date().toISOString(), text: update_text });
    db.prepare(`
      UPDATE incidents
      SET status           = COALESCE(?, status),
          assigned_to      = COALESCE(?, assigned_to),
          financial_impact = COALESCE(?, financial_impact),
          timeline         = ?,
          resolved_at      = CASE WHEN ? = 'סגור' THEN CURRENT_TIMESTAMP ELSE resolved_at END
      WHERE id = ?
    `).run(status || null, assigned_to || null, financial_impact ?? null,
           JSON.stringify(timeline), status || '', req.params.id);
    res.json({ ok: true });
  });

  // ── NCR – Non-Conformance Reports ─────────────────────────────────
  router.get('/ncr', requireAnyRole(['quality', 'production', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT n.*, m.name as machine_name
      FROM ncr n
      LEFT JOIN machines m ON n.machine_id = m.id
      ORDER BY n.created_at DESC
    `).all();
    res.json(rows);
  });

  router.post('/ncr', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    const seq = db.prepare('SELECT COUNT(*)+1 as n FROM ncr').get().n;
    const num = 'NCR-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
    const { order_id, order_num, machine_id, description, severity, root_cause,
            disposition, quantity_affected, diameter, assigned_to, notes } = req.body;
    const r = db.prepare(`
      INSERT INTO ncr (ncr_num,order_id,order_num,machine_id,description,severity,
                       root_cause,disposition,quantity_affected,diameter,assigned_to,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(num, order_id || null, order_num || '', machine_id || null, description,
           severity || 'בינוני', root_cause || '', disposition || '',
           quantity_affected || 0, diameter || null, assigned_to || '', notes || '');
    res.json({ id: r.lastInsertRowid, ncr_num: num });
  });

  router.patch('/ncr/:id', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    db.prepare(`
      UPDATE ncr
      SET status      = COALESCE(?, status),
          severity    = COALESCE(?, severity),
          root_cause  = COALESCE(?, root_cause),
          disposition = COALESCE(?, disposition),
          assigned_to = COALESCE(?, assigned_to),
          notes       = COALESCE(?, notes),
          closed_by   = COALESCE(?, closed_by),
          closed_at   = CASE WHEN ? = 'סגור' THEN CURRENT_TIMESTAMP ELSE closed_at END
      WHERE id = ?
    `).run(f.status || null, f.severity || null, f.root_cause || null,
           f.disposition || null, f.assigned_to || null, f.notes || null,
           f.closed_by || null, f.status || '', req.params.id);
    res.json({ ok: true });
  });

  // ── CAPA – Corrective & Preventive Actions ────────────────────────
  router.get('/capa', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare(`
      SELECT c.*, n.ncr_num
      FROM capa c
      LEFT JOIN ncr n ON c.ncr_id = n.id
      ORDER BY c.created_at DESC
    `).all());
  });

  router.post('/capa', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    const seq = db.prepare('SELECT COUNT(*)+1 as n FROM capa').get().n;
    const num = 'CAPA-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
    const { ncr_id, title, type, problem_description, root_cause,
            actions, owner, due_date, verification_method } = req.body;
    const r = db.prepare(`
      INSERT INTO capa (capa_num,ncr_id,title,type,problem_description,root_cause,
                        actions,owner,due_date,verification_method)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(num, ncr_id || null, title, type || 'מתקן',
           problem_description || '', root_cause || '',
           JSON.stringify(actions || []), owner || '', due_date || '', verification_method || '');
    res.json({ id: r.lastInsertRowid, capa_num: num });
  });

  router.patch('/capa/:id', requireAnyRole(['quality', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    db.prepare(`
      UPDATE capa
      SET status         = COALESCE(?, status),
          completion_pct = COALESCE(?, completion_pct),
          actions        = COALESCE(?, actions),
          owner          = COALESCE(?, owner),
          due_date       = COALESCE(?, due_date),
          problem_description = COALESCE(?, problem_description),
          root_cause     = COALESCE(?, root_cause),
          verification_method = COALESCE(?, verification_method)
      WHERE id = ?
    `).run(f.status || null, f.completion_pct ?? null,
            f.actions ? JSON.stringify(f.actions) : null,
            f.owner || null, f.due_date || null,
            f.problem_description || null, f.root_cause || null,
            f.verification_method || null, req.params.id);
    res.json({ ok: true });
  });

  return router;
};

module.exports.manifest = {
  id: 'quality',
  label: 'איכות',
  screens: [
    { id: 'quality', path: '/quality.html', label: 'איכות', icon: '🔍', group: 'בקרה' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'read', quality: 'edit' },
  },
  consumes: [{ table: 'quality_checks' }, { table: 'incidents' }, { table: 'ncr' }, { table: 'capa' }],
  produces: [{table:'quality_weighings'},{table:'quality_weighing_orders'},{table:'quality_weighing_lines'},{table:'quality_weighing_events'}],
};


