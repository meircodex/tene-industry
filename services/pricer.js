'use strict';

const { itemShapeMetrics } = require('./shapeSnapshot');

function createPricer(db) {
  if (!db) throw new Error('services/pricer missing dependency: db');

  function normalizeTier(tier) {
    return tier === 'customer' ? 'customer' : 'general';
  }

  function priceLabel(tier) {
    return normalizeTier(tier) === 'customer' ? 'מחירון לקוח' : 'מחירון כללי';
  }

  function normalizeDiscount(discountPct) {
    const n = Number(discountPct);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function isUsablePrice(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
  }

  function missingPriceResult(diameter, tier, reason = 'missing_price') {
    const normalizedTier = normalizeTier(tier);
    return {
      diameter: Number(diameter),
      pricePerKg: null,
      price_per_kg: null,
      basePrice: null,
      pricingSource: normalizedTier === 'customer' ? 'customer' : 'general',
      pricingLabel: priceLabel(normalizedTier),
      status: 'price_list_requires_update',
      requiresPriceListUpdate: true,
      warning: 'מחירון דורש עדכון',
      reason,
    };
  }

  function getActivePriceBook({ tier = 'general', customerId = null } = {}) {
    const normalizedTier = normalizeTier(tier);
    if (normalizedTier === 'customer') {
      if (!customerId) return null;
      return db.prepare(`
        SELECT *
        FROM pricing_price_books
        WHERE status = 'active'
          AND price_type = 'customer'
          AND customer_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(Number(customerId)) || null;
    }
    return db.prepare(`
      SELECT *
      FROM pricing_price_books
      WHERE status = 'active'
        AND price_type = 'general'
        AND customer_id IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get() || null;
  }

  function getPriceRow(diameter, options = {}) {
    const book = getActivePriceBook(options);
    if (!book) return null;
    const row = db.prepare(`
      SELECT i.*, b.id AS price_book_id, b.code AS price_book_code, b.name AS price_book_name, b.price_type,
             b.updated_at AS price_book_updated_at
      FROM pricing_price_items i
      JOIN pricing_price_books b ON b.id = i.price_book_id
      WHERE i.price_book_id = ?
        AND i.active = 1
        AND (
          i.diameter = ?
          OR i.sku = ?
          OR i.sku = ?
        )
      ORDER BY i.sort_order, i.id
      LIMIT 1
    `).get(book.id, Number(diameter), String(diameter), `D${Number(diameter)}`);
    return row || null;
  }

  function getAllPriceRows(options = {}) {
    const book = getActivePriceBook(options);
    if (!book) return [];
    return db.prepare(`
      SELECT i.*, b.id AS price_book_id, b.code AS price_book_code, b.name AS price_book_name, b.price_type,
             b.updated_at AS price_book_updated_at
      FROM pricing_price_items i
      JOIN pricing_price_books b ON b.id = i.price_book_id
      WHERE i.price_book_id = ? AND i.active = 1
      ORDER BY i.sort_order, i.diameter, i.sku
    `).all(book.id);
  }

  function resolveDiameterPrice(diameter, { tier = 'general', customerId = null, discountPct = 0 } = {}) {
    const normalizedTier = normalizeTier(tier);
    const row = getPriceRow(diameter, { tier: normalizedTier, customerId });
    if (!row) return missingPriceResult(diameter, normalizedTier, 'missing_diameter');
    const base = row.price_before_vat;
    if (!isUsablePrice(base)) return missingPriceResult(diameter, normalizedTier, 'missing_selected_price');

    const discount = normalizeDiscount(discountPct);
    const pricePerKg = Number((Number(base) * (1 - discount / 100)).toFixed(3));
    return {
      diameter: Number(diameter),
      sku: row.sku,
      priceBookId: row.price_book_id,
      priceBookCode: row.price_book_code,
      pricePerKg,
      price_per_kg: pricePerKg,
      basePrice: Number(base),
      pricingSource: normalizedTier === 'customer' ? 'customer' : 'general',
      pricingLabel: priceLabel(normalizedTier),
      discountPct: discount,
      status: 'priced',
      requiresPriceListUpdate: false,
    };
  }

  function getPricePerKg(diameter, { tier = 'general', customerId = null, discountPct = 0 } = {}) {
    return resolveDiameterPrice(diameter, { tier, customerId, discountPct }).pricePerKg;
  }

  function buildPriceMap({ tier = 'general', customerId = null, discountPct = 0 } = {}) {
    const map = {};
    for (const row of getAllPriceRows({ tier, customerId })) {
      if (!row.diameter) continue;
      map[row.diameter] = resolveDiameterPrice(row.diameter, { tier, customerId, discountPct }).pricePerKg;
    }
    return map;
  }

  function listCustomerPrices(customer = {}) {
    const tier = customer.price_tier === 'customer' ? 'customer' : 'general';
    const rows = getAllPriceRows({ tier, customerId: customer.id });
    return rows
      .filter(row => row.diameter)
      .map(row => resolveDiameterPrice(row.diameter, {
        tier,
        customerId: customer.id,
        discountPct: customer.discount_pct || 0,
      }));
  }

  function normalizePortalVisibility(visibility) {
    return ['none', 'general', 'customer'].includes(visibility) ? visibility : 'none';
  }

  function listPortalPriceList(customer = {}) {
    const visibility = normalizePortalVisibility(customer.portal_price_list_visibility);
    if (visibility === 'none') {
      return { priceHidden: true, visibility, items: [] };
    }

    const tier = visibility === 'customer' ? 'customer' : 'general';
    const rows = getAllPriceRows({ tier, customerId: customer.id });
    const items = rows.map(row => {
      const price = resolveDiameterPrice(row.diameter || row.sku, {
        tier,
        customerId: customer.id,
        discountPct: customer.discount_pct || 0,
      });
      return {
        sku: row.sku || null,
        description: row.description || row.item_name || row.name || (row.diameter ? `ברזל בניין ${row.diameter} מ"מ` : ''),
        diameter: row.diameter || null,
        category: row.category || '',
        unit: row.unit || 'ק"ג',
        quantity: row.quantity || 1,
        price_per_kg: price.price_per_kg,
        price: price.price_per_kg,
        status: price.status,
        requiresPriceListUpdate: price.requiresPriceListUpdate,
        warning: price.warning,
        public_note: row.public_note || row.note || '',
        updated_at: row.price_book_updated_at || row.updated_at || null,
      };
    });

    return {
      priceHidden: false,
      visibility,
      title: 'מחירון',
      updatedAt: items.find(item => item.updated_at)?.updated_at || null,
      vatNote: 'המחירים אינם כוללים מע"מ',
      items,
    };
  }

  function itemPricingWeightKg(item = {}) {
    return itemShapeMetrics(item).totalWeightKg || 0;
  }

  function calcItemPrice(item, { tier = 'general', customerId = null, discountPct = 0 } = {}) {
    const ppu = getPricePerKg(item.diameter, { tier, customerId, discountPct });
    if (ppu === null) return null;
    return Number((itemPricingWeightKg(item) * ppu).toFixed(2));
  }

  function calcOrderPrice(items, { tier = 'general', customerId = null, discountPct = 0, wastePct = 3 } = {}) {
    let totalWeight = 0;
    let totalPrice = 0;
    const warnings = [];

    const breakdown = (items || []).map(item => {
      const resolved = resolveDiameterPrice(item.diameter, { tier, customerId, discountPct });
      const ppu = resolved.pricePerKg;
      const weight = itemPricingWeightKg(item);
      const price = ppu === null ? 0 : weight * ppu;
      totalWeight += weight;
      totalPrice += price;
      if (resolved.requiresPriceListUpdate) warnings.push(resolved);
      return {
        diameter: item.diameter,
        weight: +weight.toFixed(3),
        pricePerKg: ppu === null ? null : +ppu.toFixed(3),
        price_per_kg: ppu === null ? null : +ppu.toFixed(3),
        price: +price.toFixed(2),
        pricingSource: resolved.pricingSource,
        pricingLabel: resolved.pricingLabel,
        status: resolved.status,
        requiresPriceListUpdate: resolved.requiresPriceListUpdate,
      };
    });

    const billingWeight = totalWeight * (1 + wastePct / 100);
    const billingPrice = totalPrice * (1 + wastePct / 100);

    return {
      breakdown,
      totalWeight: +totalWeight.toFixed(2),
      billingWeight: +billingWeight.toFixed(2),
      totalPrice: +totalPrice.toFixed(2),
      billingPrice: +billingPrice.toFixed(2),
      status: warnings.length ? 'price_list_requires_update' : 'priced',
      requiresPriceListUpdate: Boolean(warnings.length),
      warnings,
      currency: '₪',
    };
  }

  function calcOrderPriceForCustomer(items, customer, { wastePct = 3 } = {}) {
    const tier = customer?.price_tier === 'customer' ? 'customer' : 'general';
    return calcOrderPrice(items, {
      tier,
      customerId: customer?.id || null,
      discountPct: customer?.discount_pct ?? 0,
      wastePct,
    });
  }

  function getBaseListPrice(diameter) {
    return resolveDiameterPrice(diameter, { tier: 'general' }).pricePerKg ?? 0;
  }

  return {
    resolveDiameterPrice,
    getPricePerKg,
    buildPriceMap,
    listCustomerPrices,
    calcItemPrice,
    calcOrderPrice,
    calcOrderPriceForCustomer,
    getBaseListPrice,
    getAllPriceRows,
    listPortalPriceList,
    itemPricingWeightKg,
  };
}

module.exports = { createPricer };
