const router = require('express').Router();
const pendingReceipts = require('../services/pendingRawMaterialReceiptV2');
const { calculatePurchaseRecommendations } = require('../services/inventoryReservation');
const { planInventory } = require('../services/inventoryPlanning');
const { projectMaterialCoverageV2 } = require('../services/materialCoverageProjectionV2');

function required(name, value) {
  if (!value) throw new Error(`routes/procurement missing dependency: ${name}`);
  return value;
}

module.exports = function createProcurementRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);

  router.get('/suppliers', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all());
  });

  router.post('/suppliers', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const { name, phone, contact, email, address, payment_terms, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'supplier name is required' });
    const r = db.prepare('INSERT INTO suppliers (name,phone,contact,email,address,payment_terms,notes) VALUES (?,?,?,?,?,?,?)')
      .run(name, phone || null, contact || null, email || null, address || null, payment_terms || null, notes || null);
    res.json({ id: r.lastInsertRowid });
  });

  router.patch('/suppliers/:id', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    db.prepare('UPDATE suppliers SET name=COALESCE(?,name),phone=COALESCE(?,phone),contact=COALESCE(?,contact),email=COALESCE(?,email),address=COALESCE(?,address),payment_terms=COALESCE(?,payment_terms),notes=COALESCE(?,notes),active=COALESCE(?,active) WHERE id=?')
      .run(f.name || null, f.phone || null, f.contact || null, f.email || null, f.address || null, f.payment_terms || null, f.notes || null, f.active ?? null, req.params.id);
    res.json({ success: true });
  });

  router.get('/steel-prices', requireAnyRole(['office', 'sales', 'finance', 'manager', 'admin']), (req, res) => {
    const { diameter } = req.query;
    const q = `SELECT sph.*, s.name as supplier_name FROM steel_price_history sph
             LEFT JOIN suppliers s ON sph.supplier_id=s.id`;
    if (diameter) {
      res.json(db.prepare(q + ' WHERE sph.diameter=? ORDER BY sph.effective_date DESC LIMIT 50').all(diameter));
    } else {
      res.json(db.prepare(`SELECT sph.*, s.name as supplier_name
        FROM steel_price_history sph LEFT JOIN suppliers s ON sph.supplier_id=s.id
        WHERE sph.id IN (
          SELECT MAX(id) FROM steel_price_history GROUP BY diameter
        ) ORDER BY sph.diameter`).all());
    }
  });

  router.post('/steel-prices', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const { diameter, price_per_ton, supplier_id, effective_date, notes, created_by } = req.body;
    const r = db.prepare('INSERT INTO steel_price_history (diameter,price_per_ton,supplier_id,effective_date,notes,created_by) VALUES (?,?,?,?,?,?)')
      .run(diameter, price_per_ton, supplier_id || null, effective_date || new Date().toISOString().slice(0, 10), notes || null, created_by || null);
    res.json({ id: r.lastInsertRowid });
  });

  router.post('/procurement/purchase-draft/export', requireAnyRole(['office', 'manager', 'admin']), (req,res) => {
    try {
      const result=require('../services/purchaseDraftExport').exportPurchaseDraft(db,req.body);
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch(error){res.status(error.statusCode||400).json({error:error.code||error.message});}
  });
  router.get('/procurement/plan', requireAnyRole(['warehouse', 'office', 'finance', 'manager', 'admin']), (req,res) => {
    try { res.json({...planInventory(db,req.query),mesh_groups:require('../services/meshInventory').planMesh(db,req.query)}); }
    catch(error) {res.status(400).json({error:error.code||error.message});}
  });
  router.get('/procurement/recommendations', requireAnyRole(['warehouse', 'office', 'finance', 'manager', 'admin']), (req, res) => {
    try {
      const recommendation = calculatePurchaseRecommendations(db, {
        diameter: req.query.diameter,
        material_type: req.query.material_type,
      });
      res.json(recommendation);
    } catch (error) {
      res.status(error.statusCode || 400).json({ error: error.message || 'failed to calculate procurement recommendations' });
    }
  });
  router.get('/procurement/material-coverage-v2', requireAnyRole(['warehouse', 'office', 'finance', 'manager', 'admin']), (_req, res) => {
    try { res.json(projectMaterialCoverageV2(db)); }
    catch (error) { res.status(error.statusCode || 400).json({ error: error.code || 'material_coverage_projection_failed' }); }
  });
  router.get('/purchase-orders', requireAnyRole(['warehouse', 'office', 'finance', 'manager', 'admin']), (req, res) => {
    res.json(db.prepare(`
      SELECT po.*, s.name as supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      ORDER BY po.created_at DESC
    `).all());
  });

  router.post('/purchase-orders', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), (req, res) => {
    const seq = db.prepare('SELECT COUNT(*)+1 as n FROM purchase_orders').get().n;
    const num = 'PO-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
    const { supplier_id, diameter, material_type, quantity_ton, price_per_ton, expected_date, notes, created_by, status } = req.body;
    if(material_type==='mesh') {
      try {
        const mesh=require('../services/meshInventory');
        const spec=mesh.meshSpecification(req.body.specification),quantity=Number(req.body.quantity_units),price=Number(req.body.unit_price||0);
        if(!Number.isSafeInteger(quantity)||quantity<=0||!Number.isFinite(price)||price<0)return res.status(400).json({error:'invalid_mesh_purchase_quantity'});
        const result=db.prepare('INSERT INTO purchase_orders(po_num,supplier_id,material_type,quantity_units,specification_key,specification_json,unit_price,total_amount,expected_date,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(num,supplier_id||null,'mesh',quantity,spec.specification_key,JSON.stringify(spec.specification),price,quantity*price,expected_date||'',status||'pending',notes||'',req.auth.sub);
        return res.json({id:result.lastInsertRowid,po_num:num});
      }catch(error){return res.status(error.statusCode||400).json({error:error.code||error.message});}
    }
    const total = (quantity_ton || 0) * (price_per_ton || 0);
    const r = db.prepare(`
      INSERT INTO purchase_orders
        (po_num,supplier_id,diameter,material_type,quantity_ton,price_per_ton,total_amount,expected_date,status,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(num, supplier_id || null, diameter || null, material_type || 'coil',
      quantity_ton || 0, price_per_ton || 0, total,
      expected_date || '', status || 'pending', notes || '', created_by || '');
    res.json({ id: r.lastInsertRowid, po_num: num });
  });

  router.patch('/purchase-orders/:id', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const f = req.body;
    db.prepare(`
      UPDATE purchase_orders
      SET status      = COALESCE(?, status),
          approved_by = COALESCE(?, approved_by)
      WHERE id = ?
    `).run(f.status || null, f.approved_by || null, req.params.id);
    res.json({ ok: true });
  });

  router.patch('/purchase-orders/:id/receive', requireAnyRole(['warehouse', 'manager', 'admin']), (req, res) => {
    const { heat_number, certificate_num, received_weight, notes } = req.body;
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
    if (!po) return res.status(404).json({ error: 'not found' });
    if(po.material_type==='mesh') {
      try {
        const mesh=require('../services/meshInventory');
        const quantity=Number(req.body.received_units??po.quantity_units);
        const receipt=db.transaction(()=>{
          const result=mesh.receiptDraft(db,{specification:JSON.parse(po.specification_json),quantity_units:quantity,supplier_id:po.supplier_id,delivery_note_num:req.body.delivery_note_num||po.po_num,idempotency_key:req.body.idempotency_key||`mesh-po-receive:${po.id}`,actor_id:req.auth.sub});
          db.prepare("UPDATE purchase_orders SET status='הגיע',received_units=?,received_at=CURRENT_TIMESTAMP WHERE id=?").run(quantity,po.id);
          return result;
        }).immediate();
        return res.json({ok:true,receipt_id:receipt.id,status:receipt.status,stock_unit:'units'});
      }catch(error){return res.status(error.statusCode||400).json({error:error.code||error.message});}
    }
    const actualWeight = received_weight || (po.quantity_ton * 1000);
    let receipt = null;
    const receive = db.transaction(() => {
      receipt = pendingReceipts.createDraft(db, {
        source_type: 'purchase_order', source_ref: `purchase_order:${po.id}`, supplier_id: po.supplier_id,
        delivery_note_num: req.body.delivery_note_num || `PO-${po.po_num}`, created_by: req.auth?.sub,
        idempotency_key: req.body.idempotency_key || req.body.idempotencyKey || `purchase-order-receive:${po.id}`,
        lines: [{ source_line_ref: `po-${po.id}-1`, material_type: po.material_type || 'coil', diameter: po.diameter, lot_number: heat_number || null, certificate_num: certificate_num || null, weight_received: actualWeight, purchase_price: po.price_per_ton || 0, notes: notes || null }],
      });
      db.prepare(`
        UPDATE purchase_orders
        SET status='הגיע', heat_number=?, certificate_num=?, received_weight=?, received_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(heat_number || '', certificate_num || '', actualWeight, req.params.id);
    });
    try { receive.immediate(); } catch (error) { return res.status(400).json({ error: error.code || error.message }); }
    res.json({ ok: true, receipt_id: receipt?.id || null, status: receipt?.status || null });
  });

  return router;
};

module.exports.manifest = {
  id: 'procurement',
  label: 'רכש',
  screens: [
    { id: 'procurement', path: '/procurement.html', label: 'רכש', icon: '🛒', group: 'תפעול' },
  ],
  access: {
    default: 'hidden',
    roles: { admin: 'edit', manager: 'edit', office: 'edit', warehouse: 'read' },
  },
  consumes: [{ table: 'suppliers' }, { table: 'purchase_orders' }, { table: 'steel_price_history' }],
  produces: [],
};
