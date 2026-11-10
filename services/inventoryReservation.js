const { materialOnHandSql } = require('./materialBalance');
const { itemShapeMetrics } = require('./shapeSnapshot');

const MATERIAL_TYPES = new Set(['coil', 'straight', 'bent', 'mesh']);

const DEFAULT_ACTIVE_RESERVATION_STATUSES = ['active'];

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
      ${materialOnHandSql(db)}
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
  return require('./inventoryPlanning').CONFIRMED_INCOMING.has(normalized);
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

  const modern = tableColumns(db, 'inventory_reservations').has('consumption_mode');
  if(modern&&Number(db.prepare('SELECT inventory_lifecycle_version FROM orders WHERE id=?').get(orderId)?.inventory_lifecycle_version)===2)throw Object.assign(new Error('v2_requires_material_requirement_flow'),{statusCode:409});
  const insertReservation = db.prepare(`
    INSERT INTO inventory_reservations
      (order_id, item_id, diameter, material_type, reserved_kg, status, created_at, updated_at${modern ? ', consumption_mode, preferred_raw_material_id' : ''})
    VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP${modern ? ", 'on_completion', ?" : ''})
  `);

  const insertAll = db.transaction(rows => {
    const reservations = [];

    for (const item of rows) {
      if ((item.material_type||item.materialType)==='mesh') {
        require('./meshInventory').reserveMesh(db,{order_id:orderId,item_id:reservationItemId(item),specification:item.mesh_specification,quantity_units:item.quantity_units||item.quantity});
        continue;
      }

      const diameter = normalizeDiameter(item.diameter ?? item.diameterMm ?? item.barDiameter ?? item.barDiameterMm);
      const material_type = normalizeMaterialType(item.material_type ?? item.materialType);
      const reservedKg = reservationWeightKg(item);

      if (reservedKg <= 0) continue;

      // Browser drafts use 'auto' for FIFO selection, not a raw-material key.
      const rawPreference=item.preferred_raw_material_id;
      const source=typeof rawPreference==='string'?rawPreference.trim():rawPreference;
      let preferredId=null;
      if(modern && source!==null && source!==undefined && source!=='' && source!==0 && String(source).toLowerCase()!=='auto') {
        const id=Number(source);
        const validId=['string','number'].includes(typeof source) && Number.isSafeInteger(id) && id>0;
        if(!validId || !db.prepare('SELECT id FROM raw_material WHERE id=?').get(id)) {
          const message=validId?'מנת המלאי שנבחרה אינה קיימת במערכת. יש לבחור מנה קיימת מהרשימה או בחירה אוטומטית.':'מקור הברזל שנבחר אינו מספר מנת מלאי תקין. יש לבחור מנה מהרשימה או בחירה אוטומטית.';
          throw Object.assign(new Error(message),{statusCode:400,code:'invalid_preferred_raw_material',details:{item_sequence:item.display_sequence || null,field:'preferred_raw_material_id',value:typeof source==='number'||typeof source==='string'?source:null}});
        }
        preferredId=id;
      }

      if (modern && reservationItemId(item)) {
        const prior = db.prepare("SELECT status FROM inventory_reservations WHERE order_id=? AND item_id=? AND consumption_mode='on_completion' AND status IN ('active','consumed')").get(orderId,reservationItemId(item));
        if (prior) throw Object.assign(new Error('item_already_reserved_or_consumed'), {statusCode:409});
      }
      const result = insertReservation.run(
        orderId,
        reservationItemId(item),
        diameter,
        material_type,
        reservedKg,
        ...(modern ? [preferredId] : [])
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
function releaseReservationsForItems(db, { item_ids, correction_reason } = {}) {
  const itemIds = normalizeItemIds(item_ids);

  if (!itemIds.length) {
    return { item_ids: [], released: 0 };
  }
  const completion=require('./inventoryItemCompletion');
  if(correction_reason && completion.policy(db)) {
    // Orders may revise a completed item through its existing authorized,
    // reasoned correction. Its physical debit is reconciled in the same transaction.
    for(const id of itemIds) if(completion.state(db,id)) db.prepare("UPDATE inventory_reservations SET status='released',updated_at=CURRENT_TIMESTAMP WHERE item_id=? AND status='consumed'").run(id);
  }

  const result = db.prepare(`
    UPDATE inventory_reservations
    SET status='released', updated_at=CURRENT_TIMESTAMP
    WHERE item_id IN (${placeholders(itemIds)})
      AND status = 'active'
  `).run(...itemIds);

  if(tableExists(db,'inventory_mesh_demands')) db.prepare(`UPDATE inventory_mesh_demands SET status='released' WHERE status='active' AND item_id IN (${placeholders(itemIds)})`).run(...itemIds);
  return { item_ids: itemIds, released: result.changes || 0 };
}

function releaseAllReservationsForOrder(db, { order_id } = {}) {
  const orderId = normalizeOrderId(order_id);

  const result = db.prepare(`
    UPDATE inventory_reservations
    SET status='released', updated_at=CURRENT_TIMESTAMP
    WHERE order_id=?
      AND status = 'active'
  `).run(orderId);

  if(tableExists(db,'inventory_mesh_demands')) db.prepare("UPDATE inventory_mesh_demands SET status='released' WHERE status='active' AND order_id=?").run(orderId);
  return { order_id: orderId, released: result.changes || 0 };
}
function consumeReservationsForProduction(db, { order_id, item_ids, actual_weight_kg } = {}) {
  const orderId = order_id === undefined || order_id === null || order_id === '' ? null : normalizeOrderId(order_id);
  const itemIds = normalizeItemIds(item_ids);
  const actualWeightKg = actualProductionWeightKg(actual_weight_kg);
  if (!orderId && !itemIds.length) throw Object.assign(new Error('order_id or item_ids is required for consuming reservations'), {statusCode:400});
  const completion=require('./inventoryItemCompletion');
  if(completion.policy(db)) return db.transaction(()=>{
    const ids=itemIds.length?itemIds:db.prepare('SELECT i.id FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id WHERE COALESCE(i.order_id,p.order_id)=?').all(orderId).map(i=>i.id);
    if(actualWeightKg!==null && ids.length!==1)throw Object.assign(Error('actual_weight_requires_single_reservation'),{statusCode:400});
    let consumed=0;const pending=[];
    for(const id of ids){
      const item=completion.itemRecord(db,id);
      if(!item||orderId&&item.owner_order_id!==orderId)continue;
      const blocked=completion.eligibility(db,item);
      const mesh=tableExists(db,'inventory_mesh_demands')&&db.prepare("SELECT 1 FROM inventory_mesh_demands WHERE item_id=? AND status IN ('active','consumed')").get(id);
      const result=mesh&&!blocked?require('./meshInventory').consumeMesh(db,{orderId:item.owner_order_id,itemIds:[id]}):completion.consumeItem(db,{item_id:id,actual_weight_kg:actualWeightKg});
      consumed+=result.consumed; if(result.pending)pending.push(...(Array.isArray(result.pending)?result.pending:[result.pending]));
    }
    return {order_id:orderId,item_ids:ids,consumed,pending};
  }).immediate();
  const where=["status='active'"], params=[];
  if (orderId) {where.push('order_id=?');params.push(orderId);}
  if (itemIds.length) {where.push(`item_id IN (${placeholders(itemIds)})`);params.push(...itemIds);}
  return db.transaction(() => {
    const rows=db.prepare(`SELECT * FROM inventory_reservations WHERE ${where.join(' AND ')}`).all(...params);
    if (actualWeightKg!==null && rows.length>1) throw Object.assign(new Error('actual_weight_requires_single_reservation'),{statusCode:400});
    let consumed=0;const pending=[];
    for (const row of rows) {
      if (row.consumption_mode==='on_completion') {
        const result=require('./inventoryCompletion').consumeCompletionReservation(db,row,actualWeightKg);
        consumed+=result.consumed;if(result.pending)pending.push(result.pending);
      } else {
        // Historical order creation may already have charged raw_material_usage.
        consumed+=db.prepare("UPDATE inventory_reservations SET status='consumed',reserved_kg=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(actualWeightKg??row.reserved_kg,row.id).changes;
      }
    }
    if(tableExists(db,'inventory_mesh_demands')) {const mesh=require('./meshInventory').consumeMesh(db,{orderId,itemIds});consumed+=mesh.consumed;pending.push(...mesh.pending);}
    return {order_id:orderId,item_ids:itemIds,consumed,actual_weight_kg:actualWeightKg,...(pending.length?{pending}: {})};
  }).immediate();
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
  const recommendedPurchaseKg = roundKg(Math.max(0, reservedKg + safetyStockKg - physicalStockKg - incomingKg));

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
  if(tableColumns(db,'inventory_reservations').has('consumption_mode')) {
    normalizeDiameter(diameter);
    const row=require('./inventoryPlanning').planInventory(db,{diameter,material_type:normalizeMaterialType(material_type)}).groups[0];
    const physicalStockKg=row?.physical_stock_kg||0,reservedKg=row?.backlog_kg||0,incomingKg=row?.incoming_kg||0;
    return {physicalStockKg,reservedKg,availableKg:roundKg(physicalStockKg-reservedKg),incomingKg,shortageKg:roundKg(Math.max(0,reservedKg-physicalStockKg)),recommendedPurchaseKg:row?.recommended_purchase_kg||0};
  }

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
