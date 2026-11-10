const router = require('express').Router();
const fleetService = require('../services/fleet');

function required(name, value) {
  if (!value) throw new Error(`routes/fleet missing dependency: ${name}`);
  return value;
}

module.exports = function createFleetRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const auditLog = required('auditLog', deps.auditLog);
  const upload = required('upload', deps.upload);

// ── DRIVERS ───────────────────────────────────────────────────────
function vehiclePortfolioRows(all = false) {
  const where = all ? '' : 'WHERE v.active=1';
  const rows = db.prepare(`
    SELECT v.*,
      d.id AS assigned_driver_id,
      d.name AS assigned_driver_name,
      d.phone AS assigned_driver_phone,
      d.license_expiry AS assigned_driver_license_expiry,
      COALESCE(ev.expense_total,0) AS expense_total,
      COALESCE(ev.income_total,0) AS manual_income_total,
      COALESCE(del.delivery_count,0) AS delivery_count,
      COALESCE(del.estimated_income,0) AS delivery_income_estimate
    FROM vehicles v
    LEFT JOIN drivers d ON d.vehicle_id=v.id AND d.active=1
    LEFT JOIN (
      SELECT vehicle_id,
        SUM(CASE WHEN event_type IN ('maintenance','repair','fuel','insurance','test','expense') THEN COALESCE(amount,0) ELSE 0 END) AS expense_total,
        SUM(CASE WHEN event_type='income' THEN COALESCE(amount,0) ELSE 0 END) AS income_total
      FROM vehicle_events
      WHERE vehicle_id IS NOT NULL
      GROUP BY vehicle_id
    ) ev ON ev.vehicle_id=v.id
    LEFT JOIN (
      SELECT dr.vehicle_id,
        COUNT(*) AS delivery_count,
        SUM(COALESCE(NULLIF(o.sale_price,0), COALESCE(o.billing_weight, o.total_weight, 0) * 3.8)) AS estimated_income
      FROM deliveries deliv
      LEFT JOIN orders o ON o.id=deliv.order_id
      LEFT JOIN drivers dr ON dr.id=deliv.driver_id
      WHERE deliv.status IN ('????','???? - ????') AND dr.vehicle_id IS NOT NULL
      GROUP BY dr.vehicle_id
    ) del ON del.vehicle_id=v.id
    ${where}
    ORDER BY v.vehicle_desc, v.license_plate, v.id
  `).all();
  return rows.map(row => {
    const incomeTotal = Number(row.manual_income_total || 0) + Number(row.delivery_income_estimate || 0);
    return {
      ...row,
      health: fleetService.vehicleHealth(row),
      income_total: incomeTotal,
      net_total: incomeTotal - Number(row.expense_total || 0),
    };
  });
}

function driverRows(all = false) {
  const where = all ? '' : 'WHERE d.active=1';
  return db.prepare(`
    SELECT d.*,
      v.vehicle_desc AS assigned_vehicle_desc,
      v.license_plate AS assigned_license_plate,
      v.vehicle_make AS assigned_vehicle_make,
      v.vehicle_model AS assigned_vehicle_model
    FROM drivers d
    LEFT JOIN vehicles v ON v.id=d.vehicle_id
    ${where}
    ORDER BY d.name
  `).all();
}

router.get('/vehicles', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
  res.json(vehiclePortfolioRows(req.query.all === '1'));
});

