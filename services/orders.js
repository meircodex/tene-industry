function validateShapeGeometry(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { valid: false, error: 'חסרים קטעים (segments)' };
  }
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (typeof seg.length_mm !== 'number' || seg.length_mm <= 0) {
      return { valid: false, error: `קטע ${i + 1}: אורך חייב להיות מספר חיובי (קיבלנו: ${seg.length_mm})` };
    }
    if (seg.length_mm > 20000) {
      return { valid: false, error: `קטע ${i + 1}: אורך ${seg.length_mm / 10} ס״מ חורג מ-2,000 ס״מ` };
    }
    if (typeof seg.angle_deg !== 'number') {
      return { valid: false, error: `קטע ${i + 1}: זווית חייבת להיות מספר` };
    }
    if (seg.angle_deg < 0 || seg.angle_deg > 360) {
      return { valid: false, error: `קטע ${i + 1}: זווית ${seg.angle_deg}° חייבת להיות בין 0° ל-360°` };
    }
  }
  if (segments.length > 30) {
    return { valid: false, error: `יותר מדי קטעים: ${segments.length} (מקסימום 30)` };
  }
  return { valid: true };
}

const steelModule = require('../modules/steel-rebar');
const { normalizeSpiralParams, spiralCutLengthMm } = require('../modules/steel-rebar/shapes');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const {
  allocateOrderItemStock,
  openProcurementForStockShortages,
  normalizeStockAllocationPolicy,
  selectedRawMaterialId,
} = require('./inventory');
const { createStableOrderId, buildOrderItemUid, shapeSnapshotJson, isShapeDataContractV2, withShapeContractLegacyFields } = require('./orderContracts');
const { reserveMaterialForOrder } = require('./inventoryReservation');
const { validateCustomerTaxId, normalizeCustomerTaxId, findCustomersByTaxId, assertCustomerTaxIdAvailable, customerIdentityError, mergedCustomerId } = require('./customerIdentity');

