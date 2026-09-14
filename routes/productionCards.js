const router = require('express').Router();
const printPage = require('../services/productionCardPrintPage');
const { requestPublicBaseUrl } = require('../services/publicScanLinks');

function required(name, value) {
  if (!value) throw new Error(`routes/productionCards missing dependency: ${name}`);
  return value;
}

function parsePositiveIdList(value) {
  if (value === undefined) return null;
  const rawValues = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [];

  for (const raw of rawValues) {
    const parts = String(raw).split(',');
    for (const part of parts) {
      const normalizedValue = String(part || '').trim();
      if (!normalizedValue) continue;
      const parsed = Number(normalizedValue);
      if (!Number.isInteger(parsed) || parsed <= 0) return { error: `invalid item id: ${normalizedValue}` };
      normalized.push(parsed);
    }
  }

  if (!normalized.length) return { error: 'itemIds cannot be empty' };
  return { ids: [...new Set(normalized)] };
}

function parseCardKeyList(value) {
  if (value === undefined) return null;
  const rawValues = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [];

  for (const raw of rawValues) {
    const parts = String(raw).split(',');
    for (const part of parts) {
      const normalizedValue = String(part || '').trim();
      if (!normalizedValue) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(normalizedValue)) {
        return { error: 'cardKeys must contain only letters, numbers, underscores and hyphens' };
      }
      normalized.push(normalizedValue);
    }
  }

  if (!normalized.length) return { error: 'cardKeys cannot be empty' };
  return { values: [...new Set(normalized)] };
}

function normalizeCardKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = function createProductionCardsRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const cards = required('productionCards', deps.productionCards);
  const industry = required('industry', deps.industry);
  const tryParseJSON = required('tryParseJSON', deps.tryParseJSON);
  const normalizeFactorySegments = required('normalizeFactorySegments', deps.normalizeFactorySegments);
  const normalizeFactoryShapeName = required('normalizeFactoryShapeName', deps.normalizeFactoryShapeName);
  const statusContracts = required('statusContracts', deps.statusContracts);
  const productionActuals = required('productionActuals', deps.productionActuals);
  const settingsService = deps.settingsService || null;
  const { ORDER_STATUS, ITEM_STATUS } = statusContracts;
  const productionCardOrderGateStatuses = new Set([
    ORDER_STATUS.APPROVED_WAITING_PRODUCTION,
    ORDER_STATUS.PRODUCTION_QUEUE,
    ORDER_STATUS.IN_PRODUCTION,
  ]);

  function canCreateProductionCards(order) {
    return productionCardOrderGateStatuses.has(statusContracts.normalizeOrderStatus(order?.status));
  }