router.post('/vehicles', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const v = fleetService.vehicleInput(req.body);
  if (!v.vehicle_desc && !v.license_plate) return res.status(400).json({ error: 'vehicle_desc or license_plate is required' });
  const r = db.prepare(`
    INSERT INTO vehicles
      (vehicle_desc,license_plate,vehicle_make,vehicle_model,vehicle_year,test_expiry,insurance_expiry,next_service_date,next_service_km,odometer_km,vehicle_status,active,notes)
    VALUES (@vehicle_desc,@license_plate,@vehicle_make,@vehicle_model,@vehicle_year,@test_expiry,@insurance_expiry,@next_service_date,@next_service_km,@odometer_km,@vehicle_status,@active,@notes)
  `).run(v);
  if (req.body.assigned_driver_id) db.prepare('UPDATE drivers SET vehicle_id=? WHERE id=?').run(r.lastInsertRowid, req.body.assigned_driver_id);
  auditLog('vehicle', r.lastInsertRowid, null, 'create', null, null, null, v.notes, req.auth?.sub || null, req.auth?.display_name || null);
  wsBroadcast('vehicle_updated', { id: r.lastInsertRowid, action: 'create' });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.patch('/vehicles/:id', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const v = fleetService.vehicleInput(req.body);
  db.prepare(`UPDATE vehicles SET
    vehicle_desc=COALESCE(@vehicle_desc,vehicle_desc),
    license_plate=COALESCE(@license_plate,license_plate),
    vehicle_make=COALESCE(@vehicle_make,vehicle_make),
    vehicle_model=COALESCE(@vehicle_model,vehicle_model),
    vehicle_year=COALESCE(@vehicle_year,vehicle_year),
    test_expiry=COALESCE(@test_expiry,test_expiry),
    insurance_expiry=COALESCE(@insurance_expiry,insurance_expiry),
    next_service_date=COALESCE(@next_service_date,next_service_date),
    next_service_km=COALESCE(@next_service_km,next_service_km),
    odometer_km=COALESCE(@odometer_km,odometer_km),
    vehicle_status=COALESCE(@vehicle_status,vehicle_status),
    active=COALESCE(@active,active),
    notes=COALESCE(@notes,notes)
    WHERE id=@id`).run({ ...v, id: req.params.id });
  if (Object.prototype.hasOwnProperty.call(req.body, 'assigned_driver_id')) {
    db.prepare('UPDATE drivers SET vehicle_id=NULL WHERE vehicle_id=?').run(req.params.id);
    if (req.body.assigned_driver_id) db.prepare('UPDATE drivers SET vehicle_id=? WHERE id=?').run(req.params.id, req.body.assigned_driver_id);
  }
  auditLog('vehicle', req.params.id, null, 'update', null, null, null, v.notes, req.auth?.sub || null, req.auth?.display_name || null);
  wsBroadcast('vehicle_updated', { id: Number(req.params.id), action: 'update' });
  res.json({ success: true });
});

router.get('/vehicles/:id/events', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicle_events WHERE vehicle_id=? ORDER BY event_date DESC, id DESC LIMIT 200').all(req.params.id));
});

router.post('/vehicles/:id/events', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const { event_type, event_date, odometer_km, amount, vendor, reference, notes } = req.body;
  if (!event_type || !event_date) return res.status(400).json({ error: 'event_type and event_date are required' });
  const driver = db.prepare('SELECT id FROM drivers WHERE vehicle_id=? AND active=1 ORDER BY id LIMIT 1').get(req.params.id);
  const r = db.prepare(`
    INSERT INTO vehicle_events (vehicle_id,driver_id,event_type,event_date,odometer_km,amount,vendor,reference,notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, driver?.id || null, event_type, event_date, odometer_km||null, amount||0, vendor||null, reference||null, notes||null);
  if (odometer_km) db.prepare('UPDATE vehicles SET odometer_km=? WHERE id=?').run(odometer_km, req.params.id);
  auditLog('vehicle', req.params.id, null, 'vehicle_event', event_type, null, amount||0, notes||null, req.auth?.sub || null, req.auth?.display_name || null);
  wsBroadcast('vehicle_updated', { id: Number(req.params.id), action: 'event' });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.get('/vehicles/:id/documents', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
  res.json(db.prepare('SELECT id,vehicle_id,document_type,title,file_name,mime_type,expiry_date,notes,created_at FROM vehicle_documents WHERE vehicle_id=? ORDER BY created_at DESC, id DESC').all(req.params.id));
});

router.post('/vehicles/:id/documents', requireAnyRole(['office', 'manager', 'admin']), upload.single('file'), (req, res) => {
  const { document_type, title, expiry_date, notes } = req.body;
  if (!document_type) return res.status(400).json({ error: 'document_type is required' });
  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id=?').get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'vehicle not found' });
  const dataUrl = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;
  const r = db.prepare(`
    INSERT INTO vehicle_documents (vehicle_id,document_type,title,file_name,mime_type,data_url,expiry_date,notes,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, document_type, title||null, req.file?.originalname || null, req.file?.mimetype || null, dataUrl, expiry_date||null, notes||null, req.auth?.sub || null);
  auditLog('vehicle', req.params.id, null, 'document_upload', document_type, null, null, title||notes||null, req.auth?.sub || null, req.auth?.display_name || null);
  wsBroadcast('vehicle_updated', { id: Number(req.params.id), action: 'document' });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.get('/drivers', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
  res.json(driverRows(req.query.all === '1'));
});

router.post('/drivers', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const { name, phone, vehicle_id, license_expiry, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'לא הוזן שם נהג. יש להזין את שם הנהג לפני שמירה.' });
  const r = db.prepare('INSERT INTO drivers (name,phone,vehicle_id,license_expiry,notes) VALUES (?,?,?,?,?)').run(name, phone||null, vehicle_id||null, license_expiry||null, notes||null);
  res.json({ success: true, id: r.lastInsertRowid });
});