function parseShapeSnapshotObject(value) {
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

function roundPileCageOrderMetrics(item = {}) {
  const snapshot = parseShapeSnapshotObject(item.shapeSnapshot ?? item.shape_snapshot ?? item.shapeData ?? item.shape_data ?? item.shapeContract ?? item.shape_contract ?? item.shape_snapshot_json);
  if (snapshot?.family !== 'piles' || snapshot?.shapeType !== 'round_pile_cage') return null;
  if (snapshot.validation && (snapshot.validation.ok === false || snapshot.validation.valid === false)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  const canonical = calculatePileCage(snapshot);
  if (!canonical.validation?.ok || canonical.productionCards?.length !== 5) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  const weightKg = Number(canonical.calculated?.totalWeightKg);
  const physicalLengthMm = Number(canonical.assemblySummary?.pileLengthMm);
  if (!(weightKg > 0) || !(physicalLengthMm > 0)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 400 });
  return { snapshot, weightKg, physicalLengthMm };
}

// A lift is a bought bundle: its weight comes off the scale, and the package
// count is only a count. Anything derived from diameter and length would be a
// guess about steel we never bent.
function liftPackageOrderMetrics(item = {}) {
  const snapshot = parseShapeSnapshotObject(item.shapeSnapshot ?? item.shape_snapshot ?? item.shapeData ?? item.shape_data ?? item.shapeContract ?? item.shape_contract ?? item.shape_snapshot_json);
  if (snapshot?.family !== 'lifts' || snapshot?.shapeType !== 'lift_package') return null;
  const weighedKg = Number(snapshot.calculated?.totalWeightKg ?? snapshot.calculated?.weighedKg ?? snapshot.data?.weighedKg);
  if (!(weighedKg > 0)) return null;
  const packages = Math.max(1, Number(item.qty ?? item.quantity ?? 1) || 1);
  // orders.js multiplies weightPerUnit by the quantity, so hand it the share
  // per package and the line lands back on the weighed total.
  const barLengthMm = Number(snapshot.calculated?.totalLengthMm ?? snapshot.data?.barLength) || 0;
  return { snapshot, weighedKg, barLengthMm, weightPerUnit: weighedKg / packages };
}

function createOrderFactory(db, { generateOrderNum, industry, settingsService = null }) {
  if (!db) throw new Error('services/orders missing dependency: db');
  if (!generateOrderNum) throw new Error('services/orders missing dependency: generateOrderNum');
  if (!industry) throw new Error('services/orders missing dependency: industry');

  const normalizeSegments = industry.normalizeSegments;
  const normalizeShapeName = industry.normalizeShapeName;
  const assignResource = industry.assignResource;
  if (!normalizeSegments) throw new Error('services/orders missing industry contract: normalizeSegments');
  if (!normalizeShapeName) throw new Error('services/orders missing industry contract: normalizeShapeName');
  if (!assignResource) throw new Error('services/orders missing industry contract: assignResource');
  if (!industry.weightPerUnit) throw new Error('services/orders missing industry contract: weightPerUnit');

  function calcWeightPerUnit(diameter, totalLengthMm) {
    return industry.weightPerUnit({ diameter, total_length_mm: totalLengthMm });
  }

  function createOrderFromPayload(payload) {
    const { customer = {}, order = {}, pallets = [] } = payload || {};
    if (!customer.name?.trim()) throw Object.assign(new Error('customer.name is required'), { statusCode: 400 });
    if (!pallets.length || !pallets.some(pallet => pallet.items?.length)) {
      throw Object.assign(new Error('At least one order item is required'), { statusCode: 400 });
    }

    let customerId;
    const phone = (customer.phone || '').trim();
    const name = (customer.name || '').trim();
    const taxId = validateCustomerTaxId(customer.taxId ?? customer.tax_id);
    let existing = null;
    let matchedByArchive = false;
    if (customer.id) {
      existing = db.prepare('SELECT id,name,phone,email,address,contact_name,contact_phone,tax_id FROM customers WHERE id=?').get(customer.id);
      if (!existing) {
        const canonicalId = mergedCustomerId(db, customer.id);
        if (canonicalId) {
          existing = db.prepare('SELECT id,name,phone,email,address,contact_name,contact_phone,tax_id FROM customers WHERE id=?').get(canonicalId);
          matchedByArchive = true;
        }
      }
      if (!existing) throw customerIdentityError('customer_not_found', 'כרטיס הלקוח שנבחר לא נמצא', 404);
      if (taxId && normalizeCustomerTaxId(existing.tax_id) && normalizeCustomerTaxId(existing.tax_id) !== taxId) {
        throw customerIdentityError('customer_tax_id_mismatch', 'הח.פ אינו תואם לכרטיס הלקוח שנבחר', 409);
      }
      if (taxId && !normalizeCustomerTaxId(existing.tax_id)) assertCustomerTaxIdAvailable(db, taxId, existing.id);
    }
    let matchedByTaxId = matchedByArchive || Boolean(taxId && normalizeCustomerTaxId(existing?.tax_id));
    if (!existing && taxId) {
      const matches = findCustomersByTaxId(db, taxId);
      if (matches.length > 1) throw customerIdentityError('ambiguous_customer_tax_id', 'ח.פ זה מופיע בכמה כרטיסים קיימים. נדרשת בדיקת מנהל לפני שיוך ההזמנה.', 409);
      if (matches.length === 1) {
        existing = db.prepare('SELECT * FROM customers WHERE id=?').get(matches[0].id);
        matchedByTaxId = true;
      }
    }
    if (!existing && !taxId && phone) {
      const matches = db.prepare('SELECT id FROM customers WHERE phone=? LIMIT 2').all(phone);
      if (matches.length > 1) throw customerIdentityError('ambiguous_customer_phone', 'הטלפון מופיע בכמה לקוחות. יש לבחור כרטיס לקוח או להזין ח.פ.', 409);
      existing = matches[0] || null;
    }
    if (!existing && !taxId && name) {
      const matches = db.prepare("SELECT id FROM customers WHERE name=? AND (phone IS NULL OR phone='') ORDER BY id DESC LIMIT 2").all(name);
      if (matches.length > 1) throw customerIdentityError('ambiguous_customer_name', 'נמצאו כמה לקוחות בשם זה. יש לבחור כרטיס לקוח או להזין ח.פ.', 409);
      existing = matches[0] || null;
    }
    if (existing) {
      customerId = existing.id;
      // A tax-ID match identifies the account; an order is not permission to
      // rename it or overwrite its contact details with differently typed text.
      if (!matchedByTaxId) {
      db.prepare(`
        UPDATE customers
        SET name=COALESCE(?,name),
            phone=COALESCE(?,phone),
            email=COALESCE(?,email),
            address=COALESCE(?,address),
            contact_name=COALESCE(?,contact_name),
            contact_phone=COALESCE(?,contact_phone)
        WHERE id=?
      `).run(
        name || null,
        phone || null,
        customer.email || null,
        customer.address || null,
        customer.contactName || null,
        customer.contactPhone || null,
        customerId
      );
      }
      if (taxId && !normalizeCustomerTaxId(existing.tax_id)) db.prepare('UPDATE customers SET tax_id=? WHERE id=?').run(taxId, customerId);
    } else {
      const r = db.prepare('INSERT INTO customers (name,phone,email,address,contact_name,contact_phone,tax_id) VALUES (?,?,?,?,?,?,?)')
        .run(name || customer.name, phone || null, customer.email || null, customer.address, customer.contactName, customer.contactPhone, taxId);
      customerId = r.lastInsertRowid;
    }

    const orderSiteId = Number(order.siteId || order.site_id || 0) || null;
    if (orderSiteId) {
      const site = db.prepare('SELECT id FROM customer_sites WHERE id=? AND customer_id=?').get(orderSiteId, customerId);
      if (!site) throw Object.assign(new Error('site_id does not belong to customer'), { statusCode: 400 });
    }

    const orderNum = order.orderNum || generateOrderNum();
    const inventoryPolicy = normalizeStockAllocationPolicy(
      order.inventoryAllocationPolicy || order.stockAllocationPolicy || settingsService?.get('INVENTORY_ALLOCATION_POLICY', 'auto_fifo')
    );
    const wastePct = order.wastePctCharged ?? 3;
    const totalWeight = order.totalWeight ?? 0;
    const billingWeight = totalWeight * (1 + wastePct / 100);

    const quoteId = Number(order.quoteId || order.quote_id || 0) || null;
    const quoteNum = String(order.quoteNum || order.quote_num || '').trim() || null;
    const salePrice = Number(order.salePrice ?? order.sale_price ?? order.quoteTotal ?? 0) || 0;
    const orderResult = db.prepare(`
      INSERT INTO orders (order_num,stable_order_id,quote_id,quote_num,customer_id,site_id,channel,delivery_date,delivery_time,delivery_address,priority,driver_notes,general_notes,total_weight,waste_pct_charged,billing_weight,sale_price,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(orderNum, createStableOrderId(orderNum), quoteId, quoteNum, customerId, orderSiteId, order.channel, order.deliveryDate, order.deliveryTime,
      order.deliveryAddress, order.priority, order.driverNotes, order.generalNotes,
      totalWeight, wastePct, billingWeight, salePrice, order.createdBy || null);

    const orderId = orderResult.lastInsertRowid;
    const inventoryShortages = [];
    const reservationItems = [];

    (pallets || []).forEach((pallet, idx) => {
      const pr = db.prepare('INSERT INTO pallets (order_id,pallet_num,max_weight,total_weight) VALUES (?,?,?,?)')
        .run(orderId, idx + 1, pallet.maxWeight || 500, pallet.totalWeight || 0);

      (pallet.items || []).forEach(rawItem => {
        const item = withShapeContractLegacyFields(rawItem);
        const pileCageMetrics = roundPileCageOrderMetrics(rawItem);
        // A lift carries no bends and no cut list - it is a bought bundle, so it
        // skips the geometry checks the same way a cage does.
        const liftMetrics = pileCageMetrics ? null : liftPackageOrderMetrics(rawItem);
        const spiral = normalizeSpiralParams(item);
        const sourceLengthMm = Number(item.length ?? item.total_length_mm ?? 0) || 0;
        const sourceSides = Array.isArray(item.sides) ? item.sides : [];
        const longSimpleCoil = !spiral.isSpiral && sourceLengthMm > 20000 && sourceSides.length <= 2;
        const isSpiralLike = spiral.isSpiral || longSimpleCoil;
        const sides = isSpiralLike
          ? []
          : ((item.sides && item.sides.length) ? item.sides : (item.length ? [item.length] : []));
        const totalLengthMm = pileCageMetrics ? pileCageMetrics.physicalLengthMm : liftMetrics ? liftMetrics.barLengthMm : isSpiralLike
          ? (sourceLengthMm || spiralCutLengthMm(spiral.spiralDiameterMm, spiral.turns))
          : (sides.reduce((s, v) => s + Number(v), 0) || Number(item.length) || 0);
        const angles = item.angles || [];
        const segmentsArr = pileCageMetrics || liftMetrics || isSpiralLike
          ? []
          : normalizeSegments(
              item.shapeName,
              sides.map((len, i) => ({ length_mm: Number(len), angle_deg: angles[i] ?? 0 }))
            );
        const shapeName = longSimpleCoil
          ? 'spiral'
          : isSpiralLike
          ? normalizeShapeName(item.shapeName || item.shape_name || 'spiral', segmentsArr, {
              spiral_diameter_mm: spiral.spiralDiameterMm || null,
              spiral_turns: spiral.turns || null,
            })
          : normalizeShapeName(item.shapeName, segmentsArr);
        if (!isSpiralLike && !pileCageMetrics && !liftMetrics) {
          const geoCheck = validateShapeGeometry(segmentsArr);
          if (!geoCheck.valid) throw Object.assign(new Error(geoCheck.error), { statusCode: 400 });
        }
        const segments = JSON.stringify(segmentsArr);
        const hasShapeV2Envelope = isShapeDataContractV2(item.shapeSnapshot ?? item.shape_snapshot ?? item.shapeData ?? item.shape_data ?? item.shapeContract ?? item.shape_contract ?? item.shape_snapshot_json);
        const persistedShapeName = pileCageMetrics ? 'PILE CAGE' : (hasShapeV2Envelope ? item.shapeName : shapeName);
        const weightPerUnit = pileCageMetrics
          ? pileCageMetrics.weightKg
          : (liftMetrics ? liftMetrics.weightPerUnit : calcWeightPerUnit(item.diameter, totalLengthMm));
        // Waste is an order-level billing adjustment only. Production must use
        // the ordered item quantity without adding or rounding a percentage.
        const productionQty = item.qty || 1;
        const machine = assignResource(item.diameter);

        const totalWeight = weightPerUnit * (item.qty || 1);
        const reviewNotes = Array.isArray(item.reviewNotes || item.review_notes) ? (item.reviewNotes || item.review_notes) : [];
        const reviewNotesJson = reviewNotes.length ? JSON.stringify(reviewNotes) : null;
        const reviewStatus = reviewNotes.length ? (item.reviewStatus || item.review_status || 'pending') : (item.reviewStatus || item.review_status || null);
        const itemNote = item.note || item.notes || item.shape_description || item.shapeDescription || '';
        const structElement = item.structElement || item.struct_element || item.element_name || item.elementName || item.element || item.member_name || item.memberName || null;
        const structFloor = item.structFloor || item.struct_floor || item.floor || null;
        const sheetNum = item.sheetNum || item.sheet_num || item.sheet || null;
        const shapeSnapshot = shapeSnapshotJson({
          ...item,
          shapeId: item.shapeId,
          shapeName: persistedShapeName,
          diameter: item.diameter,
          spiralDiameterMm: isSpiralLike ? (spiral.spiralDiameterMm || null) : null,
          spiralTurns: isSpiralLike ? (spiral.turns || null) : null,
          segments,
          totalLengthMm,
          is3d: item.is_3d ? 1 : 0,
          note: itemNote,
          structElement,
          structFloor,
          sheetNum,
        });
        const itemResult = db.prepare(`INSERT INTO items (pallet_id,order_id,shape_snapshot_json,shape_id,shape_name,diameter,spiral_diameter_mm,spiral_turns,segments,total_length_mm,quantity,production_qty,weight_per_unit,total_weight,note,review_status,review_notes,struct_element,struct_floor,sheet_num,machine,is_3d)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(pr.lastInsertRowid, orderId, shapeSnapshot, item.shapeId, persistedShapeName, item.diameter,
            isSpiralLike ? (spiral.spiralDiameterMm || null) : null,
            isSpiralLike ? (spiral.turns || null) : null,
            segments, totalLengthMm, item.qty || 1, productionQty,
            weightPerUnit, totalWeight,
            itemNote, reviewStatus, reviewNotesJson, structElement, structFloor, sheetNum, machine,
            item.is_3d ? 1 : 0);
        db.prepare('UPDATE items SET item_uid=? WHERE id=?').run(buildOrderItemUid(orderId, itemResult.lastInsertRowid), itemResult.lastInsertRowid);
        reservationItems.push({
          id: itemResult.lastInsertRowid,
          item_id: itemResult.lastInsertRowid,
          diameter: item.diameter,
          material_type: item.material_type || item.materialType || 'coil',
          total_weight: totalWeight,
          quantity: item.qty || 1,
          weight_per_unit: weightPerUnit,
          shape_snapshot_json: shapeSnapshot,
        });

        const allocation = allocateOrderItemStock(db, {
          orderId,
          itemId: itemResult.lastInsertRowid,
          item: {
            diameter: item.diameter,
            material_type: item.material_type || item.materialType || null,
          },
          requiredWeightKg: totalWeight,
          requestedRawMaterialId: selectedRawMaterialId(item),
          policy: inventoryPolicy,
        });
        if (!allocation.allocated && ['no_stock', 'insufficient_stock'].includes(allocation.reason)) {
          inventoryShortages.push({
            itemId: itemResult.lastInsertRowid,
            diameter: item.diameter,
            material_type: item.material_type || item.materialType || 'coil',
            shortageKg: allocation.missingWeightKg || totalWeight,
            requiredWeightKg: totalWeight,
            reason: allocation.reason,
          });
        }
      });
    });

    const inventoryReservations = reserveMaterialForOrder(db, {
      order_id: orderId,
      items: reservationItems,
    });

    const procurementRequests = openProcurementForStockShortages(db, {
      orderId,
      orderNum,
      shortages: inventoryShortages,
      createdBy: order.createdBy || 'order-create',
    });

    return { success: true, orderNum, orderId, inventoryShortages: procurementRequests, inventoryReservations };
  }

  return {
    calcWeightPerUnit,
    createOrderFromPayload,
    createOrderTransaction: db.transaction(createOrderFromPayload),
  };
}

module.exports = {
  validateShapeGeometry,
  autoAssignMachine: steelModule.autoAssignMachine,
  normalizeFactorySegments: steelModule.normalizeFactorySegments,
  normalizeFactoryShapeName: steelModule.normalizeFactoryShapeName,
  createOrderFactory,
};
