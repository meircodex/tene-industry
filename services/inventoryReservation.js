const { itemShapeMetrics } = require('./shapeSnapshot');

const MATERIAL_TYPES = new Set(['coil', 'straight', 'bent']);

const DEFAULT_ACTIVE_RESERVATION_STATUSES = ['active'];

const CLOSED_PURCHASE_ORDER_STATUSES = new Set([
  'cancelled',
  'canceled',
  'closed',
  'done',
  'complete',
  'completed',
  'received',
  'arrived',
]);

function normalizeMaterialType(value) {
  const materialType = String(value || '').trim();
  return MATERIAL_TYPES.has(materialType) ? materialType : 'coil';
}

function normalizeDiameter(value) {
  const diameter = Number(value);
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw Object.assign(new Error('diameter is required for inventory reservation calculation'), { statusCode: 400 });
  }
  return diameter;
}

function roundKg(value) {
  const numeric = Number(value || 0);
  return Number(numeric.toFixed(3));
}

function normalizeOrderId(value) {
  const orderId = Number(value);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw Object.assign(new Error('order_id is required for inventory reservation'), { statusCode: 400 });
  }
  return orderId;
}

function reservationItemId(item = {}) {
  const itemId = Number(item.item_id ?? item.itemId ?? item.id);
  return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
}

function reservationWeightKg(item = {}) {
  const metrics = itemShapeMetrics(item);
  return roundKg(
    metrics.totalWeightKg
      ?? item.reserved_kg
      ?? item.reservedKg
      ?? item.weight_kg
      ?? item.total_weight
      ?? item.totalWeight
      ?? 0
  );
}

function normalizeItemIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0))];
}

function actualProductionWeightKg(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw Object.assign(new Error('actual_weight_kg must be a non-negative number'), { statusCode: 400 });
  }
  return roundKg(numeric);
}

function safeIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw Object.assign(new Error('invalid inventory reservation table name'), { statusCode: 400 });
  }
  return identifier;
}

function tableExists(db, tableName) {
  const safeTableName = safeIdentifier(tableName);
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(safeTableName));
}

function tableColumns(db, tableName) {
  const safeTableName = safeIdentifier(tableName);
  return new Set(db.prepare(`PRAGMA table_info(${safeTableName})`).all().map(column => column.name));
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function calculatePhysicalStockKg(db, { diameter, material_type }) {
  const hasVerificationStatus = tableColumns(db, 'raw_material').has('verification_status');
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(weight_received, 0) - COALESCE(weight_used, 0) - COALESCE(weight_scrapped, 0)
    ), 0) AS physicalStockKg
    FROM raw_material
    WHERE active=1
      ${hasVerificationStatus ? "AND COALESCE(verification_status, 'approved')='approved'" : ''}
      AND diameter=?
      AND COALESCE(material_type, 'coil')=?
  `).get(diameter, material_type);
  return roundKg(row?.physicalStockKg);
}

function reservationWeightExpression(columns) {
  if (columns.has('reserved_kg')) return 'COALESCE(reserved_kg, 0)';
  if (columns.has('reservedKg')) return 'COALESCE(reservedKg, 0)';
  if (columns.has('quantity_kg')) return 'COALESCE(quantity_kg, 0)';
  if (columns.has('required_kg')) return 'COALESCE(required_kg, 0)';
  return null;
}

function calculateReservedKg(db, {
  diameter,
  material_type,
  reservationTable = 'inventory_reservations',
  activeStatuses = DEFAULT_ACTIVE_RESERVATION_STATUSES,
} = {}) {
  const safeReservationTable = safeIdentifier(reservationTable);
  if (!tableExists(db, safeReservationTable)) return 0;

  const columns = tableColumns(db, safeReservationTable);
  if (!columns.has('diameter')) return 0;

  const weightExpression = reservationWeightExpression(columns);
  if (!weightExpression) return 0;

  const where = ['diameter=?'];
  const params = [diameter];

  if (columns.has('material_type')) {
    where.push("COALESCE(material_type, 'coil')=?");
    params.push(material_type);
  }

  if (columns.has('active')) {
    where.push('COALESCE(active, 1)=1');
  }

  const normalizedStatuses = activeStatuses
    .map(status => String(status || '').trim())
    .filter(Boolean);

  if (columns.has('status') && normalizedStatuses.length) {
    where.push(`status IN (${placeholders(normalizedStatuses)})`);
    params.push(...normalizedStatuses);
  }

  const row = db.prepare(`
    SELECT COALESCE(SUM(${weightExpression}), 0) AS reservedKg
    FROM ${safeReservationTable}
    WHERE ${where.join(' AND ')}
  `).get(...params);

  return roundKg(row?.reservedKg);
}

function isOpenPurchaseOrderStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return !CLOSED_PURCHASE_ORDER_STATUSES.has(normalized);
}

function calculateIncomingKg(db, { diameter, material_type }) {
  const rows = db.prepare(`
    SELECT quantity_ton, received_weight, status, received_at
    FROM purchase_orders
    WHERE diameter=?
      AND COALESCE(material_type, 'coil')=?
      AND received_at IS NULL
  `).all(diameter, material_type);

  const incomingKg = rows.reduce((sum, row) => {
    if (!isOpenPurchaseOrderStatus(row.status)) return sum;
    const orderedKg = Number(row.quantity_ton || 0) * 1000;
    const receivedKg = Number(row.received_weight || 0);
    return sum + Math.max(0, orderedKg - receivedKg);
  }, 0);

  return roundKg(incomingKg);
}

function reserveMaterialForOrder(db, { order_id, items } = {}) {
  const orderId = normalizeOrderId(order_id);
  const orderItems = Array.isArray(items) ? items : [];

  if (!orderItems.length) {
    return { order_id: orderId, inserted: 0, reservedKg: 0, reservations: [] };
  }

  const insertReservation = db.prepare(`
    INSERT INTO inventory_reservations
      (order_id, item_id, diameter, material_type, reserved_kg, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  const insertAll = db.transaction(rows => {
    const reservations = [];

    for (const item of rows) {
      const diameter = normalizeDiameter(item.diameter ?? item.diameterMm ?? item.barDiameter ?? item.barDiameterMm);
      const material_type = normalizeMaterialType(item.material_type ?? item.materialType);
      const reservedKg = reservationWeightKg(item);

      if (reservedKg <= 0) continue;

      const result = insertReservation.run(
        orderId,
        reservationItemId(item),
        diameter,
        material_type,
        reservedKg
      );

      reservations.push({
        id: result.lastInsertRowid,
        order_id: orderId,
        item_id: reservationItemId(item),
        diameter,
        material_type,
        reserved_kg: reservedKg,
        status: 'active',
      });
    }

    return reservations;
  });

  const reservations = insertAll(orderItems);
  return {
    order_id: orderId,
    inserted: reservations.length,
    reservedKg: roundKg(reservations.reduce((sum, row) => sum + row.reserved_kg, 0)),
    reservations,
  };
}
function releaseReservationsForItems(db, { item_ids } = {}) {
  const itemIds = normalizeItemIds(item_ids);

  if (!itemIds.length) {
    return { item_ids: [], released: 0 };
  }

  const result = db.prepare(`
    UPDATE inventory_reservations
    SET status='released', updated_at=CURRENT_TIMESTAMP
    WHERE item_id IN (${placeholders(itemIds)})
      AND status <> 'released'
  `).run(...itemIds);

  return { item_ids: itemIds, released: result.changes || 0 };
}

