const router = require('express').Router();
const {
  findSourceIdentityDuplicate,
  sourceIdentityConflictPayload,
  sourceIdentityFromRequest,
} = require('../services/importSourceIdentity');
const {
  listExternalShapeMappings,
  normalizeSourceSystem,
  normalizeExternalCode,
} = require('../services/externalShapeCodeMap');
const { getShapeTemplateByInternalCode } = require('../services/shapeTemplateRegistry');

function required(name, value) {
  if (value === undefined || value === null) throw new Error(`routes/intakeReview missing dependency: ${name}`);
  return value;
}

module.exports = function createIntakeReviewRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);
  const enrichIntakeRow = required('enrichIntakeRow', deps.enrichIntakeRow);
  const createOrderFromPayload = required('createOrderFromPayload', deps.createOrderFromPayload);
  const intakeToOrderPayload = required('intakeToOrderPayload', deps.intakeToOrderPayload);
  const intakeWorkflow = required('intakeWorkflow', deps.intakeWorkflow);
  const intake = required('intake', deps.intake);

  function parseStoredIntake(row) {
    try {
      return JSON.parse(row.parsed_data || '{}');
    } catch {
      return {};
    }
  }

  function parsedOverride(original, candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return original;
    const parsed = { ...candidate };
    parsed.items = Array.isArray(candidate.items) ? candidate.items : [];
    return parsed;
  }

  function parseJsonValue(value, fallback) {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function orderItemToParsedItem(item, index) {
    const snapshot = parseJsonValue(item.shape_snapshot_json, {});
    const segments = parseJsonValue(item.segments, []);
    const shapeName = item.shape_name || item.shape_id || snapshot.shape_name || snapshot.shapeName || 'unknown';
    return {
      item_id: item.id,
      item_number: index + 1,
      row_number: index + 1,
      shape_id: item.shape_id || snapshot.shape_id || snapshot.shapeId || null,
      shape_name: shapeName,
      diameter: item.diameter,
      total_length_mm: item.total_length_mm,
      length_mm: item.total_length_mm,
      quantity: item.quantity,
      qty: item.quantity,
      target_weight_kg: item.total_weight,
      weight_kg: item.total_weight,
      weight_per_unit: item.weight_per_unit,
      note: item.note || item.review_note_text || item.review_notes || '',
      review_note_text: item.review_note_text || item.review_notes || item.note || '',
      segments: Array.isArray(segments) ? segments : [],
      spiral_diameter_mm: item.spiral_diameter_mm,
      spiral_turns: item.spiral_turns,
      element_name: item.struct_element || '',
      struct_element: item.struct_element || '',
      struct_floor: item.struct_floor || '',
      sheet_num: item.sheet_num || '',
      source_ref: { source: 'order_items', item_id: item.id },
    };
  }

  function sourceIdentityForRow(row) {
    return row?.source_system || row?.external_id
      ? { source_system: row.source_system || null, external_id: row.external_id || null }
      : null;
  }

  function correctionPair(original, corrected) {
    const before = JSON.stringify(original || {});
    const after = JSON.stringify(corrected || {});
    if (before === after) return null;
    return {
      problem: before.slice(0, 1200),
      correction: after.slice(0, 1200),
    };
  }

  function saveCorrectionExample(row, original, corrected) {
    const pair = correctionPair(original, corrected);
    if (!pair) return;
    try {
      db.prepare(`
        INSERT INTO intake_training_examples (title, document_type, problem_text, correction_text)
        VALUES (?, ?, ?, ?)
      `).run(
        `Intake correction #${row.id}`,
        row.source || 'intake_review',
        pair.problem,
        pair.correction
      );
    } catch (error) {
      console.warn('[Intake OCR] Training example save skipped:', error.message);
    }
  }

  function saveReviewedItemCorrectionExample(row, item, index, orderItem) {
    if (!item || normalizeReviewStatus(item.operator_review_status || item.review_status || item.manual_review_status) !== 'approved') return;
    const source = {
      intake_id: row.id,
      order_id: row.order_id,
      item_id: orderItem?.id || item.item_id || null,
      item_index: index,
      original_item: item.original_item || null,
      source_ref: item.source_ref || null,
      fields: item.fields || null,
    };
    const correction = {
      scope: 'row_approval',
      item_index: index,
      item_number: item.item_number || item.row_number || index + 1,
      diameter: item.diameter ?? item.diameter_mm ?? null,
      quantity: item.quantity ?? item.qty ?? item.pcs ?? null,
      total_length_mm: item.total_length_mm ?? item.length_mm ?? item.length ?? null,
      shape_name: item.shape_name || item.shapeName || item.shape || null,
      segments: item.segments || null,
      target_weight_kg: item.target_weight_kg ?? item.weight_kg ?? null,
      operator_reviewed_at: item.operator_reviewed_at || null,
    };
    const pair = correctionPair(source, correction);
    if (!pair) return;
    try {
      db.prepare(`
        INSERT INTO intake_training_examples (title, document_type, problem_text, correction_text)
        VALUES (?, ?, ?, ?)
      `).run(
        `Intake row approval #${row.id}/${index + 1}`,
        row.source || 'intake_review',
        pair.problem,
        pair.correction
      );
    } catch (error) {
      console.warn('[Intake OCR] Row approval training example save skipped:', error.message);
    }
  }

  // ── Learned external shape codes ─────────────────────────────────
  // When an operator approves an item that carries an external shape code
  // and a resolved shape snapshot, the pair is saved so the same code maps
  // automatically on the next intake. Built-in catalog codes always win at
  // resolve time, so learning can never override them.
  function learnedMappingFromReviewedItem(item) {
    const snapshot = item?.shapeSnapshot || item?.shape_snapshot || null;
    const internalShapeCode = String(snapshot?.internalShapeCode || snapshot?.internal_shape_code || '').trim();
    const sourceSystem = normalizeSourceSystem(
      item?.sourceSystem || item?.source_system || item?.source?.sourceSystem || item?.source?.source_system || ''
    );
    const externalCode = normalizeExternalCode(
      item?.externalShapeCode || item?.external_shape_code || item?.externalCode || item?.external_code
      || item?.shapeCode || item?.shape_code || ''
    );
    if (!internalShapeCode || !sourceSystem || !externalCode) return null;
    const template = getShapeTemplateByInternalCode(internalShapeCode);
    if (!template) return null;
    return {
      sourceSystem,
      externalCode,
      shapeType: String(snapshot?.shapeType || snapshot?.shape_type || template.shapeType || 'unknown').trim(),
      internalShapeCode,
      label: String(item?.shape_description || item?.shapeDescription || '').trim(),
    };
  }

  function upsertLearnedShapeMapping(mapping, createdBy) {
    db.prepare(`
      INSERT INTO external_shape_mappings (source_system, external_code, label, shape_type, internal_shape_code, confidence, created_by, active)
      VALUES (?,?,?,?,?, 'learned', ?, 1)
      ON CONFLICT(source_system, external_code) DO UPDATE SET
        label=excluded.label,
        shape_type=excluded.shape_type,
        internal_shape_code=excluded.internal_shape_code,
        confidence='learned',
        created_by=excluded.created_by,
        active=1
    `).run(mapping.sourceSystem, mapping.externalCode, mapping.label || null, mapping.shapeType, mapping.internalShapeCode, createdBy || null);
  }

  function saveLearnedShapeMapping(item, createdBy) {
    try {
      const mapping = learnedMappingFromReviewedItem(item);
      if (mapping) upsertLearnedShapeMapping(mapping, createdBy);
    } catch (error) {
      console.warn('[Intake OCR] Learned shape mapping save skipped:', error.message);
    }
  }

  router.get('/intake/log', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const status = req.query.status; // optional filter: pending_review / approved / rejected
    const sql = status
      ? 'SELECT * FROM intake_log WHERE status=? ORDER BY created_at DESC LIMIT 100'
      : 'SELECT * FROM intake_log ORDER BY created_at DESC LIMIT 100';
    res.json(db.prepare(sql).all(...(status ? [status] : [])).map(enrichIntakeRow));
  });

  function itemNeedsPostOrderReview(item) {
    const status = String(item.review_status || '').trim().toLowerCase();
    if (status === 'approved') return false;
    if (['pending', 'missing'].includes(status)) return true;
    const note = item.review_note_text || item.review_notes || item.note || '';
    return /review|required|unclear|uncertain|verify|ambiguous|not clear/i.test(note);
  }

  function normalizeReviewStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    if (['accepted', 'approved', 'verified', '1', 'true'].includes(value)) return 'approved';
    if (['missing', 'invalid', 'rejected', 'not_ok', 'not-valid'].includes(value)) return 'missing';
    return 'pending';
  }

  function applyOrderItemReviewState(parsed, orderItems) {
    const next = parsedOverride({}, parsed);
    const parsedItems = next.items.length ? next.items : orderItems.map(orderItemToParsedItem);
    next.items = parsedItems.map((item, index) => {
      const orderItem = orderItems[index];
      if (!orderItem) return item;
      const reviewStatus = normalizeReviewStatus(orderItem.review_status);
      const operatorStatus = reviewStatus === 'approved' ? 'accepted' : reviewStatus === 'missing' ? 'missing' : 'review';
      return {
        ...item,
        item_id: orderItem.id,
        review_status: operatorStatus,
        operator_review_status: operatorStatus,
        operator_approved: reviewStatus === 'approved' ? '1' : '',
        operator_reviewed_at: orderItem.reviewed_at || item.operator_reviewed_at || '',
      };
    });
    return next;
  }

  router.get('/intake/order-review-tasks', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const rows = db.prepare(`
      SELECT il.*, o.order_num, c.name AS customer_name
      FROM intake_log il
      JOIN orders o ON o.id = il.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE il.status='approved'
      ORDER BY il.created_at DESC
      LIMIT 100
    `).all();
    const tasks = rows.map(row => {
      const items = db.prepare(`
        SELECT id,shape_snapshot_json,shape_id,shape_name,diameter,spiral_diameter_mm,spiral_turns,
               segments,total_length_mm,quantity,production_qty,weight_per_unit,total_weight,
               struct_element,struct_floor,sheet_num,note,review_notes,
               COALESCE(review_notes,note) AS review_note_text,review_status,reviewed_at
        FROM items
        WHERE order_id=?
        ORDER BY id
      `).all(row.order_id);
      const reviewItems = items.filter(itemNeedsPostOrderReview);
      const enriched = enrichIntakeRow(row);
      const parsed = applyOrderItemReviewState(parseStoredIntake(row), items);
      if (!reviewItems.length) return null;
      return {
        ...enriched,
        parsed,
        parsed_data: JSON.stringify(parsed),
        post_order_review: true,
        review_count: reviewItems.length,
        review_items: reviewItems,
      };
    }).filter(Boolean);
    res.json(tasks);
  });

  router.post('/intake/:id/approve', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const row = db.prepare('SELECT * FROM intake_log WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Intake row not found' });
    if (row.order_id) {
      const order = db.prepare('SELECT order_num FROM orders WHERE id=?').get(row.order_id);
      if (row.status !== 'approved') {
        db.prepare('UPDATE intake_log SET status=? WHERE id=?').run('approved', row.id);
      }
      return res.json({ success: true, orderId: row.order_id, orderNum: order?.order_num, alreadyApproved: true });
    }
    try {
      const originalParsed = parseStoredIntake(row);
      const parsed = intakeWorkflow.withStructuredReviewNotes(
        parsedOverride(originalParsed, req.body?.parsed_data),
        { sourceIdentity: sourceIdentityForRow(row) }
      );
      const body = req.body || {};
      const customerOverride = body.customer_id ? {
        id: Number(body.customer_id),
        name: body.customer_name || null,
        phone: body.customer_phone || null,
        email: body.customer_email || null,
      } : null;
      const validationErrors = intakeWorkflow.intakeApprovalErrors(parsed);
      if (validationErrors.length) {
        return res.status(422).json({ success: false, code: 'intake_incomplete', error: validationErrors.map(entry => entry.message).join('\n'), errors: validationErrors });
      }
      const duplicate = findSourceIdentityDuplicate(db, 'intake_log', row, { excludeId: row.id });
      if (duplicate) {
        return res.status(409).json(sourceIdentityConflictPayload('intake', duplicate));
      }
      const payload = intakeToOrderPayload(parsed, row.source || 'intake', customerOverride, row.raw_content || '');
      if (!payload.customer?.name || payload.customer.name === 'Unidentified customer') {
        return res.status(422).json({ success: false, code: 'intake_incomplete', error: 'יש לבחור לקוח או להשלים את שם הלקוח לפני יצירת הזמנה', errors: [{ field: 'customer_name' }] });
      }
      const approve = db.transaction(() => {
        saveCorrectionExample(row, originalParsed, parsed);
        const result = createOrderFromPayload(payload);
        db.prepare('UPDATE intake_log SET status=?,order_id=?,parsed_data=? WHERE id=?').run('approved', result.orderId, JSON.stringify(parsed), row.id);
        return result;
      });
      const result = approve();
      wsBroadcast('new_order', { orderNum: result.orderNum, orderId: result.orderId });
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/intake/:id/order-review', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const row = db.prepare('SELECT * FROM intake_log WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Intake row not found' });
    if (!row.order_id || row.status !== 'approved') {
      return res.status(409).json({ success: false, error: 'Order review status is available only after intake approval.' });
    }
    const originalParsed = parseStoredIntake(row);
    const parsed = parsedOverride(originalParsed, req.body?.parsed_data);
    const orderItems = db.prepare('SELECT id,review_status,reviewed_at FROM items WHERE order_id=? ORDER BY id').all(row.order_id);
    try {
      const saveReview = db.transaction(() => {
        (parsed.items || []).forEach((item, index) => {
          const orderItem = item?.item_id
            ? orderItems.find(candidate => Number(candidate.id) === Number(item.item_id))
            : orderItems[index];
          if (!orderItem) return;
          const status = normalizeReviewStatus(item.operator_review_status || item.review_status || item.manual_review_status);
          const reviewedAt = item.operator_reviewed_at || new Date().toISOString();
          const note = status === 'missing' ? 'OCR review marked this item missing or invalid.' : null;
          db.prepare('UPDATE items SET review_status=?,review_notes=?,reviewed_by=?,reviewed_at=? WHERE id=? AND order_id=?')
            .run(status, note, 'intake_ocr_review', reviewedAt, orderItem.id, row.order_id);
          if (status === 'approved') {
            saveReviewedItemCorrectionExample(row, item, index, orderItem);
            saveLearnedShapeMapping(item, 'intake_ocr_review');
          }
        });
      });
      saveReview();
      const refreshedItems = db.prepare('SELECT id,review_status,reviewed_at FROM items WHERE order_id=? ORDER BY id').all(row.order_id);
      res.json({ success: true, id: row.id, parsed: applyOrderItemReviewState(parsed, refreshedItems) });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/intake/:id/draft', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const row = db.prepare('SELECT * FROM intake_log WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Intake row not found' });
    if (row.order_id || row.status === 'approved') {
      return res.status(409).json({
        success: false,
        error: 'Intake row is already linked to an approved order; draft save cannot mutate it.',
      });
    }
    try {
      const originalParsed = parseStoredIntake(row);
      const parsed = intakeWorkflow.withStructuredReviewNotes(
        parsedOverride(originalParsed, req.body?.parsed_data),
        { sourceIdentity: sourceIdentityForRow(row) }
      );
      const saveDraft = db.transaction(() => {
        saveCorrectionExample(row, originalParsed, parsed);
        db.prepare('UPDATE intake_log SET status=?,parsed_data=? WHERE id=?')
          .run('pending_review', JSON.stringify(parsed), row.id);
      });
      saveDraft();
      res.json({ success: true, id: row.id, parsed });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });
  router.post('/intake/:id/reject', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const r = db.prepare('UPDATE intake_log SET status=? WHERE id=?').run('rejected', req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'לא נמצא' });
    res.json({ success: true });
  });

  router.post('/intake/parse-text', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const { text, source } = req.body;
    const identity = sourceIdentityFromRequest(req, source || 'manual');
    const duplicate = findSourceIdentityDuplicate(db, 'intake_log', identity);
    if (duplicate) return res.status(409).json(sourceIdentityConflictPayload('intake', duplicate));
    try {
      const parsed = intakeWorkflow.withStructuredReviewNotes(intakeWorkflow.parseManualIntakeText({
        text,
        source,
        parseWhatsAppMessage: intake.parseWhatsAppMessage,
        parseOCRText: intake.parseOCRText,
      }), { sourceIdentity: identity });
      const result = db.prepare('INSERT INTO intake_log (source,source_system,external_id,raw_content,parsed_data,status) VALUES (?,?,?,?,?,?)')
        .run(source || 'manual', identity?.source_system || null, identity?.external_id || null, text.slice(0, 2000), JSON.stringify(parsed), 'pending_review');
      res.json({ success: true, id: result.lastInsertRowid, parsed, item_count: (parsed.items || []).length });
    } catch (error) {
      res.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  // ── Shape mapping catalog: built-in + learned ────────────────────
  router.get('/intake/shape-mappings', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const learned = db.prepare(
      'SELECT id, source_system, external_code, label, shape_type, internal_shape_code, confidence, created_by, created_at FROM external_shape_mappings WHERE active=1 ORDER BY source_system, external_code'
    ).all();
    res.json({ success: true, builtin: listExternalShapeMappings(), learned });
  });

  router.post('/intake/shape-mappings', requireAnyRole(['office', 'manager', 'admin']), (req, res) => {
    const body = req.body || {};
    const sourceSystem = normalizeSourceSystem(body.source_system || body.sourceSystem);
    const externalCode = normalizeExternalCode(body.external_code || body.externalCode);
    const internalShapeCode = String(body.internal_shape_code || body.internalShapeCode || '').trim();
    if (!sourceSystem || !externalCode || !internalShapeCode) {
      return res.status(400).json({ success: false, error: 'source_system, external_code and internal_shape_code are required' });
    }
    const template = getShapeTemplateByInternalCode(internalShapeCode);
    if (!template) {
      return res.status(422).json({ success: false, error: `Unknown internal shape code: ${internalShapeCode}` });
    }
    upsertLearnedShapeMapping({
      sourceSystem,
      externalCode,
      shapeType: template.shapeType || 'unknown',
      internalShapeCode,
      label: String(body.label || '').trim(),
    }, req.user?.username || 'manual');
    res.json({
      success: true,
      mapping: { source_system: sourceSystem, external_code: externalCode, shape_type: template.shapeType, internal_shape_code: internalShapeCode },
    });
  });

  router.delete('/intake/shape-mappings/:id', requireAnyRole(['manager', 'admin']), (req, res) => {
    const result = db.prepare('UPDATE external_shape_mappings SET active=0 WHERE id=? AND active=1').run(req.params.id);
    if (!result.changes) return res.status(404).json({ success: false, error: 'Mapping not found' });
    res.json({ success: true });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'intake-review',
  label: 'אישור קליטה',
  consumes: [{ event: 'new_intake' }, { table: 'intake_log' }],
  produces: [{ event: 'new_order' }, { table: 'external_shape_mappings' }],
};
