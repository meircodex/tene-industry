const axios = require('axios');
const crypto = require('node:crypto');
const router = require('express').Router();

const {
  normalizeBendingShapeInput,
  parseReceiptReviewPayload,
} = require('../services/inventory');
const pendingReceipts = require('../services/pendingRawMaterialReceiptV2');

function required(name, value) {
  if (!value) throw new Error(`routes/inventoryVision missing dependency: ${name}`);
  return value;
}

module.exports = function createInventoryVisionRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const analyzeBendingShapeAuthorization = required('analyzeBendingShapeAuthorization', deps.analyzeBendingShapeAuthorization);
  const imageAnalysisLimiter = required('imageAnalysisLimiter', deps.imageAnalysisLimiter);
  const upload = required('upload', deps.upload);
  const getSetting = required('getSetting', deps.getSetting);
  const getOpenAiApiKey = required('getOpenAiApiKey', deps.getOpenAiApiKey);
  const getIntakeTrainingGuidance = required('getIntakeTrainingGuidance', deps.getIntakeTrainingGuidance);
  const wsBroadcast = required('wsBroadcast', deps.wsBroadcast);

  router.post('/inventory/analyze-bending-shape', analyzeBendingShapeAuthorization, imageAnalysisLimiter, upload.single('image'), async (req, res) => {
    if (getSetting('INTAKE_AI_ENABLED') !== 'true') return res.status(501).json({ error: 'Document recognition is disabled', feature: 'intake-ai' });
    const openaiKey = getOpenAiApiKey();
    if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    if (!req.file) return res.status(400).json({ error: 'Image or PDF is required' });
    const mime = req.file.mimetype || 'image/jpeg';
    if (mime !== 'application/pdf' && !mime.startsWith('image/')) {
      return res.status(400).json({ error: 'Only images and PDFs are supported' });
    }
    const fileData = req.file.buffer.toString('base64');
    const attachment = mime === 'application/pdf'
      ? { type: 'input_file', filename: req.file.originalname || 'bending-shape.pdf', file_data: `data:application/pdf;base64,${fileData}` }
      : { type: 'input_image', image_url: `data:${mime};base64,${fileData}`, detail: 'high' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        shape_name: { type: 'string' },
        diameter: { type: ['number', 'null'] },
        material_grade: { type: ['string', 'null'] },
        confidence: { type: 'number' },
        segments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              length_mm: { type: 'number' },
              angle_deg: { type: 'number' },
            },
            required: ['length_mm', 'angle_deg'],
          },
        },
        total_length_mm: { type: 'number' },
        notes: { type: ['string', 'null'] },
      },
      required: ['shape_name', 'diameter', 'material_grade', 'confidence', 'segments', 'total_length_mm', 'notes'],
    };
    const trainingGuidance = getIntakeTrainingGuidance(12, ['bending_shape', 'bar_schedule', 'general']);
    const prompt = `Analyze this rebar bending shape image.
Return only one bending shape. Read visible dimensions and bend angles.
${trainingGuidance}
length_mm must be millimeters. If dimensions are written in centimeters, convert to millimeters.
Trace the bar continuously from one physical end to the other. Use one segment per visible side.
angle_deg is the interior bend angle after that segment: 180 for straight continuation, 90 for square bends, 135 for diagonal bends.
If the drawing is uncertain, keep the conservative simple shape and explain uncertainty in notes.
Do not invent unreadable numbers.`;
    try {
      const response = await axios.post('https://api.openai.com/v1/responses', {
        model: getSetting('OPENAI_MODEL') || 'gpt-5.4-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, attachment] }],
        text: { format: { type: 'json_schema', name: 'ironbend_bending_shape', strict: true, schema } },
      }, {
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      const text = (response.data?.output || [])
        .flatMap(entry => entry.content || [])
        .find(entry => entry.type === 'output_text')?.text;
      const parsed = JSON.parse(text || '{}');
      const segments = normalizeBendingShapeInput({ bending_shape_segments: parsed.segments || [] }).segments;
      if (!segments.length) return res.status(422).json({ error: 'No bending shape was recognized' });
      res.json({
        success: true,
        shape_name: String(parsed.shape_name || 'כיפוף מזוהה').trim(),
        diameter: parsed.diameter == null ? null : Number(parsed.diameter),
        material_grade: parsed.material_grade || null,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        segments,
        total_length_mm: segments.reduce((sum, segment) => sum + segment.length_mm, 0),
        notes: parsed.notes || null,
      });
    } catch (err) {
      const message = err.response?.data?.error?.message || err.message;
      res.status(500).json({ error: `Bending shape recognition failed: ${message}` });
    }
  });

  router.post('/inventory/scan-label', requireAnyRole(['warehouse', 'office', 'manager', 'admin']), imageAnalysisLimiter, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'נדרשת תמונה' });
    const mime = req.file.mimetype || 'image/jpeg';
    if (!mime.startsWith('image/')) return res.status(400).json({ error: 'נתמכות תמונות בלבד' });
    if (getSetting('INTAKE_AI_ENABLED') !== 'true') {
      // AI מושבת — מחזיר טופס ריק לעובד למלא ידנית
      return res.json({ success: true, aiUsed: false, data: { diameter: null, lot_number: null, weight_kg: null, grade: 'B500B', material_type: 'coil', certificate_num: null, notes: null } });
    }
    const openaiKey = getOpenAiApiKey();
    if (!openaiKey) {
      return res.json({ success: true, aiUsed: false, data: { diameter: null, lot_number: null, weight_kg: null, grade: 'B500B', material_type: 'coil', certificate_num: null, notes: null } });
    }

    const fileData = req.file.buffer.toString('base64');
    const schema   = {
      type: 'object',
      additionalProperties: false,
      properties: {
        diameter:        { type: ['number',  'null'] },
        lot_number:      { type: ['string',  'null'] },
        weight_kg:       { type: ['number',  'null'] },
        grade:           { type: ['string',  'null'] },
        material_type:   { type: ['string',  'null'] },
        certificate_num: { type: ['string',  'null'] },
        supplier_name:   { type: ['string',  'null'] },
        notes:           { type: ['string',  'null'] },
        confidence:      { type: ['number',  'null'] },
      },
      required: ['diameter', 'lot_number', 'weight_kg', 'grade', 'material_type', 'certificate_num', 'supplier_name', 'notes', 'confidence'],
    };

    const prompt = `You are reading a steel bar or coil label in a factory warehouse.
Extract ONLY what is clearly visible. Return null for any field you cannot read confidently.

Fields to extract:
- diameter: bar diameter in mm (integer: 6,8,10,12,14,16,20,25,32 etc.)
- lot_number: lot or heat number (text on label, often "LOT", "חום", "לוט", or a code)
- weight_kg: net weight in kg (number only, ignore "ק\"ג" or "KG" suffix)
- grade: steel grade (B500B, B500C, or similar — default B500B if not visible)
- material_type: "coil" for coils/ملف, "straight" for straight bars/ישר
- certificate_num: material certificate number if visible
- supplier_name: supplier name if visible on label
- notes: any other relevant text (heat treatment, standard, etc.)
- confidence: 0.0–1.0 overall confidence in the reading

IMPORTANT:
- If weight is not on the label, return null for weight_kg (do not guess)
- Diameter is critical — if unclear, return null
- lot_number is critical — if unclear, return null
Return JSON matching the schema only.`;

    try {
      const response = await axios.post('https://api.openai.com/v1/responses', {
        model: getSetting('OPENAI_MODEL') || 'gpt-4o-mini',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: `data:${mime};base64,${fileData}`, detail: 'high' },
          ],
        }],
        text: { format: { type: 'json_schema', name: 'label_scan', strict: true, schema } },
      }, {
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      const text   = (response.data?.output || []).flatMap(e => e.content || []).find(e => e.type === 'output_text')?.text;
      const parsed = JSON.parse(text || '{}');

      // נסה לזהות ספק לפי שם
      let supplierId = null;
      if (parsed.supplier_name) {
        const s = db.prepare('SELECT id FROM suppliers WHERE name LIKE ? LIMIT 1').get(`%${parsed.supplier_name}%`);
        if (s) supplierId = s.id;
      }

      res.json({
        success:    true,
        aiUsed:     true,
        confidence: parsed.confidence ?? null,
        data: {
          diameter:        parsed.diameter        ?? null,
          lot_number:      parsed.lot_number      ?? null,
          weight_kg:       parsed.weight_kg       ?? null,
          grade:           parsed.grade           || 'B500B',
          material_type:   parsed.material_type   || 'coil',
          certificate_num: parsed.certificate_num ?? null,
          supplier_name:   parsed.supplier_name   ?? null,
          supplier_id:     supplierId,
          notes:           parsed.notes           ?? null,
        },
      });
    } catch (err) {
      // AI נכשל — מחזיר טופס ריק, לא שגיאה
      console.warn('[scan-label] AI failed:', err.message);
      res.json({
        success: true,
        aiUsed:  false,
        aiError: err.message,
        data: { diameter: null, lot_number: null, weight_kg: null, grade: 'B500B', material_type: 'coil', certificate_num: null, supplier_name: null, supplier_id: null, notes: null },
      });
    }
  });

  router.post('/inventory/receipt-reviews/analyze', analyzeBendingShapeAuthorization, imageAnalysisLimiter, upload.single('image'), async (req, res) => {
    if (getSetting('INTAKE_AI_ENABLED') !== 'true') return res.status(501).json({ error: 'Document recognition is disabled', feature: 'intake-ai' });
    const openaiKey = getOpenAiApiKey();
    if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    if (!req.file) return res.status(400).json({ error: 'Supplier delivery note image or PDF is required' });
    const mime = req.file.mimetype || 'image/jpeg';
    if (mime !== 'application/pdf' && !mime.startsWith('image/')) {
      return res.status(400).json({ error: 'Only images and PDFs are supported' });
    }
    const fileData = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${fileData}`;
    const attachment = mime === 'application/pdf'
      ? { type: 'input_file', filename: req.file.originalname || 'supplier-delivery-note.pdf', file_data: dataUrl }
      : { type: 'input_image', image_url: dataUrl, detail: 'high' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_name: { type: ['string', 'null'] },
        delivery_note_num: { type: ['string', 'null'] },
        received_date: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              material_type: { type: 'string' },
              diameter: { type: ['number', 'null'] },
              lot_number: { type: ['string', 'null'] },
              certificate_num: { type: ['string', 'null'] },
              grade: { type: ['string', 'null'] },
              weight_kg: { type: ['number', 'null'] },
              purchase_price: { type: ['number', 'null'] },
              warehouse_loc: { type: ['string', 'null'] },
              shape_name: { type: ['string', 'null'] },
              segments: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    length_mm: { type: 'number' },
                    angle_deg: { type: 'number' },
                  },
                  required: ['length_mm', 'angle_deg'],
                },
              },
              confidence: { type: ['number', 'null'] },
              notes: { type: ['string', 'null'] },
            },
            required: ['material_type', 'diameter', 'lot_number', 'certificate_num', 'grade', 'weight_kg', 'purchase_price', 'warehouse_loc', 'shape_name', 'segments', 'confidence', 'notes'],
          },
        },
      },
      required: ['supplier_name', 'delivery_note_num', 'received_date', 'notes', 'items'],
    };
    const trainingGuidance = getIntakeTrainingGuidance(12, ['supplier_delivery_note', 'bar_schedule', 'bending_shape', 'general']);
    const prompt = `Read this supplier delivery note / raw material receipt document.
Return the material received, but do not invent unreadable values.
${trainingGuidance}
The document may be a photo, PDF, supplier delivery note, lab certificate, or handwritten receipt.
Extract supplier_name, delivery_note_num, received_date as YYYY-MM-DD when visible, and every material row.
For each row return material_type: coil, straight, or bent.
For raw rebar stock, diameter is millimeters and weight_kg is kilograms.
Use lot_number for heat number / melt number / batch number when visible.
Use certificate_num for lab certificate or material certificate number when visible.
If a row is a bent shape, include shape_name and continuous bending segments in millimeters.
Put uncertainty in notes. The manager will compare this parsed data against the original image before approval.`;
    try {
      const response = await axios.post('https://api.openai.com/v1/responses', {
        model: getSetting('OPENAI_MODEL') || 'gpt-5.4-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, attachment] }],
        text: { format: { type: 'json_schema', name: 'ironbend_supplier_receipt', strict: true, schema } },
      }, {
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      const text = (response.data?.output || [])
        .flatMap(entry => entry.content || [])
        .find(entry => entry.type === 'output_text')?.text;
      const parsed = parseReceiptReviewPayload(JSON.parse(text || '{}'));
      const supplier = parsed.supplier_name
        ? db.prepare('SELECT id FROM suppliers WHERE name LIKE ? AND active=1 ORDER BY id LIMIT 1').get(`%${parsed.supplier_name}%`)
        : null;
      parsed.items = parsed.items.map(item => ({
        ...item,
        supplier_id: supplier?.id || null,
        received_date: item.received_date || parsed.received_date || new Date().toISOString().slice(0, 10),
        lot_number: item.lot_number || parsed.delivery_note_num || null,
      }));
      const receipt = pendingReceipts.createDraft(db, {
        source_type: 'ocr', source_ref: `ocr:${req.file.originalname || 'supplier-delivery-note'}:${crypto.createHash('sha256').update(req.file.buffer).digest('hex')}`,
        supplier_id: supplier?.id || null, supplier_name: parsed.supplier_name, delivery_note_num: parsed.delivery_note_num,
        notes: parsed.notes, lines: parsed.items.map((item, index) => ({ ...item, source_line_ref: `ocr-${index + 1}`, weight_received: item.weight_received ?? item.weight_kg })),
        idempotency_key: `ocr:${crypto.createHash('sha256').update(req.file.buffer).digest('hex')}`, created_by: req.auth?.sub,
      });
      wsBroadcast('pending_raw_material_receipt_created', { id: receipt.id, supplier_name: parsed.supplier_name, item_count: parsed.items.length });
      res.json({ success: true, id: receipt.id, receipt_id: receipt.id, parsed });
    } catch (err) {
      console.error('[Inventory Receipt OCR]', err.response?.data || err.message);
      res.status(502).json({ error: 'Supplier delivery note recognition failed', detail: err.response?.data?.error?.message || err.message });
    }
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  id: 'inventory-vision',
  label: 'זיהוי מלאי',
  consumes: [{ external: 'openai-vision' }, { table: 'intake_training_examples' }],
  produces: [{ event: 'inventory_receipt_review_created' }, { event: 'pending_raw_material_receipt_created' }],
};
