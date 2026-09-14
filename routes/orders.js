const router = require('express').Router();
const {
  assertOrderStatusTransition,
  buildOrderItemUid,
  buildFullShapeSnapshot,
  isShapeDataContractV2,
  withShapeContractLegacyFields,
} = require('../services/orderContracts');
const {
  findSourceIdentityDuplicate,
  sourceIdentityConflictPayload,
  sourceIdentityFromRequest,
} = require('../services/importSourceIdentity');
const { ORDER_STATUS, ITEM_STATUS } = require('../status-contracts');
const {
  calculateMaterialStockPosition,
  releaseAllReservationsForOrder,
  releaseReservationsForItems,
  reserveMaterialForOrder,
} = require('../services/inventoryReservation');
const { createPricer } = require('../services/pricer');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const { buildOrderCommercialSummary } = require('../services/orderCommercialSummary');
const { createOrderQuoteService } = require('../services/orderQuotes');
const { createOrderCancellationService, OrderCancellationError } = require('../services/orderCancellation');
const { createHistoricalProductionReconciliationService } = require('../services/historicalProductionReconciliation');

function required(name, value) {
  if (!value) throw new Error(`routes/orders missing dependency: ${name}`);
  return value;
}
function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shapeSnapshotCandidate(item = {}) {
  return item.shapeSnapshot
    ?? item.shape_snapshot
    ?? item.shapeData
    ?? item.shape_data
    ?? item.shapeContract
    ?? item.shape_contract
    ?? item.shape_snapshot_json
    ?? null;
}

