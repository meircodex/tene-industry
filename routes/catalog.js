const router = require('express').Router();
const { createSavedShapeCatalog } = require('../services/savedShapeCatalog');

function required(name, value) {
  if (!value) throw new Error(`routes/catalog missing dependency: ${name}`);
  return value;
}

module.exports = function createCatalogRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const upload = deps.upload;
  const imageAnalysisLimiter = deps.imageAnalysisLimiter || ((_req, _res, next) => next());
  const getSetting = deps.getSetting || (() => null);
  const getOpenAiApiKey = deps.getOpenAiApiKey || (() => null);

  function trimText(value) {
    return String(value ?? '').trim();
  }

  function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function priceBookById(id) {
    return db.prepare('SELECT * FROM pricing_price_books WHERE id = ?').get(Number(id));
  }

  function syncCustomerPriceTier(priceBook) {
    if (priceBook.price_type !== 'customer' || priceBook.status !== 'active' || !priceBook.customer_id) return;
    db.prepare("UPDATE customers SET price_tier = 'customer' WHERE id = ?").run(Number(priceBook.customer_id));
  }

  function normalizeRecognizedItem(item = {}, index = 0, currency = 'ILS') {
    const sku = trimText(item.sku) || (item.diameter ? `D${Number(item.diameter)}` : `OCR-${index + 1}`);
    const description = trimText(item.description) || sku;
    return {
      sku,
      diameter: item.diameter === null || item.diameter === undefined || item.diameter === '' ? null : Number(item.diameter),
      category: trimText(item.category),
      description,
      quantity: toNumber(item.quantity, 1) || 1,
      unit: trimText(item.unit || 'kg') || 'kg',
      price_before_vat: toNumber(item.price_before_vat, 0),
      currency: trimText(item.currency || currency || 'ILS') || 'ILS',
      notes: trimText(item.notes),
    };
  }

  function pricingOcrContext(req) {
    return {
      requested_by_module: trimText(req.body.requested_by_module || req.body.requestedByModule || 'pricing') || 'pricing',
      requested_use_case: trimText(req.body.requested_use_case || req.body.requestedUseCase || 'price_book_import') || 'price_book_import',
      target_module: trimText(req.body.target_module || 'pricing') || 'pricing',
      document_type: trimText(req.body.document_type_hint || req.body.document_type || 'price_book') || 'price_book',
      result_endpoint: '/api/pricing/price-books/analyze-upload',
    };
  }

  async function analyzePriceListWithOpenAI(req) {
    const openaiKey = getOpenAiApiKey();
    if (!openaiKey) {
      const error = new Error('OPENAI_API_KEY is not configured');
      error.status = 500;
      throw error;
    }
    const mime = req.file.mimetype || 'application/octet-stream';
    const fileData = req.file.buffer.toString('base64');
    const attachment = mime === 'application/pdf'
      ? { type: 'input_file', filename: req.file.originalname || 'price-list.pdf', file_data: `data:application/pdf;base64,${fileData}` }
      : { type: 'input_image', image_url: `data:${mime};base64,${fileData}`, detail: 'high' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        customer_name: { type: ['string', 'null'] },
        currency: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sku: { type: ['string', 'null'] },
              diameter: { type: ['number', 'null'] },
              category: { type: ['string', 'null'] },
              description: { type: ['string', 'null'] },
              quantity: { type: ['number', 'null'] },
              unit: { type: ['string', 'null'] },
              price_before_vat: { type: ['number', 'null'] },
              currency: { type: ['string', 'null'] },
              notes: { type: ['string', 'null'] },
            },
            required: ['sku', 'diameter', 'category', 'description', 'quantity', 'unit', 'price_before_vat', 'currency', 'notes'],
          },
        },
      },
      required: ['code', 'name', 'customer_name', 'currency', 'notes', 'items'],
    };
    const context = pricingOcrContext(req);
    const prompt = `The operator is importing a steel/rebar price list into IronBend pricing.
The upload context is requested_by_module=${context.requested_by_module}, requested_use_case=${context.requested_use_case}, target_module=${context.target_module}, document_type=${context.document_type}.
This is not a customer order intake route. Return only a price-book draft for /api/pricing/price-books/analyze-upload.
Extract only price-list rows. Do not extract payment terms, totals, VAT summaries, addresses, or legal text as item rows.
Return a draft that the operator will edit before saving.
For each row:
- sku is the printed catalog/item code when visible. For diameter-only rebar rows use D8, D10, D12, etc.
- diameter is the rebar diameter in millimeters when the item is a bar diameter row; otherwise null.
- category is a short category such as rebar, mesh, delivery, processing, or other.
- description is the visible item description.
- quantity defaults to 1 unless the row clearly has a price quantity basis.
- unit should be kg for price per kilogram, ton for ton, unit for fixed item, or m for meter.
- price_before_vat is the customer-facing unit price before VAT as a number.
- currency should be ILS unless the document clearly states otherwise.
If a value is uncertain, still return the row with a note. Never invent prices that are not visible.`;
    const response = await require('axios').post('https://api.openai.com/v1/responses', {
      model: getSetting('OPENAI_MODEL') || 'gpt-5.4-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, attachment] }],
      text: { format: { type: 'json_schema', name: 'ironbend_pricing_book', strict: true, schema } },
    }, {
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    const text = (response.data?.output || [])
      .flatMap(entry => entry.content || [])
      .find(entry => entry.type === 'output_text')?.text;
    return JSON.parse(text || '{}');
  }

  function validatePriceBook(body, existing = {}) {
    const code = trimText(body.code ?? existing.code);
    const name = trimText(body.name ?? existing.name);
    if (!code) return { error: 'code_required' };
    if (!name) return { error: 'name_required' };
    const priceType = trimText(body.price_type ?? existing.price_type ?? 'general') === 'customer' ? 'customer' : 'general';
    const customerId = body.customer_id === '' || body.customer_id === undefined || body.customer_id === null
      ? (priceType === 'general' ? null : (existing.customer_id ?? null))
      : Number(body.customer_id);
    const status = trimText(body.status ?? existing.status ?? 'draft') || 'draft';
    if (priceType === 'customer' && status === 'active' && !customerId) return { error: 'customer_required_for_active_customer_price_book' };
    return {
      value: {
        code,
        name,
        customer_id: customerId,
        customer_name: trimText(body.customer_name ?? existing.customer_name),
        price_type: priceType,
        currency: trimText(body.currency ?? existing.currency ?? 'ILS') || 'ILS',
        status,
        source_type: trimText(body.source_type ?? existing.source_type ?? 'manual') || 'manual',
        source_ref: trimText(body.source_ref ?? existing.source_ref),
        notes: trimText(body.notes ?? existing.notes),
      }
    };
  }

  function validatePriceItem(body, existing = {}) {
    const sku = trimText(body.sku ?? existing.sku);
    const description = trimText(body.description ?? existing.description);
    if (!sku) return { error: 'sku_required' };
    if (!description) return { error: 'description_required' };
    return {
      value: {
        sku,
        diameter: body.diameter === '' || body.diameter === undefined || body.diameter === null ? (existing.diameter ?? null) : Number(body.diameter),
        category: trimText(body.category ?? existing.category),
        description,
        quantity: toNumber(body.quantity ?? existing.quantity, 1),
        unit: trimText(body.unit ?? existing.unit ?? 'kg') || 'kg',
        price_before_vat: toNumber(body.price_before_vat ?? existing.price_before_vat, 0),
        currency: trimText(body.currency ?? existing.currency ?? 'ILS') || 'ILS',
        exception_flag: body.exception_flag ? 1 : 0,
        active: body.active === undefined ? (existing.active ?? 1) : (body.active ? 1 : 0),
        valid_from: trimText(body.valid_from ?? existing.valid_from) || null,
        valid_to: trimText(body.valid_to ?? existing.valid_to) || null,
        sort_order: toNumber(body.sort_order ?? existing.sort_order, 0),
        notes: trimText(body.notes ?? existing.notes),
      }
    };
  }

  router.get('/pricing/price-books', requireAnyRole(['office', 'sales', 'finance', 'manager', 'admin']), (req, res) => {
    const type = trimText(req.query.type);
    const where = [];
    const params = [];
    if (type === 'customer') {
      where.push("b.price_type = 'customer'");
    } else if (type === 'general') {
      where.push("b.price_type = 'general'");
    }
    const books = db.prepare(`
      SELECT b.*,
        COUNT(i.id) AS item_count,
        COALESCE(SUM(CASE WHEN i.active = 1 THEN 1 ELSE 0 END), 0) AS active_item_count
      FROM pricing_price_books b
      LEFT JOIN pricing_price_items i ON i.price_book_id = b.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY b.id
      ORDER BY CASE b.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, b.updated_at DESC, b.id DESC
    `).all(...params);
    res.json(books);
  });

  router.post('/pricing/price-books/analyze-upload', requireAnyRole(['finance', 'manager', 'admin']), imageAnalysisLimiter, (req, res, next) => {
    if (!upload) return res.status(501).json({ error: 'pricing_ocr_upload_not_configured' });
    return upload.single('file')(req, res, next);
  }, async (req, res) => {
    if (getSetting('INTAKE_AI_ENABLED') !== 'true') return res.status(501).json({ error: 'Document recognition is disabled', feature: 'pricing-ocr' });
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const mime = req.file.mimetype || 'application/octet-stream';
    if (mime !== 'application/pdf' && !mime.startsWith('image/')) return res.status(400).json({ error: 'unsupported_file_type' });
    try {
      const parsed = await analyzePriceListWithOpenAI(req);
      const currency = trimText(parsed.currency || req.body.currency || 'ILS') || 'ILS';
      const fileStem = trimText((req.file.originalname || 'price-list').replace(/\.[^.]+$/, ''));
      const items = (parsed.items || [])
        .map((item, index) => normalizeRecognizedItem(item, index, currency))
        .filter(item => item.sku && item.description && Number(item.price_before_vat) > 0);
      const context = pricingOcrContext(req);
      res.json({
        success: true,
        context,
        source: {
          filename: req.file.originalname || null,
          mime,
        },
        draft: {
          code: trimText(parsed.code) || `OCR-${Date.now()}`,
          name: trimText(parsed.name) || fileStem,
          customer_name: trimText(parsed.customer_name),
          currency,
          status: 'draft',
          source_type: 'ocr',
          source_ref: req.file.originalname || '',
          notes: trimText(parsed.notes),
          items,
        },
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: `pricing_ocr_failed: ${err.response?.data?.error?.message || err.message}` });
    }
  });

  router.post('/pricing/price-books', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const parsed = validatePriceBook(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const b = parsed.value;
    try {
      const result = db.prepare(`
        INSERT INTO pricing_price_books
          (code, name, customer_id, customer_name, price_type, currency, status, source_type, source_ref, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        b.code, b.name, b.customer_id, b.customer_name, b.price_type, b.currency,
        b.status, b.source_type, b.source_ref, b.notes
      );
      const priceBook = priceBookById(result.lastInsertRowid);
      syncCustomerPriceTier(priceBook);
      res.json({ success: true, price_book: priceBook });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'code_exists' });
      throw err;
    }
  });

  router.patch('/pricing/price-books/:id', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const existing = priceBookById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'price_book_not_found' });
    const parsed = validatePriceBook(req.body || {}, existing);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const b = parsed.value;
    try {
      db.prepare(`
        UPDATE pricing_price_books
        SET code = ?, name = ?, customer_id = ?, customer_name = ?, price_type = ?, currency = ?,
            status = ?, source_type = ?, source_ref = ?, notes = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        b.code, b.name, b.customer_id, b.customer_name, b.price_type, b.currency,
        b.status, b.source_type, b.source_ref, b.notes, existing.id
      );
      const priceBook = priceBookById(existing.id);
      syncCustomerPriceTier(priceBook);
      res.json({ success: true, price_book: priceBook });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'code_exists' });
      throw err;
    }
  });

  router.get('/pricing/price-books/:id/items', requireAnyRole(['office', 'sales', 'finance', 'manager', 'admin']), (req, res) => {
    const book = priceBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'price_book_not_found' });
    const rows = db.prepare(`
      SELECT *
      FROM pricing_price_items
      WHERE price_book_id = ? AND active = 1
      ORDER BY sort_order, category, sku
    `).all(book.id);
    res.json({ price_book: book, items: rows });
  });

  router.post('/pricing/price-books/:id/items', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const book = priceBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'price_book_not_found' });
    const parsed = validatePriceItem(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const i = parsed.value;
    try {
      const result = db.prepare(`
        INSERT INTO pricing_price_items
          (price_book_id, sku, diameter, category, description, quantity, unit, price_before_vat, currency, exception_flag, active, valid_from, valid_to, sort_order, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        book.id, i.sku, i.diameter, i.category, i.description, i.quantity, i.unit, i.price_before_vat, i.currency,
        i.exception_flag, i.active, i.valid_from, i.valid_to, i.sort_order, i.notes
      );
      db.prepare("UPDATE pricing_price_books SET updated_at = datetime('now') WHERE id = ?").run(book.id);
      res.json({ success: true, item: db.prepare('SELECT * FROM pricing_price_items WHERE id = ?').get(result.lastInsertRowid) });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'sku_exists' });
      throw err;
    }
  });

  router.patch('/pricing/price-books/:id/items/:itemId', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const book = priceBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'price_book_not_found' });
    const existing = db.prepare('SELECT * FROM pricing_price_items WHERE id = ? AND price_book_id = ?').get(Number(req.params.itemId), book.id);
    if (!existing) return res.status(404).json({ error: 'price_item_not_found' });
    const parsed = validatePriceItem(req.body || {}, existing);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const i = parsed.value;
    try {
      db.prepare(`
        UPDATE pricing_price_items
        SET sku = ?, diameter = ?, category = ?, description = ?, quantity = ?, unit = ?, price_before_vat = ?,
            currency = ?, exception_flag = ?, active = ?, valid_from = ?, valid_to = ?,
            sort_order = ?, notes = ?, updated_at = datetime('now')
        WHERE id = ? AND price_book_id = ?
      `).run(
        i.sku, i.diameter, i.category, i.description, i.quantity, i.unit, i.price_before_vat, i.currency,
        i.exception_flag, i.active, i.valid_from, i.valid_to, i.sort_order, i.notes, existing.id, book.id
      );
      db.prepare("UPDATE pricing_price_books SET updated_at = datetime('now') WHERE id = ?").run(book.id);
      res.json({ success: true, item: db.prepare('SELECT * FROM pricing_price_items WHERE id = ?').get(existing.id) });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'sku_exists' });
      throw err;
    }
  });

  router.delete('/pricing/price-books/:id/items/:itemId', requireAnyRole(['finance', 'manager', 'admin']), (req, res) => {
    const book = priceBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'price_book_not_found' });
    const result = db.prepare(`
      UPDATE pricing_price_items
      SET active = 0, updated_at = datetime('now')
      WHERE id = ? AND price_book_id = ?
    `).run(Number(req.params.itemId), book.id);
    if (!result.changes) return res.status(404).json({ error: 'price_item_not_found' });
    db.prepare("UPDATE pricing_price_books SET updated_at = datetime('now') WHERE id = ?").run(book.id);
    res.json({ success: true });
  });

  const savedShapeCatalog = createSavedShapeCatalog(db);
  router.get('/shape-definitions', requireAnyRole(['office', 'sales', 'production', 'manager', 'admin']), (_req, res) => {
    res.json({ entries: savedShapeCatalog.list() });
  });
  router.post('/shape-definitions', requireAnyRole(['manager', 'admin']), (req, res) => {
    const result = savedShapeCatalog.create(req.body || {});
    res.status(result.status).json(result.entry ? { entry: result.entry } : { error: result.error });
  });
  router.put('/shape-definitions/:id', requireAnyRole(['manager', 'admin']), (req, res) => {
    const result = savedShapeCatalog.update(req.params.id, req.body || {});
    res.status(result.status).json(result.entry ? { entry: result.entry } : { error: result.error });
  });

  router.get('/shapes', requireAnyRole(['office', 'sales', 'production', 'manager', 'admin']), (req, res) => {
    const { bends } = req.query;
    let sql = 'SELECT * FROM shapes WHERE active=1';
    const params = [];
    if (bends !== undefined) { sql += ' AND bends=?'; params.push(Number(bends)); }
    sql += ' ORDER BY sort_order, bends, name';
    res.json(db.prepare(sql).all(...params));
  });

  router.post('/shapes', requireAnyRole(['manager', 'admin']), (req, res) => {
    const { id, name, bends, sidesDefault, anglesDefault, emoji, description } = req.body;
    if (db.prepare('SELECT id FROM shapes WHERE id=? AND definition_json IS NOT NULL').get(id || '')) return res.status(409).json({ error: 'יש לעדכן צורה משותפת דרך קטלוג הצורות' });
    db.prepare(`INSERT OR REPLACE INTO shapes (id,name,bends,sides_default,angles_default,emoji,description) VALUES (?,?,?,?,?,?,?)`)
      .run(id, name, bends || 0, JSON.stringify(sidesDefault || []), JSON.stringify(anglesDefault || []), emoji || '⬡', description || '');
    res.json({ success: true });
  });

  // ── SHAPE SEED (standard Israeli rebar catalog) ──────────────────
  router.post('/shapes/seed', requireAnyRole(['manager', 'admin']), (req, res) => {
    // Standard Israeli rebar shapes (based on IS/BS 8666 catalog)
    // Dimensions in mm, angles in degrees
    const CATALOG = [
      // ── 0 Bends ──────────────────────────────────────────────────
      { id:'s00', name:'ישר',               bends:0, sides:[3000],                          angles:[],                  emoji:'➖', sort:1,  desc:'מוט ישר ללא כיפופים' },
      // ── 1 Bend ───────────────────────────────────────────────────
      { id:'s01', name:'L – זווית 90°',     bends:1, sides:[500,200],                        angles:[90],                emoji:'⌐', sort:2,  desc:'כיפוף L בזווית ישרה' },
      { id:'s02', name:'L – זווית 45°',     bends:1, sides:[500,200],                        angles:[45],                emoji:'⌐', sort:3,  desc:'כיפוף L בזווית 45°' },
      { id:'s03', name:'L – זווית 135°',    bends:1, sides:[500,200],                        angles:[135],               emoji:'⌐', sort:4,  desc:'כיפוף L בזווית 135°' },
      // ── 2 Bends ──────────────────────────────────────────────────
      { id:'s10', name:'U – אנקר 90°',      bends:2, sides:[150,1250,150],                   angles:[90,90],             emoji:'∪', sort:5,  desc:'אנקר U כיפוף 90°' },
      { id:'s11', name:'U – אנקר רחב',      bends:2, sides:[150,6000,150],                   angles:[90,90],             emoji:'∪', sort:6,  desc:'אנקר U רחב' },
      { id:'s12', name:'Z – הזזה',           bends:2, sides:[300,400,300],                    angles:[135,135],           emoji:'Z', sort:7,  desc:'הזזה Z' },
      { id:'s13', name:'S – כפול',           bends:2, sides:[300,400,300],                    angles:[45,45],             emoji:'S', sort:8,  desc:'כיפוף S כפול' },
      { id:'s14', name:'שלב פתוח',           bends:2, sides:[600,200,600],                    angles:[45,135],            emoji:'⊂', sort:9,  desc:'שלב פתוח עם זוויות' },
      // ── 3 Bends ──────────────────────────────────────────────────
      { id:'s20', name:'קרס – אוברל',        bends:3, sides:[200,400,400,200],                angles:[90,180,90],         emoji:'⎡', sort:10, desc:'קרס overlap עם כיפוף 180°' },
      { id:'s21', name:'אסדה פתוחה',         bends:3, sides:[200,500,500,200],                angles:[90,90,90],          emoji:'⬓', sort:11, desc:'אסדה פתוחה 3 כיפופים' },
      { id:'s22', name:'T – רגל',            bends:3, sides:[250,600,250,100],                angles:[90,90,90],          emoji:'⊤', sort:12, desc:'צורת T עם רגל' },
      // ── 4 Bends ──────────────────────────────────────────────────
      { id:'s30', name:'מסגרת מלבנית',       bends:4, sides:[400,200,400,200,100],            angles:[90,90,90,90],       emoji:'▭', sort:13, desc:'אצבה מלבנית – stirrup' },
      { id:'s31', name:'מסגרת ריבועית',      bends:4, sides:[300,300,300,300,100],            angles:[90,90,90,90],       emoji:'□', sort:14, desc:'אצבה ריבועית' },
      { id:'s32', name:'מסגרת גדולה',        bends:4, sides:[600,400,600,400,100],            angles:[90,90,90,90],       emoji:'▬', sort:15, desc:'מסגרת גדולה' },
      { id:'s33', name:'מסגרת עם אלכסון',    bends:4, sides:[300,300,300,300,100],            angles:[45,135,45,135],     emoji:'◇', sort:16, desc:'מסגרת עם כיפופים אלכסוניים' },
      // ── 5 Bends ──────────────────────────────────────────────────
      { id:'s40', name:'חמישה כיפופים',      bends:5, sides:[150,200,400,200,400,150],        angles:[90,90,90,90,90],    emoji:'⌂', sort:17, desc:'מוט עם 5 כיפופים' },
      { id:'s41', name:'W – גלי',            bends:5, sides:[200,300,200,300,200,200],        angles:[45,135,45,135,45],  emoji:'〜', sort:18, desc:'מוט גלי W' },
      // ── 6 Bends ──────────────────────────────────────────────────
      { id:'s50', name:'ששה כיפופים',        bends:6, sides:[150,150,400,150,400,150,150],    angles:[90,90,90,90,90,90], emoji:'⬡', sort:19, desc:'מוט עם 6 כיפופים' },
      { id:'s51', name:'ספירלה מלבנית',      bends:6, sides:[300,200,300,200,300,200,300],    angles:[90,90,90,90,90,90], emoji:'🌀', sort:20, desc:'ספירלה עם 6+ כיפופים' },
      // ── Special ──────────────────────────────────────────────────
      { id:'s60', name:'אנקר U – קצר',       bends:2, sides:[100,800,100],                    angles:[90,90],             emoji:'∪', sort:21, desc:'אנקר U קצר' },
      { id:'s61', name:'אנקר U – ארוך',      bends:2, sides:[200,2000,200],                   angles:[90,90],             emoji:'∪', sort:22, desc:'אנקר U ארוך' },
      { id:'s62', name:'ראש עוגן',           bends:2, sides:[300,1500,300],                    angles:[90,90],             emoji:'⚓', sort:23, desc:'ראש עוגן – U רחב' },
      { id:'s63', name:'U – עם זוויות 45°',  bends:2, sides:[200,800,200],                    angles:[45,45],             emoji:'∪', sort:24, desc:'U כיפוף בזוויות 45°' },
      { id:'s70', name:'מסגרת 6 צלעות',      bends:5, sides:[200,400,200,400,200,400],        angles:[60,120,60,120,60],  emoji:'⬡', sort:25, desc:'מסגרת משושה' },
      { id:'s80', name:'רשת – mesh',          bends:0, sides:[6000],                            angles:[],                  emoji:'⊞', sort:26, desc:'רשת ברזל – mesh' },
      { id:'s90', name:'מותאם אישית',        bends:0, sides:[1000],                            angles:[],                  emoji:'✏️', sort:99, desc:'כיפוף חופשי', custom:true },
    ];

    // Ensure sort_order column exists (add if missing)
    try {
      db.prepare('ALTER TABLE shapes ADD COLUMN sort_order INTEGER DEFAULT 99').run();
    } catch(e) { /* column already exists */ }

    const insert = db.prepare(`INSERT OR REPLACE INTO shapes
      (id,name,bends,sides_default,angles_default,emoji,description,sort_order,active)
      VALUES (?,?,?,?,?,?,?,?,1)`);

    const runAll = db.transaction(() => {
      CATALOG.forEach(s => {
        insert.run(
          s.id, s.name, s.bends,
          JSON.stringify(s.sides),
          JSON.stringify(s.angles),
          s.emoji, s.desc || '', s.sort || 99
        );
      });
    });
    runAll();

    res.json({ success: true, count: CATALOG.length, shapes: CATALOG.map(s => s.id) });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "catalog",
  "label": "Catalog",
  "consumes": [
    {
      "table": "shapes"
    },
    {
      "table": "pricing_price_books"
    },
    {
      "table": "pricing_price_items"
    }
  ],
  "produces": [
    {
      "event": "pricing_price_book_update"
    }
  ]
};
