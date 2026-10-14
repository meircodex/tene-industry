const router = require('express').Router();
const { itemShapeMetrics } = require('../services/shapeSnapshot');
const {
  normalizeToken,
  scannedWorkerCardToken,
  tokenItemId,
  projectOrderCards,
  findProjectedCardByToken,
} = require('../services/productionCardLoading');
const { ORDER_STATUS, normalizeOrderStatus } = require('../status-contracts');

function required(name, value) {
  if (!value) throw new Error(`routes/warehouse missing dependency: ${name}`);
  return value;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function itemIdsList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && id > 0);
}

function placeholders(count) {
  return Array(count).fill('?').join(',');
}

function packageMetricsFromItems(db, itemIds) {
  const ids = itemIdsList(itemIds);
  if (!ids.length) return { itemIds: [], quantity: 0, weight: 0, diameter: null };

  const rows = db.prepare(`SELECT * FROM items WHERE id IN (${placeholders(ids.length)})`).all(...ids);
  const diameterSet = new Set();
  const totals = rows.reduce((acc, item) => {
    const metrics = itemShapeMetrics(item);
    const quantity = positiveNumberOrNull(metrics.quantity) || positiveNumberOrNull(item.quantity) || 0;
    const weight = positiveNumberOrNull(metrics.totalWeightKg) || positiveNumberOrNull(item.total_weight) || 0;
    const diameter = positiveNumberOrNull(item.diameter);
    if (diameter) diameterSet.add(String(diameter));
    acc.quantity += quantity;
    acc.weight += weight;
    return acc;
  }, { quantity: 0, weight: 0 });

  return {
    itemIds: ids,
    quantity: totals.quantity,
    weight: Math.round(totals.weight * 1000) / 1000,
    diameter: diameterSet.size === 1 ? Array.from(diameterSet)[0] : null,
  };
}

function deliveryNoteWeightFromPayload({ packagesJson = [], itemsJson = [] } = {}) {
  const packageWeight = Array.isArray(packagesJson)
    ? packagesJson.reduce((sum, pkg) => sum + (positiveNumberOrNull(pkg && pkg.weight) || 0), 0)
    : 0;
  if (packageWeight > 0) return Math.round(packageWeight * 1000) / 1000;

  const itemWeight = Array.isArray(itemsJson)
    ? itemsJson.reduce((sum, item) => {
        const metrics = itemShapeMetrics(item || {});
        return sum + (positiveNumberOrNull(metrics.totalWeightKg) || positiveNumberOrNull(item && item.total_weight) || 0);
      }, 0)
    : 0;
  return Math.round(itemWeight * 1000) / 1000;
}

function loadingSessionUid() {
  return `LOAD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
}

function loadingActorId(req) {
  const value = Number(req.userId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function safeJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scannedPackageCode(rawValue) {
  let value = String(rawValue == null ? '' : rawValue).trim();
  if (!value || value.length > 512) return '';

  // Package labels currently encode the package code directly.  Accept the
  // existing JSON `qr_data` form as well, without treating a production-card
  // QR as a package label.
  if (value.startsWith('{')) {
    try {
      const decoded = JSON.parse(value);
      value = String(decoded && (decoded.code || decoded.package_code) || '').trim();
    } catch (_) {
      return '';
    }
  }
  return value.toUpperCase();
}

function loadingSessionState(db, sessionUid) {
  const session = db.prepare(`
    SELECT id, session_uid, order_id, order_num, status, expected_count,
           expected_weight, started_by, started_at, completed_by, completed_at,
           departure_type, departure_reason, delivery_note_id
    FROM order_loading_sessions WHERE session_uid=?
  `).get(sessionUid);
  if (!session) return null;

  const packages = db.prepare(`
    SELECT package_id, package_code, quantity, weight, state, loaded_by, loaded_at
    FROM order_loading_session_packages
    WHERE session_id=?
    ORDER BY id
  `).all(session.id);
  const loaded = packages.filter(row => row.state === 'loaded');
  const missing = packages.filter(row => row.state !== 'loaded');
  return {
    ...session,
    packages,
    loaded_count: loaded.length,
    loaded_weight: Math.round(loaded.reduce((sum, row) => sum + Number(row.weight || 0), 0) * 1000) / 1000,
    missing_count: missing.length,
    missing_weight: Math.round(missing.reduce((sum, row) => sum + Number(row.weight || 0), 0) * 1000) / 1000,
  };
}

function addLoadingEvent(db, { sessionId, type, packageId = null, scannedValue = null, actorId = null, details = {} }) {
  db.prepare(`
    INSERT INTO order_loading_events (session_id,event_type,package_id,scanned_value,actor_id,details_json)
    VALUES (?,?,?,?,?,?)
  `).run(sessionId, type, packageId, scannedValue, actorId, safeJson(details));
}

function addOrderLoadingStatusAudit(db, { order, from, to, actorId, note }) {
  db.prepare(`
    INSERT INTO audit_log (entity_type,entity_id,entity_ref,action,field_name,old_value,new_value,notes,user_id,user_name)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    'order',
    order.id,
    order.order_num,
    'status_change',
    'status',
    from,
    to,
    note,
    actorId,
    null,
  );
}

function eligibleOrderPackages(db, orderId) {
  return db.prepare(`
    SELECT id, package_code, item_ids, quantity, weight
    FROM packages
    WHERE order_id=? AND status IN ('packed','ready','staged')
    ORDER BY id
  `).all(orderId);
}

function sessionLoadedPackages(db, sessionId) {
  return db.prepare(`
    SELECT package_id, package_code, item_ids_json, quantity, weight
    FROM order_loading_session_packages
    WHERE session_id=? AND state='loaded'
    ORDER BY id
  `).all(sessionId);
}