function roundPileCageOrderMetrics(item = {}) {
  const snapshot = parseJsonObject(shapeSnapshotCandidate(item));
  if (snapshot?.family !== 'piles' || snapshot?.shapeType !== 'round_pile_cage') return null;
  if (snapshot.validation && (snapshot.validation.ok === false || snapshot.validation.valid === false)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  const canonical = calculatePileCage(snapshot);
  if (!canonical.validation?.ok || canonical.productionCards?.length !== 5) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  const weightKg = Number(canonical.calculated?.totalWeightKg);
  const physicalLengthMm = Number(canonical.assemblySummary?.pileLengthMm);
  if (!(weightKg > 0) || !(physicalLengthMm > 0)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  return { snapshot, weightKg, physicalLengthMm };
}

function buildOrderItemShapeSnapshotJson(rawItem = {}, fallback = {}) {
  const candidate = shapeSnapshotCandidate(rawItem);
  const fullEnvelope = parseJsonObject(candidate);
  if (isShapeDataContractV2(fullEnvelope)) return JSON.stringify(fullEnvelope);
  if (typeof candidate === 'string' && isShapeDataContractV2(candidate)) return candidate;
  return JSON.stringify(buildFullShapeSnapshot({ ...rawItem, ...fallback }));
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// These fields define the geometry that every consumer (order detail, print,
// production queue and QR/scan card) must see.  Quantity-only edits keep the
// approved geometry snapshot untouched; a geometry edit must never leave an
// older snapshot behind for another renderer to pick up.
function hasShapeDefinitionChange(body = {}) {
  return [
    'shape_name', 'shapeName', 'shape_id', 'shapeId', 'shapeType', 'family',
    'diameter', 'diameterMm', 'total_length_mm', 'totalLengthMm',
    'segments', 'sides', 'angles',
    'spiral_diameter_mm', 'spiralDiameterMm', 'spiralDiameter',
    'spiral_turns', 'spiralTurns', 'turns',
  ].some(field => Object.prototype.hasOwnProperty.call(body, field));
}

function synchronizedShapeSnapshotForItem(existingItem = {}, body = {}, cleanItem = {}) {
  // A complete editor envelope is already the current canonical snapshot.
  // It is validated and normalized by the existing order-contract helpers.
  if (shapeSnapshotCandidate(body) != null) {
    return buildOrderItemShapeSnapshotJson(body, {
      shapeId: body.shapeId || body.shape_id || existingItem.shape_id || cleanItem.shapeName,
      shapeName: cleanItem.shapeName,
      diameter: cleanItem.diameter,
      segments: cleanItem.segments,
      totalLengthMm: cleanItem.totalLengthMm,
      spiralDiameterMm: cleanItem.spiralDiameter || null,
      spiralTurns: cleanItem.spiralTurns || null,
      note: cleanItem.note,
      structElement: cleanItem.structElement,
      structFloor: cleanItem.structFloor,
      sheetNum: cleanItem.sheetNum,
    });
  }

  // A non-geometric edit (for example quantity or note) must not manufacture
  // a new geometry snapshot.
  if (!hasShapeDefinitionChange(body)) {
    return existingItem.shape_snapshot_json || buildOrderItemShapeSnapshotJson(body, {
      shapeId: existingItem.shape_id || cleanItem.shapeName,
      shapeName: cleanItem.shapeName,
      diameter: cleanItem.diameter,
      segments: cleanItem.segments,
      totalLengthMm: cleanItem.totalLengthMm,
      spiralDiameterMm: cleanItem.spiralDiameter || null,
      spiralTurns: cleanItem.spiralTurns || null,
      note: cleanItem.note,
      structElement: cleanItem.structElement,
      structFloor: cleanItem.structFloor,
      sheetNum: cleanItem.sheetNum,
    });
  }

  const prior = parseJsonObject(existingItem.shape_snapshot_json) || {};
  const priorData = prior.data && typeof prior.data === 'object' ? prior.data : {};
  const priorGeneric = prior.machineOutput?.generic && typeof prior.machineOutput.generic === 'object'
    ? prior.machineOutput.generic
    : {};
  const segments = parseJsonArray(cleanItem.segments).map((segment, index, all) => ({
    length_mm: Number(segment?.length_mm ?? segment?.length ?? 0),
    angle_deg: Number(segment?.angle_deg ?? segment?.angle ?? (index < all.length - 1 ? 180 : 0)),
  })).filter(segment => Number.isFinite(segment.length_mm) && segment.length_mm > 0);
  const genericSegments = segments.map((segment, index) => ({
    index: index + 1,
    lengthMm: segment.length_mm,
    bendAfterDeg: index < segments.length - 1 ? segment.angle_deg : null,
  }));
  const isSpiral = cleanItem.spiralDiameter != null || cleanItem.spiralTurns != null
    || prior.family === 'spirals' || prior.shapeType === 'spiral';
  const shapeId = String(body.shapeId || body.shape_id || prior.shapeId || existingItem.shape_id || cleanItem.shapeName);
  const shapeType = String(body.shapeType || (body.shape_name !== undefined || body.shapeName !== undefined
    ? cleanItem.shapeName
    : prior.shapeType || existingItem.shape_id || 'custom_bar'));
  const family = String(body.family || prior.family || (isSpiral ? 'spirals' : 'bars'));

  // Keep any existing family-specific metadata, but project the authoritative
  // item fields into both the readable data and generic machine output.  The
  // two representations are consumed by legacy and V2 renderers respectively.
  // Do not pass this object through the legacy snapshot builder: that builder
  // intentionally accepts flat inputs and would discard the V2 data we are
  // synchronizing here.
  return JSON.stringify({
    ...prior,
    contract: prior.contract || 'SHAPE_DATA_CONTRACT_V2',
    contractVersion: prior.contractVersion || '2.0',
    shapeVersion: prior.shapeVersion || '1.0',
    shapeId,
    shapeType,
    family,
    source: prior.source || 'order-item-update',
    approvedAt: prior.approvedAt || new Date().toISOString(),
    displayName: cleanItem.shapeName,
    shapeName: cleanItem.shapeName,
    data: {
      ...priorData,
      diameter: cleanItem.diameter,
      segments,
      sides: segments.map(segment => segment.length_mm),
      angles: segments.slice(0, -1).map(segment => segment.angle_deg),
      ...(isSpiral ? {
        spiral: {
          ...(priorData.spiral && typeof priorData.spiral === 'object' ? priorData.spiral : {}),
          diameterMm: cleanItem.spiralDiameter || null,
          turns: cleanItem.spiralTurns || null,
        },
      } : {}),
    },
    calculated: {
      ...(prior.calculated && typeof prior.calculated === 'object' ? prior.calculated : {}),
      totalLengthMm: cleanItem.totalLengthMm,
      weightKg: cleanItem.weightPerUnit,
      totalWeightKg: cleanItem.totalWeight,
    },
    machineOutput: {
      ...(prior.machineOutput && typeof prior.machineOutput === 'object' ? prior.machineOutput : {}),
      generic: {
        ...priorGeneric,
        diameter: cleanItem.diameter,
        segments: genericSegments,
        totalLengthMm: cleanItem.totalLengthMm,
        lengthMm: cleanItem.totalLengthMm,
        weightKg: cleanItem.weightPerUnit,
        totalWeightKg: cleanItem.totalWeight,
        ...(isSpiral ? {
          spiralDiameterMm: cleanItem.spiralDiameter || null,
          turns: cleanItem.spiralTurns || null,
        } : {}),
      },
    },
    validation: prior.validation && typeof prior.validation === 'object'
      ? prior.validation
      : { valid: true, errors: [], warnings: [] },
  });
}

function shapeIdFromSnapshotJson(value, fallback) {
  const snapshot = parseJsonObject(value);
  const shapeId = snapshot?.shapeId;
  return String(shapeId || fallback || '').trim() || null;
}


module.exports = function createOrdersRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const requireRole = required('requireRole', deps.requireRole);
  const upload = required('upload', deps.upload);
  const modbus = required('modbus', deps.modbus);
  const intake = required('intake', deps.intake);
  const listPage = required('listPage', deps.listPage);
  const industry = required('industry', deps.industry);
  const normalizeOrderStatus = required('normalizeOrderStatus', deps.normalizeOrderStatus);
  const isValidOrderTransition = required('isValidOrderTransition', deps.isValidOrderTransition);
  const allowedOrderTransitions = required('allowedOrderTransitions', deps.allowedOrderTransitions);
  const createOrderFromPayload = required('createOrderFromPayload', deps.createOrderFromPayload);
  const createOrderTransaction = required('createOrderTransaction', deps.createOrderTransaction);
  const buildOrderImportPreview = required('buildOrderImportPreview', deps.buildOrderImportPreview);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const auditLog = required('auditLog', deps.auditLog);
  const productionCards = deps.productionCards || require('../services/productionCards');
  const pricer = deps.pricer || createPricer(db);
  const quotes = createOrderQuoteService(db, { createOrderFromPayload });
  const cancellations = createOrderCancellationService(db);
  const historicalReconciliations = createHistoricalProductionReconciliationService(db);

  function normalizePreviewItem(item = {}, index = 0) {
    const shapeSnapshot = parseJsonObject(item.shape_snapshot_json) || parseJsonObject(item.shapeSnapshot) || null;
    return {
      order_item_temp_id: item.order_item_temp_id ?? item.temp_id ?? item.id ?? index,
      diameter: Number(item.diameter),
      quantity: Math.max(1, Number(item.quantity ?? item.qty ?? 1) || 1),
      totalWeight: Number(item.total_weight_kg ?? item.totalWeightKg ?? item.totalWeight ?? item.total_weight ?? 0) || 0,
      shapeSnapshot,
      shape_snapshot_json: shapeSnapshot ? JSON.stringify(shapeSnapshot) : null,
    };
  }

  function pricePreviewCustomer(customerId) {
    const id = Number(customerId || 0);
    if (!id) return null;
    return db.prepare('SELECT * FROM customers WHERE id=?').get(id) || null;
  }

  function roundKg(value) {
    const numeric = Number(value || 0);
    return Number(numeric.toFixed(3));
  }

  function normalizeReservationPreviewItem(item = {}) {
    return {
      diameter: Number(item.diameter),
      material_type: String(item.material_type || item.materialType || 'coil').trim() || 'coil',
      required_kg: Number(item.required_kg ?? item.total_weight_kg ?? item.totalWeightKg ?? item.totalWeight ?? item.total_weight ?? 0) || 0,
    };
  }

  function emptyReservationPreviewTotal() {
    return {
      required_kg: 0,
      physical_kg: 0,
      reserved_kg: 0,
      available_kg: 0,
      shortage_kg: 0,
      incoming_kg: 0,
      recommended_purchase_kg: 0,
    };
  }

  function cleanItemPayload(body, existingItem = {}) {
    const pileCageMetrics = roundPileCageOrderMetrics({ ...existingItem, ...body });
    body = withShapeContractLegacyFields(body || {});
    let segments = existingItem.segments || '[]';
    if (body.segments !== undefined) {
      if (!Array.isArray(body.segments)) throw Object.assign(new Error('segments must be an array'), { statusCode: 400 });
      const clean = [];
      for (const [index, segment] of body.segments.entries()) {
        const length = Number(segment?.length_mm ?? segment?.length);
        const angle = Number(segment?.angle_deg ?? segment?.angle ?? 180);
        if (!Number.isFinite(length) || length < 0) throw Object.assign(new Error(`invalid segment length at ${index + 1}`), { statusCode: 400 });
        if (!Number.isFinite(angle) || angle < 0 || angle > 180) throw Object.assign(new Error(`invalid segment angle at ${index + 1}`), { statusCode: 400 });
        clean.push({ length_mm: length, angle_deg: angle });
      }
      segments = JSON.stringify(clean);
    }

    const shapeName = pileCageMetrics ? 'PILE CAGE' : (body.shape_name !== undefined ? String(body.shape_name || '').trim() : existingItem.shape_name);
    const diameter = body.diameter !== undefined ? Number(body.diameter) : Number(existingItem.diameter);
    const quantity = body.quantity !== undefined ? Number(body.quantity) : Number(existingItem.quantity);
    const totalLengthMm = pileCageMetrics ? pileCageMetrics.physicalLengthMm : body.total_length_mm !== undefined
      ? Number(body.total_length_mm)
      : (Array.isArray(body.segments)
        ? body.segments.reduce((sum, segment) => sum + Number(segment?.length_mm ?? segment?.length ?? 0), 0)
        : Number(existingItem.total_length_mm));
    const spiralDiameter = body.spiral_diameter_mm !== undefined ? Number(body.spiral_diameter_mm) : existingItem.spiral_diameter_mm;
    const spiralTurns = body.spiral_turns !== undefined ? Number(body.spiral_turns) : existingItem.spiral_turns;
    const note = body.note !== undefined ? String(body.note || '') : (body.shape_description !== undefined ? String(body.shape_description || '') : (body.shapeDescription !== undefined ? String(body.shapeDescription || '') : (existingItem.note || '')));
    const structElement = body.structElement !== undefined ? String(body.structElement || '').trim()
      : (body.struct_element !== undefined ? String(body.struct_element || '').trim()
        : (body.element_name !== undefined ? String(body.element_name || '').trim()
          : (body.elementName !== undefined ? String(body.elementName || '').trim()
            : (existingItem.struct_element || ''))));
    const structFloor = body.structFloor !== undefined ? String(body.structFloor || '').trim()
      : (body.struct_floor !== undefined ? String(body.struct_floor || '').trim() : (existingItem.struct_floor || ''));
    const sheetNum = body.sheetNum !== undefined ? String(body.sheetNum || '').trim()
      : (body.sheet_num !== undefined ? String(body.sheet_num || '').trim() : (existingItem.sheet_num || ''));

    if (!shapeName) throw Object.assign(new Error('shape_name is required'), { statusCode: 400 });
    if (!Number.isFinite(diameter) || diameter <= 0) throw Object.assign(new Error('invalid diameter'), { statusCode: 400 });
    if (!Number.isFinite(quantity) || quantity <= 0) throw Object.assign(new Error('invalid quantity'), { statusCode: 400 });
    if (!Number.isFinite(totalLengthMm) || totalLengthMm < 0) throw Object.assign(new Error('invalid total_length_mm'), { statusCode: 400 });

    if (pileCageMetrics) segments = '[]';
    const weightPerUnit = pileCageMetrics ? pileCageMetrics.weightKg : industry.weightPerUnit({ diameter, total_length_mm: totalLengthMm });
    const totalWeight = weightPerUnit * quantity;
    return { shapeName, diameter, quantity, totalLengthMm, segments, spiralDiameter, spiralTurns, note, structElement, structFloor, sheetNum, weightPerUnit, totalWeight };
  }

  function recalcOrderWeights(orderId) {
    const orderTotal = db.prepare(`
      SELECT COALESCE(SUM(i.total_weight),0) AS total_weight
      FROM items i JOIN pallets p ON p.id=i.pallet_id
      WHERE p.order_id=?
    `).get(orderId).total_weight || 0;
    const order = db.prepare('SELECT COALESCE(waste_pct_charged, 3) AS waste_pct_charged FROM orders WHERE id=?').get(orderId);
    const wastePct = Number(order?.waste_pct_charged);
    const billingWeight = orderTotal * (1 + (Number.isFinite(wastePct) ? wastePct : 3) / 100);
    db.prepare('UPDATE orders SET total_weight=?, billing_weight=? WHERE id=?').run(orderTotal, billingWeight, orderId);
    db.prepare(`
      UPDATE pallets
      SET total_weight=(SELECT COALESCE(SUM(total_weight),0) FROM items WHERE pallet_id=pallets.id)
      WHERE order_id=?
    `).run(orderId);
    return orderTotal;
  }

  function firstOrCreatePallet(orderId) {
    const existing = db.prepare('SELECT * FROM pallets WHERE order_id=? ORDER BY pallet_num LIMIT 1').get(orderId);
    if (existing) return existing;
    const next = db.prepare('SELECT COALESCE(MAX(pallet_num),0)+1 AS pallet_num FROM pallets WHERE order_id=?').get(orderId).pallet_num || 1;
    const result = db.prepare('INSERT INTO pallets (order_id,pallet_num,max_weight,total_weight) VALUES (?,?,?,0)').run(orderId, next, 500);
    return { id: result.lastInsertRowid, order_id: Number(orderId), pallet_num: next };
  }

  router.post('/orders/reservation-preview', requireAnyRole(['office', 'sales', 'manager', 'admin']), (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items.map(normalizeReservationPreviewItem) : [];
      const requiredByDiameter = new Map();

      for (const item of items) {
        if (!Number.isFinite(item.diameter) || item.diameter <= 0 || item.required_kg <= 0) continue;
        const key = String(item.diameter);
        const current = requiredByDiameter.get(key) || { diameter: item.diameter, material_type: item.material_type, required_kg: 0 };
        current.required_kg += item.required_kg;
        requiredByDiameter.set(key, current);
      }

      const byDiameter = {};
      const total = emptyReservationPreviewTotal();

      for (const [key, required] of requiredByDiameter.entries()) {
        const position = calculateMaterialStockPosition(db, {
          diameter: required.diameter,
          material_type: required.material_type,
        });
        const requiredKg = roundKg(required.required_kg);
        const availableKg = roundKg(position.availableKg);
        const incomingKg = roundKg(position.incomingKg);
        const shortageKg = roundKg(Math.max(0, requiredKg - availableKg));
        const recommendedPurchaseKg = roundKg(Math.max(0, shortageKg - incomingKg));

        const row = {
          required_kg: requiredKg,
          physical_kg: roundKg(position.physicalStockKg),
          reserved_kg: roundKg(position.reservedKg),
          available_kg: availableKg,
          shortage_kg: shortageKg,
          incoming_kg: incomingKg,
          recommended_purchase_kg: recommendedPurchaseKg,
        };
        byDiameter[key] = row;
        for (const field of Object.keys(total)) total[field] = roundKg(total[field] + row[field]);
      }

      res.json({ by_diameter: byDiameter, total });
    } catch (err) {
      console.error('reservation preview failed:', err);
      res.status(err.statusCode || 500).json({ error: 'reservation_preview_failed', message: err.message });
    }
  });

  router.post('/orders/price-preview', requireAnyRole(['finance', 'sales', 'manager', 'admin']), (req, res) => {
    try {
      const customerId = Number(req.body?.customer_id || 0) || null;
      const items = Array.isArray(req.body?.items) ? req.body.items.map(normalizePreviewItem) : [];
      if (!items.length) {
        return res.json({ lines: [], totals: { subtotal: 0, vat: 0, total: 0 }, missing_prices: [] });
      }

      const customer = pricePreviewCustomer(customerId);
      const pricingOptions = customer
        ? {
            tier: customer.price_tier === 'customer' ? 'customer' : 'general',
            customerId: customer.id,
            discountPct: customer.discount_pct || 0,
          }
        : { tier: 'general', customerId: null, discountPct: 0 };

      const lines = items.map((item, index) => {
        const resolved = pricer.resolveDiameterPrice(item.diameter, pricingOptions);
        const unitPrice = resolved.pricePerKg === null ? null : Number(resolved.pricePerKg);
        const lineTotal = unitPrice === null ? 0 : Number((item.totalWeight * unitPrice).toFixed(2));
        return {
          order_item_temp_id: item.order_item_temp_id ?? index,
          diameter: item.diameter,
          total_weight_kg: Number(item.totalWeight.toFixed(3)),
          quantity: item.quantity,
          unit_price: unitPrice === null ? null : Number(unitPrice.toFixed(3)),
          line_total: lineTotal,
          source_price_book: resolved.priceBookCode || resolved.pricingLabel || resolved.pricingSource || null,
          pricing_source: resolved.pricingSource || null,
          pricing_label: resolved.pricingLabel || null,
          requires_price_list_update: Boolean(resolved.requiresPriceListUpdate),
        };
      });

      const missingPrices = lines
        .filter(line => line.requires_price_list_update || line.unit_price === null)
        .map(line => ({
          order_item_temp_id: line.order_item_temp_id,
          diameter: line.diameter,
          reason: 'missing_diameter',
          source_price_book: line.source_price_book,
        }));
      const subtotal = Number(lines.reduce((sum, line) => sum + Number(line.line_total || 0), 0).toFixed(2));
      const vatRate = 0.18;
      const vat = Number((subtotal * vatRate).toFixed(2));
      const total = Number((subtotal + vat).toFixed(2));

      res.json({
        lines,
        totals: { subtotal, vat, total },
        missing_prices: missingPrices,
      });
    } catch (err) {
      console.error('price preview failed:', err);
      res.status(500).json({ error: 'price_preview_failed', message: err.message });
    }
  });

  router.get('/order-quotes', requireAnyRole(['office', 'sales', 'manager', 'admin']), (req, res) => {
    res.json(quotes.listQuotes({ status: req.query?.status }));
  });

  router.get('/order-quotes/:id', requireAnyRole(['office', 'sales', 'manager', 'admin']), (req, res) => {
    const quote = quotes.getQuote(req.params.id);
    if (!quote) return res.status(404).json({ error: 'הצעת מחיר לא נמצאה' });
    res.json(quote);
  });

  router.post('/order-quotes', requireAnyRole(['office', 'sales', 'manager', 'admin']), (req, res) => {
    try {
      const quote = quotes.createQuoteTransaction({
        payload: req.body?.payload,
        pricingSnapshot: req.body?.pricing_snapshot ?? req.body?.pricingSnapshot ?? null,
        createdBy: req.userId || req.auth?.sub || null,
      });
      auditLog('order_quote', quote.id, quote.quote_num, 'quote_create', 'status', null, quote.status, null, req.userId || req.auth?.sub || null, req.auth?.display_name || null);
      wsBroadcast('order_quote_created', { quoteId: quote.id, quoteNum: quote.quote_num });
      res.status(201).json({ success: true, quote });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/order-quotes/:id/approve', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    try {
      const result = quotes.approveQuoteTransaction({ quoteId: req.params.id, approvedBy: req.userId || req.auth?.sub || null });
      if (!result.alreadyConverted) {
        auditLog('order_quote', result.quote.id, result.quote.quote_num, 'quote_convert_to_order', 'status', 'pending_approval', 'converted', `נוצרה הזמנה ${result.orderNum}`, req.userId || req.auth?.sub || null, req.auth?.display_name || null);
        wsBroadcast('new_order', { orderNum: result.orderNum, orderId: result.orderId, quoteId: result.quote.id });
        wsBroadcast('order_quote_converted', { quoteId: result.quote.id, quoteNum: result.quote.quote_num, orderId: result.orderId, orderNum: result.orderNum });
      }
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.get('/orders', requireAnyRole(['office', 'production', 'sales', 'manager', 'admin']), (req, res) => {
    const { status, date, priority } = req.query;
    const page = listPage(req.query, { limit: 100, max: 500 });
    let sql = `SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email
               FROM orders o LEFT JOIN customers c ON o.customer_id = c.id`;
    const params = [];
    const where = [];
    if (status) { where.push('o.status = ?'); params.push(normalizeOrderStatus(status)); }
    if (date) { where.push('DATE(o.delivery_date)=?'); params.push(date); }
    if (priority) { where.push('o.priority = ?'); params.push(priority); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(page.limit, page.offset);
    res.json(db.prepare(sql).all(...params));
  });

  // Cancellation has its own review and commit routes.  A regular status
  // change is never allowed to bypass the production/disposition ledger.
  router.get('/orders/cancellation/warehouses', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (_req, res) => {
    res.json({ warehouses: cancellations.listWarehouses() });
  });

  router.get('/orders/:id/cancellation-review', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    try {
      res.json(cancellations.review({
        order_id: req.params.id,
        scope: 'order',
        production_record_correction_authorized: canCorrectStartedProduction(req.userPerm),
      }));
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.code || error.message, details: error.details || null });
    }
  });

  router.get('/orders/:orderId/items/:itemId/cancellation-review', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    try {
      res.json(cancellations.review({
        order_id: req.params.orderId,
        item_id: req.params.itemId,
        scope: 'item',
        production_record_correction_authorized: canCorrectStartedProduction(req.userPerm),
      }));
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.code || error.message, details: error.details || null });
    }
  });

  function submitCancellation(req, res, scope) {
    try {
      const bodyItems = req.body?.items ?? req.body?.item_dispositions ?? req.body?.itemDispositions
        ?? (scope === 'item' ? [{ ...req.body, item_id: req.params.itemId }] : undefined);
      const result = cancellations.cancel({
        ...req.body,
        items: bodyItems,
        order_id: req.params.orderId || req.params.id,
        item_id: scope === 'item' ? req.params.itemId : undefined,
        scope,
        actor_id: req.auth?.sub || req.userId || null,
        actor_name: req.auth?.display_name || null,
        production_record_correction_authorized: canCorrectStartedProduction(req.userPerm),
      });
      const order = db.prepare('SELECT id,order_num,status,customer_id FROM orders WHERE id=?').get(result.order_id);
      wsBroadcast('order_cancellation_disposition', {
        id: result.order_id,
        orderNum: order?.order_num || null,
        cancellationUid: result.cancellation_uid,
        scope: result.scope,
      });
      if (order?.status === ORDER_STATUS.CANCELLED) {
        wsBroadcast('order_status', { id: order.id, status: order.status, orderNum: order.order_num });
        if (!result.replay && order.customer_id) {
          const customer = db.prepare('SELECT phone FROM customers WHERE id=?').get(order.customer_id);
          if (customer?.phone) intake.notifyOrderStatus(customer.phone, order.order_num, order.status).catch(() => {});
        }
      }
      res.status(result.replay ? 200 : 201).json(result);
    } catch (error) {
      const known = error instanceof OrderCancellationError;
      res.status(error.statusCode || 400).json({ success: false, error: known ? error.code : error.message, details: error.details || null });
    }
  }

  router.post('/orders/:id/cancel', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    submitCancellation(req, res, 'order');
  });

  router.post('/orders/:orderId/items/:itemId/cancel', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    submitCancellation(req, res, 'item');
  });

  // Historical correction has a separate, manager-level route and never
  // changes the order lifecycle or inserts a cancellation transaction.
  router.get('/orders/:orderId/items/:itemId/historical-production-reconciliation-review', requireAnyRole(['manager', 'admin']), (req, res) => {
    try {
      res.json(historicalReconciliations.review({ order_id: req.params.orderId, item_id: req.params.itemId }));
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.code || error.message, details: error.details || null });
    }
  });

  router.post('/orders/:orderId/items/:itemId/historical-production-reconciliation', requireAnyRole(['manager', 'admin']), (req, res) => {
    try {
      const result = historicalReconciliations.reconcile({
        ...req.body,
        order_id: req.params.orderId,
        item_id: req.params.itemId,
        actor_id: req.auth?.sub || req.userId || null,
        actor_name: req.auth?.display_name || req.userRole || null,
        historical_reconciliation_authorized: canCorrectStartedProduction(req.userPerm),
      });
      wsBroadcast('historical_production_reconciled', {
        orderId: Number(req.params.orderId), itemId: Number(req.params.itemId),
        reconciliationUid: result.historical_reconciliation_uid,
      });
      res.status(result.replay ? 200 : 201).json(result);
    } catch (error) {
      const known = error instanceof OrderCancellationError;
      res.status(error.statusCode || 400).json({ success: false, error: known ? error.code : error.message, details: error.details || null });
    }
  });

  router.get('/orders/:id', requireAnyRole(['office', 'production', 'sales', 'manager', 'admin']), (req, res) => {
    const order = db.prepare(`SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email
      FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=?`).get(req.params.id);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    const pallets = db.prepare('SELECT * FROM pallets WHERE order_id=? ORDER BY pallet_num').all(order.id);
    pallets.forEach(p => {
      p.items = db.prepare('SELECT * FROM items WHERE pallet_id=? ORDER BY id').all(p.id);
      p.items.forEach(item => { item.shape_svg = productionCards.itemShapeSvg(item); });
    });
    order.pallets = pallets;
    // One computed-on-read projection serves current and historical orders.
    // It never rewrites an order and keeps overlapping kg services separate
    // from piece-based work such as chairs and rings.
    order.commercial_summary = buildOrderCommercialSummary(pallets.flatMap(p => p.items));
    res.json(order);
  });

  router.get('/orders/:id/intake-source', requireAnyRole(['office', 'production', 'sales', 'manager', 'admin']), (req, res) => {
    const row = db.prepare(`
      SELECT il.*, o.order_num, c.name AS customer_name
      FROM intake_log il
      JOIN orders o ON o.id = il.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE il.order_id = ?
      ORDER BY il.created_at DESC
      LIMIT 1
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'intake source not found' });
    let parsed = {};
    try { parsed = JSON.parse(row.parsed_data || '{}'); } catch {}
    res.json({ ...row, parsed });
  });

  router.post('/orders/manual', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const { machineId, diameter, qty, totalLengthMm, shape, note } = req.body;
    if (!machineId || !diameter || !qty || !totalLengthMm) {
      return res.status(400).json({ error: 'חסרים פרמטרים' });
    }
    const orderNum = 'MAN-' + Date.now().toString(36).toUpperCase();
    const totalWeight = industry.weightPerUnit({ diameter, total_length_mm: totalLengthMm }) * qty;

    const orderRow = db.prepare(
      `INSERT INTO orders (order_num,channel,delivery_date,delivery_address,priority,general_notes,total_weight,waste_pct_charged,billing_weight,created_by)
       VALUES (?,?,date('now'),?,?,?,?,3,?,?)`
    ).run(orderNum, 'ידני', 'מפעל', note || 'עבודה ידנית', 'רגיל', totalWeight, totalWeight * 1.03, null);

    const orderId = orderRow.lastInsertRowid;
    const palletRow = db.prepare('INSERT INTO pallets (order_id,pallet_num,max_weight,total_weight) VALUES (?,1,9999,?)').run(orderId, totalWeight);
    const palletId = palletRow.lastInsertRowid;

    const segments = JSON.stringify([{ length_mm: totalLengthMm, angle_deg: 0 }]);
    const itemRow = db.prepare(
      `INSERT INTO items (pallet_id,order_id,shape_id,shape_name,diameter,quantity,production_qty,segments,total_length_mm,weight_per_unit,status,machine_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(palletId, orderId, shape || 'straight', shape || 'ישר', diameter, qty, qty, segments, totalLengthMm, totalWeight / qty, 'בייצור', machineId);

    const itemId = itemRow.lastInsertRowid;
    db.prepare('UPDATE machines SET current_item_id=?,current_order_num=?,status=? WHERE id=?')
      .run(itemId, orderNum, 'בייצור', machineId);
    db.prepare('UPDATE items SET started_at=? WHERE id=?').run(new Date().toISOString(), itemId);

    const machineState = modbus.getState(machineId);
    if (machineState) {
      modbus.writeParams(machineId, { diameter, totalLengthMm, productionQty: qty, angles: [] }).catch(() => {});
    }
    wsBroadcast('machine_assign', { machineId: Number(machineId), itemId, orderNum });
    res.json({ success: true, orderNum, itemId });
  });

  router.post('/order-imports/preview', requireAnyRole(['office', 'manager', 'admin']), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Spreadsheet file is required' });
    try {
      const identity = sourceIdentityFromRequest(req, 'order_import');
      const duplicate = findSourceIdentityDuplicate(db, 'order_imports', identity);
      if (duplicate) return res.status(409).json(sourceIdentityConflictPayload('order_import', duplicate));
      const preview = buildOrderImportPreview(req.file.buffer, { sourceIdentity: identity });
      if (identity) preview.source_identity = identity;
      const result = db.prepare('INSERT INTO order_imports (filename,source_system,external_id,preview_data,status) VALUES (?,?,?,?,?)')
        .run(req.file.originalname || 'orders.xlsx', identity?.source_system || null, identity?.external_id || null, JSON.stringify(preview), 'preview');
      res.json({ success: true, importId: result.lastInsertRowid, preview });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/order-imports/:id/approve', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const row = db.prepare('SELECT * FROM order_imports WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Import preview not found' });
    if (row.status === 'approved') return res.json({ success: true, alreadyApproved: true });
    try {
      const preview = JSON.parse(row.preview_data || '{}');
      if (preview.errors?.length) throw Object.assign(new Error('Resolve spreadsheet validation errors before approval'), { statusCode: 400 });
      if (preview.orders?.some(order => order.duplicate)) {
        throw Object.assign(new Error('Resolve duplicate order numbers before approval'), { statusCode: 409 });
      }
      const approve = db.transaction(() => {
        const created = (preview.orders || []).map(order => createOrderFromPayload(order.payload));
        const orderIds = JSON.stringify(created.map(order => order.orderId).filter(Boolean));
        db.prepare("UPDATE order_imports SET status='approved',approved_at=CURRENT_TIMESTAMP,order_ids_json=? WHERE id=?").run(orderIds, row.id);
        return created;
      });
      const created = approve();
      created.forEach(order => wsBroadcast('new_order', { orderNum: order.orderNum, orderId: order.orderId }));
      res.json({ success: true, created });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/orders', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    try {
      const result = createOrderTransaction(req.body);
      wsBroadcast('new_order', { orderNum: result.orderNum, orderId: result.orderId });
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  function hasOrderProductionActivity(orderId) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM items i
      JOIN pallets p ON p.id=i.pallet_id
      WHERE p.order_id=?
        AND (
          COALESCE(i.produced_qty, 0) > 0
          OR i.started_at IS NOT NULL
          OR i.completed_at IS NOT NULL
          OR COALESCE(i.actual_weight_kg, 0) > 0
          OR i.status IN ('בייצור', 'הושלם', 'סופק')
          OR EXISTS (SELECT 1 FROM production_card_weights pcw WHERE pcw.item_id=i.id AND COALESCE(pcw.actual_weight_kg,0) > 0)
          OR EXISTS (SELECT 1 FROM production_output_events poe WHERE poe.item_id=i.id AND COALESCE(poe.delta_weight_kg,0) <> 0)
        )
      LIMIT 1
    `).get(orderId));
  }

  function hasOrderCancellationHistory(orderId) {
    return Boolean(db.prepare(`
      SELECT 1 FROM order_cancellation_transactions WHERE order_id=? LIMIT 1
    `).get(orderId));
  }

  function itemHasProductionEvidence(item) {
    if (Number(item.produced_qty || 0) > 0 || Number(item.actual_weight_kg || 0) > 0
      || item.started_at !== null || item.completed_at !== null
      || ['בייצור', 'הושלם', 'סופק'].includes(item.status)) return true;
    return Boolean(db.prepare(`
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM production_card_weights WHERE item_id=? AND COALESCE(actual_weight_kg,0)>0)
         OR EXISTS (SELECT 1 FROM production_output_events WHERE item_id=? AND COALESCE(delta_weight_kg,0)<>0)
    `).get(item.id, item.id));
  }

  function correctionReason(value) {
    const reason = String(value || '').trim();
    return reason.length >= 3 && reason.length <= 1000 ? reason : null;
  }

  function canCorrectStartedProduction(permission) {
    // The permission engine, not a browser role string, is authoritative.
    // Its current management tier is level 90+; production staff are level 50.
    return Number(permission?.level || 0) >= 90 && permission?.canApprove === true;
  }

  function baseOrderEditError(order) {
    if (normalizeOrderStatus(order.status) === ORDER_STATUS.CANCELLED) {
      return { statusCode: 409, message: 'לא ניתן לערוך הזמנה שבוטלה; היסטוריית הביטול נשמרת' };
    }
    if (order.locked) {
      return { statusCode: 403, message: 'לא ניתן לערוך הזמנה נעולה' };
    }
    if (hasOrderLeftFactory(order)) {
      return { statusCode: 409, message: 'לא ניתן לערוך הזמנה אחרי שיצאה מהמפעל' };
    }
    return null;
  }

  function orderHeaderEditError(order, { permission, correctionReason: reason } = {}) {
    const baseError = baseOrderEditError(order);
    if (baseError) return baseError;
    if (hasOrderProductionActivity(order.id || order.order_id)) {
      if (!canCorrectStartedProduction(permission)) {
        return { statusCode: 403, message: 'לאחר תחילת ייצור רק מנהל מורשה יכול לערוך את ההזמנה' };
      }
      if (!correctionReason(reason)) {
        return { statusCode: 400, message: 'נדרשת סיבת תיקון לאחר תחילת ייצור' };
      }
    }
    return null;
  }

  function orderDeleteError(order) {
    const baseError = baseOrderEditError(order);
    // Preserve the established delete-route contract for dispatched orders.
    if (baseError) return baseError.statusCode === 409
      ? { ...baseError, statusCode: 403 }
      : baseError;
    if (hasOrderProductionActivity(order.id || order.order_id)) {
      return { statusCode: 409, message: 'לא ניתן למחוק הזמנה לאחר שהחלה ייצור באחת הכרטיסיות' };
    }
    if (hasOrderCancellationHistory(order.id || order.order_id)) {
      return { statusCode: 409, message: 'לא ניתן למחוק הזמנה עם היסטוריית ביטול' };
    }
    return null;
  }

  function itemUpdateError(item, { permission, correctionReason: reason } = {}) {
    const baseError = baseOrderEditError({ id: item.order_id, locked: item.locked, status: item.order_status });
    if (baseError) return baseError;
    if (item.status === ITEM_STATUS.CANCELLED || item.cancelled_at != null || item.production_stopped_at != null) {
      return { statusCode: 409, message: 'לא ניתן לערוך כרטיסייה שבוטלה; היסטוריית הייצור וההחלטה נשמרות' };
    }
    const itemStarted = itemHasProductionEvidence(item);
    if (itemStarted) {
      if (!canCorrectStartedProduction(permission)) {
        return { statusCode: 403, message: 'לאחר תחילת ייצור של הכרטיסייה רק מנהל מורשה יכול לתקן אותה' };
      }
      if (!correctionReason(reason)) {
        return { statusCode: 400, message: 'נדרשת סיבת תיקון לכרטיסייה שכבר החלה ייצור' };
      }
    }
    return null;
  }

  function itemDeleteError(item) {
    const baseError = baseOrderEditError({ id: item.order_id, locked: item.locked, status: item.order_status });
    if (baseError) return baseError;
    const itemStarted = itemHasProductionEvidence(item);
    const itemCancelled = item.status === ITEM_STATUS.CANCELLED || item.cancelled_at != null
      || Boolean(db.prepare('SELECT 1 FROM order_cancellation_item_dispositions WHERE source_order_item_id=?').get(item.id));
    if (itemCancelled) return { statusCode: 409, message: 'לא ניתן למחוק כרטיסייה עם היסטוריית ביטול' };
    return itemStarted
      ? { statusCode: 409, message: 'לא ניתן למחוק כרטיסייה שכבר החלה ייצור; מנהל יכול לבצע תיקון מתועד בלבד' }
      : null;
  }

  function trimOptionalText(value, field, maxLength = 2000) {
    if (value === undefined) return undefined;
    const text = String(value || '').trim();
    if (text.length > maxLength) throw Object.assign(new Error(`invalid ${field}`), { statusCode: 400 });
    return text || null;
  }

  function orderHeaderSnapshot(order) {
    return {
      customer_id: order.customer_id || null,
      delivery_date: order.delivery_date || null,
      delivery_time: order.delivery_time || null,
      delivery_address: order.delivery_address || null,
      priority: order.priority || 'רגיל',
      channel: order.channel || null,
      driver_notes: order.driver_notes || null,
      general_notes: order.general_notes || null,
    };
  }

  router.patch('/orders/:id', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const blocked = orderHeaderEditError(order, {
      permission: req.userPerm,
      correctionReason: req.body?.correction_reason ?? req.body?.correctionReason,
    });
    if (blocked) return res.status(blocked.statusCode).json({ error: blocked.message });

    try {
      const customerInput = req.body?.customer_id ?? req.body?.customerId;
      let customerId = order.customer_id || null;
      if (customerInput !== undefined) {
        if (customerInput === null || customerInput === '') {
          customerId = null;
        } else {
          customerId = Number(customerInput);
          if (!Number.isInteger(customerId) || customerId <= 0 || !db.prepare('SELECT 1 FROM customers WHERE id=?').get(customerId)) {
            throw Object.assign(new Error('לקוח לא נמצא'), { statusCode: 400 });
          }
        }
      }

      const deliveryDate = trimOptionalText(req.body?.delivery_date ?? req.body?.deliveryDate, 'delivery_date', 30);
      if (deliveryDate !== undefined && deliveryDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
        throw Object.assign(new Error('invalid delivery_date'), { statusCode: 400 });
      }
      const deliveryTime = trimOptionalText(req.body?.delivery_time ?? req.body?.deliveryTime, 'delivery_time', 10);
      if (deliveryTime !== undefined && deliveryTime !== null && !/^\d{2}:\d{2}$/.test(deliveryTime)) {
        throw Object.assign(new Error('invalid delivery_time'), { statusCode: 400 });
      }
      const priority = req.body?.priority === undefined ? order.priority : String(req.body.priority || '').trim();
      if (!['רגיל', 'דחוף'].includes(priority)) {
        throw Object.assign(new Error('invalid priority'), { statusCode: 400 });
      }

      const next = {
        customer_id: customerId,
        delivery_date: deliveryDate === undefined ? order.delivery_date || null : deliveryDate,
        delivery_time: deliveryTime === undefined ? order.delivery_time || null : deliveryTime,
        delivery_address: trimOptionalText(req.body?.delivery_address ?? req.body?.deliveryAddress, 'delivery_address') ?? (req.body?.delivery_address === undefined && req.body?.deliveryAddress === undefined ? order.delivery_address || null : null),
        priority,
        channel: trimOptionalText(req.body?.channel, 'channel', 80) ?? (req.body?.channel === undefined ? order.channel || null : null),
        driver_notes: trimOptionalText(req.body?.driver_notes ?? req.body?.driverNotes, 'driver_notes') ?? (req.body?.driver_notes === undefined && req.body?.driverNotes === undefined ? order.driver_notes || null : null),
        general_notes: trimOptionalText(req.body?.general_notes ?? req.body?.generalNotes, 'general_notes') ?? (req.body?.general_notes === undefined && req.body?.generalNotes === undefined ? order.general_notes || null : null),
      };
      const before = orderHeaderSnapshot(order);
      const customerChanged = Number(before.customer_id || 0) !== Number(next.customer_id || 0);

      db.prepare(`
        UPDATE orders
        SET customer_id=?, delivery_date=?, delivery_time=?, delivery_address=?, priority=?, channel=?,
            driver_notes=?, general_notes=?, site_id=CASE WHEN ? THEN NULL ELSE site_id END
        WHERE id=?
      `).run(
        next.customer_id,
        next.delivery_date,
        next.delivery_time,
        next.delivery_address,
        next.priority,
        next.channel,
        next.driver_notes,
        next.general_notes,
        customerChanged ? 1 : 0,
        order.id,
      );

      const updated = db.prepare(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
        FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?`).get(order.id);
      const auditReason = correctionReason(req.body?.correction_reason ?? req.body?.correctionReason);
      auditLog('order', order.id, order.order_num, 'order_update', 'order_header', JSON.stringify(before), JSON.stringify(orderHeaderSnapshot(updated)), auditReason, req.auth?.sub || req.userId || null, req.auth?.display_name || null);
      wsBroadcast('order_updated', { id: Number(order.id), orderNum: order.order_num });
      res.json({ success: true, order: updated });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.patch('/orders/:id/status', requireAnyRole(['office', 'production', 'manager', 'admin']), (req, res) => {
    const { status, userId, userName } = req.body;
    if (!status) return res.status(400).json({ error: 'חסר סטטוס' });
    const requestedStatus = normalizeOrderStatus(status);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    if (requestedStatus === ORDER_STATUS.CANCELLED) {
      return res.status(409).json({
        error: 'cancellation_review_required',
        message: 'ביטול הזמנה מתבצע רק דרך סקירת ביטול והחלטת מלאי/גריטה',
        cancellation_review_url: `/api/orders/${order.id}/cancellation-review`,
      });
    }
    if (order.locked) return res.status(403).json({ error: 'הזמנה נעולה' });
    let transition;
    try {
      transition = assertOrderStatusTransition({ from: order.status, to: requestedStatus, role: req.userRole });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        from: error.from || order.status,
        to: error.to || requestedStatus,
        allowed: error.allowed || allowedOrderTransitions(order.status),
      });
    }
    const old = order.status;
    const approvedAt = transition.isApproval ? new Date().toISOString() : null;
    db.prepare(
      'UPDATE orders SET status=?, stable_order_id=COALESCE(stable_order_id, order_num), approved_by=CASE WHEN ? THEN ? ELSE approved_by END, approved_at=CASE WHEN ? THEN ? ELSE approved_at END WHERE id=?'
    ).run(requestedStatus, transition.isApproval ? 1 : 0, req.userId || userId || null, transition.isApproval ? 1 : 0, approvedAt, order.id);
    const releasedReservations = { order_id: order.id, released: 0 };
    auditLog('order', order.id, order.order_num, 'status_change', 'status', old, requestedStatus, null, req.userId || userId || null, req.auth?.display_name || userName || null);
    if (transition.isApproval) {
      auditLog('order', order.id, order.order_num, 'manager_approval', 'approved_by', null, req.userId || userId || null, null, req.userId || userId || null, req.auth?.display_name || userName || null);
    }
    wsBroadcast('order_status', { id: order.id, status: requestedStatus, orderNum: order.order_num });
    if (order.customer_id) {
      const c = db.prepare('SELECT phone FROM customers WHERE id=?').get(order.customer_id);
      if (c?.phone) intake.notifyOrderStatus(c.phone, order.order_num, requestedStatus).catch(() => {});
    }
    res.json({ success: true, releasedReservations });
  });

  router.post('/orders/:orderId/items', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    const blocked = baseOrderEditError(order);
    if (blocked) return res.status(blocked.statusCode).json({ error: blocked.message });

    try {
      const item = cleanItemPayload(req.body, { shape_name: '', diameter: 12, quantity: 1, total_length_mm: 0, segments: '[]' });
      const pallet = firstOrCreatePallet(order.id);
      const hasOrderIdColumn = db.prepare("PRAGMA table_info(items)").all().some(column => column.name === 'order_id');
      const shapeSnapshot = buildOrderItemShapeSnapshotJson(req.body, { shapeId: req.body.shapeId || req.body.shape_id || item.shapeName, shapeName: item.shapeName, diameter: item.diameter, segments: item.segments, totalLengthMm: item.totalLengthMm, spiralDiameterMm: item.spiralDiameter || null, spiralTurns: item.spiralTurns || null, note: item.note, structElement: item.structElement, structFloor: item.structFloor, sheetNum: item.sheetNum });
      const columns = ['pallet_id', 'shape_snapshot_json', 'shape_id', 'shape_name', 'diameter', 'quantity', 'production_qty', 'segments', 'total_length_mm', 'weight_per_unit', 'total_weight', 'note', 'status', 'spiral_diameter_mm', 'spiral_turns', 'review_status', 'struct_element', 'struct_floor', 'sheet_num'];
      const values = [pallet.id, shapeSnapshot, item.shapeName, item.shapeName, item.diameter, item.quantity, item.quantity, item.segments, item.totalLengthMm, item.weightPerUnit, item.totalWeight, item.note, 'ממתין', item.spiralDiameter || null, item.spiralTurns || null, 'pending', item.structElement || null, item.structFloor || null, item.sheetNum || null];
      if (hasOrderIdColumn) {
        columns.splice(1, 0, 'order_id');
        values.splice(1, 0, order.id);
      }
      const placeholders = columns.map(() => '?').join(',');
      const result = db.prepare(`INSERT INTO items (${columns.join(',')}) VALUES (${placeholders})`).run(...values);
      db.prepare('UPDATE items SET item_uid=COALESCE(item_uid, ?) WHERE id=?').run(buildOrderItemUid(order.id, result.lastInsertRowid), result.lastInsertRowid);
      const orderTotal = recalcOrderWeights(order.id);

      auditLog('item', result.lastInsertRowid, order.order_num, 'item_add', 'shape_payload', null, JSON.stringify(req.body), item.note || null, req.auth?.sub || null, req.auth?.display_name || null);
      wsBroadcast('order_item_added', { orderId: Number(order.id), itemId: Number(result.lastInsertRowid), orderNum: order.order_num });
      res.json({ success: true, itemId: Number(result.lastInsertRowid), total_weight: item.totalWeight, order_total_weight: orderTotal });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });
  router.patch('/orders/:orderId/items/:itemId', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const item = db.prepare(`
      SELECT i.*, p.order_id, o.order_num, o.locked, o.status AS order_status
      FROM items i
      JOIN pallets p ON p.id = i.pallet_id
      JOIN orders o ON o.id = p.order_id
      WHERE i.id=? AND p.order_id=?
    `).get(req.params.itemId, req.params.orderId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    const blocked = itemUpdateError(item, {
      permission: req.userPerm,
      correctionReason: req.body?.correction_reason ?? req.body?.correctionReason,
    });
    if (blocked) return res.status(blocked.statusCode).json({ error: blocked.message });

    let cleanItem;
    try {
      cleanItem = cleanItemPayload(req.body, item);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    const { shapeName, diameter, quantity, totalLengthMm, segments, spiralDiameter, spiralTurns, note, structElement, structFloor, sheetNum, weightPerUnit, totalWeight } = cleanItem;
    const alreadyProduced = Math.max(0, Number(item.produced_qty || 0));
    if (alreadyProduced > 0 && quantity < alreadyProduced) {
      return res.status(409).json({ error: 'לא ניתן להקטין כמות מתחת לכמות שכבר יוצרה' });
    }
    const before = JSON.stringify({
      shape_name: item.shape_name,
      diameter: item.diameter,
      quantity: item.quantity,
      total_length_mm: item.total_length_mm,
      segments: item.segments,
    });
    const nextShapeSnapshot = synchronizedShapeSnapshotForItem(item, req.body, cleanItem);
    const nextShapeId = shapeIdFromSnapshotJson(nextShapeSnapshot, req.body.shapeId || req.body.shape_id || item.shape_id || shapeName);
    const updateResult = db.transaction(() => {
      const releasedReservations = releaseReservationsForItems(db, { item_ids: [item.id] });
      db.prepare(`
        UPDATE items
        SET shape_id=?, shape_name=?, diameter=?, quantity=?, production_qty=?, total_length_mm=?,
            segments=?, spiral_diameter_mm=?, spiral_turns=?, weight_per_unit=?, total_weight=?,
            item_uid=COALESCE(item_uid, ?), shape_snapshot_json=?,
            note=?, struct_element=?, struct_floor=?, sheet_num=?, review_status='pending', reviewed_by=NULL, reviewed_at=NULL
        WHERE id=?
      `).run(nextShapeId, shapeName, diameter, quantity, quantity, totalLengthMm, segments, spiralDiameter || null, spiralTurns || null, weightPerUnit, totalWeight, buildOrderItemUid(req.params.orderId, item.id), nextShapeSnapshot, note, structElement || null, structFloor || null, sheetNum || null, item.id);
      const inventoryReservations = reserveMaterialForOrder(db, {
        order_id: Number(req.params.orderId),
        items: [{
          id: item.id,
          item_id: item.id,
          diameter,
          material_type: item.material_type || item.materialType || 'coil',
          total_weight: totalWeight,
          quantity,
          weight_per_unit: weightPerUnit,
          shape_snapshot_json: nextShapeSnapshot,
        }],
      });
      const orderTotal = recalcOrderWeights(req.params.orderId);
      return { releasedReservations, inventoryReservations, orderTotal };
    })();
    const { releasedReservations, inventoryReservations, orderTotal } = updateResult;


    const auditReason = correctionReason(req.body?.correction_reason ?? req.body?.correctionReason);
    auditLog('item', item.id, item.order_num, 'item_update', 'shape_payload', before, JSON.stringify(req.body), auditReason || note || null, req.auth?.sub || null, req.auth?.display_name || null);
    wsBroadcast('order_item_updated', { orderId: Number(req.params.orderId), itemId: Number(item.id), orderNum: item.order_num });
    res.json({ success: true, itemId: Number(item.id), total_weight: totalWeight, order_total_weight: orderTotal, releasedReservations, inventoryReservations });
  });

  router.delete('/orders/:orderId/items/:itemId', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const item = db.prepare(`
      SELECT i.*, p.order_id, o.order_num, o.locked, o.status AS order_status
      FROM items i
      JOIN pallets p ON p.id = i.pallet_id
      JOIN orders o ON o.id = p.order_id
      WHERE i.id=? AND p.order_id=?
    `).get(req.params.itemId, req.params.orderId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    const blocked = itemDeleteError(item);
    if (blocked) return res.status(blocked.statusCode).json({ error: blocked.message });

    const before = JSON.stringify({
      shape_name: item.shape_name,
      diameter: item.diameter,
      quantity: item.quantity,
      total_length_mm: item.total_length_mm,
      segments: item.segments,
    });
    const deleteResult = db.transaction(() => {
      const releasedReservations = releaseReservationsForItems(db, { item_ids: [item.id] });
      db.prepare("UPDATE inventory_reservations SET item_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE item_id=? AND status='released'").run(item.id);
      db.prepare('DELETE FROM items WHERE id=?').run(item.id);
      db.prepare(`
        DELETE FROM pallets
        WHERE order_id=?
          AND NOT EXISTS (SELECT 1 FROM items WHERE items.pallet_id=pallets.id)
      `).run(req.params.orderId);
      const orderTotal = recalcOrderWeights(req.params.orderId);
      return { releasedReservations, orderTotal };
    })();
    const { releasedReservations, orderTotal } = deleteResult;

    auditLog('item', item.id, item.order_num, 'item_delete', 'shape_payload', before, null, item.note || null, req.auth?.sub || null, req.auth?.display_name || null);
    wsBroadcast('order_item_deleted', { orderId: Number(req.params.orderId), itemId: Number(item.id), orderNum: item.order_num });
    res.json({ success: true, itemId: Number(item.id), order_total_weight: orderTotal, releasedReservations });
  });
  router.patch('/orders/:orderId/items/:itemId/review', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const status = String(req.body?.status || 'approved').trim();
    if (!['approved', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'invalid review status' });
    }
    const item = db.prepare('SELECT i.*, o.order_num FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=? AND i.order_id=?')
      .get(req.params.itemId, req.params.orderId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    const reviewedAt = status === 'approved' ? new Date().toISOString() : null;
    const reviewedBy = status === 'approved' ? (req.auth?.sub || null) : null;
    db.prepare(`
      UPDATE items
      SET review_status=?, review_notes=?, reviewed_by=?, reviewed_at=?
      WHERE id=? AND order_id=?
    `).run(status, req.body?.notes || null, reviewedBy, reviewedAt, item.id, req.params.orderId);
    auditLog('item', item.id, item.order_num, 'review_status', 'review_status', item.review_status || null, status, req.body?.notes || null, req.auth?.sub || null, req.auth?.display_name || null);
    wsBroadcast('order_review', { orderId: Number(req.params.orderId), itemId: Number(item.id), status });
    res.json({ success: true, status, reviewed_at: reviewedAt });
  });

  router.patch('/orders/:id/lock', requireRole('manager'), (req, res) => {
    const { userId, userName } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    db.prepare('UPDATE orders SET locked=1,locked_by=?,locked_at=? WHERE id=?').run(userId || null, new Date().toISOString(), order.id);
    auditLog('order', order.id, order.order_num, 'lock', 'locked', '0', '1', 'נעילה לאחר שילוח', userId, userName);
    res.json({ success: true });
  });

  router.patch('/orders/:id/unlock', requireRole('manager'), (req, res) => {
    const { userId, userName } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'לא נמצא' });
    db.prepare('UPDATE orders SET locked=0,locked_by=NULL,locked_at=NULL WHERE id=?').run(order.id);
    auditLog('order', order.id, order.order_num, 'unlock', 'locked', '1', '0', 'פתיחת נעילה', userId, userName);
    res.json({ success: true });
  });

  function hasOrderLeftFactory(order) {
    const status = normalizeOrderStatus(order.status);
    return [
      ORDER_STATUS.ON_THE_WAY,
      ORDER_STATUS.SENT,
      ORDER_STATUS.DELIVERY_PROBLEM,
      ORDER_STATUS.DELIVERED_CONFIRMED,
    ].includes(status);
  }

  router.delete('/orders/:id', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const blocked = orderDeleteError(order);
    if (blocked) return res.status(blocked.statusCode).json({ error: blocked.message });

    const before = JSON.stringify({ order_num: order.order_num, status: order.status });
    const deletion = db.transaction(() => {
      const releasedReservations = releaseAllReservationsForOrder(db, { order_id: order.id });
      db.prepare('DELETE FROM production_card_weights WHERE order_id=?').run(order.id);
      db.prepare('DELETE FROM scan_log WHERE order_num=?').run(order.order_num);
      db.prepare('DELETE FROM items WHERE pallet_id IN (SELECT id FROM pallets WHERE order_id=?)').run(order.id);
      db.prepare('DELETE FROM pallets WHERE order_id=?').run(order.id);
      db.prepare('DELETE FROM orders WHERE id=?').run(order.id);
      return releasedReservations;
    });
    const releasedReservations = deletion();

    auditLog('order', order.id, order.order_num, 'order_delete', 'status', before, null, 'מחיקת הזמנה', req.auth?.sub || null, req.auth?.display_name || null);
    wsBroadcast('order_deleted', { orderId: Number(order.id), orderNum: order.order_num });
    res.json({ success: true, orderNum: order.order_num, releasedReservations });
  });

  return router;
};