// ── PRINT CARDS ───────────────────────────────────────────────────
router.get('/orders/:id/print-cards', requireAnyRole(['office', 'production', 'manager', 'admin']), (req, res) => {
  const itemIdsFromQuery = req.query.itemIds ?? req.query.item_ids;
  const parsedItemIds = parsePositiveIdList(itemIdsFromQuery);
  if (parsedItemIds && parsedItemIds.error) return res.status(400).send('Invalid itemIds. Use comma-separated positive integers.');
  const selectedItemIds = parsedItemIds && parsedItemIds.ids ? new Set(parsedItemIds.ids) : null;

  const cardKeysFromQuery = req.query.cardKeys ?? req.query.card_keys;
  const parsedCardKeys = parseCardKeyList(cardKeysFromQuery);
  if (parsedCardKeys && parsedCardKeys.error) return res.status(400).send('Invalid cardKeys. Use comma-separated values.');
  const selectedCardKeys = parsedCardKeys && parsedCardKeys.values
    ? new Set(parsedCardKeys.values.map(cardKey => normalizeCardKey(cardKey)).filter(Boolean))
    : null;

  const order = db.prepare(`SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
      p.name as project_name, COALESCE(cs.name, legacy_site.name) as site_name
    FROM orders o
    LEFT JOIN customers c ON o.customer_id=c.id
    LEFT JOIN projects p ON o.project_id=p.id
    LEFT JOIN customer_sites cs ON o.site_id=cs.id
    LEFT JOIN sites legacy_site ON o.site_id=legacy_site.id
    WHERE o.id=?`).get(req.params.id);
  if (!order) return res.status(404).send('הזמנה לא נמצאה');

  const pallets = db.prepare('SELECT * FROM pallets WHERE order_id=? ORDER BY pallet_num').all(order.id);
  pallets.forEach(p => {
    p.items = db.prepare('SELECT * FROM items WHERE pallet_id=? ORDER BY id').all(p.id);
    p.items.forEach(item => {
      item._palletNum = p.pallet_num;
      const snapshot = tryParseJSON(item.shape_snapshot_json, null);
      const snapshotSegments = snapshot && typeof snapshot === 'object' ? cards.shapeSegmentsFromItem(item) : [];
      const segments = snapshotSegments.length
        ? snapshotSegments
        : normalizeFactorySegments(item.shape_name, tryParseJSON(item.segments, []));
      item.shape_name = normalizeFactoryShapeName(item.shape_name, segments);
      item.segments = JSON.stringify(segments);
    });
  });
  order.pallets = pallets;

  const allItems = pallets.flatMap(p => p.items);
  const filteredItems = selectedItemIds
    ? allItems.filter(item => selectedItemIds.has(Number(item.id)))
    : allItems;
  if (selectedItemIds && filteredItems.length !== selectedItemIds.size) {
    const missing = [...selectedItemIds].filter(itemId => !allItems.some(item => Number(item.id) === itemId));
    if (missing.length) {
      return res.status(404).json({
        error: 'One or more requested itemIds were not found in this order',
        missing_item_ids: missing,
      });
    }
  }

  if (selectedItemIds && !filteredItems.length) {
    return res.status(404).json({ error: 'No matching items for requested itemIds' });
  }

  const cardFilterSourceItems = selectedItemIds ? filteredItems : allItems;
  const selectedCardKeysSet = selectedCardKeys && selectedCardKeys.size ? selectedCardKeys : null;
  let validatedCardKeys = null;
  if (selectedCardKeysSet) {
    const expandedCards = printPage.expandProductionCardsForOrder(cardFilterSourceItems, tryParseJSON);
    const availableCardKeys = new Set(
      expandedCards.map(item => normalizeCardKey(item.card_key || item.id)).filter(Boolean)
    );
    const missingCardKeys = [...selectedCardKeysSet].filter(cardKey => !availableCardKeys.has(cardKey));
    if (missingCardKeys.length) {
      return res.status(404).json({
        error: 'One or more requested cardKeys were not found in this order',
        missing_card_keys: missingCardKeys,
      });
    }
    validatedCardKeys = selectedCardKeysSet;
  }

  const previewOnly = allItems.length && !canCreateProductionCards(order);
  const cardWeights = db.prepare('SELECT * FROM production_card_weights WHERE order_id=? ORDER BY item_id, card_total, card_index').all(order.id);
  const weightsByItem = new Map();
  for (const row of cardWeights) {
    const key = Number(row.item_id);
    if (!weightsByItem.has(key)) weightsByItem.set(key, []);
    weightsByItem.get(key).push(row);
  }
  filteredItems.forEach(item => {
    item.card_weights = weightsByItem.get(Number(item.id)) || [];
  });

  // Format date dd-mm-yyyy
  const today = new Date();
  const fmtDate = d => {
    const dt = d ? new Date(d) : today;
    return `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`;
  };
  const printDate = fmtDate(order.created_at);
  const delivDate = order.delivery_date ? fmtDate(order.delivery_date) : '';

  const html = printPage.renderPrintCardsPage({
    order,
    pallets,
    allItems: filteredItems,
    selectedCardKeys: validatedCardKeys,
    printDate,
    delivDate,
    cards,
    industry,
    tryParseJSON,
    previewOnly,
    publicBaseUrl: requestPublicBaseUrl(req, settingsService),
  });

  console.log('[print-cards] order', req.params.id, '→', filteredItems.length, 'items server-rendered');

  if (previewOnly) res.setHeader('X-Production-Cards-Preview-Only', '1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

router.patch('/orders/:orderId/production-card-weight', requireAnyRole(['production', 'office', 'manager', 'admin']), (req, res) => {
  const orderId = Number(req.params.orderId);
  const itemId = Number(req.body.item_id);
  const cardIndex = Number(req.body.card_index);
  const cardTotal = Number(req.body.card_total || 1);
  const cardQty = Number(req.body.card_qty || 0);
  const actualWeight = Number(req.body.actual_weight_kg);

  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid orderId' });
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'invalid item_id' });
  if (!Number.isInteger(cardIndex) || cardIndex < 1) return res.status(400).json({ error: 'invalid card_index' });
  if (!Number.isInteger(cardTotal) || cardTotal < 1 || cardIndex > cardTotal) return res.status(400).json({ error: 'invalid card_total' });
  if (!Number.isFinite(actualWeight) || actualWeight < 0) return res.status(400).json({ error: 'invalid actual_weight_kg' });

  const item = db.prepare(`
    SELECT i.*, p.order_id, o.status AS order_status
    FROM items i
    JOIN pallets p ON p.id=i.pallet_id
    JOIN orders o ON o.id=p.order_id
    WHERE i.id=? AND p.order_id=?
  `).get(itemId, orderId);
  if (!item) return res.status(404).json({ error: 'item not found' });
  if (item.status === ITEM_STATUS.CANCELLED || item.cancelled_at != null || item.production_stopped_at != null) {
    return res.status(409).json({ error: 'production_stopped_by_cancellation' });
  }
  if (!canCreateProductionCards({ status: item.order_status })) {
    return res.status(409).json({ error: 'order_not_released_to_production_cards', order_status: item.order_status });
  }

  const targetWeight = Number(item.total_weight) || 0;
  const targetCardWeight = targetWeight > 0 && Number(item.quantity) > 0 && cardQty > 0
    ? targetWeight * cardQty / Number(item.quantity)
    : targetWeight / cardTotal;
  const deviationPct = targetCardWeight > 0 ? ((actualWeight - targetCardWeight) / targetCardWeight) * 100 : null;

  const saveCardWeight = db.transaction(() => {
    const previousItemActualWeight = Number(item.actual_weight_kg) || 0;
    db.prepare('DELETE FROM production_card_weights WHERE item_id=? AND card_total<>?').run(itemId, cardTotal);
    db.prepare(`
      INSERT INTO production_card_weights
        (order_id,item_id,card_index,card_total,card_qty,target_weight_kg,actual_weight_kg,weight_deviation_pct,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(item_id, card_index, card_total) DO UPDATE SET
        order_id=excluded.order_id,
        card_qty=excluded.card_qty,
        target_weight_kg=excluded.target_weight_kg,
        actual_weight_kg=excluded.actual_weight_kg,
        weight_deviation_pct=excluded.weight_deviation_pct,
        updated_by=excluded.updated_by,
        updated_at=CURRENT_TIMESTAMP
    `).run(orderId, itemId, cardIndex, cardTotal, cardQty, targetCardWeight, actualWeight, deviationPct, req.auth?.sub || null);

    const summary = db.prepare(`
      SELECT COUNT(*) AS saved_cards, COALESCE(SUM(actual_weight_kg),0) AS actual_weight_kg
      FROM production_card_weights
      WHERE item_id=? AND card_total=?
    `).get(itemId, cardTotal);
    const itemActualWeight = Number(summary.actual_weight_kg) || 0;
    const itemDeviationPct = targetWeight > 0 ? ((itemActualWeight - targetWeight) / targetWeight) * 100 : null;
    db.prepare('UPDATE items SET actual_weight_kg=?, weight_deviation_pct=? WHERE id=?').run(itemActualWeight, itemDeviationPct, itemId);
    productionActuals.recordActualWeightChange(db, {
      itemId,
      orderId,
      beforeKg: previousItemActualWeight,
      afterKg: itemActualWeight,
      source: 'production_card_weight',
      actorId: req.auth?.sub || null,
      metadata: { card_index: cardIndex, card_total: cardTotal, card_qty: cardQty },
    });
    return { saved_cards: Number(summary.saved_cards) || 0, item_actual_weight_kg: itemActualWeight, item_deviation_pct: itemDeviationPct };
  });
  const summary = saveCardWeight();

  res.json({ success: true, card_target_weight_kg: targetCardWeight, card_deviation_pct: deviationPct, item_actual_weight_kg: summary.item_actual_weight_kg, item_deviation_pct: summary.item_deviation_pct, saved_cards: summary.saved_cards, expected_cards: cardTotal });
});

  return router;
};

module.exports.manifest = {
  id: 'production-cards',
  label: 'כרטיסי ייצור',
  screens: [
    { id: 'production-cards', path: '/productionCards.html', label: 'כרטיסי ייצור', icon: '🗂️', group: 'ייצור' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'read' },
  },
  consumes: [{ table: 'orders' }, { table: 'items' }],
  produces: [],
};
