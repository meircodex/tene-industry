'use strict';

// Loading is deliberately a projection of the already-issued production-card
// contract.  It never creates a second package label or changes production
// status; it only gives the printed worker-card QR a second meaning while an
// order-loading session is active.
const { expandProductionCardsForOrder } = require('./productionCardPrintPage');
const { ITEM_STATUS } = require('../status-contracts');
const { buildDeliveryCertificateProgress } = require('./deliveryCertificateProgress');

function tryParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function workerCardToken(orderNum, card) {
  const parentItemId = Number(card.parent_item_id || card.id);
  if (!Number.isInteger(parentItemId) || parentItemId <= 0) return '';
  const suffix = String(card.scan_suffix || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${String(orderNum || '').trim()}-${String(parentItemId).padStart(6, '0')}${suffix ? `-${suffix}` : ''}`;
}

function scannedWorkerCardToken(rawValue) {
  let value = String(rawValue == null ? '' : rawValue).trim();
  if (!value || value.length > 2048) return '';

  if (value.startsWith('{')) {
    try {
      const decoded = JSON.parse(value);
      value = String(decoded?.card || decoded?.scanToken || decoded?.token || '').trim();
    } catch (_) {
      return '';
    }
  }

  try {
    const appUrl = new URL(value);
    const parts = appUrl.pathname.split('/').filter(Boolean);
    if (appUrl.protocol === 'web+ironbend:' && appUrl.hostname.toLowerCase() === 'open' && parts[0] === 'card' && parts[1]) {
      value = decodeURIComponent(parts.slice(1).join('/'));
    }
  } catch (_) {
    // Continue with the raw production token and legacy worker URL.
  }

  // New printed cards use a public customer-portal URL. Only authenticated,
  // approved work scanners call this parser and use its embedded card code.
  try {
    const parsed = new URL(value, 'https://scanner.invalid');
    const publicCode = parsed.searchParams.get('code');
    if (publicCode && /\/customer-scan\.html$/i.test(parsed.pathname)) value = publicCode;
    const card = parsed.searchParams.get('card');
    // Keep the old worker-view URL so forms already in circulation remain usable.
    if (card && /worker-visual\.html$/i.test(parsed.pathname)) value = card;
  } catch (_) {
    // A raw card barcode is the normal scanner result.
  }
  return normalizeToken(value);
}

function tokenItemId(token) {
  // Order numbers contain hyphens, so this must strip only the known
  // production-card suffix and then read the final numeric item identity.
  // A greedy optional suffix used to read the last number in an order number
  // instead (for example PILE-LOAD-1-000005-C1OF5 -> 1).
  const value = String(token || '').trim().replace(/-(?:C\d+(?:OF\d+)?|P\d+-C\d+|P\d+-MASTER|ASSEMBLY)$/i, '');
  // HZ-2026-055-000123, HZ-...-000123-C1, HZ-...-000123-C1OF5,
  // HZ-...-000123-P1-C1 and HZ-...-000123-ASSEMBLY.
  const match = value.match(/-(\d{1,12})$/);
  const id = Number(match?.[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sourceItemsForOrder(db, orderId) {
  return db.prepare(`
    SELECT i.*, p.pallet_num AS _palletNum
    FROM items i
    JOIN pallets p ON p.id=i.pallet_id
    WHERE p.order_id=?
    ORDER BY p.pallet_num, i.id
  `).all(orderId);
}

function isFinalDeliverableCard(card) {
  if (!card?.virtual_card) return true;
  // A pile cage's four steel component cards are production instructions. The
  // physical outbound unit is its existing PILE CAGE assembly card. Scanning
  // components as well would ship the same steel twice.
  return card.pile_card_type === 'pile_assembly';
}

function cardIsCompleted(card) {
  const status = String(card?.status || '');
  return status === ITEM_STATUS.DONE || status === ITEM_STATUS.DELIVERED;
}

function projectOrderCards(db, order) {
  const sourceItems = sourceItemsForOrder(db, order.id);
  const progress = buildDeliveryCertificateProgress(db, order.id, sourceItems);
  const unavailable = new Set(progress.items.filter(row => row.remaining_qty <= 0).map(row => row.id));
  // A manual source certificate is also a real departure. Correcting the item
  // back to DONE must not make its old QR eligible for a second truck.
  const expanded = expandProductionCardsForOrder(sourceItems.filter(item => !unavailable.has(Number(item.id))), tryParseJson);
  return expanded.map(card => {
    const token = workerCardToken(order.order_num, card);
    return {
      card_key: String(card.card_key || `item-${card.parent_item_id || card.id}`),
      worker_card_token: token,
      parent_item_id: Number(card.parent_item_id || card.id),
      title: String(card.shape_name || 'כרטיס ייצור'),
      quantity: Number(card.quantity || 0),
      weight: Number(card.total_weight || 0),
      diameter_mm: Number(card.diameter || 0) || null,
      total_length_mm: Number(card.total_length_mm || 0) || null,
      final_deliverable: isFinalDeliverableCard(card),
      completed: cardIsCompleted(card),
      pile_card_type: card.pile_card_type || null,
    };
  }).filter(card => card.worker_card_token && Number.isInteger(card.parent_item_id) && card.parent_item_id > 0);
}

function findProjectedCardByToken(db, order, token) {
  const normalized = normalizeToken(token);
  return projectOrderCards(db, order)
    .find(card => normalizeToken(card.worker_card_token) === normalized) || null;
}

module.exports = {
  normalizeToken,
  workerCardToken,
  scannedWorkerCardToken,
  tokenItemId,
  projectOrderCards,
  findProjectedCardByToken,
};
