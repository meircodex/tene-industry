const router = require('express').Router();
const { consumeReservationsForProduction } = require('../services/inventoryReservation');

function required(name, value) {
  if (!value) throw new Error(`routes/productionMachines missing dependency: ${name}`);
  return value;
}

module.exports = function createProductionMachinesRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireRole = required('requireRole', deps.requireRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const modbus = required('modbus', deps.modbus);
  const MACHINE_STATES = required('MACHINE_STATES', deps.MACHINE_STATES);
  const STATE_TRANSITIONS = required('STATE_TRANSITIONS', deps.STATE_TRANSITIONS);
  const checkOrderComplete = required('checkOrderComplete', deps.checkOrderComplete);

  // ── MACHINES ──────────────────────────────────────────────────────
  router.get('/machines', requireAnyRole(['production', 'kiosk', 'maintenance', 'office', 'manager', 'admin']), (req, res) => {
    const machines = db.prepare('SELECT * FROM machines ORDER BY id').all();
    const live = modbus.getAllState();
    const merged = machines.map(m => {
      const ls = live.find(l => l.id === m.id);
      return ls ? { ...m, ...ls } : m;
    });
    res.json(merged);
  });

  // Create new machine
  router.post('/machines', requireRole('manager'), (req, res) => {
    const {
      name, label, conn_mode, tcp_host, tcp_port, rtu_port, baud_rate, parity, stop_bits, slave_id,
      min_diameter, max_diameter,
      single_min_diameter, single_max_diameter, double_min_diameter, double_max_diameter
    } = req.body;
    if (!name) return res.status(400).json({ error: 'שם מכונה נדרש' });
    const result = db.prepare(`INSERT INTO machines (name,label,conn_mode,tcp_host,tcp_port,rtu_port,baud_rate,parity,stop_bits,slave_id,min_diameter,max_diameter,single_min_diameter,single_max_diameter,double_min_diameter,double_max_diameter)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(name.trim(), label||name.substring(0,1).toUpperCase(), conn_mode||'tcp',
           tcp_host||null, tcp_port||502, rtu_port||null, baud_rate||9600,
           parity||'none', stop_bits||1,
           slave_id||1, min_diameter||8, max_diameter||32,
           single_min_diameter || min_diameter || 8,
           single_max_diameter || max_diameter || 32,
           double_min_diameter || min_diameter || 8,
           double_max_diameter || 16);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  // Delete machine
  router.delete('/machines/:id', requireRole('manager'), (req, res) => {
    db.prepare('DELETE FROM machines WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  router.post('/machines/:id/send-params', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), async (req, res) => {
    const machineId = Number(req.params.id);
    const { diameter, totalLengthMm, productionQty, angles } = req.body;
    try {
      await modbus.writeParams(machineId, { diameter, totalLengthMm, productionQty, angles: angles || [] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/machines/:id/assign', requireAnyRole(['production', 'manager', 'admin']), (req, res) => {
    const { itemId, orderNum } = req.body;
    db.prepare('UPDATE machines SET current_item_id=?,current_order_num=? WHERE id=?')
      .run(itemId, orderNum, req.params.id);
    db.prepare('UPDATE items SET status=?,started_at=?,machine_id=? WHERE id=?')
      .run('בייצור', new Date().toISOString(), req.params.id, itemId);
    wsBroadcast('machine_assign', { machineId: Number(req.params.id), itemId, orderNum });
    res.json({ success: true });
  });

  // ── MACHINE CONNECTION CONFIG ─────────────────────────────────────
  router.patch('/machines/:id/config', requireRole('manager'), (req, res) => {
    const {
      conn_mode, tcp_host, tcp_port, rtu_port, baud_rate, parity, stop_bits, slave_id,
      min_diameter, max_diameter,
      single_min_diameter, single_max_diameter, double_min_diameter, double_max_diameter,
      name, label, can_3d
    } = req.body;
    const mode = conn_mode || 'tcp';
    db.prepare(`UPDATE machines SET
      conn_mode=?,
      tcp_host=?,
      tcp_port=?,
      rtu_port=?,
      baud_rate=COALESCE(?,baud_rate),
      parity=COALESCE(?,parity),
      stop_bits=COALESCE(?,stop_bits),
      slave_id=COALESCE(?,slave_id),
      min_diameter=COALESCE(?,min_diameter),
      max_diameter=COALESCE(?,max_diameter),
      single_min_diameter=COALESCE(?,single_min_diameter),
      single_max_diameter=COALESCE(?,single_max_diameter),
      double_min_diameter=COALESCE(?,double_min_diameter),
      double_max_diameter=COALESCE(?,double_max_diameter),
      name=COALESCE(?,name),
      label=COALESCE(?,label),
      can_3d=COALESCE(?,can_3d)
      WHERE id=?`)
      .run(
        mode,
        mode === 'tcp' ? (tcp_host || null) : null,
        mode === 'tcp' ? (tcp_port || 502)  : null,
        mode === 'rtu' ? (rtu_port || null) : null,
        baud_rate || null, parity || null, stop_bits || null, slave_id || null,
        min_diameter || null, max_diameter || null,
        single_min_diameter || null, single_max_diameter || null,
        double_min_diameter || null, double_max_diameter || null,
        name || null, label || null,
        can_3d != null ? (can_3d ? 1 : 0) : null,
        req.params.id
      );
    if (modbus) modbus.reconfigMachine(req.params.id).catch(()=>{});
    res.json({ success: true });
  });

  router.post('/machines/:id/complete', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const machineId = Number(req.params.id);
    const { producedQty } = req.body;
    const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(machineId);
    if (!machine?.current_item_id) return res.status(400).json({ error: 'אין פריט פעיל' });

    const item       = db.prepare('SELECT * FROM items WHERE id=?').get(machine.current_item_id);
    const actualWaste = Math.max(0, (producedQty || 0) - (item?.quantity || 0));

    db.prepare('UPDATE items SET status=?,completed_at=?,produced_qty=?,actual_waste=? WHERE id=?')
      .run('הושלם', new Date().toISOString(), producedQty, actualWaste, machine.current_item_id);
    db.prepare('UPDATE machines SET current_item_id=NULL,current_order_num=NULL,counter=0 WHERE id=?').run(machineId);

    const pallet = item ? db.prepare('SELECT order_id FROM pallets WHERE id=?').get(item.pallet_id) : null;
    const consumedReservations = pallet ? consumeReservationsForProduction(db,{order_id:pallet.order_id,item_ids:[item.id],actual_weight_kg:req.body.actual_weight_kg}) : {consumed:0};
    if (pallet) checkOrderComplete(pallet.order_id);

    if(consumedReservations.consumed)wsBroadcast('inventory_changed',{item_id:item.id});
    wsBroadcast('machine_complete', { machineId });
    res.json({ success: true, actualWaste, consumedReservations });
  });

  // ── MACHINE STATE MACHINE ────────────────────────────────────────

  router.patch('/machines/:id/state', requireAnyRole(['production', 'maintenance', 'manager', 'admin']), (req, res) => {
    const machineId = Number(req.params.id);
    const { state, reason, operator_id } = req.body;
    if (!MACHINE_STATES.includes(state)) {
      return res.status(400).json({ error: `מצב לא תקין: ${state}. מצבים אפשריים: ${MACHINE_STATES.join(', ')}` });
    }
    const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(machineId);
    if (!machine) return res.status(404).json({ error: 'מכונה לא נמצאה' });

    const currentState = machine.status || 'לא מחובר';
    const allowed = STATE_TRANSITIONS[currentState] || [];
    if (!allowed.includes(state)) {
      return res.status(409).json({
        error: `מעבר לא חוקי: ${currentState} → ${state}`,
        current: currentState,
        allowed
      });
    }

    // Block transition to ריצה if machine has active LOTO lock
    if (state === 'ריצה') {
      const activeLock = db.prepare("SELECT id FROM loto WHERE machine_id=? AND status='פעיל'").get(machineId);
      if (activeLock) {
        return res.status(409).json({ error: 'לא ניתן להפעיל מכונה עם נעילת LOTO פעילה', loto_id: activeLock.id });
      }
    }

    // Update machine status
    db.prepare('UPDATE machines SET status=? WHERE id=?').run(state, machineId);

    // Log the transition
    db.prepare('INSERT INTO machine_state_log (machine_id,from_state,to_state,reason,operator_id) VALUES (?,?,?,?,?)')
      .run(machineId, currentState, state, reason || null, operator_id || null);

    // Insert production event
    const eventMap = {
      'ריצה':   'MachineStarted',
      'תקלה':   'MachineStopped',
      'תחזוקה': 'MachineStopped',
      'לא מחובר': 'MachineStopped',
    };
    if (eventMap[state]) {
      db.prepare('INSERT INTO production_events (event_type,machine_id,payload) VALUES (?,?,?)')
        .run(eventMap[state], machineId, JSON.stringify({ from: currentState, to: state, reason }));
    }

    // If fault or maintenance, create alert
    if (state === 'תקלה') {
      db.prepare("INSERT INTO alerts (type,level,message,machine_id) VALUES (?,?,?,?)")
        .run('machine_fault', 'critical', `מכונה ${machine.name} עברה לתקלה${reason ? ': ' + reason : ''}`, machineId);
    }

    wsBroadcast('machine_state', { machineId, from: currentState, to: state, reason });
    res.json({ ok: true, from: currentState, to: state });
  });

  router.get('/machines/:id/state-log', requireAnyRole(['production', 'maintenance', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT sl.*, u.display_name as operator_name
      FROM machine_state_log sl
      LEFT JOIN users u ON sl.operator_id = u.id
      WHERE sl.machine_id = ?
      ORDER BY sl.created_at DESC
      LIMIT 100
    `).all(req.params.id);
    res.json(rows);
  });

  return router;
};

module.exports.manifest = {
  id: 'production-machines',
  label: 'מכונות ייצור',
  screens: [
    { id: 'machine', path: '/machine.html', label: 'מכונות', icon: '🔧', group: 'ייצור' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'read', maintenance: 'read', kiosk: 'read' },
  },
  consumes: [{ table: 'machines' }, { table: 'items' }],
  produces: [
    { event: 'inventory_changed' },
    { event: 'machine_assign' },
    { event: 'machine_complete' },
    { event: 'machine_state' },
  ],
};
