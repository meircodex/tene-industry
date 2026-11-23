const express = require('express');

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/bvbs missing dependency: ${name}`);
  return value;
}

function decimalNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return NaN;
}

module.exports = function createBvbsRouter(deps) {
  const router = express.Router();
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const upload = required('upload', deps.upload);
  const industry = required('industry', deps.industry);
  const generateOrderNum = required('generateOrderNum', deps.generateOrderNum);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  router.post('/bvbs/parse', requireAnyRole(['office', 'manager', 'admin']), upload.single('file'), (req, res) => {
    try {
      const content = req.file
        ? req.file.buffer.toString('utf-8')
        : req.body?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'יש להזין תוכן BVBS' });
      }
      const result = industry.parseBatchFile(content);
      if (!result.items.length) return res.status(422).json({ error: 'לא נמצאו פריטים בקובץ BVBS', raw_lines: content.split(/\r?\n/).slice(0, 5) });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const createOrder = db.transaction(({ items, customerId, deliveryDate, priority, totalWeight, notes }) => {
    if (customerId !== null && !db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) {
      return null;
    }

    const orderNum = generateOrderNum();
    const orderId = db.prepare(`INSERT INTO orders
      (order_num,customer_id,channel,delivery_date,priority,status,total_weight,general_notes)
      VALUES (?,?,?,?,?,?,?,?)`).run(orderNum, customerId, 'BVBS', deliveryDate,
      priority, 'ממתינה לאישור', totalWeight, notes).lastInsertRowid;
    const palletId = db.prepare('INSERT INTO pallets (order_id,pallet_num,total_weight) VALUES (?,1,?)')
      .run(orderId, totalWeight).lastInsertRowid;

    const insertItem = db.prepare(`INSERT INTO items
      (pallet_id,shape_id,diameter,total_length_mm,quantity,weight_per_unit,total_weight,note,status)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const item of items) {
      insertItem.run(palletId, item.shapeId, item.diameter, item.length, item.quantity,
        item.unitWeight, item.weight, item.note, 'ממתין');
    }

    return { orderId, orderNum };
  });

  router.post('/bvbs/create-order', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const { bvbs_result, customer_id, delivery_date, priority } = req.body || {};
    if (!Array.isArray(bvbs_result?.items) || !bvbs_result.items.length) {
      return res.status(400).json({ error: 'אין פריטים להזמנה' });
    }

    const customerId = customer_id == null ? null : decimalNumber(customer_id);
    if (customerId !== null && (!Number.isSafeInteger(customerId) || customerId <= 0)) {
      return res.status(400).json({ error: 'מזהה לקוח לא תקין' });
    }

    const items = [];
    let totalWeight = 0;
    for (const [index, item] of bvbs_result.items.entries()) {
      const diameter = decimalNumber(item?.diameter);
      const length = decimalNumber(item?.total_length);
      const quantity = decimalNumber(item?.quantity);
      if (!industry.VALID_DIAMETERS.includes(diameter) || !Number.isFinite(length) || length <= 0 ||
          !Number.isSafeInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: `פריט ${index + 1}: קוטר, אורך או כמות לא תקינים` });
      }

      const unitWeight = industry.weightPerUnit({ diameter, total_length_mm: length });
      const weight = unitWeight * quantity;
      totalWeight += weight;
      if (!Number.isFinite(totalWeight) || weight <= 0) {
        return res.status(400).json({ error: `פריט ${index + 1}: משקל לא תקין` });
      }

      const mark = typeof item.mark === 'string' ? item.mark : '';
      const grade = typeof item.grade === 'string' && item.grade ? item.grade : 'B500B';
      items.push({
        shapeId: typeof item.shape_code === 'string' && item.shape_code ? 's12' : 's1',
        diameter, length, quantity, unitWeight, weight,
        note: `מסימן ${mark} | ${grade}`,
      });
    }

    const project = bvbs_result.header?.project;
    const notes = typeof project === 'string' && project
      ? `יובא מקובץ BVBS – פרויקט: ${project}`
      : 'יובא מקובץ BVBS';
    let result;
    try {
      result = createOrder.immediate({
        items, customerId, totalWeight, notes,
        deliveryDate: delivery_date || null, priority: priority || 'רגיל',
      });
    } catch {
      return res.status(500).json({ error: 'שמירת הזמנת BVBS נכשלה' });
    }
    if (!result) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const { orderId, orderNum } = result;
    wsBroadcast('new_order', { orderId, orderNum });
    res.json({ ok: true, order_id: orderId, order_num: orderNum, items_created: items.length });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'bvbs',
  label: 'ייבוא BVBS',
  consumes: [{ external: 'bvbs-file' }],
  produces: [{ event: 'new_order' }],
};