router.patch('/drivers/:id', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const { name, phone, vehicle_id, license_expiry, notes, active } = req.body;
  db.prepare(`UPDATE drivers SET
    name=COALESCE(?,name), phone=COALESCE(?,phone), vehicle_id=COALESCE(?,vehicle_id),
    license_expiry=COALESCE(?,license_expiry), notes=COALESCE(?,notes), active=COALESCE(?,active)
    WHERE id=?`)
    .run(name||null, phone||null, vehicle_id??null, license_expiry||null, notes||null, active??null, req.params.id);
  res.json({ success: true });
});

router.delete('/drivers/:id', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  db.prepare('UPDATE drivers SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/drivers/:id/vehicle-events', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
  const driver = db.prepare('SELECT vehicle_id FROM drivers WHERE id=?').get(req.params.id);
  if (driver?.vehicle_id) return res.json(db.prepare('SELECT * FROM vehicle_events WHERE vehicle_id=? ORDER BY event_date DESC, id DESC LIMIT 200').all(driver.vehicle_id));
  res.json(db.prepare('SELECT * FROM vehicle_events WHERE driver_id=? ORDER BY event_date DESC, id DESC LIMIT 200').all(req.params.id));
});

router.post('/drivers/:id/vehicle-events', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
  const { event_type, event_date, odometer_km, amount, vendor, reference, notes } = req.body;
  if (!event_type || !event_date) return res.status(400).json({ error: 'event_type and event_date are required' });
  const driver = db.prepare('SELECT vehicle_id FROM drivers WHERE id=?').get(req.params.id);
  const r = db.prepare(`
    INSERT INTO vehicle_events (driver_id,vehicle_id,event_type,event_date,odometer_km,amount,vendor,reference,notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, driver?.vehicle_id || null, event_type, event_date, odometer_km||null, amount||0, vendor||null, reference||null, notes||null);
  if (odometer_km) db.prepare('UPDATE drivers SET odometer_km=? WHERE id=?').run(odometer_km, req.params.id);
  if (odometer_km && driver?.vehicle_id) db.prepare('UPDATE vehicles SET odometer_km=? WHERE id=?').run(odometer_km, driver.vehicle_id);
  auditLog('vehicle', req.params.id, null, 'vehicle_event', event_type, null, amount||0, notes||null, req.auth?.sub || null, req.auth?.display_name || null);
  res.json({ success: true, id: r.lastInsertRowid });
});
router.patch('/drivers/:id/location', requireAnyRole(['driver', 'office', 'manager', 'admin']), (req, res) => {
  const { lat, lng } = req.body;
  db.prepare('UPDATE drivers SET current_lat=?,current_lng=?,last_location_update=? WHERE id=?')
    .run(lat, lng, new Date().toISOString(), req.params.id);
  wsBroadcast('driver_location', { driverId: Number(req.params.id), lat, lng });
  res.json({ success: true });
});

  return router;
};

module.exports.manifest = {
  id: 'fleet',
  label: 'צי רכבים',
  screens: [
    { id: 'delivery-admin', path: '/delivery-admin.html', label: 'ניהול צי',  icon: '🚚', group: 'תפעול' },
    { id: 'driver',         path: '/driver.html',         label: 'מסך נהג',   icon: '🚚', group: 'תפעול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', driver: 'edit' },
  },
  consumes: [{ table: 'vehicles' }, { table: 'drivers' }],
  produces: [
    { event: 'vehicle_updated' },
    { event: 'driver_location' },
  ],
};