module.exports.manifest = {
  id: 'orders',
  label: 'הזמנות',
  screens: [
    { id: 'orders',    path: '/orders.html', label: 'הזמנות',     icon: '📋', group: 'ראשי' },
    { id: 'order-quotes', path: '/orders.html?view=quotes', label: 'הצעות מחיר', icon: '💬', group: 'ראשי' },
    { id: 'new-order', path: '/index.html',  label: 'הזמנה חדשה', icon: '➕', group: 'ראשי' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'edit', warehouse: 'edit', finance: 'read', production: 'read', sales: 'read' },
  },
  consumes: [
    { table: 'customers' }, { table: 'orders' }, { table: 'order_quotes' }, { table: 'items' }, { table: 'production_output_events' },
    { table: 'historical_production_reconciliation_transactions' }, { table: 'historical_production_reconciliation_items' },
  ],
  produces: [
    { event: 'new_order' },
    { event: 'order_quote_created' },
    { event: 'order_quote_converted' },
    { event: 'order_status' },
    { event: 'order_updated' },
    { event: 'order_review' },
    { event: 'order_item_updated' },
    { event: 'order_item_added' },
    { event: 'order_item_deleted' },
    { event: 'order_cancellation_disposition' },
    { event: 'historical_production_reconciled' },
    { event: 'order_deleted' },
    { event: 'machine_assign' },
  ],
};