function releaseAllReservationsForOrder(db, { order_id } = {}) {
  const orderId = normalizeOrderId(order_id);

  const result = db.prepare(`
    UPDATE inventory_reservations
    SET status='released', updated_at=CURRENT_TIMESTAMP
    WHERE order_id=?
      AND status <> 'released'
  `).run(orderId);

  return { order_id: orderId, released: result.changes || 0 };
}
function consumeReservationsForProduction(db, { order_id, item_ids, actual_weight_kg } = {}) {
  const orderId = order_id === undefined || order_id === null || order_id === ''
    ? null
    : normalizeOrderId(order_id);
  const itemIds = normalizeItemIds(item_ids);
  const actualWeightKg = actualProductionWeightKg(actual_weight_kg);

  if (!orderId && !itemIds.length) {
    throw Object.assign(new Error('order_id or item_ids is required for consuming reservations'), { statusCode: 400 });
  }

  const where = ["status <> 'consumed'"];
  const params = [];

  if (orderId) {
    where.push('order_id=?');
    params.push(orderId);
  }

  if (itemIds.length) {
    where.push(`item_id IN (${placeholders(itemIds)})`);
    params.push(...itemIds);
  }

  const setClauses = ["status='consumed'", 'updated_at=CURRENT_TIMESTAMP'];
  const setParams = [];

  if (actualWeightKg !== null) {
    setClauses.splice(1, 0, 'reserved_kg=?');
    setParams.push(actualWeightKg);
  }

  const result = db.prepare(`
    UPDATE inventory_reservations
    SET ${setClauses.join(', ')}
    WHERE ${where.join(' AND ')}
  `).run(...setParams, ...params);

  return {
    order_id: orderId,
    item_ids: itemIds,
    consumed: result.changes || 0,
    actual_weight_kg: actualWeightKg,
  };
}
function calculateMaterialStockPosition(db, input = {}) {
  const diameter = normalizeDiameter(input.diameter);
  const material_type = normalizeMaterialType(input.material_type);
  const safetyStockKg = Math.max(0, Number(input.safetyStockKg || 0));

  const physicalStockKg = calculatePhysicalStockKg(db, { diameter, material_type });
  const reservedKg = calculateReservedKg(db, {
    diameter,
    material_type,
    reservationTable: input.reservationTable,
    activeStatuses: input.activeStatuses || DEFAULT_ACTIVE_RESERVATION_STATUSES,
  });
  const availableKg = roundKg(physicalStockKg - reservedKg);
  const shortageKg = roundKg(Math.max(0, -availableKg));
  const incomingKg = calculateIncomingKg(db, { diameter, material_type });
  const recommendedPurchaseKg = roundKg(Math.max(0, shortageKg - incomingKg + safetyStockKg));

  return {
    diameter,
    material_type,
    physicalStockKg,
    reservedKg,
    availableKg,
    shortageKg,
    incomingKg,
    recommendedPurchaseKg,
  };
}

function calculatePurchaseRecommendations(db, { diameter, material_type } = {}) {
  const position = calculateMaterialStockPosition(db, { diameter, material_type });
  return {
    physicalStockKg: position.physicalStockKg,
    reservedKg: position.reservedKg,
    availableKg: position.availableKg,
    incomingKg: position.incomingKg,
    shortageKg: position.shortageKg,
    recommendedPurchaseKg: position.recommendedPurchaseKg,
  };
}

module.exports = {
  DEFAULT_ACTIVE_RESERVATION_STATUSES,
  calculateMaterialStockPosition,
  calculatePurchaseRecommendations,
  reserveMaterialForOrder,
  releaseReservationsForItems,
  releaseAllReservationsForOrder,
  consumeReservationsForProduction,
  calculatePhysicalStockKg,
  calculateReservedKg,
  calculateIncomingKg,
  normalizeMaterialType,
};
