const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/logistics missing dependency: ${name}`);
  return value;
}

module.exports = function createLogisticsRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const intakeNotify = required('intakeNotify', deps.intakeNotify);
  const priorityUpdate = required('priorityUpdate', deps.priorityUpdate);
  const createAlert = required('createAlert', deps.createAlert);

  // Delivery lifecycle routes
  router.get('/deliveries', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { driverId, date, status } = req.query;
    let sql = `SELECT d.*, o.order_num, o.delivery_address, o.total_weight, o.billing_weight,
                 c.name as customer_name, c.phone as customer_phone,
                 dr.name as driver_name
               FROM deliveries d
               JOIN orders o ON d.order_id = o.id
               LEFT JOIN customers c ON o.customer_id = c.id
               LEFT JOIN drivers dr ON d.driver_id = dr.id`;
    const where = [], params = [];
    if (driverId) { where.push('d.driver_id=?'); params.push(driverId); }
    if (date)     { where.push('d.scheduled_date=?'); params.push(date); }
    if (status)   { where.push('d.status=?'); params.push(status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY d.scheduled_date, d.id';
    const deliveries = db.prepare(sql).all(...params);
    // Attach pallets count
    deliveries.forEach(d => {
      d.pallets_count = db.prepare('SELECT COUNT(*) as c FROM pallets WHERE order_id=?').get(d.order_id)?.c || 0;
    });
    res.json(deliveries);
  });

  router.post('/deliveries', requireAnyRole(['office', 'warehouse', 'manager', 'admin']), (req, res) => {
    const { orderId, driverId, scheduledDate } = req.body;
    const r = db.prepare('INSERT INTO deliveries (order_id,driver_id,scheduled_date) VALUES (?,?,?)')
      .run(orderId, driverId, scheduledDate);
    // Update order status
    db.prepare("UPDATE orders SET status='בתור ייצור' WHERE id=? AND status='ממתינה לאישור'").run(orderId);
    res.json({ id: r.lastInsertRowid });
  });

  // Driver departs from either pending status.
  router.post('/deliveries/:id/depart', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const delivery = db.prepare('SELECT status FROM deliveries WHERE id=?').get(req.params.id);
    if (!delivery) return res.status(404).json({ error: 'משלוח לא נמצא' });
    if (!['ממתין', 'מתוכנן'].includes(delivery.status)) {
      return res.status(409).json({ error: `לא ניתן לצאת מסטטוס: ${delivery.status}` });
    }
    db.prepare("UPDATE deliveries SET status='יצא',departed_at=? WHERE id=?")
      .run(new Date().toISOString(), req.params.id);
    const del = db.prepare('SELECT order_id FROM deliveries WHERE id=?').get(req.params.id);
    if (del) {
      db.prepare("UPDATE orders SET status='בדרך ללקוח' WHERE id=?").run(del.order_id);
      const o = db.prepare('SELECT o.*,c.phone FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=?').get(del.order_id);
      if (o?.phone) intakeNotify(o.phone, o.order_num, 'בדרך ללקוח').catch(() => {});
      wsBroadcast('delivery_depart', { deliveryId: Number(req.params.id), orderId: del.order_id });
    }
    res.json({ success: true });
  });

  // Driver confirms delivery — BUG-33: only allowed after depart
  router.post('/deliveries/:id/confirm', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const delivery = db.prepare('SELECT status FROM deliveries WHERE id=?').get(req.params.id);
    if (!delivery) return res.status(404).json({ error: 'משלוח לא נמצא' });
    if (delivery.status !== 'יצא') {
      return res.status(409).json({ error: `לא ניתן לאשר ממצב: ${delivery.status}. נדרש מצב: יצא` });
    }
    const { signatureData, photoUrl, notes, lat, lng } = req.body ?? {};
    db.prepare(`UPDATE deliveries SET status='סופק',delivered_at=?,signature_data=?,photo_url=?,notes=?,delivery_lat=?,delivery_lng=? WHERE id=?`)
      .run(new Date().toISOString(), signatureData, photoUrl, notes, lat, lng, req.params.id);
    const del = db.prepare('SELECT order_id FROM deliveries WHERE id=?').get(req.params.id);
    if (del) {
      db.prepare("UPDATE orders SET status='סופק – אושר' WHERE id=?").run(del.order_id);
      const o = db.prepare('SELECT o.*,c.phone FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=?').get(del.order_id);
      if (o?.phone) intakeNotify(o.phone, o.order_num, 'סופק – אושר').catch(() => {});
      // Sync to Priority
      if (o?.priority_order_id) {
        priorityUpdate(o.priority_order_id, 'סופק – אושר').catch(() => {});
      }
      wsBroadcast('delivery_confirm', { deliveryId: Number(req.params.id), orderId: del.order_id });
    }
    res.json({ success: true });
  });

  // Driver can report a problem until the delivery is confirmed.
  router.post('/deliveries/:id/problem', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const delivery = db.prepare('SELECT status FROM deliveries WHERE id=?').get(req.params.id);
    if (!delivery) return res.status(404).json({ error: 'משלוח לא נמצא' });
    if (delivery.status === 'סופק') {
      return res.status(409).json({ error: 'לא ניתן לדווח על בעיה — משלוח כבר סופק' });
    }
    const { problemType, problemNotes } = req.body;
    db.prepare("UPDATE deliveries SET status='בעיה',problem_type=?,problem_notes=? WHERE id=?")
      .run(problemType, problemNotes, req.params.id);
    const del = db.prepare('SELECT order_id FROM deliveries WHERE id=?').get(req.params.id);
    if (del) {
      const o = db.prepare('SELECT order_num FROM orders WHERE id=?').get(del.order_id);
      createAlert('delivery_problem', 'danger', `בעיה באספקה ${o?.order_num}: ${problemType}`, { orderId: del.order_id });
    }
    res.json({ success: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'logistics',
  label: 'משלוחים',
  consumes: [{ event: 'order_status' }, { table: 'deliveries' }, { table: 'drivers' }],
  produces: [
    { event: 'delivery_depart' },
    { event: 'delivery_confirm' },
  ],
};
