const router = require('express').Router();
const crypto = require('node:crypto');

const {
  MATERIAL_TYPES,
  bendingShapeColumns,
  normalizeReceiptReviewItem,
  parseReceiptReviewPayload,
} = require('../services/inventory');
const { normalizeDiameter } = require('../services/materialCatalog');
const receipts = require('../services/pendingRawMaterialReceiptV2');
const stocktakes = require('../services/inventoryStocktake');
const mesh = require('../services/meshInventory');
const { materialOnHandSql } = require('../services/materialBalance');
const { consumeReservationsForProduction } = require('../services/inventoryReservation');
const { cuttingStock } = require('../services/cuttingStock');

function required(name, value) {
  if (!value) throw new Error(`routes/inventory missing dependency: ${name}`);
  return value;
}

module.exports = function createInventoryRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const auditLog = required('auditLog', deps.auditLog);
  const listPage = required('listPage', deps.listPage);

  function canApproveCatalog(req) {
    return ['manager', 'admin', 'procurement'].includes(req.auth?.role);
  }

  function resolveDiameterCatalog(value, req, { approveNew, reactivate } = {}) {
    const diameter = normalizeDiameter(value);
    if (!diameter) {
      throw Object.assign(new Error('invalid_diameter'), { statusCode: 400 });
    }
    const existing = db.prepare('SELECT * FROM diameter_catalog WHERE diameter_key=?').get(diameter.key);
    if (!existing) {
      const status = canApproveCatalog(req) && approveNew !== false ? 'active' : 'pending_approval';
      db.prepare(`
        INSERT INTO diameter_catalog (diameter_key,diameter_display,status,source,created_by,approved_by,approved_at)
        VALUES (?,?,?,?,?,?,CASE WHEN ?='active' THEN CURRENT_TIMESTAMP ELSE NULL END)
      `).run(diameter.key, diameter.display, status, 'manual', req.auth?.sub || null,
        status === 'active' ? req.auth?.sub || null : null, status);
      return { ...diameter, status, catalogAction: 'created' };
    }
    if (existing.status !== 'active' && canApproveCatalog(req) && reactivate) {
      db.prepare(`UPDATE diameter_catalog
        SET status='active', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(req.auth?.sub || null, existing.id);
      return { ...diameter, status: 'active', catalogAction: 'reactivated' };
    }
    return { ...diameter, status: existing.status, catalogAction: null };
  }

  function resolveCatalogItem(input, materialType, diameter) {
    const catalogItemId = Number(input.catalog_item_id ?? input.catalogItemId);
    if (!Number.isSafeInteger(catalogItemId) || catalogItemId <= 0) {
      return { catalogItem: null, specException: false };
    }
    const catalogItem = db.prepare(`SELECT * FROM catalog_items
      WHERE id=? AND item_kind='raw_material' AND active=1`).get(catalogItemId);
    if (!catalogItem) return { catalogItem: null, specException: true };
    const comparisons = [
      ['diameter_key', diameter.key],
      ['supply_form', materialType],
      ['steel_grade', input.grade || 'B500B'],
      ['standard_code', input.standard_code || input.standardCode || null],
      ['nominal_length_mm', input.nominal_length_mm ?? input.nominalLengthMm ?? null],
    ];
    const specException = comparisons.some(([field, actual]) => {
      if (catalogItem[field] === null || catalogItem[field] === undefined || actual === null || actual === '') return false;
      return String(catalogItem[field]) !== String(actual);
    });
    return { catalogItem: specException ? null : catalogItem, specException };
  }



  router.get('/inventory', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { diameter, supplier_id } = req.query;
    const page = listPage(req.query, { limit: 200, max: 1000 });
    let sql = `SELECT r.*,s.name as supplier_name,ROUND(${materialOnHandSql(db,'r')},2) as weight_available FROM raw_material r LEFT JOIN suppliers s ON r.supplier_id=s.id WHERE r.active=1 AND COALESCE(r.verification_status,'approved')='approved'`;
    const params = [];
    if (diameter) { sql += ' AND r.diameter=?'; params.push(diameter); }
    if (supplier_id) { sql += ' AND r.supplier_id=?'; params.push(supplier_id); }
    sql += ' ORDER BY r.received_date DESC, r.id DESC LIMIT ? OFFSET ?';
    params.push(page.limit, page.offset);
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/inventory/summary', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare(`SELECT diameter,material_type,nominal_length_mm,SUM(stock_adjustment_kg) as total_adjustments,SUM(weight_received) as total_received,SUM(weight_used) as total_used,SUM(weight_scrapped) as total_scrapped,ROUND(SUM(${materialOnHandSql(db)}),2) as available,COUNT(*) as batches FROM raw_material WHERE active=1 AND COALESCE(verification_status,'approved')='approved' GROUP BY diameter,material_type,nominal_length_mm ORDER BY diameter,material_type,nominal_length_mm`).all());
  });
  router.get('/inventory/cutting-stock', requireAnyRole(['warehouse','office','manager','admin']), (req,res) => {
    const raw=String(req.query.order_ids||''),parts=raw?raw.split(','):[];
    if(parts.length>500||parts.some(value=>!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<=0))return res.status(400).json({error:'יש לבחור מספרי הזמנות תקינים לתכנון החיתוך'});
    res.json(cuttingStock(db,[...new Set(parts.map(Number))]));
  });
  router.get('/inventory/metrics', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req,res) => {
    res.json(require('../services/inventoryMetrics').inventoryMetrics(db));
  });

  router.get('/inventory/mesh', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req,res) => {
    const page=listPage(req.query,{limit:100,max:500});
    res.json(mesh.planMesh(db,req.query).slice(page.offset,page.offset+page.limit));
  });
  router.get('/inventory/mesh/receipts', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req,res) => {
    const page=listPage(req.query,{limit:50,max:200});
    res.json(db.prepare("SELECT * FROM inventory_mesh_receipts WHERE status='draft' ORDER BY id DESC LIMIT ? OFFSET ?").all(page.limit,page.offset));
  });
  router.post('/inventory/mesh/receipts', requireAnyRole(['warehouse', 'manager', 'admin']), (req,res) => {
    try {res.json(mesh.receiptDraft(db,{...req.body,actor_id:req.auth.sub}));}
    catch(error){res.status(error.statusCode||400).json({error:error.code||error.message});}
  });
  router.post('/inventory/mesh/receipts/:id/approve', requireAnyRole(['manager', 'admin']), (req,res) => {
    try {const result=mesh.approveReceipt(db,{...req.body,receipt_id:req.params.id,actor_id:req.auth.sub});wsBroadcast('inventory_changed',{mesh_receipt_id:result.id});res.json(result);}
    catch(error){res.status(error.statusCode||400).json({error:error.code||error.message});}
  });
  router.post('/inventory/mesh/stocktakes/preview', requireAnyRole(['warehouse', 'manager', 'admin']), (req,res) => {
    try {res.json(mesh.previewCount(db,req.body));}
    catch(error){res.status(error.statusCode||400).json({error:error.code||error.message});}
  });
  router.post('/inventory/mesh/stocktakes', requireAnyRole(['manager', 'admin']), (req,res) => {
    try {const result=mesh.approveCount(db,{...req.body,actor_id:req.auth.sub});wsBroadcast('inventory_changed',{mesh_count_id:result.id});res.json(result);}
    catch(error){res.status(error.statusCode||400).json({error:error.code||error.message});}
  });
  router.post('/inventory/stocktakes/preview', requireAnyRole(['warehouse', 'manager', 'admin']), (req,res) => {
    try { res.json(stocktakes.previewStocktake(db,req.body)); }
    catch(error) { res.status(error.statusCode||400).json({error:error.code||error.message}); }
  });
  router.post('/inventory/stocktakes', requireAnyRole(['manager', 'admin']), (req,res) => {
    try {
      const result=stocktakes.approveStocktake(db,{...req.body,actor_id:req.auth.sub});
      wsBroadcast('inventory_changed',{stocktake_id:result.id});res.json(result);
    } catch(error) { res.status(error.statusCode||400).json({error:error.code||error.message}); }
  });
  router.get('/inventory/stocktakes', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req,res) => {
    const page=listPage(req.query,{limit:50,max:200});
    res.json(db.prepare('SELECT id,counted_at,reason,actor_id,created_at FROM inventory_stocktakes ORDER BY id DESC LIMIT ? OFFSET ?').all(page.limit,page.offset));
  });
  router.get('/inventory/stocktakes/:id', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req,res) => {
    const result=stocktakes.getStocktake(db,req.params.id);res.status(result?200:404).json(result||{error:'stocktake_not_found'});
  });
  router.post('/inventory/consumption/retry', requireAnyRole(['manager', 'admin']), (req,res) => {
    try {
      const item=db.prepare("SELECT i.id,i.status,COALESCE(i.order_id,p.order_id) AS order_id FROM items i LEFT JOIN pallets p ON p.id=i.pallet_id WHERE i.id=?").get(Number(req.body.item_id));
      if(!item||!['הושלם','סופק'].includes(item.status)) return res.status(409).json({error:'completed_item_required'});
      const result=consumeReservationsForProduction(db,{order_id:item.order_id,item_ids:[item.id]});
      wsBroadcast('inventory_changed',{item_id:item.id});res.json(result);
    } catch(error) {res.status(error.statusCode||400).json({error:error.code||error.message});}
  });

  router.get('/inventory/diameter-catalog', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (_req, res) => {
    res.json(db.prepare(`SELECT id,diameter_key,diameter_display,status
      FROM diameter_catalog WHERE status IN ('active','inactive','pending_approval')
      ORDER BY CAST(diameter_key AS NUMERIC), diameter_key`).all());
  });

  router.get('/inventory/catalog-items', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (_req, res) => {
    res.json(db.prepare(`SELECT id,sku,name,category,supply_form,diameter_key,steel_grade,standard_code,nominal_length_mm,
      nominal_kg_per_meter,nominal_unit_weight_kg
      FROM catalog_items WHERE item_kind='raw_material' AND active=1 ORDER BY sku`).all());
  });

  router.get('/inventory/pending-verification', requireAnyRole(['manager', 'admin']), (_req, res) => {
    res.json(db.prepare(`SELECT r.*, d.status AS diameter_catalog_status
      FROM raw_material r
      LEFT JOIN diameter_catalog d ON d.diameter_key=CAST(r.diameter AS TEXT)
      WHERE r.active=1 AND r.verification_status='pending_verification'
      ORDER BY r.created_at ASC, r.id ASC`).all());
  });

  router.post('/inventory/:id/approve-verification', requireAnyRole(['manager', 'admin']), (req, res) => {
    const lot = db.prepare('SELECT * FROM raw_material WHERE id=?').get(req.params.id);
    if (!lot) return res.status(404).json({ error: 'raw_material_not_found' });
    const diameter = normalizeDiameter(lot.diameter);
    if (!diameter) return res.status(400).json({ error: 'invalid_diameter' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE diameter_catalog SET status='active', approved_by=?, approved_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE diameter_key=? AND status<>'active'`).run(req.auth?.sub || null, diameter.key);
      db.prepare("UPDATE raw_material SET verification_status='approved' WHERE id=?").run(lot.id);
    });
    tx();
    auditLog('raw_material', lot.id, lot.lot_number || String(lot.id), 'approve_verification', 'verification_status',
      lot.verification_status, 'approved', null, req.auth?.sub || null, req.auth?.display_name || null);
    res.json({ success: true });
  });

  router.post('/inventory/product-masters', requireAnyRole(['manager', 'admin']), (req, res) => {
    const code = String(req.body?.master_code ?? req.body?.masterCode ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    if (!code || !name) return res.status(400).json({ error: 'master_code_and_name_required' });
    try {
      const result = db.prepare('INSERT INTO product_masters (master_code,name,category) VALUES (?,?,?)')
        .run(code, name, String(req.body?.category ?? '').trim());
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(409).json({ error: 'product_master_code_exists' });
    }
  });

  router.post('/inventory/catalog-items', requireAnyRole(['manager', 'admin']), (req, res) => {
    const body = req.body || {};
    const sku = String(body.sku ?? '').trim();
    const name = String(body.name ?? '').trim();
    const itemKind = body.item_kind ?? body.itemKind;
    if (!sku || !name || !['raw_material', 'finished_product'].includes(itemKind)) {
      return res.status(400).json({ error: 'invalid_catalog_item' });
    }
    const diameter = body.diameter === undefined || body.diameter === null || body.diameter === '' ? null : normalizeDiameter(body.diameter);
    if (body.diameter !== undefined && !diameter) return res.status(400).json({ error: 'invalid_diameter' });
    const supplyForm = body.supply_form ?? body.supplyForm ?? null;
    if (supplyForm !== null && !MATERIAL_TYPES.has(supplyForm)) return res.status(400).json({ error: 'invalid_supply_form' });
    if (itemKind === 'raw_material' && diameter) {
      const catalogDiameter = db.prepare("SELECT 1 FROM diameter_catalog WHERE diameter_key=? AND status='active'").get(diameter.key);
      if (!catalogDiameter) return res.status(400).json({ error: 'catalog_diameter_must_be_active' });
    }
    const productMasterId = Number(body.product_master_id ?? body.productMasterId) || null;
    if (productMasterId && !db.prepare('SELECT 1 FROM product_masters WHERE id=? AND active=1').get(productMasterId)) {
      return res.status(400).json({ error: 'product_master_not_found' });
    }
    try {
      const result = db.prepare(`INSERT INTO catalog_items
        (sku,product_master_id,item_kind,name,category,supply_form,diameter_key,steel_grade,standard_code,nominal_length_mm,nominal_kg_per_meter,nominal_unit_weight_kg)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sku, productMasterId, itemKind, name, String(body.category ?? '').trim(),
        supplyForm, diameter?.key || null, body.steel_grade ?? body.steelGrade ?? null, body.standard_code ?? body.standardCode ?? null,
        Number(body.nominal_length_mm ?? body.nominalLengthMm) || null, Number(body.nominal_kg_per_meter ?? body.nominalKgPerMeter) || null,
        Number(body.nominal_unit_weight_kg ?? body.nominalUnitWeightKg) || null
      );
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(409).json({ error: 'catalog_sku_exists' });
    }
  });

  router.get('/inventory/receipt-reviews', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const status = req.query.status || 'pending_review';
    const rows = db.prepare(`
      SELECT rr.*, s.name AS supplier_master_name
      FROM inventory_receipt_reviews rr
      LEFT JOIN suppliers s ON s.id=rr.supplier_id
      WHERE rr.status=?
      ORDER BY rr.created_at DESC, rr.id DESC
      LIMIT 100
    `).all(status);
    res.json(rows);
  });

  router.post('/inventory/receipt-reviews/:id/approve', requireAnyRole(['manager', 'admin']), (req, res) => {
    const review = db.prepare('SELECT * FROM inventory_receipt_reviews WHERE id=?').get(req.params.id);
    if (!review) return res.status(404).json({ error: 'not found' });
    if (review.status !== 'pending_review') return res.status(409).json({ error: 'review is not pending', status: review.status });
    const parsed = parseReceiptReviewPayload(JSON.parse(review.parsed_data || '{}'));
    let receipt = null;
    const tx = db.transaction(() => {
      receipt = receipts.createDraft(db, {
        source_type: 'ocr', source_ref: `receipt_review:${review.id}`, supplier_id: review.supplier_id,
        supplier_name: review.supplier_name, delivery_note_num: review.delivery_note_num,
        notes: req.body?.notes || parsed.notes, created_by: req.auth?.sub,
        idempotency_key: req.body?.idempotency_key || req.body?.idempotencyKey || `receipt-review:${review.id}`,
        lines: parsed.items.map((item, index) => ({ ...item, source_line_ref: `review-${review.id}-${index + 1}`, weight_received: item.weight_received ?? item.weight_kg })),
      });
      db.prepare(`
        UPDATE inventory_receipt_reviews
        SET status='approved', raw_material_ids=?, reviewed_by=?, review_notes=?, reviewed_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(JSON.stringify([]), req.auth?.sub || null, req.body?.notes || null, review.id);
    });
    try {
      tx();
      auditLog('inventory_receipt_review', review.id, review.delivery_note_num, 'approve', 'status', 'pending_review', 'approved', req.body?.notes || null, req.auth?.sub || null, req.auth?.display_name || null);
      wsBroadcast('inventory_receipt_review_approved', { id: review.id, receipt_id: receipt.id });
      res.json({ success: true, raw_material_ids: [], receipt_id: receipt.id, status: receipt.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/inventory/receipt-reviews/:id/reject', requireAnyRole(['manager', 'admin']), (req, res) => {
    const review = db.prepare('SELECT * FROM inventory_receipt_reviews WHERE id=?').get(req.params.id);
    if (!review) return res.status(404).json({ error: 'not found' });
    db.prepare(`
      UPDATE inventory_receipt_reviews
      SET status='rejected', reviewed_by=?, review_notes=?, reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.auth?.sub || null, req.body?.notes || null, req.params.id);
    auditLog('inventory_receipt_review', review.id, review.delivery_note_num, 'reject', 'status', review.status, 'rejected', req.body?.notes || null, req.auth?.sub || null, req.auth?.display_name || null);
    wsBroadcast('inventory_receipt_review_rejected', { id: review.id });
    res.json({ success: true });
  });

  router.get('/inventory/pending-receipts', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    res.json(receipts.listReceipts(db, { status: req.query.status || 'draft' }));
  });
  router.get('/inventory/pending-receipts/:id', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const receipt = receipts.getReceipt(db, req.params.id); return receipt ? res.json(receipt) : res.status(404).json({ error: 'pending_receipt_not_found' });
  });
  router.post('/inventory/pending-receipts', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    try { res.status(201).json(receipts.createDraft(db, { ...req.body, source_type: req.body?.source_type || 'manual', created_by: req.auth?.sub })); }
    catch (error) { res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });
  router.patch('/inventory/pending-receipts/:id', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    try { res.json(receipts.updateDraft(db, { ...req.body, receipt_id: req.params.id, updated_by: req.auth?.sub })); }
    catch (error) { res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });
  router.post('/inventory/pending-receipts/:id/cancel', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    try { res.json(receipts.cancelDraft(db, { ...req.body, receipt_id: req.params.id, decided_by: req.auth?.sub })); }
    catch (error) { res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });
  router.post('/inventory/pending-receipts/:id/approve', requireAnyRole(['manager', 'admin']), (req, res) => {
    try { const receipt=receipts.approveReceipt(db, { ...req.body, receipt_id: req.params.id, decided_by: req.auth?.sub });wsBroadcast('inventory_changed',{receipt_id:receipt.id});res.json(receipt); }
    catch (error) { res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });
  router.post('/inventory/pending-receipts/:id/reject', requireAnyRole(['manager', 'admin']), (req, res) => {
    try { res.json(receipts.rejectReceipt(db, { ...req.body, receipt_id: req.params.id, decided_by: req.auth?.sub })); }
    catch (error) { res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });

  router.post('/inventory', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    if (req.auth?.role === 'office') return res.status(403).json({ error: 'Forbidden' });
    try {
      const f = req.body || {};
      if (!f.diameter || !f.weight_received) return res.status(400).json({ error: 'diameter_and_weight_required' });
      const diameter = resolveDiameterCatalog(f.diameter_input ?? f.diameter, req, {
        approveNew: f.approve_new_diameter,
        reactivate: f.reactivate_diameter,
      });
      const receipt = receipts.createDraft(db, { ...f, source_type: 'manual', created_by: req.auth?.sub,
        idempotency_key: req.body?.idempotency_key || req.body?.idempotencyKey || `manual:${crypto.randomUUID()}`,
        lines: f.lines || [{ ...f, source_line_ref: 'manual-1', diameter: diameter.numeric }] });
      return res.status(200).json({ id: receipt.id, receipt_id: receipt.id, status: receipt.status, verification_status: 'pending_receipt', diameter: diameter.display, catalog_action: diameter.catalogAction });
    } catch (error) { return res.status(error instanceof receipts.PendingReceiptError ? 409 : 400).json({ error: error.code || error.message }); }
  });

  router.patch('/inventory/:id', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    const current = db.prepare('SELECT * FROM raw_material WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'raw_material_not_found' });
    for (const field of ['weight_received','weight_used','weight_scrapped','stock_adjustment_kg']) {
      if (Object.hasOwn(f,field) && Number(f[field])!==Number(current[field]||0)) {
        return res.status(409).json({error:'use_stocktake_receipt_or_consumption_for_stock_changes'});
      }
    }
    if ((Number(current.weight_used)||Number(current.weight_scrapped)||Number(current.stock_adjustment_kg)) &&
        ((f.diameter!==undefined&&Number(f.diameter)!==Number(current.diameter))||(f.material_type&&f.material_type!==current.material_type))) {
      return res.status(409).json({error:'used_lot_specification_is_immutable'});
    }

    if (f.material_type !== undefined && !MATERIAL_TYPES.has(f.material_type)) return res.status(400).json({error:'invalid_material_type'});
    const materialType = f.material_type || current.material_type;
    const merged = { ...current, ...f, material_type: materialType };
    const shape = bendingShapeColumns(merged);
    try {
      const diameter = resolveDiameterCatalog(f.diameter_input ?? f.diameter ?? current.diameter, req, {
        approveNew: f.approve_new_diameter,
        reactivate: f.reactivate_diameter,
      });
      const { catalogItem, specException } = resolveCatalogItem(merged, materialType, diameter);
      const verificationStatus = current.verification_status === 'pending_verification' && !canApproveCatalog(req) ? 'pending_verification' : 'approved';
      db.prepare(`UPDATE raw_material SET
      material_type=?,
      diameter=?,
      catalog_item_id=?,
      verification_status=?,
      supplier_id=COALESCE(?,supplier_id),
      lot_number=COALESCE(?,lot_number),
      certificate_num=COALESCE(?,certificate_num),
      grade=COALESCE(?,grade),
      standard_code=COALESCE(?,standard_code),
      nominal_length_mm=COALESCE(?,nominal_length_mm),
      spec_exception=?,
      received_date=COALESCE(?,received_date),
      purchase_price=COALESCE(?,purchase_price),
      warehouse_loc=COALESCE(?,warehouse_loc),
      bending_shape_name=?,
      bending_shape_segments=?,
      bending_shape_source=?,
      bending_shape_confidence=?,
      notes=COALESCE(?,notes),
      active=COALESCE(?,active)
      WHERE id=?`)
      .run(materialType, diameter.numeric, catalogItem?.id || null, verificationStatus,
        f.supplier_id || null, f.lot_number || null, f.certificate_num || null, f.grade || null,
        f.standard_code ?? f.standardCode ?? null, Number(f.nominal_length_mm ?? f.nominalLengthMm) || null, specException ? 1 : 0,
        f.received_date || null,
        f.purchase_price ?? null, f.warehouse_loc || null, shape.name, shape.segments, shape.source,
        shape.confidence, f.notes || null, f.active ?? null, req.params.id);
      auditLog('raw_material',current.id,current.lot_number || String(current.id),'update','verification_status',current.verification_status,verificationStatus,'עדכון פרטי חומר; שדות מלאי מחייבים: קוטר, סוג ומשקל',req.auth?.sub || null,req.auth?.display_name || null);
      wsBroadcast('inventory_changed',{raw_material_id:current.id});
      res.json({ success: true, diameter: diameter.display, verification_status: verificationStatus,
        catalog_action: diameter.catalogAction, spec_exception: specException });
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message || 'inventory_update_failed' });
    }
  });

  return router;
};

module.exports.manifest = {
  id: 'inventory',
  label: 'מלאי',
  screens: [
    { id: 'inventory', path: '/inventory.html', label: 'מלאי', icon: '🗄️', group: 'תפעול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'read', production: 'read', warehouse: 'edit' },
  },
  consumes: [{ table: 'raw_materials' }, { table: 'inventory_receipt_reviews' }, { table: 'inventory_stocktakes' }, { table: 'inventory_mesh_stock' }],
  produces: [
    { event: 'inventory_changed' },
    { event: 'inventory_receipt_review_approved' },
    { event: 'inventory_receipt_review_rejected' },
  ],
};
