const router = require('express').Router();
const createProductionMachinesRouter = require('./productionMachines');
const productionCards = require('../services/productionCards');
const { consumeReservationsForProduction, calculateMaterialStockPosition, normalizeMaterialType } = require('../services/inventoryReservation');
const { expandProductionCardsForOrder } = require('../services/productionCardPrintPage');

function required(name, value) {
  if (!value) throw new Error(`routes/production missing dependency: ${name}`);
  return value;
}

module.exports = function createProductionRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireRole = required('requireRole', deps.requireRole);
  const requireApprovedDevice = required('requireApprovedDevice', deps.requireApprovedDevice);
  const requireQrPermission = required('requireQrPermission', deps.requireQrPermission);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const modbus = required('modbus', deps.modbus);
  const statusContracts = required('statusContracts', deps.statusContracts);
  const MACHINE_STATES = required('MACHINE_STATES', deps.MACHINE_STATES);
  const STATE_TRANSITIONS = required('STATE_TRANSITIONS', deps.STATE_TRANSITIONS);
  const checkOrderComplete = required('checkOrderComplete', deps.checkOrderComplete);
  const tryParseJSON = required('tryParseJSON', deps.tryParseJSON);
  const productionActuals = required('productionActuals', deps.productionActuals);
  const workerCardActivity = required('workerCardActivity', deps.workerCardActivity);
  const { ORDER_STATUS, ITEM_STATUS } = statusContracts;

  const productionOrderGateStatuses = new Set([
    ORDER_STATUS.APPROVED_WAITING_PRODUCTION,
    ORDER_STATUS.PRODUCTION_QUEUE,
    ORDER_STATUS.IN_PRODUCTION,
  ]);
  const productionStartItemStatuses = new Set([
    ITEM_STATUS.WAITING,
    ITEM_STATUS.IN_PRODUCTION,
  ]);
  const productionWritableItemStatuses = new Set([
    ITEM_STATUS.WAITING,
    ITEM_STATUS.IN_PRODUCTION,
    ITEM_STATUS.DONE,
    ITEM_STATUS.DELIVERED,
    ITEM_STATUS.ON_HOLD,
    ITEM_STATUS.CANCELLED,
  ]);
  const forbiddenProductionItemPatchFields = new Set([
    'quantity',
    'production_qty',
    'shapeSnapshot',
    'shape_snapshot_json',
    'shape_id',
    'shape_name',
    'segments',
    'diameter',
    'spiral_diameter_mm',
    'spiral_turns',
    'total_length_mm',
    'weight_per_unit',
    'total_weight',
    'pricingSnapshot',
    'pricing_snapshot',
    'finance',
    'billing_weight',
    'price',
    'unit_price',
    'package_id',
    'zone',
    'warehouse',
    'packingStatus',
    'shippingStatus',
    'deliveryNoteReference',
  ]);

  function isProductionGateOpen(item) {
    return Boolean(item)
      && !isCancellationStopped(item)
      && productionOrderGateStatuses.has(statusContracts.normalizeOrderStatus(item.order_status))
      && productionStartItemStatuses.has(item.status);
  }

  function isCancellationStopped(item) {
    return item?.status === ITEM_STATUS.CANCELLED || item?.cancelled_at != null || item?.production_stopped_at != null;
  }

  function sendCancellationStoppedError(res, item) {
    return res.status(409).json({
      error: 'production_stopped_by_cancellation',
      item_status: item?.status || null,
      order_status: item?.order_status || null,
    });
  }

  function sendProductionGateError(res, item) {
    return res.status(409).json({
      error: 'item_not_released_to_production',
      item_status: item?.status || null,
      order_status: item?.order_status || null,
    });
  }

  function forbiddenProductionPatchFields(body) {
    return Object.keys(body || {}).filter(key => forbiddenProductionItemPatchFields.has(key));
  }

  function parseWorkerCardToken(raw) {
    const token = String(raw || '').trim();
    if (!token) return null;
    const pipeParts = token.split('|');
    if (pipeParts.length >= 2 && /^\d+$/.test(pipeParts[1])) return { token, itemId: Number(pipeParts[1]) };
    if (/^\d+$/.test(token)) return { token, itemId: Number(token) };
    const match = token.match(/-(\d{1,12})(?:-[A-Z]+[A-Z0-9]*)*(?:-C\d+OF\d+)?$/i);
    return match ? { token, itemId: Number(match[1]) } : null;
  }

  function tokenMatchesItem(token, itemId) {
    const parsed = parseWorkerCardToken(token);
    return Boolean(parsed && Number(parsed.itemId) === Number(itemId));
  }

  function publicWorkerCardToken(req) {
    return req.query.card || req.body?.card || req.body?.scanToken || '';
  }

  function selectWorkerCardById(itemId) {
    const item = db.prepare(`
      SELECT i.id, i.pallet_id, i.shape_id, i.shape_name, i.diameter,
             i.quantity, i.produced_qty, i.total_weight AS weight, i.status, i.machine,
             i.actual_weight_kg, i.weight_deviation_pct,
             i.segments, i.shape_snapshot_json, i.spiral_diameter_mm, i.spiral_turns,
             i.total_length_mm, i.note, i.qc_status,
             p.order_id, p.pallet_num,
             o.order_num, o.priority, o.delivery_date, o.customer_id, o.status AS order_status,
             c.name as customer_name
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      LEFT JOIN customers c ON o.customer_id=c.id
      WHERE i.id=?
    `).get(itemId);
    if (item) item.shape_svg = productionCards.itemShapeSvg(item);
    return item;
  }

  function authorizePublicWorkerCard(req, res, itemId) {
    const token = publicWorkerCardToken(req);
    if (!tokenMatchesItem(token, itemId)) {
      res.status(403).json({ error: 'invalid_worker_card_token' });
      return null;
    }
    const item = db.prepare(`
      SELECT i.*, p.order_id, o.order_num, o.status AS order_status
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      WHERE i.id=?
    `).get(itemId);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return item;
  }

  function setOrderStatusIfChanged(orderId, nextStatus) {
    const order = db.prepare('SELECT id,order_num,status FROM orders WHERE id=?').get(orderId);
    if (!order) return null;
    if (statusContracts.normalizeOrderStatus(order.status) === nextStatus) return null;
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(nextStatus, order.id);
    wsBroadcast('order_status', { id: order.id, status: nextStatus, orderNum: order.order_num });
    return nextStatus;
  }

  function syncOrderStatusAfterItemStatus(item, nextItemStatus) {
    if (!item?.order_id) return null;
    const orderStatus = statusContracts.normalizeOrderStatus(item.order_status);
    if (nextItemStatus === ITEM_STATUS.IN_PRODUCTION && (
      orderStatus === ORDER_STATUS.APPROVED_WAITING_PRODUCTION ||
      orderStatus === ORDER_STATUS.PRODUCTION_QUEUE
    )) {
      return setOrderStatusIfChanged(item.order_id, ORDER_STATUS.IN_PRODUCTION);
    }
    if (nextItemStatus === ITEM_STATUS.DONE) {
      checkOrderComplete(item.order_id);
    }
    return null;
  }

  function consumeProductionReservations(item, actualWeightKg) {
    if (!item?.order_id || !item?.id) return { consumed: 0 };
    return consumeReservationsForProduction(db, {
      order_id: item.order_id,
      item_ids: [item.id],
      actual_weight_kg: actualWeightKg,
    });
  }

  function cardMaterialRequirement(card, reservationRows) {
    // The assembly card is a real production card but does not consume a fifth
    // material. Its live state is derived from its source item only.
    if (card.pile_card_type === 'pile_assembly') return null;
    const diameter = Number(card.diameter);
    if (!(diameter > 0)) return null;
    const matchingReservation = reservationRows.find(row => Number(row.diameter) === diameter);
    return {
      diameter,
      material_type: normalizeMaterialType(matchingReservation?.material_type),
      source: matchingReservation ? 'reservation' : 'default_coil',
    };
  }

  function liveCardState(card, materialRequirement) {
    const status = String(card.status || '');
    const requestedQty = Number(card.quantity || 0);
    const producedQty = Number(card.produced_qty || 0);
    if (status === ITEM_STATUS.DONE || status === ITEM_STATUS.DELIVERED || (requestedQty > 0 && producedQty >= requestedQty)) {
      return { code: 'completed', label: 'הושלם', tone: 'green' };
    }
    if (status === ITEM_STATUS.IN_PRODUCTION || producedQty > 0) {
      return { code: 'in_production', label: 'בייצור', tone: 'yellow' };
    }
    if (status === ITEM_STATUS.CANCELLED) {
      return { code: 'cancelled', label: 'בוטל', tone: 'gray' };
    }
    if (status === ITEM_STATUS.ON_HOLD) {
      return { code: 'on_hold', label: 'בהמתנה', tone: 'gray' };
    }
    if (!materialRequirement) {
      return { code: 'waiting_assembly', label: 'ממתין להרכבה', tone: 'gray' };
    }
    try {
      const position = calculateMaterialStockPosition(db, materialRequirement);
      if (Number(position.physicalStockKg) <= 0 || Number(position.availableKg) < 0) {
        return {
          code: 'material_shortage',
          label: 'חסר חומר גלם',
          tone: 'red',
          stock: position,
        };
      }
      return { code: 'waiting', label: 'ממתין לייצור', tone: 'gray', stock: position };
    } catch {
      // A malformed legacy item is not proof of a material shortage. Keep it
      // neutral instead of fabricating a stock conclusion.
      return { code: 'stock_unknown', label: 'ממתין לאימות חומר', tone: 'gray' };
    }
  }

  function liveProductionCardDto(card, reservationRowsByItem) {
    const parentItemId = Number(card.parent_item_id || card.id);
    const material = cardMaterialRequirement(card, reservationRowsByItem.get(parentItemId) || []);
    const state = liveCardState(card, material);
    return {
      card_key: card.card_key || `item-${parentItemId}`,
      item_id: parentItemId,
      card_type: card.pile_card_type || 'item',
      component_type: card.pile_component_type || null,
      title: card.shape_name || productionCards.itemHumanTitle(card),
      quantity: Number(card.quantity || 0),
      produced_quantity: Number(card.produced_qty || 0),
      diameter_mm: Number(card.diameter || 0) || null,
      total_weight_kg: Number(card.total_weight || 0),
      total_length_mm: Number(card.total_length_mm || 0),
      pallet_number: Number(card._palletNum || 0) || null,
      source_item_status: card.status || null,
      state,
      material: material ? {
        ...material,
        physical_stock_kg: state.stock?.physicalStockKg ?? null,
        reserved_kg: state.stock?.reservedKg ?? null,
        available_kg: state.stock?.availableKg ?? null,
        shortage_kg: state.stock?.shortageKg ?? null,
      } : null,
      shape_svg: card.shape_svg || productionCards.itemShapeSvg(card),
    };
  }

  // ── LIVE ORDER PRODUCTION SHEET ──────────────────────────────────
  // This read-only projection is the order-QR landing point. Production-card
  // status remains sourced from items; inventory status is calculated from the
  // existing verified-stock and active-reservation ledger.
  router.get('/production/orders/:orderId/live-sheet', requireAnyRole(['production', 'kiosk', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
    const order = db.prepare(`
      SELECT o.id,o.order_num,o.status,o.total_weight,o.delivery_date,c.name AS customer_name
      FROM orders o
      LEFT JOIN customers c ON c.id=o.customer_id
      WHERE o.id=?
    `).get(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    const sourceItems = db.prepare(`
      SELECT i.*, p.pallet_num AS _palletNum
      FROM items i
      JOIN pallets p ON p.id=i.pallet_id
      WHERE p.order_id=?
      ORDER BY p.pallet_num, i.id
    `).all(orderId);
    const reservationRowsByItem = new Map();
    const reservations = db.prepare(`
      SELECT item_id,diameter,material_type,reserved_kg
      FROM inventory_reservations
      WHERE order_id=? AND status='active' AND item_id IS NOT NULL
      ORDER BY id
    `).all(orderId);
    for (const reservation of reservations) {
      const itemId = Number(reservation.item_id);
      if (!reservationRowsByItem.has(itemId)) reservationRowsByItem.set(itemId, []);
      reservationRowsByItem.get(itemId).push(reservation);
    }

    const expandedCards = expandProductionCardsForOrder(sourceItems, tryParseJSON);
    const cards = expandedCards.map(card => liveProductionCardDto(card, reservationRowsByItem));
    const stateCounts = cards.reduce((counts, card) => {
      counts[card.state.code] = (counts[card.state.code] || 0) + 1;
      return counts;
    }, {});
    const role = String(req.userRole || req.auth?.role || '');
    const mayManageLoading = ['warehouse', 'manager', 'admin'].includes(role);
    const orderStatus = statusContracts.normalizeOrderStatus(order.status);
    const activeLoadingSession = db.prepare(`
      SELECT session_uid FROM order_loading_sessions WHERE order_id=? AND status='active'
    `).get(order.id);
    const loadingState = activeLoadingSession
      ? 'active'
      : orderStatus === ORDER_STATUS.DONE_WAITING_PICKUP
        ? 'ready_to_start'
        : orderStatus === ORDER_STATUS.PARTIAL_DELIVERY
          ? 'ready_for_next_truck'
        : orderStatus === ORDER_STATUS.LOADING
          ? 'ready_to_resume'
          : 'not_ready';
    const mayOpenLoading = mayManageLoading && loadingState !== 'not_ready';

    return res.json({
      order: {
        id: order.id,
        order_num: order.order_num,
        status: order.status,
        customer_name: order.customer_name || null,
        total_weight_kg: Number(order.total_weight || 0),
        delivery_date: order.delivery_date || null,
      },
      cards,
      state_counts: stateCounts,
      may_start_loading: mayOpenLoading,
      loading_state: loadingState,
      loading_entry_url: `/warehouse.html?load_order=${encodeURIComponent(order.id)}&autostart=1`,
    });
  });

  router.get('/workers', requireAnyRole(['production', 'office', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare('SELECT * FROM workers WHERE active=1 ORDER BY name').all());
  });

  router.post('/workers', requireRole('manager'), (req, res) => {
    const { name, role, language } = req.body;
    const r = db.prepare('INSERT INTO workers (name,role,language) VALUES (?,?,?)').run(name, role || 'ייצור', language || 'he');
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/workers/:id', requireRole('manager'), (req, res) => {
    const { name, role, language, active } = req.body;
    db.prepare('UPDATE workers SET name=?,role=?,language=?,active=? WHERE id=?').run(name, role, language, active ?? 1, req.params.id);
    res.json({ success: true });
  });

  router.use(createProductionMachinesRouter({
    db,
    requireAnyRole,
    requireRole,
    wsBroadcast,
    modbus,
    MACHINE_STATES,
    STATE_TRANSITIONS,
    checkOrderComplete,
  }));

  router.get('/worker-card', requireQrPermission('production'), (req, res) => {
    const parsed = parseWorkerCardToken(req.query.card);
    if (!parsed?.itemId) return res.status(400).json({ error: 'invalid_worker_card_token' });
    const item = selectWorkerCardById(parsed.itemId);
    if (!item) return res.status(404).json({ error: 'not_found' });
    workerCardActivity.record(req, item, 'opened', { source: 'worker_card_qr' });
    res.json({ items: [item], grouped: {} });
  });

  router.patch('/worker-card/:id/status', requireQrPermission('production'), (req, res) => {
    const status = req.body?.status;
    if (!statusContracts.isValidItemStatus(status)) return res.status(400).json({ error: 'invalid status', allowed: statusContracts.VALID_ITEM_STATUSES });
    if (![ITEM_STATUS.WAITING, ITEM_STATUS.IN_PRODUCTION, ITEM_STATUS.DONE, ITEM_STATUS.DELIVERED].includes(status)) {
      return res.status(400).json({ error: 'invalid public production status' });
    }
    const item = authorizePublicWorkerCard(req, res, req.params.id);
    if (!item) return;
    if (isCancellationStopped(item)) return sendCancellationStoppedError(res, item);
    if (status === ITEM_STATUS.IN_PRODUCTION && !isProductionGateOpen(item)) return sendProductionGateError(res, item);
    const updates = { status };
    if (status === ITEM_STATUS.IN_PRODUCTION && !item.started_at) updates.started_at = new Date().toISOString();
    if (status === ITEM_STATUS.DONE) updates.completed_at = new Date().toISOString();
    db.prepare(`UPDATE items SET status=?${status===ITEM_STATUS.IN_PRODUCTION&&!item.started_at?',started_at=?':''}${status===ITEM_STATUS.DONE?',completed_at=?':''} WHERE id=?`)
      .run(...Object.values(updates), req.params.id);
    workerCardActivity.record(req, item, 'status_changed', { from_status: item.status, to_status: status });
    const orderStatus = syncOrderStatusAfterItemStatus(item, status);
    const consumedReservations = status === ITEM_STATUS.DONE ? consumeProductionReservations(item) : { consumed: 0 };
    wsBroadcast('item_status', { id: Number(req.params.id), status });
    res.json({ ok: true, order_status: orderStatus, consumedReservations });
  });

  router.patch('/worker-card/:id', requireQrPermission('production'), (req, res) => {
    const forbiddenFields = forbiddenProductionPatchFields(req.body);
    if (forbiddenFields.length) {
      return res.status(400).json({ error: 'non_production_fields_forbidden', fields: forbiddenFields });
    }
    const item = authorizePublicWorkerCard(req, res, req.params.id);
    if (!item) return;
    if (isCancellationStopped(item)) return sendCancellationStoppedError(res, item);
    const { produced_qty, actual_weight_kg, note } = req.body || {};
    const fields = [], vals = [];
    let previousActualWeight = null;
    let nextItemStatus = null;
    function addStatusUpdate(nextStatus) {
      if (nextStatus === ITEM_STATUS.IN_PRODUCTION && !isProductionGateOpen(item)) {
        sendProductionGateError(res, item);
        return false;
      }
      fields.push('status=?'); vals.push(nextStatus); nextItemStatus = nextStatus;
      if (nextStatus === ITEM_STATUS.IN_PRODUCTION && !item.started_at) { fields.push('started_at=?'); vals.push(new Date().toISOString()); }
      if (nextStatus === ITEM_STATUS.DONE) { fields.push('completed_at=?'); vals.push(new Date().toISOString()); }
      return true;
    }
    if (produced_qty !== undefined) {
      const producedQty = Number(produced_qty);
      const requestedQty = Number(item.quantity) || 0;
      if (!Number.isFinite(producedQty) || producedQty < 0 || !Number.isInteger(producedQty)) return res.status(400).json({ error: 'invalid produced_qty' });
      if (requestedQty > 0 && producedQty > requestedQty) return res.status(400).json({ error: 'produced_qty_exceeds_quantity', quantity: requestedQty });
      fields.push('produced_qty=?'); vals.push(producedQty);
      if (requestedQty > 0 && producedQty >= requestedQty && item.status !== ITEM_STATUS.DONE) {
        if (!addStatusUpdate(ITEM_STATUS.DONE)) return;
      } else if (producedQty > 0 && item.status === ITEM_STATUS.WAITING) {
        if (!addStatusUpdate(ITEM_STATUS.IN_PRODUCTION)) return;
      }
    }
    if (actual_weight_kg !== undefined) {
      const actualWeight = Number(actual_weight_kg);
      if (!Number.isFinite(actualWeight) || actualWeight < 0) return res.status(400).json({ error: 'invalid actual_weight_kg' });
      previousActualWeight = Number(item.actual_weight_kg) || 0;
      const targetWeight = Number(item.total_weight) || 0;
      const deviationPct = targetWeight > 0 ? ((actualWeight - targetWeight) / targetWeight) * 100 : null;
      fields.push('actual_weight_kg=?'); vals.push(actualWeight);
      fields.push('weight_deviation_pct=?'); vals.push(deviationPct);
    }
    if (note !== undefined) { fields.push('note=?'); vals.push(note); }
    if (!fields.length) return res.json({ ok: true });
    vals.push(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE items SET ${fields.join(',')} WHERE id=?`).run(...vals);
      if (actual_weight_kg !== undefined) {
        productionActuals.recordActualWeightChange(db, {
          itemId: Number(req.params.id),
          orderId: item.order_id,
          beforeKg: previousActualWeight,
          afterKg: Number(actual_weight_kg),
          source: 'public_worker_card',
          metadata: { worker_card: true },
        });
      }
    })();
    if (nextItemStatus) {
      const savedItem = db.prepare(`
        SELECT i.*, p.order_id, o.order_num, o.status AS order_status
        FROM items i
        JOIN pallets p ON i.pallet_id=p.id
        JOIN orders o ON p.order_id=o.id
        WHERE i.id=?
      `).get(req.params.id);
      syncOrderStatusAfterItemStatus(savedItem, nextItemStatus);
      if (nextItemStatus === ITEM_STATUS.DONE) consumeProductionReservations(savedItem, actual_weight_kg);
      wsBroadcast('item_status', { id: Number(req.params.id), status: nextItemStatus });
    }
    if (produced_qty !== undefined) wsBroadcast('item_progress', { id: Number(req.params.id), produced_qty: Number(produced_qty) });
    workerCardActivity.record(req, item, 'updated', {
      from_status: item.status,
      to_status: nextItemStatus || item.status,
      produced_qty: produced_qty === undefined ? null : Number(produced_qty),
      actual_weight_kg: actual_weight_kg === undefined ? null : Number(actual_weight_kg),
      note_updated: note !== undefined,
    });
    res.json({ ok: true, status: nextItemStatus });
  });

  // ── SCAN (QR) ─────────────────────────────────────────────────────
  router.post('/scan', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const { qrData, machineId, workerId } = req.body;
    if (!qrData || !machineId) return res.status(400).json({ error: 'חסרים פרמטרים' });

    const [orderNum, itemId] = qrData.split('|');
    const itemIdNum = Number(itemId);
    const machineIdNum = Number(machineId);

    if (isNaN(itemIdNum)) return res.status(400).json({ error: 'QR לא תקין' });

    const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(machineIdNum);
    if (!machine) return res.status(404).json({ error: 'מכונה לא נמצאה' });

    const item = db.prepare(`
      SELECT i.*, p.order_id, o.status AS order_status
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      WHERE i.id=?
    `).get(itemIdNum);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (!isProductionGateOpen(item)) return sendProductionGateError(res, item);

    const now = new Date().toISOString();

    // Close previous item on this machine
    if (machine.current_item_id && machine.current_item_id !== itemIdNum) {
      const liveCounter = modbus.getState(machineIdNum)?.counter ?? machine.counter ?? 0;
      const prevItem = db.prepare('SELECT * FROM items WHERE id=?').get(machine.current_item_id);
      const actualWaste = Math.max(0, liveCounter - (prevItem?.quantity || 0));

      db.prepare('UPDATE items SET status=?,completed_at=?,produced_qty=?,actual_waste=? WHERE id=?')
        .run('הושלם', now, liveCounter, actualWaste, machine.current_item_id);

      db.prepare('INSERT INTO scan_log (machine_id,worker_id,item_id,order_num,action,counter_at_scan,waste_calculated) VALUES (?,?,?,?,?,?,?)')
        .run(machineIdNum, workerId, machine.current_item_id, machine.current_order_num, 'close_prev', liveCounter, actualWaste);

      const prevPallet = prevItem ? db.prepare('SELECT order_id FROM pallets WHERE id=?').get(prevItem.pallet_id) : null;
      if (prevPallet) {
        consumeProductionReservations({ ...prevItem, order_id: prevPallet.order_id });
        checkOrderComplete(prevPallet.order_id);
      }
    }

    // Start new item
    db.prepare('UPDATE items SET status=?,started_at=?,worker_id=? WHERE id=?')
      .run('בייצור', now, workerId, itemIdNum);
    db.prepare('UPDATE machines SET current_item_id=?,current_order_num=?,counter=0 WHERE id=?')
      .run(itemIdNum, orderNum, machineIdNum);

    // Auto-update order status to 'בייצור'
    db.prepare("UPDATE orders SET status='בייצור' WHERE id=? AND status IN ('בתור ייצור','ממתינה לאישור')")
      .run(item.order_id);

    // Send params to machine via Modbus
    const segments = productionCards.shapeSegmentsFromItem(item);
    const angles   = segments.slice(1).map(s => s.angle_deg || 0);
    modbus.writeParams(machineIdNum, {
      diameter:       productionCards.shapeDiameterFromItem(item) || item.diameter,
      totalLengthMm:  productionCards.shapeTotalLengthMmFromItem(item) ?? item.total_length_mm,
      productionQty:  item.production_qty || item.quantity,
      angles,
    }).catch(() => {}); // non-blocking

    db.prepare('INSERT INTO scan_log (machine_id,worker_id,item_id,order_num,action,counter_at_scan) VALUES (?,?,?,?,?,?)')
      .run(machineIdNum, workerId, itemIdNum, orderNum, 'start', 0);

    wsBroadcast('machine_assign', { machineId: machineIdNum, itemId: itemIdNum, orderNum, workerId });

    res.json({ success: true, item, orderNum, machineLabel: machine.label });
  });

  // End-of-day: close last item on machine
  router.post('/machines/:id/end-of-day', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const machineIdNum = Number(req.params.id);
    const { workerId } = req.body;
    const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(machineIdNum);
    if (!machine?.current_item_id) return res.json({ success: true, message: 'אין פריט פעיל' });

    const liveCounter = modbus.getState(machineIdNum)?.counter ?? machine.counter ?? 0;
    const prevItem    = db.prepare('SELECT * FROM items WHERE id=?').get(machine.current_item_id);
    const actualWaste = Math.max(0, liveCounter - (prevItem?.quantity || 0));

    db.prepare('UPDATE items SET status=?,completed_at=?,produced_qty=?,actual_waste=? WHERE id=?')
      .run('הושלם', new Date().toISOString(), liveCounter, actualWaste, machine.current_item_id);
    db.prepare('UPDATE machines SET current_item_id=NULL,current_order_num=NULL,counter=0 WHERE id=?').run(machineIdNum);

    db.prepare('INSERT INTO scan_log (machine_id,worker_id,item_id,order_num,action,counter_at_scan,waste_calculated) VALUES (?,?,?,?,?,?,?)')
      .run(machineIdNum, workerId, machine.current_item_id, machine.current_order_num, 'end_of_day', liveCounter, actualWaste);

    const prevPallet = prevItem ? db.prepare('SELECT order_id FROM pallets WHERE id=?').get(prevItem.pallet_id) : null;
    if (prevPallet) {
      consumeProductionReservations({ ...prevItem, order_id: prevPallet.order_id });
      checkOrderComplete(prevPallet.order_id);
    }

    wsBroadcast('end_of_day', { machineId: machineIdNum });
    res.json({ success: true, producedQty: liveCounter, actualWaste });
  });

  router.patch('/items/:id/status', requireAnyRole(['production', 'kiosk', 'manager', 'admin']), (req, res) => {
    const { status } = req.body;
    if (!statusContracts.isValidItemStatus(status)) return res.status(400).json({ error: 'invalid status', allowed: statusContracts.VALID_ITEM_STATUSES });
    const allowed = ['ממתין','בייצור','הושלם','סופק','בהמתנה','בוטל'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
    if (status === ITEM_STATUS.CANCELLED) {
      return res.status(409).json({ error: 'cancellation_review_required' });
    }
    const item = db.prepare(`
      SELECT i.*, p.order_id, o.order_num, o.status AS order_status
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      WHERE i.id=?
    `).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (isCancellationStopped(item)) return sendCancellationStoppedError(res, item);
    if (!productionWritableItemStatuses.has(status)) return res.status(400).json({ error: 'invalid production status' });
    if (status === ITEM_STATUS.IN_PRODUCTION && !isProductionGateOpen(item)) return sendProductionGateError(res, item);
    const updates = { status };
    if (status === ITEM_STATUS.IN_PRODUCTION && !item.started_at) updates.started_at = new Date().toISOString();
    if (status === ITEM_STATUS.DONE) updates.completed_at = new Date().toISOString();
    db.prepare(`UPDATE items SET status=?${status===ITEM_STATUS.IN_PRODUCTION&&!item.started_at?',started_at=?':''}${status===ITEM_STATUS.DONE?',completed_at=?':''} WHERE id=?`)
      .run(...Object.values(updates), req.params.id);
    const orderStatus = syncOrderStatusAfterItemStatus(item, status);
    const consumedReservations = status === ITEM_STATUS.DONE ? consumeProductionReservations(item) : { consumed: 0 };
    wsBroadcast('item_status', { id: Number(req.params.id), status });
    res.json({ ok: true, order_status: orderStatus, consumedReservations });
  });

  router.patch('/items/:id', requireAnyRole(['production', 'kiosk', 'warehouse', 'manager', 'admin']), (req, res) => {
    const forbiddenFields = forbiddenProductionPatchFields(req.body);
    if (forbiddenFields.length) {
      return res.status(400).json({ error: 'non_production_fields_forbidden', fields: forbiddenFields });
    }
    const { produced_qty, actual_waste, actual_weight_kg, note, status } = req.body;
    const fields = [], vals = [];
    let loadedItem = null;
    let nextItemStatus = null;
    let previousActualWeight = null;

    function loadProductionItem() {
      if (!loadedItem) {
        loadedItem = db.prepare(`
          SELECT i.*, p.order_id, o.order_num, o.status AS order_status
          FROM items i
          JOIN pallets p ON i.pallet_id=p.id
          JOIN orders o ON p.order_id=o.id
          WHERE i.id=?
        `).get(req.params.id);
      }
      return loadedItem;
    }

    function addStatusUpdate(item, nextStatus) {
      if (!statusContracts.isValidItemStatus(nextStatus) || !productionWritableItemStatuses.has(nextStatus)) {
        return false;
      }
      if (nextStatus === ITEM_STATUS.IN_PRODUCTION && !isProductionGateOpen(item)) {
        sendProductionGateError(res, item);
        return false;
      }
      if (nextStatus === ITEM_STATUS.DONE && item.status === ITEM_STATUS.WAITING && !isProductionGateOpen(item)) {
        sendProductionGateError(res, item);
        return false;
      }
      fields.push('status=?'); vals.push(nextStatus);
      nextItemStatus = nextStatus;
      if (nextStatus === ITEM_STATUS.IN_PRODUCTION && !item.started_at) {
        fields.push('started_at=?'); vals.push(new Date().toISOString());
      }
      if (nextStatus === ITEM_STATUS.DONE) {
        fields.push('completed_at=?'); vals.push(new Date().toISOString());
      }
      return true;
    }

    if (produced_qty !== undefined) {
      const item = loadProductionItem();
      if (!item) return res.status(404).json({ error: 'not found' });
      const producedQty = Number(produced_qty);
      const requestedQty = Number(item.quantity) || 0;
      if (!Number.isFinite(producedQty) || producedQty < 0 || !Number.isInteger(producedQty)) {
        return res.status(400).json({ error: 'invalid produced_qty' });
      }
      if (requestedQty > 0 && producedQty > requestedQty) {
        return res.status(400).json({ error: 'produced_qty_exceeds_quantity', quantity: requestedQty });
      }
      fields.push('produced_qty=?'); vals.push(producedQty);

      if (status === undefined) {
        if (requestedQty > 0 && producedQty >= requestedQty && item.status !== ITEM_STATUS.DONE) {
          if (!addStatusUpdate(item, ITEM_STATUS.DONE)) return;
        } else if (producedQty > 0 && item.status === ITEM_STATUS.WAITING) {
          if (!addStatusUpdate(item, ITEM_STATUS.IN_PRODUCTION)) return;
        }
      }
    }
    if (actual_waste !== undefined) { fields.push('actual_waste=?'); vals.push(actual_waste); }
    if (actual_weight_kg !== undefined) {
      const actualWeight = Number(actual_weight_kg);
      if (!Number.isFinite(actualWeight) || actualWeight < 0) return res.status(400).json({ error: 'invalid actual_weight_kg' });
      const item = loadProductionItem();
      if (!item) return res.status(404).json({ error: 'not found' });
      previousActualWeight = Number(item.actual_weight_kg) || 0;
      const targetWeight = Number(item.total_weight) || 0;
      const deviationPct = targetWeight > 0 ? ((actualWeight - targetWeight) / targetWeight) * 100 : null;
      fields.push('actual_weight_kg=?'); vals.push(actualWeight);
      fields.push('weight_deviation_pct=?'); vals.push(deviationPct);
    }
    if (note !== undefined) { fields.push('note=?'); vals.push(note); }
    if (status !== undefined) {
      const item = loadProductionItem();
      if (!item) return res.status(404).json({ error: 'not found' });
      if (!addStatusUpdate(item, status)) return;
    }
    if (!fields.length) return res.json({ ok: true });
    const cancellationCheckItem = loadProductionItem();
    if (!cancellationCheckItem) return res.status(404).json({ error: 'not found' });
    if (isCancellationStopped(cancellationCheckItem)) return sendCancellationStoppedError(res, cancellationCheckItem);
    vals.push(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE items SET ${fields.join(',')} WHERE id=?`).run(...vals);
      if (actual_weight_kg !== undefined) {
        productionActuals.recordActualWeightChange(db, {
          itemId: Number(req.params.id),
          orderId: loadedItem?.order_id,
          beforeKg: previousActualWeight,
          afterKg: Number(actual_weight_kg),
          source: 'production_item_patch',
          actorId: req.auth?.sub || null,
          metadata: { status: nextItemStatus || loadedItem?.status || null },
        });
      }
    })();

    const savedItem = nextItemStatus ? db.prepare(`
      SELECT i.*, p.order_id, o.order_num, o.status AS order_status
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      WHERE i.id=?
    `).get(req.params.id) : null;
    const orderStatus = savedItem ? syncOrderStatusAfterItemStatus(savedItem, nextItemStatus) : null;
    const consumedReservations = savedItem && nextItemStatus === ITEM_STATUS.DONE
      ? consumeProductionReservations(savedItem, actual_weight_kg)
      : { consumed: 0 };
    if (nextItemStatus) wsBroadcast('item_status', { id: Number(req.params.id), status: nextItemStatus });
    if (produced_qty !== undefined) wsBroadcast('item_progress', { id: Number(req.params.id), produced_qty: Number(produced_qty) });
    res.json({ ok: true, order_status: orderStatus, status: nextItemStatus, consumedReservations });
  });

  // ── PRODUCTION QUEUE ──────────────────────────────────────────────
  // Returns pending items grouped and sorted by machine, diameter priority
  router.get('/production-queue', requireAnyRole(['production', 'kiosk', 'office', 'manager', 'admin']), (req, res) => {
    const { machine } = req.query;
    const visibleItemStatuses = req.query.visual === '1'
      ? "('ממתין','בייצור','הושלם','סופק')"
      : "('ממתין','בייצור')";
    const visibleOrderStatuses = req.query.visual === '1'
      ? "('אושרה – ממתין לייצור','בתור ייצור','בייצור','הושלם – ממתין לאיסוף','נשלחה','סופק – אושר')"
      : "('אושרה – ממתין לייצור','בתור ייצור','בייצור')";
    let q = `
      SELECT i.id, i.pallet_id, i.shape_id, i.shape_name, i.diameter,
             i.quantity, i.produced_qty, i.total_weight AS weight, i.status, i.machine,
             i.actual_weight_kg, i.weight_deviation_pct,
             i.segments, i.shape_snapshot_json, i.spiral_diameter_mm, i.spiral_turns,
             i.total_length_mm, i.note, i.qc_status,
             p.order_id, p.pallet_num,
             o.order_num, o.priority, o.delivery_date, o.customer_id, o.status AS order_status,
             c.name as customer_name,
             COALESCE(o.priority='דחוף',0)*100 +
             COALESCE(JULIANDAY('now') - JULIANDAY(o.delivery_date), 0)*10 as priority_score
      FROM items i
      JOIN pallets p ON i.pallet_id=p.id
      JOIN orders o ON p.order_id=o.id
      LEFT JOIN customers c ON o.customer_id=c.id
      WHERE i.status IN ${visibleItemStatuses}
      AND o.status IN ${visibleOrderStatuses}
    `;
    const params = [];
    if (machine) { q += ' AND i.machine=?'; params.push(machine); }
    q += ' ORDER BY i.machine, priority_score DESC, o.delivery_date ASC, i.diameter ASC';
    const items = db.prepare(q).all(...params);
    items.forEach(item => { item.shape_svg = productionCards.itemShapeSvg(item); });

    // Group by machine
    const grouped = {};
    for (const item of items) {
      const key = item.machine || 'לא שויך';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    }
    res.json({ items, grouped });
  });

  // ── PRODUCTION EVENTS ─────────────────────────────────────────────
  router.get('/production-events', requireAnyRole(['production', 'maintenance', 'manager', 'admin']), (req, res) => {
    const { machine_id, event_type, limit = 100 } = req.query;
    let q = `SELECT pe.*, m.name as machine_name, u.display_name as operator_name
             FROM production_events pe
             LEFT JOIN machines m ON pe.machine_id=m.id
             LEFT JOIN users u ON pe.operator_id=u.id`;
    const wheres = [], params = [];
    if (machine_id)  { wheres.push('pe.machine_id=?');  params.push(machine_id); }
    if (event_type)  { wheres.push('pe.event_type=?');  params.push(event_type); }
    if (wheres.length) q += ' WHERE ' + wheres.join(' AND ');
    q += ' ORDER BY pe.created_at DESC LIMIT ?';
    params.push(Number(limit));
    res.json(db.prepare(q).all(...params));
  });

  return router;
};

module.exports.manifest = {
  id: 'production',
  label: 'ייצור',
  screens: [
    { id: 'production-queue',  path: '/production-queue.html',  label: 'תור ייצור',      icon: '🏭', group: 'ייצור' },
    { id: 'worker-visual',     path: '/worker-visual.html',     label: 'דשבורד איסוף',   icon: '🧾', group: 'ייצור' },
    { id: 'kiosk',             path: '/kiosk.html',             label: 'תחנת עבודה',     icon: '🖥️', group: 'ייצור' },
    { id: 'production-setup',  path: '/production-setup.html',  label: 'הגדרות ייצור',   icon: '⚙️', group: 'ייצור' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'edit', kiosk: 'edit' },
  },
  consumes: [{ event: 'new_order' }, { event: 'order_status' }, { table: 'items' }, { table: 'machines' }],
  produces: [
    { event: 'machine_assign' },
    { event: 'end_of_day' },
    { event: 'item_status' },
    { event: 'item_progress' },
    { event: 'order_complete' },
  ],
};