function linkedDeliveryNote(db, deliveryNoteId) {
  const id = Number(deliveryNoteId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const note = db.prepare('SELECT id,note_num,total_weight FROM delivery_notes WHERE id=?').get(id);
  return note ? { ...note, print_url: `/api/delivery-notes/${note.id}/print` } : null;
}

// A note is created from the packages actually on this truck, not from the
// complete order. The session id makes the note reference deterministic and
// protects a retry from issuing a second note for the same departure.
function createLoadingDeliveryNote(db, { session, departureType, departureReason = null }) {
  const existing = Number(session.delivery_note_id);
  if (Number.isInteger(existing) && existing > 0) {
    return linkedDeliveryNote(db, existing);
  }

  const packages = sessionLoadedPackages(db, session.id);
  if (!packages.length) {
    const error = new Error('no_loaded_packages');
    error.statusCode = 409;
    throw error;
  }

  const packageSnapshot = packages.map(row => ({
    id: row.package_id,
    package_code: row.package_code,
    item_ids: (() => { try { return JSON.parse(row.item_ids_json || '[]'); } catch (_) { return []; } })(),
    quantity: Number(row.quantity || 0),
    weight: Number(row.weight || 0),
  }));
  const itemIds = [...new Set(packageSnapshot.flatMap(row => itemIdsList(row.item_ids)))];
  const items = itemIds.length
    ? db.prepare(`SELECT * FROM items WHERE id IN (${placeholders(itemIds.length)}) ORDER BY id`).all(...itemIds)
    : [];
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const noteNum = `DN-${dateStr}-L${session.id}`;
  const totalWeight = deliveryNoteWeightFromPayload({ packagesJson: packageSnapshot, itemsJson: items });
  const inserted = db.prepare(`
    INSERT INTO delivery_notes (note_num,order_id,order_num,customer_id,packages_json,items_json,total_weight)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    noteNum,
    session.order_id,
    session.order_num,
    session.customer_id || null,
    JSON.stringify(packageSnapshot),
    JSON.stringify(items),
    totalWeight,
  );
  const noteId = Number(inserted.lastInsertRowid);
  db.prepare(`
    UPDATE order_loading_sessions
    SET delivery_note_id=?,departure_type=?,departure_reason=?
    WHERE id=? AND delivery_note_id IS NULL
  `).run(noteId, departureType, departureReason || null, session.id);
  return {
    id: noteId,
    note_num: noteNum,
    total_weight: totalWeight,
    print_url: `/api/delivery-notes/${noteId}/print`,
  };
}

function cardLoadingSessionState(db, sessionUid) {
  const session = db.prepare(`
    SELECT id, session_uid, order_id, order_num, status, expected_count,
           expected_weight, started_by, started_at, completed_by, completed_at,
           departure_type, departure_reason, delivery_note_id, scan_unit
    FROM order_loading_sessions
    WHERE session_uid=? AND scan_unit='production_card'
  `).get(sessionUid);
  if (!session) return null;

  const cards = db.prepare(`
    SELECT card_key, worker_card_token, parent_item_id, title, quantity, weight,
           diameter_mm, total_length_mm, state, loaded_by, loaded_at
    FROM order_loading_session_cards
    WHERE session_id=?
    ORDER BY id
  `).all(session.id);
  const loaded = cards.filter(card => card.state === 'loaded');
  const pending = cards.filter(card => card.state !== 'loaded');
  return {
    ...session,
    cards,
    loaded_count: loaded.length,
    loaded_weight: Math.round(loaded.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
    missing_count: pending.length,
    missing_weight: Math.round(pending.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
  };
}

function addCardLoadingEvent(db, { sessionId, type, cardKey = null, scannedValue = null, actorId = null, details = {} }) {
  db.prepare(`
    INSERT INTO order_loading_card_events (session_id,event_type,card_key,scanned_value,actor_id,details_json)
    VALUES (?,?,?,?,?,?)
  `).run(sessionId, type, cardKey, scannedValue, actorId, safeJson(details));
}

function completedCardKeysForOrder(db, orderId) {
  return new Set(db.prepare(`
    SELECT DISTINCT c.card_key
    FROM order_loading_session_cards c
    JOIN order_loading_sessions s ON s.id=c.session_id
    WHERE s.order_id=? AND s.scan_unit='production_card' AND s.status='completed' AND c.state='loaded'
  `).all(orderId).map(row => String(row.card_key)));
}

function sourceOrderForCardToken(db, token) {
  const itemId = tokenItemId(token);
  if (!itemId) return null;
  return db.prepare(`
    SELECT o.id,o.order_num,o.status,o.customer_id
    FROM items i
    JOIN pallets p ON p.id=i.pallet_id
    JOIN orders o ON o.id=p.order_id
    WHERE i.id=?
  `).get(itemId) || null;
}

function loadingCardSnapshot(row) {
  return {
    card_key: row.card_key,
    worker_card_token: row.worker_card_token,
    parent_item_id: Number(row.parent_item_id),
    title: row.title,
    quantity: Number(row.quantity || 0),
    weight: Number(row.weight || 0),
    diameter_mm: Number(row.diameter_mm || 0) || null,
    total_length_mm: Number(row.total_length_mm || 0) || null,
  };
}

function sessionLoadedCards(db, sessionId) {
  return db.prepare(`
    SELECT card_key,worker_card_token,parent_item_id,title,quantity,weight,diameter_mm,total_length_mm
    FROM order_loading_session_cards
    WHERE session_id=? AND state='loaded'
    ORDER BY id
  `).all(sessionId).map(loadingCardSnapshot);
}

// A delivery note is a truck snapshot, not a second production or packing
// record.  Its `items_json` carries only the cards actually scanned onto this
// truck and is immutable once written.
function createCardLoadingDeliveryNote(db, { session, departureType, departureReason = null }) {
  const existing = Number(session.delivery_note_id);
  if (Number.isInteger(existing) && existing > 0) return linkedDeliveryNote(db, existing);

  const cards = sessionLoadedCards(db, session.id);
  if (!cards.length) {
    const error = new Error('no_loaded_cards');
    error.statusCode = 409;
    throw error;
  }
  const noteNum = `DN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-L${session.id}`;
  const totalWeight = Math.round(cards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000;
  const inserted = db.prepare(`
    INSERT INTO delivery_notes (note_num,order_id,order_num,customer_id,packages_json,items_json,total_weight)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    noteNum,
    session.order_id,
    session.order_num,
    session.customer_id || null,
    JSON.stringify([]),
    JSON.stringify(cards.map(card => ({ ...card, loading_card: true }))),
    totalWeight,
  );
  const noteId = Number(inserted.lastInsertRowid);
  db.prepare(`
    UPDATE order_loading_sessions
    SET delivery_note_id=?,departure_type=?,departure_reason=?
    WHERE id=? AND delivery_note_id IS NULL
  `).run(noteId, departureType, departureReason || null, session.id);
  return { id: noteId, note_num: noteNum, total_weight: totalWeight, print_url: `/api/delivery-notes/${noteId}/print` };
}

function eligibleProductionCardsForLoading(db, order) {
  const alreadyLoaded = completedCardKeysForOrder(db, order.id);
  const remainingFinalCards = projectOrderCards(db, order)
    .filter(card => card.final_deliverable && !alreadyLoaded.has(card.card_key));
  return {
    cards: remainingFinalCards.filter(card => card.completed),
    incomplete: remainingFinalCards.filter(card => !card.completed),
  };
}

function normalizedDestination(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('he-IL');
}

function multiOrderLoadingState(db, groupUid) {
  const sessions = db.prepare(`
    SELECT s.id,s.session_uid,s.loading_group_uid,s.order_id,s.order_num,s.status,
           s.expected_count,s.expected_weight,s.started_by,s.started_at,
           s.completed_by,s.completed_at,s.departure_type,s.departure_reason,
           s.delivery_note_id,o.customer_id,o.status AS order_status,o.delivery_address
    FROM order_loading_sessions s
    JOIN orders o ON o.id=s.order_id
    WHERE s.loading_group_uid=? AND s.scan_unit='production_card'
    ORDER BY s.id
  `).all(groupUid);
  if (!sessions.length) return null;
  const cards = db.prepare(`
    SELECT c.id,c.session_id,c.card_key,c.worker_card_token,c.parent_item_id,c.title,
           c.quantity,c.weight,c.diameter_mm,c.total_length_mm,c.state,c.loaded_by,c.loaded_at,
           s.order_id,s.order_num
    FROM order_loading_session_cards c
    JOIN order_loading_sessions s ON s.id=c.session_id
    WHERE s.loading_group_uid=? AND s.scan_unit='production_card'
    ORDER BY s.id,c.id
  `).all(groupUid);
  const loaded = cards.filter(card => card.state === 'loaded');
  const pending = cards.filter(card => card.state !== 'loaded');
  const completed = sessions.every(session => session.status === 'completed');
  const noteIds = [...new Set(sessions.map(session => Number(session.delivery_note_id)).filter(id => id > 0))];
  return {
    multi_order: true,
    group_uid: groupUid,
    session_uid: groupUid,
    status: completed ? 'completed' : 'active',
    order_id: null,
    order_num: sessions.map(session => session.order_num).join(' + '),
    order_count: sessions.length,
    customer_id: sessions[0].customer_id || null,
    delivery_address: sessions[0].delivery_address || null,
    orders: sessions.map(session => ({
      id: session.order_id,
      order_num: session.order_num,
      status: session.order_status,
      expected_count: session.expected_count,
      expected_weight: session.expected_weight,
    })),
    sessions,
    cards,
    expected_count: cards.length,
    expected_weight: Math.round(cards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
    loaded_count: loaded.length,
    loaded_weight: Math.round(loaded.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
    missing_count: pending.length,
    missing_weight: Math.round(pending.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
    departure_type: sessions[0].departure_type || null,
    departure_reason: sessions[0].departure_reason || null,
    delivery_note_id: noteIds.length === 1 ? noteIds[0] : null,
  };
}

function createMultiOrderDeliveryNote(db, { state, departureType, departureReason = null }) {
  if (state.delivery_note_id) return linkedDeliveryNote(db, state.delivery_note_id);
  const loadedCards = state.cards.filter(card => card.state === 'loaded').map(card => ({
    ...loadingCardSnapshot(card),
    order_id: Number(card.order_id),
    order_num: card.order_num,
    loading_card: true,
  }));
  if (!loadedCards.length) {
    const error = new Error('no_loaded_cards');
    error.statusCode = 409;
    throw error;
  }
  const includedOrderIds = [...new Set(loadedCards.map(card => card.order_id))];
  const includedSessions = state.sessions.filter(session => includedOrderIds.includes(Number(session.order_id)));
  const noteNum = `DN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-G${state.sessions[0].id}`;
  const totalWeight = Math.round(loadedCards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000;
  const orderNumbers = includedSessions.map(session => session.order_num).join(' + ');
  const inserted = db.prepare(`
    INSERT INTO delivery_notes (note_num,order_id,order_num,customer_id,packages_json,items_json,total_weight)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    noteNum,
    includedSessions[0].order_id,
    orderNumbers,
    state.customer_id || null,
    JSON.stringify([]),
    JSON.stringify(loadedCards),
    totalWeight,
  );
  const noteId = Number(inserted.lastInsertRowid);
  const addOrder = db.prepare(`
    INSERT INTO delivery_note_orders
      (delivery_note_id,order_id,order_num,customer_id,items_json,total_weight)
    VALUES (?,?,?,?,?,?)
  `);
  for (const session of includedSessions) {
    const orderCards = loadedCards.filter(card => card.order_id === Number(session.order_id));
    const orderWeight = Math.round(orderCards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000;
    addOrder.run(noteId, session.order_id, session.order_num, state.customer_id || null, JSON.stringify(orderCards), orderWeight);
  }
  db.prepare(`
    UPDATE order_loading_sessions
    SET delivery_note_id=?,departure_type=?,departure_reason=?
    WHERE loading_group_uid=? AND delivery_note_id IS NULL
  `).run(noteId, departureType, departureReason || null, state.group_uid);
  return { id: noteId, note_num: noteNum, total_weight: totalWeight, print_url: `/api/delivery-notes/${noteId}/print` };
}

module.exports = function createWarehouseRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireApprovedDevice = required('requireApprovedDevice', deps.requireApprovedDevice);
  const requireQrPermission = required('requireQrPermission', deps.requireQrPermission);
  const qrAccess = required('qrAccess', deps.qrAccess);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  // ── MULTI-ORDER CARD LOADING ──────────────────────────────────────
  // A truck may carry several orders, but one delivery note is valid only
  // when every selected order belongs to the same customer and destination.
  // Each order still owns its frozen card session; loading_group_uid is the
  // additive link that makes scanning and departure atomic across the truck.
  router.get('/loading/multi-order-candidates', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT o.id,o.order_num,o.status,o.customer_id,o.delivery_address,o.total_weight,
             c.name AS customer_name
      FROM orders o
      LEFT JOIN customers c ON c.id=o.customer_id
      WHERE o.status IN (?,?,?)
      ORDER BY c.name,o.delivery_address,o.order_num
      LIMIT 200
    `).all(ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY);
    const candidates = [];
    for (const order of rows) {
      const active = db.prepare(`SELECT loading_group_uid,session_uid FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(order.id);
      if (active) continue;
      const availability = eligibleProductionCardsForLoading(db, order);
      if (availability.incomplete.length || !availability.cards.length) continue;
      candidates.push({
        id: order.id,
        order_num: order.order_num,
        customer_id: order.customer_id,
        customer_name: order.customer_name || 'ללא לקוח',
        delivery_address: order.delivery_address || '',
        status: order.status,
        card_count: availability.cards.length,
        total_weight: Math.round(availability.cards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000,
      });
    }
    res.json(candidates);
  });

  router.post('/loading/multi-order-card-sessions', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const orderIds = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : [])
      .map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (orderIds.length < 2 || orderIds.length > 20) return res.status(400).json({ error: 'multi_order_selection_requires_2_to_20_orders' });
    const actorId = loadingActorId(req);
    try {
      const result = db.transaction(() => {
        const orders = db.prepare(`
          SELECT id,order_num,status,customer_id,delivery_address,total_weight
          FROM orders WHERE id IN (${placeholders(orderIds.length)}) ORDER BY id
        `).all(...orderIds);
        if (orders.length !== orderIds.length) return { error: 'order_not_found', status: 404 };
        const customerIds = new Set(orders.map(order => Number(order.customer_id) || null));
        if (customerIds.size !== 1 || [...customerIds][0] == null) return { error: 'multi_order_customer_mismatch', status: 409 };
        const destinations = new Set(orders.map(order => normalizedDestination(order.delivery_address)));
        if (destinations.size !== 1) return { error: 'multi_order_destination_mismatch', status: 409 };

        const activeSessions = db.prepare(`
          SELECT order_id,loading_group_uid,session_uid FROM order_loading_sessions
          WHERE order_id IN (${placeholders(orderIds.length)}) AND status='active'
        `).all(...orderIds);
        if (activeSessions.length) {
          const groups = [...new Set(activeSessions.map(row => row.loading_group_uid).filter(Boolean))];
          if (activeSessions.length === orders.length && groups.length === 1) {
            return { resumed: true, group_uid: groups[0], status: 200, changed_orders: [] };
          }
          return { error: 'order_already_in_loading', status: 409 };
        }

        const snapshots = [];
        for (const order of orders) {
          const normalizedStatus = normalizeOrderStatus(order.status);
          if (![ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY].includes(normalizedStatus)) {
            return { error: 'order_not_ready_for_loading', status: 409, order_num: order.order_num };
          }
          const availability = eligibleProductionCardsForLoading(db, order);
          if (availability.incomplete.length) return { error: 'production_cards_not_completed', status: 409, order_num: order.order_num };
          if (!availability.cards.length) return { error: 'no_completed_cards_to_load', status: 409, order_num: order.order_num };
          snapshots.push({ order, normalizedStatus, cards: availability.cards });
        }

        const groupUid = loadingSessionUid().replace(/^LOAD-/, 'MLOAD-');
        const addCard = db.prepare(`
          INSERT INTO order_loading_session_cards
            (session_id,card_key,worker_card_token,parent_item_id,title,quantity,weight,diameter_mm,total_length_mm)
          VALUES (?,?,?,?,?,?,?,?,?)
        `);
        const changedOrders = [];
        for (const snapshot of snapshots) {
          const { order, normalizedStatus, cards } = snapshot;
          if (normalizedStatus !== ORDER_STATUS.LOADING) {
            db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.LOADING, order.id);
            addOrderLoadingStatusAudit(db, { order, from: order.status, to: ORDER_STATUS.LOADING, actorId, note: `תחילת העמסה משותפת ${groupUid}` });
            changedOrders.push({ id: order.id, order_num: order.order_num });
          }
          const expectedWeight = Math.round(cards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000;
          const created = db.prepare(`
            INSERT INTO order_loading_sessions
              (session_uid,order_id,order_num,expected_count,expected_weight,started_by,scan_unit,loading_group_uid)
            VALUES (?,?,?,?,?,?, 'production_card',?)
          `).run(`${groupUid}-${order.id}`, order.id, order.order_num, cards.length, expectedWeight, actorId, groupUid);
          const sessionId = Number(created.lastInsertRowid);
          for (const card of cards) {
            addCard.run(sessionId, card.card_key, normalizeToken(card.worker_card_token), card.parent_item_id, card.title,
              Number(card.quantity || 0), Number(card.weight || 0), card.diameter_mm, card.total_length_mm);
          }
          addCardLoadingEvent(db, {
            sessionId,
            type: 'started',
            actorId,
            details: { loading_group_uid: groupUid, expected_count: cards.length, expected_weight: expectedWeight, source: 'multi_order_selector' },
          });
        }
        return { resumed: false, group_uid: groupUid, status: 201, changed_orders: changedOrders };
      })();
      if (result.error) return res.status(result.status).json({ error: result.error, order_num: result.order_num || null });
      for (const order of result.changed_orders) wsBroadcast('order_status', { id: order.id, status: ORDER_STATUS.LOADING, orderNum: order.order_num });
      return res.status(result.status).json({ ...multiOrderLoadingState(db, result.group_uid), resumed: result.resumed });
    } catch (error) {
      if (/idx_loading_session_one_active_order|UNIQUE constraint failed/i.test(String(error.message || ''))) {
        return res.status(409).json({ error: 'order_already_in_loading' });
      }
      throw error;
    }
  });

  router.get('/loading/multi-order-card-sessions/:groupUid', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const state = multiOrderLoadingState(db, String(req.params.groupUid || ''));
    if (!state) return res.status(404).json({ error: 'multi_order_loading_session_not_found' });
    res.json(state);
  });

  router.post('/loading/multi-order-card-sessions/:groupUid/scan', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const token = scannedWorkerCardToken(req.body?.qr_data ?? req.body?.code);
    if (!token) return res.status(400).json({ error: 'invalid_worker_card_qr' });
    const actorId = loadingActorId(req);
    const groupUid = String(req.params.groupUid || '');
    const result = db.transaction(() => {
      const state = multiOrderLoadingState(db, groupUid);
      if (!state) return { error: 'multi_order_loading_session_not_found', status: 404 };
      if (state.status !== 'active' || state.sessions.some(session => session.status !== 'active')) return { error: 'loading_session_not_active', status: 409 };
      if (state.sessions.some(session => normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING)) return { error: 'order_not_in_loading', status: 409 };
      const expected = state.cards.find(card => normalizeToken(card.worker_card_token) === token);
      if (!expected) {
        const scannedOrder = sourceOrderForCardToken(db, token);
        const eventSession = scannedOrder
          ? state.sessions.find(session => Number(session.order_id) === Number(scannedOrder.id)) || state.sessions[0]
          : state.sessions[0];
        if (!scannedOrder) {
          addCardLoadingEvent(db, { sessionId: eventSession.id, type: 'unknown_scan', scannedValue: token, actorId, details: { loading_group_uid: groupUid } });
          return { outcome: 'unknown' };
        }
        const selectedOrderIds = new Set(state.sessions.map(session => Number(session.order_id)));
        if (!selectedOrderIds.has(Number(scannedOrder.id))) {
          addCardLoadingEvent(db, { sessionId: eventSession.id, type: 'wrong_order_scan', scannedValue: token, actorId, details: { loading_group_uid: groupUid, scanned_order_id: scannedOrder.id } });
          return { outcome: 'wrong_order' };
        }
        const projected = findProjectedCardByToken(db, scannedOrder, token);
        const previouslyLoaded = db.prepare(`
          SELECT 1 FROM order_loading_session_cards c
          JOIN order_loading_sessions s ON s.id=c.session_id
          WHERE s.order_id=? AND s.scan_unit='production_card' AND s.status='completed'
            AND c.worker_card_token=? AND c.state='loaded' LIMIT 1
        `).get(scannedOrder.id, token);
        const outcome = previouslyLoaded ? 'already_loaded'
          : projected && !projected.final_deliverable ? 'not_final_card'
            : projected && !projected.completed ? 'not_ready'
              : projected ? 'not_in_loading_snapshot' : 'unknown';
        addCardLoadingEvent(db, { sessionId: eventSession.id, type: outcome, cardKey: projected?.card_key || null, scannedValue: token, actorId, details: { loading_group_uid: groupUid } });
        return { outcome };
      }
      if (expected.state === 'loaded') {
        addCardLoadingEvent(db, { sessionId: expected.session_id, type: 'duplicate_scan', cardKey: expected.card_key, scannedValue: token, actorId, details: { loading_group_uid: groupUid } });
        return { outcome: 'duplicate' };
      }
      const changed = db.prepare(`UPDATE order_loading_session_cards SET state='loaded',loaded_by=?,loaded_at=CURRENT_TIMESTAMP WHERE id=? AND state='pending'`).run(actorId, expected.id);
      if (changed.changes !== 1) return { outcome: 'duplicate' };
      addCardLoadingEvent(db, { sessionId: expected.session_id, type: 'card_loaded', cardKey: expected.card_key, scannedValue: token, actorId, details: { loading_group_uid: groupUid } });
      return { outcome: 'loaded', card_key: expected.card_key, order_num: expected.order_num };
    })();
    if (result.error) return res.status(result.status).json({ error: result.error });
    const messages = {
      loaded: `כרטיס העבודה הועמס${result.order_num ? ` · ${result.order_num}` : ''}`,
      duplicate: 'כרטיס העבודה כבר נסרק להעמסה זו',
      wrong_order: 'כרטיס העבודה אינו שייך לאחת ההזמנות שנבחרו',
      already_loaded: 'כרטיס העבודה כבר יצא בהעמסה קודמת',
      not_final_card: 'זהו רכיב ייצור פנימי; יש לסרוק את כרטיס ההרכבה של הכלוב',
      not_ready: 'כרטיס העבודה עדיין לא הושלם בייצור',
      not_in_loading_snapshot: 'הכרטיס אינו חלק מסשן ההעמסה שנפתח',
      unknown: 'QR של כרטיס עבודה אינו מוכר',
    };
    res.json({ outcome: result.outcome, message: messages[result.outcome], state: multiOrderLoadingState(db, groupUid) });
  });

  function finishMultiOrderLoading(req, res, { partial = false } = {}) {
    const groupUid = String(req.params.groupUid || '');
    const reason = String(req.body?.reason || '').trim();
    if (partial && !reason) return res.status(400).json({ error: 'partial_departure_reason_required' });
    const actorId = loadingActorId(req);
    const result = db.transaction(() => {
      const state = multiOrderLoadingState(db, groupUid);
      if (!state) return { error: 'multi_order_loading_session_not_found', status: 404 };
      if (state.status === 'completed') return { replay: true, note: linkedDeliveryNote(db, state.delivery_note_id), transitions: [] };
      if (state.sessions.some(session => session.status !== 'active')) return { error: 'loading_session_not_active', status: 409 };
      if (state.sessions.some(session => normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING)) return { error: 'order_not_in_loading', status: 409 };
      if (!state.loaded_count) return { error: 'no_loaded_cards', status: 409 };
      if (!partial && state.missing_count > 0) return { error: 'cards_missing', status: 409, missing_count: state.missing_count };
      if (partial && state.missing_count === 0) return { error: 'all_cards_loaded_use_complete', status: 409 };
      const departureType = partial ? 'partial' : 'full';
      const note = createMultiOrderDeliveryNote(db, { state, departureType, departureReason: partial ? reason : null });
      db.prepare(`UPDATE order_loading_sessions SET status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP WHERE loading_group_uid=? AND status='active'`).run(actorId, groupUid);
      const transitions = [];
      for (const session of state.sessions) {
        const counts = db.prepare(`
          SELECT SUM(CASE WHEN state='loaded' THEN 1 ELSE 0 END) AS loaded,
                 SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending
          FROM order_loading_session_cards WHERE session_id=?
        `).get(session.id);
        const loaded = Number(counts?.loaded || 0);
        const pending = Number(counts?.pending || 0);
        let nextStatus;
        if (loaded > 0 && pending === 0) nextStatus = ORDER_STATUS.ON_THE_WAY;
        else if (loaded > 0) nextStatus = ORDER_STATUS.PARTIAL_DELIVERY;
        else {
          const deliveredBefore = db.prepare(`
            SELECT 1 FROM order_loading_session_cards c
            JOIN order_loading_sessions s ON s.id=c.session_id
            WHERE s.order_id=? AND s.status='completed' AND c.state='loaded'
              AND (s.loading_group_uid IS NULL OR s.loading_group_uid<>?) LIMIT 1
          `).get(session.order_id, groupUid);
          nextStatus = deliveredBefore ? ORDER_STATUS.PARTIAL_DELIVERY : ORDER_STATUS.DONE_WAITING_PICKUP;
        }
        db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(nextStatus, session.order_id, ORDER_STATUS.LOADING);
        addCardLoadingEvent(db, {
          sessionId: session.id,
          type: 'completed',
          actorId,
          details: { loading_group_uid: groupUid, departure_type: departureType, departure_reason: partial ? reason : null, delivery_note_id: note.id, delivery_note_num: note.note_num, loaded_count: loaded, remaining_count: pending },
        });
        addOrderLoadingStatusAudit(db, {
          order: { id: session.order_id, order_num: session.order_num },
          from: session.order_status,
          to: nextStatus,
          actorId,
          note: `העמסה משותפת ${groupUid} · תעודת משלוח ${note.note_num}${partial ? ` · ${reason}` : ''}`,
        });
        transitions.push({ id: session.order_id, order_num: session.order_num, status: nextStatus });
      }
      return { replay: false, note, transitions };
    })();
    if (result.error) return res.status(result.status).json({ error: result.error, missing_count: result.missing_count || 0 });
    for (const transition of result.transitions) wsBroadcast('order_status', { id: transition.id, status: transition.status, orderNum: transition.order_num });
    res.json({ ...multiOrderLoadingState(db, groupUid), replay: result.replay, delivery_note: result.note || null });
  }

  router.post('/loading/multi-order-card-sessions/:groupUid/complete', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => finishMultiOrderLoading(req, res));
  router.post('/loading/multi-order-card-sessions/:groupUid/partial-departure', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => finishMultiOrderLoading(req, res, { partial: true }));

  // ── CARD-QR LOADING (canonical outbound flow) ────────────────────
  // The same worker-card QR has two safe contexts: production updates at the
  // workstation and loading verification here.  A session freezes its card
  // list so an order edit cannot silently change a truck already loading.
  router.post('/loading/card-sessions', requireQrPermission('warehouse'), (req, res) => {
    const orderId = Number(req.body?.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
    const actorId = loadingActorId(req);

    try {
      const result = db.transaction(() => {
        const order = db.prepare('SELECT id,order_num,status,customer_id,total_weight FROM orders WHERE id=?').get(orderId);
        if (!order) return { error: 'order_not_found', status: 404 };
        const normalizedOrderStatus = normalizeOrderStatus(order.status);
        const active = db.prepare(`SELECT session_uid,scan_unit FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(orderId);
        if (active) {
          if (active.scan_unit !== 'production_card') return { error: 'legacy_package_loading_session_active', status: 409 };
          return { session_uid: active.session_uid, resumed: true };
        }
        if (![ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY].includes(normalizedOrderStatus)) {
          return { error: 'order_not_ready_for_loading', status: 409, order_status: order.status };
        }

        const cardAvailability = eligibleProductionCardsForLoading(db, order);
        if (cardAvailability.incomplete.length) {
          return { error: 'production_cards_not_completed', status: 409, incomplete_count: cardAvailability.incomplete.length };
        }
        const cards = cardAvailability.cards;
        if (!cards.length) return { error: 'no_completed_cards_to_load', status: 409 };

        if (normalizedOrderStatus !== ORDER_STATUS.LOADING) {
          db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.LOADING, order.id);
          addOrderLoadingStatusAudit(db, { order, from: order.status, to: ORDER_STATUS.LOADING, actorId, note: 'תחילת העמסה מסריקת QR של טופס ההזמנה' });
        }

        const sessionUid = loadingSessionUid();
        const expectedWeight = Math.round(cards.reduce((sum, card) => sum + Number(card.weight || 0), 0) * 1000) / 1000;
        const created = db.prepare(`
          INSERT INTO order_loading_sessions (session_uid,order_id,order_num,expected_count,expected_weight,started_by,scan_unit)
          VALUES (?,?,?,?,?,?, 'production_card')
        `).run(sessionUid, order.id, order.order_num, cards.length, expectedWeight, actorId);
        const sessionId = Number(created.lastInsertRowid);
        const addCard = db.prepare(`
          INSERT INTO order_loading_session_cards
            (session_id,card_key,worker_card_token,parent_item_id,title,quantity,weight,diameter_mm,total_length_mm)
          VALUES (?,?,?,?,?,?,?,?,?)
        `);
        for (const card of cards) {
          addCard.run(sessionId, card.card_key, normalizeToken(card.worker_card_token), card.parent_item_id, card.title,
            Number(card.quantity || 0), Number(card.weight || 0), card.diameter_mm, card.total_length_mm);
        }
        addCardLoadingEvent(db, {
          sessionId,
          type: 'started',
          actorId,
          details: { expected_count: cards.length, expected_weight: expectedWeight, source: 'order_qr' },
        });
        return { session_uid: sessionUid, resumed: false, status_changed: normalizedOrderStatus !== ORDER_STATUS.LOADING, order_num: order.order_num };
      })();

      if (result.error) return res.status(result.status).json({
        error: result.error,
        order_status: result.order_status || null,
        incomplete_count: result.incomplete_count || 0,
      });
      if (result.status_changed) wsBroadcast('order_status', { id: orderId, status: ORDER_STATUS.LOADING, orderNum: result.order_num });
      return res.status(result.resumed ? 200 : 201).json({ ...cardLoadingSessionState(db, result.session_uid), resumed: result.resumed });
    } catch (error) {
      // SQLite reports partial-index collisions by column names on some
      // versions and by the index name on others.  Either form means another
      // scanner opened the same order at the same moment, so return that
      // canonical session instead of creating a second truck workflow.
      if (/idx_loading_session_one_active_order|UNIQUE constraint failed/i.test(String(error.message || ''))) {
        const active = db.prepare(`SELECT session_uid,scan_unit FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(orderId);
        if (active?.scan_unit === 'production_card') return res.json({ ...cardLoadingSessionState(db, active.session_uid), resumed: true });
      }
      throw error;
    }
  });

  router.get('/loading/card-sessions/:sessionUid', requireQrPermission('warehouse'), (req, res) => {
    const state = cardLoadingSessionState(db, req.params.sessionUid);
    if (!state) return res.status(404).json({ error: 'card_loading_session_not_found' });
    res.json(state);
  });

  router.post('/loading/card-sessions/:sessionUid/scan', requireQrPermission('warehouse'), (req, res) => {
    const token = scannedWorkerCardToken(req.body?.qr_data ?? req.body?.code);
    if (!token) return res.status(400).json({ error: 'invalid_worker_card_qr' });
    const actorId = loadingActorId(req);
    const sessionUid = String(req.params.sessionUid || '');

    const result = db.transaction(() => {
      const session = db.prepare(`
        SELECT s.id,s.order_id,s.order_num,s.status,s.scan_unit,o.status AS order_status,o.customer_id
        FROM order_loading_sessions s
        JOIN orders o ON o.id=s.order_id
        WHERE s.session_uid=?
      `).get(sessionUid);
      if (!session || session.scan_unit !== 'production_card') return { error: 'card_loading_session_not_found', status: 404 };
      if (session.status !== 'active') return { error: 'loading_session_not_active', status: 409 };
      if (normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING) return { error: 'order_not_in_loading', status: 409 };

      const expected = db.prepare(`
        SELECT id,card_key,state
        FROM order_loading_session_cards
        WHERE session_id=? AND worker_card_token=?
      `).get(session.id, token);
      if (!expected) {
        const scannedOrder = sourceOrderForCardToken(db, token);
        if (!scannedOrder) {
          addCardLoadingEvent(db, { sessionId: session.id, type: 'unknown_scan', scannedValue: token, actorId });
          return { outcome: 'unknown' };
        }
        if (Number(scannedOrder.id) !== Number(session.order_id)) {
          addCardLoadingEvent(db, {
            sessionId: session.id, type: 'wrong_order_scan', scannedValue: token, actorId,
            details: { expected_order_id: session.order_id, scanned_order_id: scannedOrder.id },
          });
          return { outcome: 'wrong_order' };
        }
        const projected = findProjectedCardByToken(db, scannedOrder, token);
        const previouslyLoaded = db.prepare(`
          SELECT 1
          FROM order_loading_session_cards c
          JOIN order_loading_sessions s ON s.id=c.session_id
          WHERE s.order_id=? AND s.scan_unit='production_card' AND s.status='completed'
            AND c.worker_card_token=? AND c.state='loaded'
          LIMIT 1
        `).get(session.order_id, token);
        const outcome = previouslyLoaded ? 'already_loaded'
          : projected && !projected.final_deliverable ? 'not_final_card'
            : projected && !projected.completed ? 'not_ready'
              : projected ? 'not_in_loading_snapshot' : 'unknown';
        addCardLoadingEvent(db, { sessionId: session.id, type: outcome, cardKey: projected?.card_key || null, scannedValue: token, actorId });
        return { outcome };
      }

      if (expected.state === 'loaded') {
        addCardLoadingEvent(db, { sessionId: session.id, type: 'duplicate_scan', cardKey: expected.card_key, scannedValue: token, actorId });
        return { outcome: 'duplicate' };
      }
      const changed = db.prepare(`
        UPDATE order_loading_session_cards
        SET state='loaded',loaded_by=?,loaded_at=CURRENT_TIMESTAMP
        WHERE id=? AND state='pending'
      `).run(actorId, expected.id);
      if (changed.changes !== 1) {
        addCardLoadingEvent(db, { sessionId: session.id, type: 'duplicate_scan', cardKey: expected.card_key, scannedValue: token, actorId });
        return { outcome: 'duplicate' };
      }
      addCardLoadingEvent(db, { sessionId: session.id, type: 'card_loaded', cardKey: expected.card_key, scannedValue: token, actorId });
      return { outcome: 'loaded', card_key: expected.card_key };
    })();

    if (result.error) return res.status(result.status).json({ error: result.error });
    const state = cardLoadingSessionState(db, sessionUid);
    qrAccess.record(req, { permission: 'warehouse', kind: 'card', value: token, action: 'loading_card_scan', outcome: result.outcome });
    const messages = {
      loaded: 'כרטיס העבודה הועמס',
      duplicate: 'כרטיס העבודה כבר נסרק להעמסה זו',
      wrong_order: 'כרטיס העבודה שייך להזמנה אחרת',
      already_loaded: 'כרטיס העבודה כבר יצא בהעמסה קודמת',
      not_final_card: 'זהו רכיב ייצור פנימי; יש לסרוק את כרטיס ההרכבה של הכלוב',
      not_ready: 'כרטיס העבודה עדיין לא הושלם בייצור',
      not_in_loading_snapshot: 'הכרטיס אינו חלק מסשן ההעמסה שנפתח',
      unknown: 'QR של כרטיס עבודה אינו מוכר',
    };
    res.json({ outcome: result.outcome, message: messages[result.outcome], state });
  });

  function finishCardLoadingSession(req, res, { partial = false } = {}) {
    const sessionUid = String(req.params.sessionUid || '');
    const reason = String(req.body?.reason || '').trim();
    if (partial && !reason) return res.status(400).json({ error: 'partial_departure_reason_required' });
    const actorId = loadingActorId(req);
    const result = db.transaction(() => {
      const session = db.prepare(`
        SELECT s.id,s.status,s.order_id,s.order_num,s.delivery_note_id,s.scan_unit,
               o.customer_id,o.status AS order_status
        FROM order_loading_sessions s
        JOIN orders o ON o.id=s.order_id
        WHERE s.session_uid=?
      `).get(sessionUid);
      if (!session || session.scan_unit !== 'production_card') return { error: 'card_loading_session_not_found', status: 404 };
      if (session.status === 'completed') return {
        completed: true, replay: true, delivery_note: linkedDeliveryNote(db, session.delivery_note_id),
        order_id: session.order_id, order_num: session.order_num,
      };
      if (session.status !== 'active') return { error: 'loading_session_not_active', status: 409 };
      if (normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING) return { error: 'order_not_in_loading', status: 409 };
      const counts = db.prepare(`
        SELECT
          SUM(CASE WHEN state='loaded' THEN 1 ELSE 0 END) AS loaded,
          SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending
        FROM order_loading_session_cards WHERE session_id=?
      `).get(session.id);
      const loaded = Number(counts?.loaded || 0);
      const pending = Number(counts?.pending || 0);
      if (!loaded) return { error: 'no_loaded_cards', status: 409 };
      if (!partial && pending > 0) return { error: 'cards_missing', status: 409, missing_count: pending };
      if (partial && !pending) return { error: 'all_cards_loaded_use_complete', status: 409 };

      const departureType = partial ? 'partial' : 'full';
      const note = createCardLoadingDeliveryNote(db, { session, departureType, departureReason: partial ? reason : null });
      db.prepare(`UPDATE order_loading_sessions SET status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(actorId, session.id);
      const nextOrderStatus = departureType === 'full' ? ORDER_STATUS.ON_THE_WAY : ORDER_STATUS.PARTIAL_DELIVERY;
      db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(nextOrderStatus, session.order_id, ORDER_STATUS.LOADING);
      addCardLoadingEvent(db, {
        sessionId: session.id,
        type: 'completed',
        actorId,
        details: { departure_type: departureType, departure_reason: partial ? reason : null, delivery_note_id: note.id, delivery_note_num: note.note_num, loaded_count: loaded, remaining_count: pending },
      });
      addOrderLoadingStatusAudit(db, {
        order: { id: session.order_id, order_num: session.order_num }, from: session.order_status, to: nextOrderStatus, actorId,
        note: departureType === 'full' ? `העמסה מלאה · תעודת משלוח ${note.note_num}` : `העמסה חלקית: ${reason} · תעודת משלוח ${note.note_num}`,
      });
      return { completed: true, replay: false, status_changed: true, next_order_status: nextOrderStatus, delivery_note: note, order_id: session.order_id, order_num: session.order_num };
    })();
    if (result.error) return res.status(result.status).json({ error: result.error, missing_count: result.missing_count || 0 });
    if (result.status_changed) wsBroadcast('order_status', { id: result.order_id, status: result.next_order_status, orderNum: result.order_num });
    res.json({ ...cardLoadingSessionState(db, sessionUid), replay: result.replay, delivery_note: result.delivery_note || null });
  }

  router.post('/loading/card-sessions/:sessionUid/complete', requireQrPermission('warehouse'), (req, res) => finishCardLoadingSession(req, res));
  router.post('/loading/card-sessions/:sessionUid/partial-departure', requireQrPermission('warehouse'), (req, res) => finishCardLoadingSession(req, res, { partial: true }));

  router.get('/packages', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { order_id, status, zone } = req.query;
    let q = `SELECT pk.*, u.display_name as packed_by_name, c.name as customer_name
             FROM packages pk
             LEFT JOIN orders o ON pk.order_id=o.id
             LEFT JOIN customers c ON o.customer_id=c.id
             LEFT JOIN users u ON pk.packed_by=u.id`;
    const wheres = [], params = [];
    if (order_id) { wheres.push('pk.order_id=?'); params.push(order_id); }
    if (status) { wheres.push('pk.status=?'); params.push(status); }
    if (zone) { wheres.push('pk.zone=?'); params.push(zone); }
    if (wheres.length) q += ' WHERE ' + wheres.join(' AND ');
    q += ' ORDER BY pk.packed_at DESC LIMIT 200';
    res.json(db.prepare(q).all(...params));
  });

  router.post('/packages', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { order_id, order_num, item_ids, quantity, weight, diameter, zone, packed_by } = req.body;
    const itemMetrics = packageMetricsFromItems(db, item_ids);
    const packageItemIds = itemMetrics.itemIds;
    const packageQuantity = itemMetrics.quantity || positiveNumberOrNull(quantity) || 0;
    const packageWeight = itemMetrics.weight || positiveNumberOrNull(weight) || 0;
    const packageDiameter = itemMetrics.diameter || diameter || null;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const seq = (db.prepare('SELECT COUNT(*)+1 as n FROM packages WHERE package_code LIKE ?').get('PKG-' + dateStr + '%').n || 1);
    const package_code = `PKG-${dateStr}-${String(seq).padStart(3, '0')}`;
    const qr_data = JSON.stringify({ code: package_code, order_num, diameter: packageDiameter, weight: packageWeight });
    const r = db.prepare(`INSERT INTO packages (package_code,qr_data,order_id,order_num,item_ids,quantity,weight,diameter,zone,packed_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(package_code, qr_data, order_id || null, order_num || null, JSON.stringify(packageItemIds), packageQuantity, packageWeight, packageDiameter, zone || null, packed_by || null);
    if (packageItemIds.length) {
      const upd = db.prepare('UPDATE items SET package_id=?, zone=? WHERE id=?');
      for (const iid of packageItemIds) upd.run(r.lastInsertRowid, zone || null, iid);
    }
    res.json({ id: r.lastInsertRowid, package_code, weight: packageWeight });
  });

  // Historical package operations stay available for existing records. New
  // QR-driven loading never invokes this endpoint: it uses production cards
  // and issues a truck delivery note atomically at session completion.
  router.patch('/packages/:id/ship', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    db.prepare('UPDATE packages SET status=?,shipped_at=CURRENT_TIMESTAMP WHERE id=?')
      .run('shipped', req.params.id);
    res.json({ ok: true });
  });

  // ── ORDER LOADING BY THE QR PRINTED ON THE ORDER SHEET ─────────────
  // Production scans keep using their own worker-card flow.  This flow only
  // accepts physical package labels, so an item can later be split into
  // multiple packages without changing production-card semantics.
  router.get('/loading/orders/:orderId', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
    const order = db.prepare('SELECT id,order_num,status,total_weight FROM orders WHERE id=?').get(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    const active = db.prepare(`SELECT session_uid FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(orderId);
    const packages = eligibleOrderPackages(db, orderId);
    const orderStatus = normalizeOrderStatus(order.status);
    res.json({
      order: { id: order.id, order_num: order.order_num, status: order.status, total_weight: order.total_weight },
      active_session_uid: active?.session_uid || null,
      loading_available: Boolean(active) || [ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY].includes(orderStatus),
      loading_state: active ? 'active' : orderStatus === ORDER_STATUS.DONE_WAITING_PICKUP ? 'ready_to_start' : orderStatus === ORDER_STATUS.PARTIAL_DELIVERY ? 'ready_for_next_truck' : orderStatus === ORDER_STATUS.LOADING ? 'ready_to_resume' : 'not_ready',
      eligible_package_count: packages.length,
      eligible_package_weight: Math.round(packages.reduce((sum, row) => sum + Number(row.weight || 0), 0) * 1000) / 1000,
    });
  });

  router.post('/loading/sessions', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const orderId = Number(req.body?.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
    const actorId = loadingActorId(req);

    try {
      const result = db.transaction(() => {
        const order = db.prepare('SELECT id,order_num,status FROM orders WHERE id=?').get(orderId);
        if (!order) return { error: 'order_not_found', status: 404 };
        const normalizedOrderStatus = normalizeOrderStatus(order.status);
        const active = db.prepare(`SELECT session_uid FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(orderId);
        if (active) return { session_uid: active.session_uid, resumed: true };

        if (![ORDER_STATUS.DONE_WAITING_PICKUP, ORDER_STATUS.LOADING, ORDER_STATUS.PARTIAL_DELIVERY].includes(normalizedOrderStatus)) {
          return { error: 'order_not_ready_for_loading', status: 409, order_status: order.status };
        }

        const packages = eligibleOrderPackages(db, orderId);
        if (!packages.length) return { error: 'no_loadable_packages', status: 409 };

        if (normalizedOrderStatus !== ORDER_STATUS.LOADING) {
          db.prepare('UPDATE orders SET status=? WHERE id=?').run(ORDER_STATUS.LOADING, order.id);
          addOrderLoadingStatusAudit(db, { order, from: order.status, to: ORDER_STATUS.LOADING, actorId, note: 'תחילת העמסה מסשן מחסן' });
        }

        const sessionUid = loadingSessionUid();
        const expectedWeight = Math.round(packages.reduce((sum, row) => sum + Number(row.weight || 0), 0) * 1000) / 1000;
        const created = db.prepare(`
          INSERT INTO order_loading_sessions (session_uid,order_id,order_num,expected_count,expected_weight,started_by)
          VALUES (?,?,?,?,?,?)
        `).run(sessionUid, order.id, order.order_num, packages.length, expectedWeight, actorId);
        const sessionId = created.lastInsertRowid;
        const addPackage = db.prepare(`
          INSERT INTO order_loading_session_packages (session_id,package_id,package_code,item_ids_json,quantity,weight)
          VALUES (?,?,?,?,?,?)
        `);
        for (const pkg of packages) {
          addPackage.run(sessionId, pkg.id, pkg.package_code, pkg.item_ids || '[]', Number(pkg.quantity || 0), Number(pkg.weight || 0));
        }
        addLoadingEvent(db, {
          sessionId,
          type: 'started',
          actorId,
          details: { expected_count: packages.length, expected_weight: expectedWeight },
        });
        return { session_uid: sessionUid, resumed: false, status_changed: normalizedOrderStatus !== ORDER_STATUS.LOADING, order_num: order.order_num };
      })();

      if (result.error) return res.status(result.status).json({ error: result.error, order_status: result.order_status || null });
      if (result.status_changed) wsBroadcast('order_status', { id: orderId, status: ORDER_STATUS.LOADING, orderNum: result.order_num });
      return res.status(result.resumed ? 200 : 201).json({ ...loadingSessionState(db, result.session_uid), resumed: result.resumed });
    } catch (error) {
      if (String(error.message || '').includes('idx_loading_session_one_active_order')) {
        const active = db.prepare(`SELECT session_uid FROM order_loading_sessions WHERE order_id=? AND status='active'`).get(orderId);
        if (active) return res.json({ ...loadingSessionState(db, active.session_uid), resumed: true });
      }
      throw error;
    }
  });

  router.get('/loading/sessions/:sessionUid', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const state = loadingSessionState(db, req.params.sessionUid);
    if (!state) return res.status(404).json({ error: 'loading_session_not_found' });
    res.json(state);
  });

  router.post('/loading/sessions/:sessionUid/scan', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const code = scannedPackageCode(req.body?.qr_data ?? req.body?.code);
    if (!code) return res.status(400).json({ error: 'invalid_package_qr' });
    const actorId = loadingActorId(req);
    const sessionUid = String(req.params.sessionUid || '');

    const result = db.transaction(() => {
      const session = db.prepare(`
        SELECT s.id,s.order_id,s.status,o.status AS order_status
        FROM order_loading_sessions s
        JOIN orders o ON o.id=s.order_id
        WHERE s.session_uid=?
      `).get(sessionUid);
      if (!session) return { error: 'loading_session_not_found', status: 404 };
      if (session.status !== 'active') return { error: 'loading_session_not_active', status: 409 };
      if (normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING) return { error: 'order_not_in_loading', status: 409 };

      const expected = db.prepare(`
        SELECT id,package_id,state FROM order_loading_session_packages
        WHERE session_id=? AND package_code=?
      `).get(session.id, code);
      if (!expected) {
        const packageRow = db.prepare('SELECT id,order_id FROM packages WHERE package_code=?').get(code);
        addLoadingEvent(db, {
          sessionId: session.id,
          type: packageRow ? 'wrong_order_scan' : 'unknown_scan',
          packageId: packageRow?.id || null,
          scannedValue: code,
          actorId,
          details: { expected_order_id: session.order_id, scanned_order_id: packageRow?.order_id || null },
        });
        return { outcome: packageRow ? 'wrong_order' : 'unknown' };
      }

      if (expected.state === 'loaded') {
        addLoadingEvent(db, { sessionId: session.id, type: 'duplicate_scan', packageId: expected.package_id, scannedValue: code, actorId });
        return { outcome: 'duplicate' };
      }

      const packageUpdated = db.prepare(`
        UPDATE packages SET status='loaded'
        WHERE id=? AND status IN ('packed','ready','staged')
      `).run(expected.package_id);
      if (packageUpdated.changes !== 1) {
        addLoadingEvent(db, { sessionId: session.id, type: 'unknown_scan', packageId: expected.package_id, scannedValue: code, actorId, details: { reason: 'package_not_loadable' } });
        return { outcome: 'not_loadable' };
      }

      const loaded = db.prepare(`
        UPDATE order_loading_session_packages
        SET state='loaded',loaded_by=?,loaded_at=CURRENT_TIMESTAMP
        WHERE id=? AND state='pending'
      `).run(actorId, expected.id);
      if (loaded.changes !== 1) {
        addLoadingEvent(db, { sessionId: session.id, type: 'duplicate_scan', packageId: expected.package_id, scannedValue: code, actorId });
        return { outcome: 'duplicate' };
      }
      addLoadingEvent(db, { sessionId: session.id, type: 'package_loaded', packageId: expected.package_id, scannedValue: code, actorId });
      return { outcome: 'loaded', package_code: code };
    })();

    if (result.error) return res.status(result.status).json({ error: result.error });
    const state = loadingSessionState(db, sessionUid);
    const messages = {
      loaded: 'החבילה נוספה להעמסה',
      duplicate: 'החבילה כבר נסרקה בסשן זה',
      wrong_order: 'החבילה אינה שייכת להזמנה זו',
      unknown: 'QR חבילה לא מוכר',
      not_loadable: 'החבילה אינה זמינה להעמסה',
    };
    res.json({ outcome: result.outcome, message: messages[result.outcome], state });
  });

  router.post('/loading/sessions/:sessionUid/complete', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const sessionUid = String(req.params.sessionUid || '');
    const actorId = loadingActorId(req);
    const result = db.transaction(() => {
      const session = db.prepare(`
        SELECT s.id,s.status,s.order_id,s.order_num,s.delivery_note_id,
               o.customer_id,o.status AS order_status
        FROM order_loading_sessions s
        JOIN orders o ON o.id=s.order_id
        WHERE s.session_uid=?
      `).get(sessionUid);
      if (!session) return { error: 'loading_session_not_found', status: 404 };
      if (session.status === 'completed') return {
        completed: true,
        replay: true,
        delivery_note: linkedDeliveryNote(db, session.delivery_note_id),
        order_id: session.order_id,
        order_num: session.order_num,
      };
      if (session.status !== 'active') return { error: 'loading_session_not_active', status: 409 };
      if (normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING) return { error: 'order_not_in_loading', status: 409 };
      const missing = db.prepare(`SELECT COUNT(*) AS count FROM order_loading_session_packages WHERE session_id=? AND state='pending'`).get(session.id).count;
      if (missing > 0) return { error: 'packages_missing', status: 409, missing_count: missing };

      // A package can be added after the session froze its expected set. Do
      // not silently send the whole order in that case: this departure is
      // partial and the new package remains eligible for the next truck.
      const remainingPackages = eligibleOrderPackages(db, session.order_id);
      const departureType = remainingPackages.length ? 'partial' : 'full';
      const nextOrderStatus = departureType === 'full'
        ? ORDER_STATUS.ON_THE_WAY
        : ORDER_STATUS.PARTIAL_DELIVERY;
      const deliveryNote = createLoadingDeliveryNote(db, { session, departureType });
      db.prepare(`
        UPDATE order_loading_sessions
        SET status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(actorId, session.id);
      addLoadingEvent(db, {
        sessionId: session.id,
        type: 'completed',
        actorId,
        details: { departure_type: departureType, delivery_note_id: deliveryNote.id, delivery_note_num: deliveryNote.note_num },
      });
      db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(nextOrderStatus, session.order_id, ORDER_STATUS.LOADING);
      addOrderLoadingStatusAudit(db, {
        order: { id: session.order_id, order_num: session.order_num },
        from: session.order_status,
        to: nextOrderStatus,
        actorId,
        note: departureType === 'full'
          ? `יציאה מלאה לאחר העמסה · תעודת משלוח ${deliveryNote.note_num}`
          : `יציאה חלקית לאחר העמסה · תעודת משלוח ${deliveryNote.note_num}`,
      });
      return {
        completed: true,
        replay: false,
        status_changed: true,
        next_order_status: nextOrderStatus,
        departure_type: departureType,
        delivery_note: deliveryNote,
        order_id: session.order_id,
        order_num: session.order_num,
      };
    })();
    if (result.error) return res.status(result.status).json({ error: result.error, missing_count: result.missing_count || 0 });
    if (result.status_changed) wsBroadcast('order_status', { id: result.order_id, status: result.next_order_status, orderNum: result.order_num });
    res.json({ ...loadingSessionState(db, sessionUid), replay: result.replay, delivery_note: result.delivery_note || null });
  });

  router.post('/loading/sessions/:sessionUid/partial-departure', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const sessionUid = String(req.params.sessionUid || '');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'partial_departure_reason_required' });
    const actorId = loadingActorId(req);
    const result = db.transaction(() => {
      const session = db.prepare(`
        SELECT s.id,s.status,s.order_id,s.order_num,s.delivery_note_id,
               o.customer_id,o.status AS order_status
        FROM order_loading_sessions s
        JOIN orders o ON o.id=s.order_id
        WHERE s.session_uid=?
      `).get(sessionUid);
      if (!session) return { error: 'loading_session_not_found', status: 404 };
      if (session.status === 'completed') return {
        completed: true,
        replay: true,
        delivery_note: linkedDeliveryNote(db, session.delivery_note_id),
        order_id: session.order_id,
        order_num: session.order_num,
      };
      if (session.status !== 'active') return { error: 'loading_session_not_active', status: 409 };
      if (normalizeOrderStatus(session.order_status) !== ORDER_STATUS.LOADING) return { error: 'order_not_in_loading', status: 409 };
      const missing = Number(db.prepare(`SELECT COUNT(*) AS count FROM order_loading_session_packages WHERE session_id=? AND state='pending'`).get(session.id).count || 0);
      const loaded = Number(db.prepare(`SELECT COUNT(*) AS count FROM order_loading_session_packages WHERE session_id=? AND state='loaded'`).get(session.id).count || 0);
      if (!loaded) return { error: 'no_loaded_packages', status: 409 };
      if (!missing) return { error: 'all_packages_loaded_use_complete', status: 409 };

      const deliveryNote = createLoadingDeliveryNote(db, { session, departureType: 'partial', departureReason: reason });
      db.prepare(`
        UPDATE order_loading_sessions
        SET status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(actorId, session.id);
      addLoadingEvent(db, {
        sessionId: session.id,
        type: 'completed',
        actorId,
        details: {
          departure_type: 'partial',
          departure_reason: reason,
          delivery_note_id: deliveryNote.id,
          delivery_note_num: deliveryNote.note_num,
          loaded_count: loaded,
          remaining_count: missing,
        },
      });
      db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(ORDER_STATUS.PARTIAL_DELIVERY, session.order_id, ORDER_STATUS.LOADING);
      addOrderLoadingStatusAudit(db, {
        order: { id: session.order_id, order_num: session.order_num },
        from: session.order_status,
        to: ORDER_STATUS.PARTIAL_DELIVERY,
        actorId,
        note: `יציאה חלקית: ${reason} · תעודת משלוח ${deliveryNote.note_num}`,
      });
      return {
        completed: true,
        replay: false,
        status_changed: true,
        next_order_status: ORDER_STATUS.PARTIAL_DELIVERY,
        delivery_note: deliveryNote,
        order_id: session.order_id,
        order_num: session.order_num,
      };
    })();
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (result.status_changed) wsBroadcast('order_status', { id: result.order_id, status: result.next_order_status, orderNum: result.order_num });
    res.json({ ...loadingSessionState(db, sessionUid), replay: result.replay, delivery_note: result.delivery_note || null });
  });

  router.get('/delivery-notes', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { order_id } = req.query;
    const rows = order_id
      ? db.prepare(`
          SELECT DISTINCT dn.* FROM delivery_notes dn
          LEFT JOIN delivery_note_orders dno ON dno.delivery_note_id=dn.id
          WHERE dn.order_id=? OR dno.order_id=?
          ORDER BY dn.issued_at DESC
        `).all(order_id, order_id)
      : db.prepare('SELECT * FROM delivery_notes ORDER BY issued_at DESC LIMIT 50').all();
    res.json(rows);
  });

  // A loading-session note is a truck-specific document.  It renders only
  // the package snapshot frozen at departure, so a later truck cannot change
  // an earlier delivery note by loading the rest of the order.
  router.get('/delivery-notes/:id/print', requireAnyRole(['driver', 'warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const cancelled=db.prepare('SELECT 1 FROM delivery_note_cancellations WHERE note_id=?').get(req.params.id);
    const note = db.prepare(`
      SELECT dn.*,o.delivery_address,c.name AS customer_name,c.phone AS customer_phone
      FROM delivery_notes dn
      LEFT JOIN orders o ON o.id=dn.order_id
      LEFT JOIN customers c ON c.id=dn.customer_id
      WHERE dn.id=?
    `).get(req.params.id);
    if (!note) return res.status(404).send('תעודת המשלוח לא נמצאה');
    const linkedOrders = db.prepare(`
      SELECT order_id,order_num,items_json,total_weight
      FROM delivery_note_orders WHERE delivery_note_id=? ORDER BY rowid
    `).all(note.id);
    const packages = safeJsonArray(note.packages_json);
    const loadingCards = safeJsonArray(note.items_json).filter(row => row && row.loading_card === true);
    const packageRows = packages.map((pkg, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(pkg.package_code || '—')}</td>
        <td>${escapeHtml(pkg.quantity || '—')}</td>
        <td>${Number(pkg.weight || 0).toLocaleString('he-IL', { maximumFractionDigits: 3 })} ק"ג</td>
      </tr>`).join('');
    const renderCardRow = (card, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(card.title || 'כרטיס ייצור')}</td>
        <td>${escapeHtml(card.worker_card_token || '—')}</td>
        <td>${Number(card.quantity || 0).toLocaleString('he-IL', { maximumFractionDigits: 3 })}</td>
        <td>${Number(card.weight || 0).toLocaleString('he-IL', { maximumFractionDigits: 3 })} ק"ג</td>
      </tr>`;
    const cardRows = linkedOrders.length > 1
      ? linkedOrders.map(link => {
          const orderCards = safeJsonArray(link.items_json);
          return `<tr class="order-group"><td colspan="5">הזמנה ${escapeHtml(link.order_num)} · ${Number(link.total_weight || 0).toLocaleString('he-IL', { maximumFractionDigits: 3 })} ק"ג</td></tr>${orderCards.map(renderCardRow).join('')}`;
        }).join('')
      : loadingCards.map(renderCardRow).join('');
    const deliveryRowsHtml = loadingCards.length
      ? `<table><thead><tr><th>#</th><th>כרטיס עבודה</th><th>QR / מספר כרטיס</th><th>כמות</th><th>משקל</th></tr></thead><tbody>${cardRows}</tbody></table>`
      : `<table><thead><tr><th>#</th><th>חבילה</th><th>כמות</th><th>משקל</th></tr></thead><tbody>${packageRows || '<tr><td colspan="4">אין חבילות בתעודה</td></tr>'}</tbody></table>`;
    const issuedAt = note.issued_at ? new Date(note.issued_at).toLocaleString('he-IL') : '—';
    const orderNumbers = linkedOrders.length ? linkedOrders.map(link => link.order_num).join(' · ') : note.order_num;
    const orderLabel = linkedOrders.length > 1 ? 'הזמנות' : 'הזמנה';
    res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>תעודת משלוח ${escapeHtml(note.note_num)}</title><style>
      body{font-family:Arial,sans-serif;color:#111;margin:0;padding:24mm;background:#fff}h1{margin:0 0 5mm;font-size:24px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:0 0 8mm}.meta div{border:1px solid #222;padding:3mm}table{width:100%;border-collapse:collapse}th,td{border:1px solid #222;padding:3mm;text-align:right}th{background:#eee}.order-group td{background:#ddd;font-weight:900;border-top:2px solid #111}.total{font-size:18px;font-weight:bold;margin-top:7mm}@media print{body{padding:12mm}}
    </style></head><body><h1>תעודת משלוח</h1>${cancelled?'<div style="border:3px solid #b42318;color:#b42318;padding:12px;font-weight:900">מבוטלת — אינה תעודת משלוח תקפה</div>':''}<div class="meta"><div><b>מספר תעודה:</b> ${escapeHtml(note.note_num)}</div><div><b>${orderLabel}:</b> ${escapeHtml(orderNumbers)}</div><div><b>לקוח:</b> ${escapeHtml(note.customer_name || '—')}</div><div><b>תאריך יציאה:</b> ${escapeHtml(issuedAt)}</div><div><b>כתובת:</b> ${escapeHtml(note.delivery_address || '—')}</div><div><b>טלפון:</b> ${escapeHtml(note.customer_phone || '—')}</div></div>${deliveryRowsHtml}<p class="total">סה"כ למשאית זו: ${Number(note.total_weight || 0).toLocaleString('he-IL', { maximumFractionDigits: 3 })} ק"ג</p></body></html>`);
  });

  router.post('/delivery-notes', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { order_id, order_num, delivery_id, customer_id, packages_json, items_json, total_weight, driver_id } = req.body;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const seq = (db.prepare('SELECT COUNT(*)+1 as n FROM delivery_notes WHERE note_num LIKE ?').get('DN-' + dateStr + '%').n || 1);
    const note_num = `DN-${dateStr}-${String(seq).padStart(3, '0')}`;
    const deliveryWeight = deliveryNoteWeightFromPayload({
      packagesJson: packages_json,
      itemsJson: items_json,
    }) || positiveNumberOrNull(total_weight) || 0;
    const r = db.prepare(`INSERT INTO delivery_notes (note_num,order_id,order_num,delivery_id,customer_id,packages_json,items_json,total_weight,driver_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(note_num, order_id || null, order_num || null, delivery_id || null, customer_id || null,
        JSON.stringify(packages_json || []), JSON.stringify(items_json || []), deliveryWeight || 0, driver_id || null);
    res.json({ id: r.lastInsertRowid, note_num, total_weight: deliveryWeight || 0 });
  });

  return router;
};

module.exports.manifest = {
  id: 'warehouse',
  label: 'מחסן',
  screens: [
    { id: 'warehouse', path: '/warehouse.html', label: 'מחסן', icon: '📦', group: 'תפעול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'read', warehouse: 'edit' },
  },
  consumes: [
    { table: 'packages' },
    { table: 'delivery_notes' },
    { table: 'order_loading_sessions' },
    { table: 'order_loading_session_packages' },
    { table: 'order_loading_session_cards' },
    { table: 'order_loading_card_events' },
  ],
  produces: [],
};
