const { isTechnicalRecognitionNote } = require('./intakeWorkflow');
const productionCardShapes = require('./productionCards');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');

const REVIEW_NOTE_LABEL = '\u05d3\u05d5\u05e8\u05e9 \u05d0\u05d9\u05de\u05d5\u05ea \u05de\u05d5\u05dc \u05de\u05e7\u05d5\u05e8 \u05d4\u05e7\u05dc\u05d9\u05d8\u05d4';

function printableItemNote(note) {
  const normalized = String(note || '').trim();
  if (!normalized) return '';
  // Editor provenance is an internal marker, not a printable production note.
  if (/^נוסף ידנית בעורך הצורות\.?$/u.test(normalized)) return '';
  return isTechnicalRecognitionNote(normalized) ? REVIEW_NOTE_LABEL : normalized;
}


function parseCardSnapshot(value, tryParseJSON) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  return tryParseJSON ? tryParseJSON(value, null) : null;
}

function pileSnapshotForItem(item, tryParseJSON) {
  const direct = parseCardSnapshot(item.shape_snapshot_json, tryParseJSON)
    || parseCardSnapshot(item.shapeSnapshot, tryParseJSON)
    || parseCardSnapshot(item.shape_data_json, tryParseJSON);
  return direct && direct.family === 'piles' && direct.shapeType === 'round_pile_cage' ? direct : null;
}

function pileCardTitle(card) {
  if (card.cardType === 'pile_assembly') return 'PILE CAGE';
  if (card.componentType === 'longitudinal_l_bar') return 'מוטות אורך L';
  if (card.componentType === 'longitudinal_straight_bar') return 'מוטות אורך ישרים';
  if (card.componentType === 'spiral_consolidated') return 'ספירלה מאוחדת';
  if (card.componentType === 'hoop_ring') return 'טבעות חיזוק פנימיות';
  return card.title || card.description || 'רכיב כלונס';
}

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function monochromePileSvg(svg) {
  return String(svg || '')
    .replace(/#3a5070/gi, '#1a2332')
    .replace(/#2563eb/gi, '#1a2332')
    .replace(/#c9621a/gi, '#1a2332')
    .replace(/#9a4b10/gi, '#1a2332')
    .replace(/#fff7ed/gi, '#ffffff')
    .replace(/#f8fafc/gi, '#ffffff');
}

function scopePileSvgIds(svg, scope) {
  const suffix = String(scope || 'pile').replace(/[^a-zA-Z0-9_-]/g, '');
  return String(svg || '').replace(/id="([^"]+)"/g, (_match, id) => `id="${id}-${suffix}"`)
    .replace(/url\(#([^\)]+)\)/g, (_match, id) => `url(#${id}-${suffix})`);
}

function markerFreePileSvg(svg) {
  return String(svg || '')
    .replace(/<defs>[\s\S]*?<\/defs>/g, '')
    .replace(/\smarker-(?:start|mid|end)="[^"]*"/g, '');
}

function pileMasterShapeSvg(snapshot = {}, card = {}) {
  return monochromePileSvg(productionCardShapes.pileCageProductionSvg({
    shape_snapshot_json: snapshot,
    pile_card_type: 'pile_assembly',
    pile_component_summary: card.componentSummary,
    pile_total_steel_length_mm: card.totalSteelCutLengthMm,
  }));
}


function formatPileNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatPileCm(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  const formatted = formatPileNumber(numeric / 10);
  return formatted ? formatted + ' cm' : '';
}

function pileComponentShapeSvg(card, fallbackLengthMm, scope = 'pile') {
  const componentType = card && (card.componentType || card.type);
  const source = card && card.source && typeof card.source === 'object' ? card.source : (card || {});
  if (componentType === 'spiral_consolidated') {
    const schedule = Array.isArray(source.schedule) ? source.schedule : [];
    const width = 240;
    const height = 118;
    const axisLengthMm = schedule.reduce((sum, segment) => sum + Number(segment.axialLengthMm ?? segment.lengthMm ?? 0), 0);
    const cutLengthMm = Number(source.totalLengthMm || card.totalLengthMm || 0);
    const scale = axisLengthMm > 0 ? 196 / axisLengthMm : 0;
    let svg = '<text x="120" y="12" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">CONSOLIDATED SPIRAL</text>';
    svg += '<line x1="22" y1="34" x2="218" y2="34" stroke="#1a2332" stroke-width="1"/>';
    schedule.forEach((segment, index) => {
      const axial = Number(segment.axialLengthMm ?? segment.lengthMm ?? 0);
      const start = Number(segment.startMm || 0);
      const x1 = 22 + start * scale;
      const x2 = x1 + axial * scale;
      if (segment.noWrap) {
        svg += `<line x1="${x1.toFixed(1)}" y1="26" x2="${x2.toFixed(1)}" y2="42" stroke="#1a2332" stroke-width="1" stroke-dasharray="3 3"/>`;
      } else {
        const marks = Math.max(2, Math.min(12, Math.round(Number(segment.turns || 0))));
        for (let mark = 0; mark < marks; mark += 1) {
          const mx = x1 + ((mark + 0.5) / marks) * Math.max(1, x2 - x1);
          svg += `<line x1="${(mx - 3).toFixed(1)}" y1="25" x2="${(mx + 3).toFixed(1)}" y2="43" stroke="#1a2332" stroke-width="1.4"/>`;
        }
      }
      const name = String(segment.name || index + 1).slice(0, 40);
      const rowY = 57 + index * 12;
      if (rowY <= 93) {
        const detail = segment.noWrap
          ? `${name} ${formatPileCm(start)}-${formatPileCm(start + axial)} NO WRAP`
          : `${name} ${formatPileCm(start)}-${formatPileCm(start + axial)} P${formatPileCm(segment.pitchMm)} N${formatPileNumber(segment.turns)} C${formatPileCm(segment.helicalCutLengthMm ?? segment.totalLengthMm)}`;
        svg += `<text x="18" y="${rowY}" text-anchor="start" font-size="7" font-family="Arial" font-weight="700" fill="#1a2332">${escapeSvgText(detail)}</text>`;
      }
    });
    svg += `<text x="18" y="108" text-anchor="start" font-size="8" font-family="Arial" font-weight="900" fill="#1a2332">AXIS ${escapeSvgText(formatPileCm(axisLengthMm))}</text>`;
    svg += `<text x="222" y="108" text-anchor="end" font-size="8" font-family="Arial" font-weight="900" fill="#1a2332">CUT ${escapeSvgText(formatPileCm(cutLengthMm))}</text>`;
    return `<svg data-shape-kind="pile-spiral-component" data-component-type="spiral_consolidated" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;max-height:112px;overflow:visible">${svg}</svg>`;
  }
  if (componentType === 'hoop_ring') {
    const bendingDiameterMm = Number(source.bendingDiameterMm ?? source.hoopDiameterMm ?? card.hoopDiameterMm ?? 0);
    const svg = productionCardShapes.spiralShapeSvg({ shape_name: 'ring', spiral_diameter_mm: bendingDiameterMm, spiral_turns: 1, diameter: source.diameterMm || card.diameterMm });
    return markerFreePileSvg(scopePileSvgIds(monochromePileSvg(svg).replace('data-shape-kind="ring"', 'data-shape-kind="pile-hoop-component" data-component-type="hoop_ring"'), scope));
  }
  if (componentType === 'longitudinal_l_bar' || componentType === 'longitudinal_straight_bar') {
    const segments = Array.isArray(source.segments) ? source.segments.map(segment => ({ length_mm: Number(segment.length_mm ?? segment.lengthMm), angle_deg: segment.angle_deg ?? segment.bendAfterDeg })) : [];
    const fallbackSegments = componentType === 'longitudinal_l_bar'
      ? [{ length_mm: Math.max(1, Number(source.mainLengthMm || fallbackLengthMm || 0)), angle_deg: 90 }, { length_mm: Math.max(1, Number(source.bendLengthMm || 0)), angle_deg: null }]
      : [{ length_mm: Math.max(1, Number(source.unitLengthMm || source.lengthMm || fallbackLengthMm || 0)), angle_deg: null }];
    const cleanSegments = segments.length ? segments : fallbackSegments;
    const svg = productionCardShapes.shapeSvgForProductionCard({ shape_name: componentType, diameter: source.diameterMm || card.diameterMm, segments: JSON.stringify(cleanSegments), shape_snapshot_json: null }, cleanSegments);
    return monochromePileSvg(svg).replace('data-shape-kind="', `data-component-type="${componentType}" data-shape-kind="pile-longitudinal-`);
  }
  return '';
}

function normalizeCardPrintKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeCardKeySet(cardKeys) {
  if (!cardKeys || !cardKeys.size) return null;
  const normalized = new Set();
  for (const cardKey of cardKeys) {
    const cleaned = normalizeCardPrintKey(cardKey);
    if (cleaned) normalized.add(cleaned);
  }
  return normalized.size ? normalized : null;
}

function fallbackPileProductionCards(item, snapshot) {
  if (snapshot?.validation && (snapshot.validation.ok === false || snapshot.validation.valid === false)) return [];
  const calculated = calculatePileCage(snapshot);
  if (!calculated.validation?.ok || !Array.isArray(calculated.productionCards) || calculated.productionCards.length !== 5) return [];
  const cageQuantity = Math.max(1, Math.round(Number(item.quantity) || Number(snapshot?.quantity) || 1));
  return calculated.productionCards.map((card, index) => {
    const isAssembly = card.cardType === 'pile_assembly';
    const componentQuantity = isAssembly ? cageQuantity : Number(card.quantity || 0) * cageQuantity;
    return {
      ...card,
      quantity: componentQuantity,
      unitLengthMm: Number(card.unitLengthMm || 0),
      totalLengthMm: isAssembly ? Number(card.unitLengthMm || card.totalLengthMm || 0) * cageQuantity : Number(card.totalLengthMm || 0) * cageQuantity,
      weightKg: Number(card.weightKg || 0) * cageQuantity,
      cageQuantity,
      componentIndex: card.componentIndex || index + 1,
      // Keep the canonical component contract unit-scoped for geometry labels.
      // Order-wide quantity/length/weight live on the virtual card above.
      source: card.source ? { ...card.source } : { assemblySummary: calculated.assemblySummary, componentSummary: card.componentSummary },
      scanCodeSuffix: card.scanCodeSuffix || (isAssembly ? 'ASSEMBLY' : `C${index + 1}`),
    };
  });
}

function expandPileCageProductionItems(allItems, tryParseJSON) {
  const expanded = [];
  for (const item of allItems) {
    const snapshot = pileSnapshotForItem(item, tryParseJSON);
    const cards = snapshot ? fallbackPileProductionCards(item, snapshot) : [];
    if (!snapshot) {
      expanded.push(item);
      continue;
    }
    if (cards.length !== 5) continue;
    cards.forEach((card, index) => {
      const parentId = Number(item.id);
      const cardKey = `${parentId}-${card.scanCodeSuffix || 'P' + (index + 1)}`;
      const componentQuantity = Number.isFinite(Number(card.quantity)) && Number(card.quantity) > 0 ? Math.round(Number(card.quantity)) : null;
      const quantity = componentQuantity ?? 1;
      const totalWeight = Number.isFinite(Number(card.weightKg)) && Number(card.weightKg) > 0
        ? Number(card.weightKg)
        : 0;
      const lengthMm = Number(card.totalLengthMm || card.lengthMm || item.total_length_mm || 0);
      const unitLengthMm = Number(card.unitLengthMm || card.source?.unitLengthMm || 0);
      const isAssembly = card.cardType === 'pile_assembly';
      expanded.push({
        ...item,
        id: parentId,
        parent_item_id: parentId,
        card_key: cardKey,
        virtual_card: 1,
        pile_card_type: card.cardType,
        pile_component_type: card.componentType,
        pile_component_quantity: componentQuantity,
        pile_unit_index: card.unitIndex,
        pile_unit_total: card.unitTotal,
        pile_component_index: card.componentIndex || 0,
        pile_component_summary: card.componentSummary || null,
        pile_total_steel_length_mm: Number(card.totalSteelCutLengthMm || 0),
        scan_suffix: card.scanCodeSuffix || `P${card.unitIndex || 1}-C${index + 1}`,
        shape_name: pileCardTitle(card),
        quantity,
        diameter: Number(card.diameterMm || item.diameter || 0),
        unit_length_mm: unitLengthMm,
        total_length_mm: lengthMm,
        total_weight: totalWeight,
        weight_per_unit: quantity > 0 ? totalWeight / quantity : totalWeight,
        segments: JSON.stringify(Array.isArray(card.source?.segments) ? card.source.segments.map(segment => ({ length_mm: Number(segment.length_mm ?? segment.lengthMm), angle_deg: segment.angle_deg ?? segment.bendAfterDeg })) : []),
        shape_svg: isAssembly ? pileMasterShapeSvg(snapshot, card) : pileComponentShapeSvg(card, unitLengthMm || lengthMm, cardKey),
        note: isAssembly ? 'הרכבת כלוב זיון לכלונס עגול' : (card.description || card.title || ''),
        pile_cage_snapshot: snapshot,
        shape_snapshot_json: null,
        shapeSnapshot: null,
        shape_data_json: null,
      });
    });
  }
  return expanded;
}

// The live order-production sheet uses the same canonical expansion as the
// printed production cards.  This is intentionally a projection only: it
// never creates cards or writes a production state.
function expandProductionCardsForOrder(allItems, tryParseJSON) {
  return expandPileCageProductionItems(allItems, tryParseJSON);
}

function renderPrintCardsPage({
  order,
  pallets,
  allItems,
  selectedCardKeys,
  printDate,
  delivDate,
  cards,
  industry,
  tryParseJSON,
  previewOnly = false,
  publicBaseUrl = '',
}) {
const isPreviewOnly = !!previewOnly;
const previewNoticeHtml = isPreviewOnly
  ? '<div class="preview-lock"><b>תצוגה בלבד</b><span>ההזמנה עדיין לא מאושרת/מתוכננת לייצור, לכן אפשר לראות את הכרטיסיות אבל אי אפשר להדפיס אותן.</span><a href="/orders.html?id=' + encodeURIComponent(order.id || '') + '">פתח הזמנה לאישור</a></div>'
  : '';
const printButtonHtml = isPreviewOnly
  ? '<span class="preview-pill">תצוגה בלבד - הדפסה חסומה</span>'
  : '<button class="print-btn" onclick="printCards()">🖨️ הדפס כרטיסיות</button>';

function renderA4CardPages(cardHtmlList) {
  if (!cardHtmlList.length) {
    return '<div class="cards-page"><div class="cards-grid"><div style="padding:40px;text-align:center;color:#888;">No order items</div></div></div>';
  }
  var pages = [];
  for (var i = 0; i < cardHtmlList.length; i += 8) {
    pages.push('<div class="cards-page"><div class="cards-grid">' + cardHtmlList.slice(i, i + 8).join('') + '</div></div>');
  }
  return pages.join('');
}

 const numberedItems = cards.attachOrderLineNumbers ? cards.attachOrderLineNumbers(allItems) : allItems;
 const requestedCardKeys = normalizeCardKeySet(selectedCardKeys);
 const expandedCardItems = expandPileCageProductionItems(numberedItems, tryParseJSON);
 const cardItems = requestedCardKeys && requestedCardKeys.size
   ? expandedCardItems.filter(item => requestedCardKeys.has(normalizeCardPrintKey(item.card_key || item.id)))
   : expandedCardItems;
 const serverCardsHtml = renderA4CardPages(cardItems.map(it => cards.itemCard(it, order, printDate, (industry.REBAR_WEIGHTS || {}))));




  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<title>כרטיסיות ייצור – ${order.order_num}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&family=Libre+Barcode+128&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Heebo',Arial,sans-serif;background:#e8e8e8;padding:16px;direction:rtl;}
.preview-lock{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff3d7;border:1px solid #ffd6a0;color:#8a4b00;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13px;font-weight:700;}
.preview-lock b{font-size:14px;color:#1a2332}.preview-lock a{color:#1a2332;font-weight:900;text-decoration:underline}.preview-pill{display:inline-flex;align-items:center;padding:9px 14px;border-radius:6px;background:#fff3d7;border:1px solid #ffd6a0;color:#8a4b00;font-weight:900;font-size:13px}.print-blocked-page{display:none;}

/* ── Screen-only UI ── */
.screen-only{margin-bottom:14px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;}
.print-btn{padding:9px 22px;background:#1a2332;color:#fff;border:none;border-radius:6px;
  cursor:pointer;font-size:14px;font-family:inherit;}
.print-btn:hover{background:#c9621a;}
.pc-weight-entry{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-items:end;padding:7px 10px;background:#eef8f2;border-bottom:1px solid #d8eadf;}
.pc-weight-entry label{display:block;font-size:9px;font-weight:900;color:#45645a;margin-bottom:2px;}
.pc-weight-entry input{width:100%;border:1px solid #aac7b4;border-radius:5px;padding:5px 6px;font-family:inherit;font-size:12px;background:#fff;}
.pc-weight-entry button{border:0;border-radius:6px;background:#1a7a3c;color:#fff;padding:7px 8px;font-family:inherit;font-weight:900;cursor:pointer;}
.pc-weight-chip{min-height:30px;border-radius:6px;background:#fff;border:1px solid #c8ddcf;padding:5px 6px;font-size:11px;font-weight:900;color:#1a2332;display:flex;align-items:center;}
.pc-weight-chip.warn{color:#9f4f00;background:#fff7ed;border-color:#fed7aa;}
.pc-weight-chip.bad{color:#991b1b;background:#fef2f2;border-color:#fecaca;}

/* ── Cards ── */
.cards-pages{display:flex;flex-direction:column;gap:12mm;align-items:center;}
.cards-page{width:210mm;height:297mm;background:#fff;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.14);}
.cards-grid{display:grid;grid-template-columns:repeat(2,105mm);grid-template-rows:repeat(4,74.25mm);grid-auto-rows:74.25mm;gap:0;align-items:stretch;justify-content:start;width:210mm;height:297mm;margin:0;background:#fff;}
.prod-card{width:105mm;height:74.25mm;margin:0;background:#fff;border:0.25mm solid #1a2332;border-radius:0;
  overflow:hidden;page-break-inside:avoid;break-inside:avoid;display:flex;flex-direction:column;
  font-size:8px;box-shadow:none;position:relative;}
.prod-card.pile-cage-master-card{border:0.6mm solid #1a2332;background:#fff;}
.prod-card.pile-cage-component-card{border-style:dashed;}
.prod-card>:not(.pc-print-face):not(.pc-screen-tools):not(.pc-pick){display:none!important;}
/* Card picking — tap a card to include or exclude it, like picking photos. */
.pc-pick{position:absolute;top:1.5mm;right:1.5mm;z-index:4;width:6.4mm;height:6.4mm;border-radius:50%;
  border:0.5mm solid #1a2332;background:#fff;cursor:pointer;padding:0;line-height:1;
  display:flex;align-items:center;justify-content:center;font-size:3.4mm;font-weight:900;color:transparent;}
.prod-card[data-picked="1"] .pc-pick{background:#1a7a42;border-color:#1a7a42;color:#fff;}
.prod-card[data-picked="0"]{opacity:0.34;}
.prod-card[data-picked="0"] .pc-pick{background:#fff;}
.pc-pick-bar{display:inline-flex;align-items:center;gap:8px;}
.pc-pick-bar b{font-variant-numeric:tabular-nums;}
.pc-screen-tools{position:absolute;top:1.5mm;left:1.5mm;z-index:3;display:flex;align-items:center;gap:4px;direction:rtl;font-family:'Heebo',Arial,sans-serif;}
.prod-card:not([data-split-menu-open="1"]) .pc-split-menu{display:none!important;}
.pc-split-hotspot{position:absolute;inset:0;z-index:2;border:0;background:transparent;color:transparent;cursor:pointer;}
.pc-split-menu{position:relative;z-index:4;display:flex;align-items:center;gap:4px;}
.pc-screen-tools button{border:0;border-radius:5px;background:#1a2332;color:#fff;padding:4px 7px;font-family:inherit;font-size:10px;font-weight:900;line-height:1;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.18);}
.pc-screen-tools button:hover{background:#c9621a;}
.pc-split-state{display:inline-flex;align-items:center;border-radius:5px;background:#fff3d7;border:1px solid #ffd6a0;color:#8a4b00;padding:3px 6px;font-size:10px;font-weight:900;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,0.12);}
.pc-print-face{display:grid;grid-template-columns:minmax(0,1fr) 27mm;width:100%;height:100%;background:#fff;direction:ltr;}
.pc-print-main{display:grid;grid-template-rows:11mm minmax(11mm,auto) minmax(0,1fr) 18.25mm;width:100%;height:100%;border-right:0.25mm solid #1a2332;overflow:hidden;direction:ltr;}
.pc-print-head{display:flex;align-items:center;justify-content:space-between;gap:2.5mm;padding:2mm 3mm;border-bottom:0.25mm solid #1a2332;font-size:13.5px;font-weight:900;line-height:1;background:#1a2332;color:#fff;}
.pc-print-head-meta{display:flex;align-items:center;justify-content:flex-end;gap:2.5mm;min-width:0;flex:1;}
.pc-print-customer{min-width:0;font-size:12px;font-weight:900;line-height:1.1;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pc-print-diameter{font-size:13.5px;font-weight:900;white-space:nowrap;}
.pc-print-ref{min-height:11mm;padding:1.25mm 3mm;border-bottom:0.25mm solid #d8dee8;font-size:12.5px;font-weight:900;line-height:1.25;white-space:normal;overflow:visible;overflow-wrap:anywhere;direction:rtl;text-align:right;display:flex;align-items:center;}
.pc-print-shape{display:flex;align-items:center;justify-content:center;padding:1.5mm 3mm;overflow:hidden;}
.pc-print-shape svg{max-width:72mm!important;max-height:35mm!important;}
.pc-print-bottom{display:grid;grid-template-columns:1fr 1fr;align-items:center;border-top:0.25mm solid #1a2332;font-size:11px;font-weight:900;text-align:center;}
.pc-print-bottom span{height:100%;display:flex;align-items:center;justify-content:center;border-left:0.25mm solid #1a2332;white-space:nowrap;overflow:hidden;}
.pc-print-bottom span:first-child{border-left:0;}
.pc-print-qr-panel{display:grid;align-items:center;justify-items:center;width:27mm;height:100%;overflow:hidden;background:transparent;}
.pc-print-qr-code{width:22mm;height:22mm;display:flex;align-items:center;justify-content:center;transform:translate(-1.5mm,0);}
.pc-print-qr-code canvas,.pc-print-qr-code img{width:22mm!important;height:22mm!important;display:block;}
.pc-print-status{width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-top:0.25mm solid #1a2332;font-size:9px;font-weight:900;letter-spacing:0;text-align:center;line-height:1.1;background:#1a2332;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.pc-head{display:flex;justify-content:space-between;align-items:flex-start;
  padding:7px 10px 5px;border-bottom:2px solid #1a2332;background:#fff;}
.pc-title{font-size:13px;font-weight:900;color:#1a2332;line-height:1.2;}
.pc-date{font-size:10px;color:#666;margin-top:2px;}
.pc-top-barcode{text-align:center;min-width:90px;}
.bc-font-top{font-family:'Libre Barcode 128',cursive;font-size:46px;line-height:1;max-height:48px;overflow:hidden;letter-spacing:0;color:#000;}
.bc-font-mid{font-family:'Libre Barcode 128',cursive;font-size:36px;line-height:1;max-height:38px;overflow:hidden;letter-spacing:0;color:#000;}
.bc-font-footer{font-family:'Libre Barcode 128',cursive;font-size:30px;line-height:1;max-height:32px;overflow:hidden;letter-spacing:0;color:#fff;flex:1;}
.bc-label{font-size:7px;color:#555;margin-top:1px;text-align:center;font-family:monospace;}
.bc-ord-text{font-size:9px;color:#333;font-family:monospace;text-align:center;}
.split-badge{display:inline-block;background:#e07b39;color:#fff;border-radius:4px;
  font-size:11px;font-weight:900;padding:1px 6px;margin-left:5px;white-space:nowrap;}
.pc-order-row{display:flex;align-items:center;gap:8px;padding:4px 10px;
  border-bottom:1px solid #eee;background:#fafafa;}
.pc-order-label{font-size:10px;color:#555;white-space:nowrap;}
.pc-order-barcode{flex:1;}
.pc-pallet{font-size:11px;color:#333;white-space:nowrap;border-right:1px solid #ddd;padding-right:8px;}
.pc-wq-row{display:flex;align-items:center;padding:5px 10px;gap:4px;
  border-bottom:1px solid #eee;background:#fff;}
.pc-wq-cell{display:flex;align-items:baseline;gap:3px;flex:1;}
.wq-lbl{font-size:10px;color:#666;}
.wq-val{font-size:15px;font-weight:900;color:#1a2332;}
.wq-cust{font-size:10px;font-weight:700;color:#333;}
.pc-wq-sep{width:1px;height:18px;background:#ddd;}
.pc-shape-area{flex:1;min-height:105px;display:flex;align-items:center;
  justify-content:center;padding:6px 8px;background:#fafbfc;border-bottom:1px solid #eee;}
.pc-shape-svg{width:100%;max-height:120px;}
.pc-dims{display:flex;flex-wrap:wrap;gap:4px;padding:4px 10px;
  border-bottom:1px solid #eee;background:#f5f8fb;}
.dim-seg{font-size:10px;background:#e8f0fb;border-radius:3px;padding:2px 5px;color:#1a2332;}
.dim-ang{font-size:10px;background:#fff3e0;border-radius:3px;padding:2px 5px;color:#c9621a;font-weight:700;}
.pc-spec-row{display:flex;align-items:center;gap:0;padding:5px 10px;
  border-bottom:1px solid #eee;background:#fff;}
.pc-spec-cell{font-size:11px;color:#1a2332;flex:1;}
.spec-lbl{color:#666;font-size:10px;}
.pc-spec-sep{width:1px;height:16px;background:#ddd;margin:0 6px;}
.pc-note{padding:3px 10px;background:#fff3cd;font-size:10px;color:#856404;border-bottom:1px solid #f0d060;}
.pc-footer{display:flex;align-items:center;justify-content:space-between;
  padding:5px 10px;background:#1a2332;}
.pc-brand{color:#e07b39;font-weight:900;font-size:12px;line-height:1.1;text-align:center;}
.pc-brand-num{font-size:18px;font-weight:900;color:#fff;}
.pc-scan-row{display:flex;align-items:center;gap:6px;padding:3px 10px;background:#f7fbff;border-bottom:1px solid #e3edf5;}
.pc-scan-qr{width:46px;height:46px;flex:0 0 46px;background:#fff;border:1px solid #cfd8e3;border-radius:4px;display:flex;align-items:center;justify-content:center;}
.pc-scan-qr canvas,.pc-scan-qr img{width:42px!important;height:42px!important;display:block;}
.pc-scan-text{min-width:0;font-size:8px;line-height:1.25;color:#1a2332;font-family:monospace;direction:ltr;overflow:hidden;text-overflow:ellipsis;}
.pc-scan-label{font-size:8px;font-weight:900;color:#45645a;white-space:nowrap;}

@media screen and (max-width: 760px){
  body{padding:8px;overflow-x:hidden;}
  .toolbar{gap:8px;}
  .pc-head{gap:8px;padding:8px;align-items:center;}
  .pc-title{font-size:12px;}
  .bc-font-top{font-size:34px;max-height:36px;}
  .bc-font-mid{font-size:28px;max-height:30px;}
  .pc-wq-row,.pc-spec-row{flex-wrap:wrap;gap:6px;}
  .pc-wq-cell,.pc-spec-cell{min-width:42%;flex:1 1 42%;}
  .pc-wq-sep,.pc-spec-sep{display:none;}
  .pc-shape-area{min-height:130px;padding:10px;}
  .pc-shape-area svg{max-height:128px!important;}
}

@media print{
  html{direction:ltr!important;overflow:hidden!important;margin:0!important;padding:0!important;}
  body{width:210mm!important;margin:0!important;padding:0!important;background:#fff!important;direction:ltr!important;position:absolute!important;left:0!important;top:0!important;}
  .screen-only{display:none!important;}
  body.preview-locked .cards-pages{display:none!important;}
  body.preview-locked .print-blocked-page{display:flex!important;width:210mm;height:297mm;align-items:center;justify-content:center;text-align:center;font-family:'Heebo',Arial,sans-serif;font-size:18px;font-weight:900;color:#1a2332;padding:20mm;}
  .cards-pages{display:block!important;margin:0!important;padding:0!important;direction:ltr!important;width:210mm!important;}
  .cards-page{width:210mm!important;height:297mm!important;margin:0!important;padding:0!important;overflow:hidden!important;box-shadow:none!important;break-after:page;page-break-after:always;position:relative!important;left:0!important;}
  .cards-page:last-child{break-after:auto;page-break-after:auto;}
  .cards-grid{
    display:grid!important;
    grid-template-columns:repeat(2, 105mm);
    grid-template-rows:repeat(4, 74.25mm);
    grid-auto-rows:74.25mm;
    gap:0;
    align-items:stretch;
    justify-content:start;
  }
  .cards-grid{break-before:auto;page-break-before:auto;height:297mm!important;width:210mm!important;}
  .prod-card{border:0.25mm solid #1a2332!important;border-radius:0!important;overflow:hidden!important;box-sizing:border-box!important;width:105mm!important;height:74.25mm!important;}
  .pc-pick{display:none!important;}
  .prod-card[data-picked="0"]{display:none!important;}
  .cards-page[data-empty-page="1"]{display:none!important;}
  .pc-screen-tools{display:none!important;}
  .prod-card>:not(.pc-print-face){display:none!important;}
  .pc-print-face{display:grid!important;grid-template-columns:minmax(0,1fr) 27mm;width:100%;height:100%;background:#fff;direction:ltr;}
  .pc-print-main{display:grid;grid-template-rows:11mm minmax(11mm,auto) minmax(0,1fr) 18.25mm;width:100%;height:100%;border-right:0.25mm solid #1a2332;overflow:hidden;direction:ltr;}
  .pc-print-head{display:flex;align-items:center;justify-content:space-between;gap:2.5mm;padding:2mm 3mm;border-bottom:0.25mm solid #1a2332;font-size:14px;font-weight:900;line-height:1;background:#1a2332!important;color:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .pc-print-customer{font-size:12.5px!important;}
  .pc-print-diameter{font-size:14px!important;}
  .pc-print-ref{min-height:11mm;padding:1.25mm 3mm;border-bottom:0.25mm solid #d8dee8;font-size:13px;font-weight:900;line-height:1.25;white-space:normal;overflow:visible;overflow-wrap:anywhere;direction:rtl;text-align:right;display:flex;align-items:center;}
  .pc-print-shape{display:flex;align-items:center;justify-content:center;padding:1.5mm 3mm;overflow:hidden;}
  .pc-print-shape svg{max-width:72mm!important;max-height:35mm!important;}
  .pc-print-bottom{display:grid;grid-template-columns:1fr 1fr;align-items:center;border-top:0.25mm solid #1a2332;font-size:13px;font-weight:900;text-align:center;}
  .pc-print-bottom span{height:100%;display:flex;align-items:center;justify-content:center;border-left:0.25mm solid #1a2332;white-space:nowrap;overflow:hidden;}
  .pc-print-bottom span:first-child{border-left:0;}
  .pc-print-qr-panel{display:grid;align-items:center;justify-items:center;width:27mm;height:100%;overflow:hidden;background:transparent!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .pc-print-qr-code{width:22mm;height:22mm;display:flex;align-items:center;justify-content:center;transform:translate(-1.5mm,0);}
  .pc-print-qr-code canvas,.pc-print-qr-code img{width:22mm!important;height:22mm!important;display:block;}
  .pc-print-status{width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-top:0.25mm solid #1a2332;font-size:10px;font-weight:900;letter-spacing:0;text-align:center;line-height:1.1;background:#1a2332!important;color:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .prod-card{
    width:105mm!important;
    height:74.25mm!important;
    margin:0!important;
    box-shadow:none;
    break-inside:avoid;
    page-break-inside:avoid;
    border-width:1px;
    border-radius:2px;
    font-size:8px;
  }
  .prod-card{border:0.25mm solid #1a2332!important;border-radius:0!important;overflow:hidden!important;}
  .pc-head{padding:3px 5px 2px;border-bottom-width:1px;}
  .pc-title{font-size:9px;line-height:1.1;}
  .pc-date{font-size:7px;margin-top:0;}
  .bc-font-top{font-size:28px;max-height:28px;}
  .bc-font-mid{font-size:23px;max-height:24px;}
  .bc-font-footer{font-size:18px;max-height:18px;}
  .bc-label,.bc-ord-text{font-size:6px;}
  .split-badge{font-size:7px;padding:0 3px;margin-left:2px;}
  .pc-order-row{gap:3px;padding:2px 5px;}
  .pc-order-label,.pc-pallet{font-size:7px;}
  .pc-wq-row{padding:2px 5px;gap:2px;}
  .wq-lbl,.spec-lbl{font-size:7px;}
  .wq-val{font-size:10px;}
  .wq-cust{font-size:7px;}
  .pc-wq-sep{height:11px;}
  .pc-shape-area{min-height:33mm;padding:2mm 3mm;}
  .pc-shape-svg,.pc-shape-area svg{max-height:31mm!important;}
  .pc-dims{gap:2px;padding:2px 5px;}
  .dim-seg,.dim-ang{font-size:6.5px;padding:1px 3px;}
  .pc-spec-row{padding:2px 5px;}
  .pc-spec-cell{font-size:7px;}
  .pc-spec-sep{height:10px;margin:0 3px;}
  .pc-note{padding:1px 5px;font-size:7px;}
  .pc-scan-row{padding:1px 5px;gap:3px;}
  .pc-scan-qr{width:28px;height:28px;flex-basis:28px;}
  .pc-scan-qr canvas,.pc-scan-qr img{width:25px!important;height:25px!important;}
  .pc-scan-text,.pc-scan-label{font-size:5.5px;}
  .pc-weight-entry{display:none!important;}
  .pc-footer{padding:2px 5px;}
  .pc-brand{font-size:7px;}
  .pc-brand-num{font-size:11px;}
  @page{size:A4 portrait;margin:0!important;}
}
</style>
</head>
<body${isPreviewOnly ? ' class="preview-locked"' : ''}>

<div class="print-blocked-page">הכרטיסיות בתצוגה בלבד. יש לאשר/לתכנן את ההזמנה לפני הדפסה.</div>

<!-- ── Screen toolbar ── -->
<div class="screen-only">
  ${previewNoticeHtml}
  <div class="toolbar">
    ${printButtonHtml}
    <span class="pc-pick-bar">
      <button type="button" class="btn-print" onclick="pickAllCards(true)">✓ בחר הכל</button>
      <button type="button" class="btn-print" onclick="pickAllCards(false)">נקה</button>
      <span style="font-size:13px;color:#555;">נבחרו <b id="pcPickCount">0</b></span>
    </span>
  <button class="btn-print" onclick="IronBendDocExport.download({ button: this, filename: 'כרטיסיות ייצור ${order.order_num}', pageSelector: '.cards-page', scale: 3 })">⬇️ הורד PDF</button>
  <button class="btn-print" onclick="IronBendDocExport.send({ button: this, filename: 'כרטיסיות ייצור ${order.order_num}', pageSelector: '.cards-page', scale: 3 })">📤 שלח</button>
    <span style="font-size:13px;color:#555;">הזמנה ${order.order_num} · ${order.customer_name || ''} · ${cardItems.length} כרטיסיות</span>
  </div>

<!-- ── Card grid – server-rendered, barcodes added by JS ── -->
</div>

<div class="cards-pages" id="cardsGrid">${serverCardsHtml}</div>

<script>
// ── Server data ───────────────────────────────────────────────────
var ORDER_ID      = ${Number(order.id) || 0};
var ORDER_NUM     = ${JSON.stringify(order.order_num || '')};
var CUSTOMER      = ${JSON.stringify(order.customer_name || '')};
var SHORT_REF     = ${JSON.stringify([order.customer_name, order.project_name || order.site_name].filter(Boolean).join(' / '))};
var PRINT_DATE    = ${JSON.stringify(printDate)};
var DELIV_DATE    = ${JSON.stringify(delivDate)};
var ORDER_STATUS  = ${JSON.stringify(order.status || '')};
var TOTAL_WEIGHT  = ${(order.total_weight||0).toFixed(1)};
var TOTAL_PALLETS = ${pallets.length};
var PREVIEW_ONLY  = ${isPreviewOnly ? 'true' : 'false'};
var PUBLIC_SCAN_BASE = ${JSON.stringify(String(publicBaseUrl || '').replace(/\/+$/, '')).replace(/</g, '\\u003c')};
var allItems      = ${JSON.stringify(cardItems.map(it => ({
  id:             it.id,
  parent_item_id: it.parent_item_id || it.id,
  card_key:       it.card_key || String(it.id),
  virtual_card:   it.virtual_card || 0,
  scan_suffix:    it.scan_suffix || '',
  pile_card_type: it.pile_card_type || '',
  pile_component_type: it.pile_component_type || '',
  pile_component_quantity: it.pile_component_quantity == null ? null : it.pile_component_quantity,
  pile_cage_snapshot: it.pile_cage_snapshot || pileSnapshotForItem(it, tryParseJSON),
  shape_name:     it.shape_name  || '',
  diameter:       it.diameter    || 12,
  quantity:       it.quantity    || 1,
  unit_length_mm: it.unit_length_mm || 0,
  total_length_mm:it.total_length_mm || 0,
  total_weight:   +(it.total_weight  || 0),
  weight_per_unit:+(it.weight_per_unit || 0),
  segments:       cards.shapeSegmentsFromItem(it),
  shape_svg:      it.virtual_card && it.shape_svg ? it.shape_svg : cards.shapeSvgForProductionCard(it),
  note:           printableItemNote(it.note),
  struct_element: it.struct_element || '',
  orderLineNo:    it.orderLineNo || it.order_line_no || it.line_no || it.lineNo || it.position || null,
  orderTotalLines:it.orderTotalLines || it.order_total_lines || null,
  pallet_num:     it._palletNum  || 1,
  material_grade: it.material_grade || 'B500B',
  actual_weight_kg:+(it.actual_weight_kg || 0),
  card_weights:   Array.isArray(it.card_weights) ? it.card_weights.map(function(weight){ return {
    card_index: +(weight.card_index || 0),
    card_total: +(weight.card_total || 0),
    card_qty: +(weight.card_qty || 0),
    target_weight_kg: +(weight.target_weight_kg || 0),
    actual_weight_kg: +(weight.actual_weight_kg || 0),
    weight_deviation_pct: weight.weight_deviation_pct == null ? null : +(weight.weight_deviation_pct || 0)
  }; }) : [],
  is_3d:          it.is_3d       || 0
})))};

// ── Shape drawing ─────────────────────────────────────────────────
function proportionalPrintSidesClient(sides) {
  var clean = (Array.isArray(sides) ? sides : []).map(function(value){ return Math.max(0, Number(value || 0)); });
  var max = Math.max.apply(null, clean.concat([0]));
  if (!max) return clean;
  return clean.map(function(length){
    if (!length) return 0;
    var ratio = max / length;
    if (ratio < 6) return length;
    return Math.min(max, Math.max(length, max * 0.14));
  });
}

function drawShape(svgEl, segments) {
  if (!segments || !segments.length) return;
  var sides  = segments.map(function(s){ return s.length_mm; });
  var angles = segments.map(function(s){ return s.angle_deg; }).slice(0, -1);
  var visualSides = separateOverlappingSidesClient(proportionalPrintSidesClient(sides), angles);
  var pts = [[0,0]];
  var dir = 0;
  for (var i = 0; i < sides.length; i++) {
    var rad = dir * Math.PI / 180;
    var p = pts[pts.length-1];
    pts.push([p[0] + visualSides[i]*Math.cos(rad), p[1] + visualSides[i]*Math.sin(rad)]);
    if (i < angles.length) dir -= (180 - angles[i]);
  }
  var PAD=28, W=220, H=130;
  var xs=pts.map(function(p){return p[0];}), ys=pts.map(function(p){return p[1];});
  var minX=Math.min.apply(null,xs), maxX=Math.max.apply(null,xs);
  var minY=Math.min.apply(null,ys), maxY=Math.max.apply(null,ys);
  var rX=maxX-minX||1, rY=maxY-minY||1;
  var sc=Math.min((W-PAD*2)/rX,(H-PAD*2)/rY);
  var oX=PAD+((W-PAD*2)-rX*sc)/2, oY=PAD+((H-PAD*2)-rY*sc)/2;
  var mp=function(p){return [oX+(p[0]-minX)*sc, oY+(p[1]-minY)*sc];};
  var mapped=pts.map(mp);
  var pd='M '+mapped.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' L ');
  var svg='<path d="'+pd+'" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>';
  svg+='<path d="'+pd+'" fill="none" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  var center = [mapped.reduce(function(sum, point){ return sum + point[0]; }, 0) / mapped.length, mapped.reduce(function(sum, point){ return sum + point[1]; }, 0) / mapped.length];
  for (var i=0; i<mapped.length-1; i++) {
    svg += sideDimensionSvg(mapped[i], mapped[i + 1], sides[i], center, 19);
  }
  for (var i=1; i<mapped.length-1; i++) {
    var angle = angles[i - 1];
    if (angle !== undefined && angle !== 180) {
      svg += angleMarkerSvg(mapped[i - 1], mapped[i], mapped[i + 1], angle, center);
    }
  }
  var ep=mapped[mapped.length-1];
  svg+='<circle cx="'+mapped[0][0].toFixed(1)+'" cy="'+mapped[0][1].toFixed(1)+'" r="3" fill="#1a2332"/>';
  svg+='<circle cx="'+ep[0].toFixed(1)+'" cy="'+ep[1].toFixed(1)+'" r="3" fill="#1a2332"/>';
  svgEl.innerHTML = svg;
}


function splitQty(total, n) {
  var base = Math.floor(total / n);
  var rem  = total % n;
  var arr  = [];
  for (var i = 0; i < n; i++) arr.push(base + (i < rem ? 1 : 0));
  return arr;
}

function splitWeight(item, subQty) {
  if (!item.quantity) return 0;
  return Number(item.total_weight || 0) * subQty / Number(item.quantity || 1);
}

function cardWeightFor(item, cardTotal, cardIdx) {
  var weights = item.card_weights || [];
  for (var i = 0; i < weights.length; i++) {
    if (Number(weights[i].card_total) === Number(cardTotal) && Number(weights[i].card_index) === cardIdx + 1) return weights[i];
  }
  return null;
}

function deviationClass(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return '';
  var abs = Math.abs(Number(pct));
  if (abs >= 10) return ' bad';
  if (abs >= 3) return ' warn';
  return '';
}

function fmtPct(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return '-';
  return (Number(pct) > 0 ? '+' : '') + Number(pct).toFixed(1) + '%';
}

function itemOrderLineLabel(item) {
  var lineNo = Number(item.orderLineNo || item.order_line_no || item.line_no || item.lineNo || item.position || 0);
  var total = Number(item.orderTotalLines || item.order_total_lines || 0);
  if (lineNo > 0 && total > 0) return 'פריט ' + lineNo + '/' + total;
  if (lineNo > 0) return 'פריט ' + lineNo;
  return 'פריט';
}

function itemHumanTitle(item) {
  var element = String(item.struct_element || item.structElement || item.element_name || item.elementName || item.element || '').trim();
  var lineLabel = itemOrderLineLabel(item);
  return element ? lineLabel + ' — ' + element : lineLabel;
}

var cardSplits = {};

function openCardSplitMenu(itemId, event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.prod-card[data-split-menu-open="1"]').forEach(function(card){ card.removeAttribute('data-split-menu-open'); });
  var card = document.querySelector('.prod-card[data-parent-item-id="' + itemId + '"]:not([data-virtual-card="1"]), .prod-card[data-item-id="' + itemId + '"]');
  if (card) card.setAttribute('data-split-menu-open', '1');
}

function setCardSplit(itemId, count, event) {
  if (event) event.stopPropagation();
  var item = allItems.find(function(row){ return Number(row.id) === Number(itemId) && !row.virtual_card; }) || allItems.find(function(row){ return Number(row.id) === Number(itemId); });
  if (!item || item.virtual_card) return;
  var next = Math.max(1, Math.min(2, Number(count) || 1));
  if (next === 1) delete cardSplits[itemId];
  else cardSplits[itemId] = next;
  generateCards();
  refreshPickedCards();
  renderWorkerCardQrCodes();
}

function cardPlan() {
  var rows = [];
  for (var i=0; i<allItems.length; i++) {
    var item = allItems[i];
    var n = item.virtual_card ? 1 : Math.max(1, Math.min(2, Number(cardSplits[item.id] || 1)));
    var subs = splitQty(item.quantity || 1, n);
    for (var ci=0; ci<n; ci++) {
      rows.push({
        item: item,
        subQty: subs[ci],
        totalCards: n,
        cardIdx: ci,
        cardLabel: n > 1 ? (ci + 1) + '/' + n : ''
      });
    }
  }
  return rows;
}

// ── Build shape SVG string (client-side mirror of pcShapeSVG) ─────
function isRightAngleValue(value) {
  return Math.abs(Number(value) - 90) < 0.001;
}

function normalizeAngleValue(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bend direction is encoded on a full 0-360 turn: -30 and 330 are the same
// physical bend, so displayed values are normalized into [0,360).
function displayBendAngleDeg(value) {
  var n = normalizeAngleValue(value);
  if (n === null) return null;
  return ((n % 360) + 360) % 360;
}

function isPrintableBendAngle(angle) {
  var n = displayBendAngleDeg(angle);
  if (n === null) return false;
  if (Math.abs(n) < 0.001) return false;
  if (Math.abs(n - 180) < 0.001) return false;
  return true;
}

function angleText(angle) {
  var n = displayBendAngleDeg(angle);
  if (n === null) return '';
  return (Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')) + '°';
}

function isOpenUShapeClient(segments) {
  if (!segments || segments.length !== 3) return false;
  var lengths = segments.map(function(s){ return +(s.length_mm || 0); });
  if (lengths.some(function(length){ return length <= 0; })) return false;
  var leftLeg = lengths[0], bridge = lengths[1], rightLeg = lengths[2];
  var legsSimilar = Math.abs(leftLeg - rightLeg) <= Math.max(10, Math.max(leftLeg, rightLeg) * 0.1);
  var legsShorterThanBridge = leftLeg < bridge && rightLeg < bridge;
  return isRightAngleValue(segments[0].angle_deg)
    && isRightAngleValue(segments[1].angle_deg)
    && legsShorterThanBridge
    && legsSimilar;
}

function isSimilarDimensionClient(a, b, tolerance) {
  var max = Math.max(+(a || 0), +(b || 0));
  if (max <= 0) return false;
  return Math.abs(+(a || 0) - +(b || 0)) <= Math.max(10, max * (tolerance || 0.12));
}

function closedStirrupPartsClient(segments) {
  if (!segments || segments.length < 4) return null;
  var values = segments.map(function(s){ return +(s.length_mm || 0); });
  if (values.some(function(v){ return v <= 0; })) return null;
  var checkedAngles = segments.slice(0, Math.min(4, segments.length - 1));
  if (checkedAngles.length && !checkedAngles.every(function(s){ return isRightAngleValue(s.angle_deg); })) return null;

  if (values.length >= 5) {
    var tailStart = values[0], verticalA = values[1], horizontalA = values[2], verticalB = values[3], horizontalB = values[4], tailEnd = values[5] || 0;
    var maxBody = Math.max(verticalA, horizontalA, verticalB, horizontalB);
    if (
      tailStart <= maxBody * 0.45 &&
      (!tailEnd || tailEnd <= maxBody * 0.45) &&
      isSimilarDimensionClient(verticalA, verticalB) &&
      isSimilarDimensionClient(horizontalA, horizontalB)
    ) {
      return { top: horizontalA, right: verticalA, bottom: horizontalB, left: verticalB, tailStart: tailStart, tailEnd: tailEnd };
    }
  }

  if (isSimilarDimensionClient(values[0], values[2]) && isSimilarDimensionClient(values[1], values[3])) {
    return { top: values[0], right: values[1], bottom: values[2], left: values[3], tailStart: values[4] || 0, tailEnd: 0 };
  }

  return null;
}


function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function displayLengthCm(value) {
  var cm = (Number(value) || 0) / 10;
  if (!Number.isFinite(cm)) return '';
  return cm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function displayPileLengthCmExact(value) {
  var cm = Number(value) / 10;
  if (!Number.isFinite(cm)) return '';
  return cm.toFixed(3).replace(/0+$/, '').replace(/\\.$/, '');
}


// כשצלע מאוחרת רצה בדיוק על גבי צלע קודמת (מוט מקופל אחורה על עצמו),
// הן מצוירות קו-על-קו ואי אפשר להבחין ביניהן בשרטוט.
function overlappingCoverIndexClient(points, scale) {
  var EPS = Math.max(1e-9, scale * 0.002);
  for (var i = 1; i < points.length - 1; i++) {
    var a = points[i], b = points[i + 1];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!len) continue;
    dx /= len; dy /= len;
    for (var j = 0; j < i; j++) {
      var c = points[j], d = points[j + 1];
      var ex = d[0] - c[0], ey = d[1] - c[1];
      var elen = Math.sqrt(ex * ex + ey * ey);
      if (!elen) continue;
      ex /= elen; ey /= elen;
      if (Math.abs(dx * ey - dy * ex) > 0.02) continue;
      if (Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) > EPS) continue;
      var t0 = (c[0] - a[0]) * dx + (c[1] - a[1]) * dy;
      var t1 = (d[0] - a[0]) * dx + (d[1] - a[1]) * dy;
      if (Math.max(t0, t1) <= EPS || Math.min(t0, t1) >= len - EPS) continue;
      return { covering: i, victim: j };
    }
  }
  return null;
}

// חישוקים וכל צורה סגורה שחוזרת לנקודת ההתחלה - לא בתחום הכלל הזה.
function isClosedHoopOutlineClient(points, scale) {
  if (!points || points.length < 4 || !scale) return false;
  var first = points[0], last = points[points.length - 1];
  return Math.sqrt(Math.pow(last[0] - first[0], 2) + Math.pow(last[1] - first[1], 2)) < scale * 0.35;
}

// קיצור ויזואלי בלבד של הצלע הצמודה לצלע הקצרה שנדרסת, כדי שהשתיים ייפרדו.
// המידות המודפסות נשענות על sides המקורי ולא מושפעות.
var OVERLAP_SEPARATION_RATIO = 0.10;
function separateOverlappingSidesClient(visualSides, angles) {
  if (!visualSides || visualSides.length < 3) return visualSides;
  var max = Math.max.apply(null, visualSides.concat([0]));
  var shapePoints = calcShapePointsClient(visualSides, angles || []);
  if (isClosedHoopOutlineClient(shapePoints, max)) return visualSides;
  var hit = overlappingCoverIndexClient(shapePoints, max);
  if (!hit) return visualSides;
  var legIndex = hit.victim > 0 ? hit.victim - 1 : hit.victim + 1;
  if (legIndex < 0 || legIndex >= visualSides.length) return visualSides;
  var adjusted = visualSides.slice();
  var leg = adjusted[legIndex];
  adjusted[legIndex] = Math.max(leg * 0.5, leg - max * OVERLAP_SEPARATION_RATIO);
  return adjusted;
}

function calcShapePointsClient(sides, angles) {
  var points = [[0, 0]];
  var direction = 0;
  for (var i = 0; i < sides.length; i++) {
    var previous = points[points.length - 1];
    var radians = direction * Math.PI / 180;
    points.push([
      previous[0] + sides[i] * Math.cos(radians),
      previous[1] + sides[i] * Math.sin(radians)
    ]);
    if (i < angles.length) direction -= (180 - Number(angles[i] == null ? 180 : angles[i]));
  }
  return points;
}

function normalizeShapePointsBaseBottomClient(points) {
  if (!Array.isArray(points) || points.length < 2) return points;
  var longest = { index: 0, length: 0, angle: 0 };
  for (var i = 0; i < points.length - 1; i++) {
    var dx = points[i + 1][0] - points[i][0];
    var dy = points[i + 1][1] - points[i][1];
    var length = Math.hypot(dx, dy);
    if (length > longest.length) longest = { index: i, length: length, angle: Math.atan2(dy, dx) };
  }
  if (!longest.length) return points;
  var cos = Math.cos(-longest.angle);
  var sin = Math.sin(-longest.angle);
  var rotated = points.map(function(point){ return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos]; });
  var base = rotated[longest.index];
  var baseNext = rotated[longest.index + 1];
  var baseY = (base[1] + baseNext[1]) / 2;
  var bodyY = rotated.reduce(function(sum, point){ return sum + point[1]; }, 0) / rotated.length;
  if (bodyY > baseY) rotated = rotated.map(function(point){ return [point[0], baseY + (baseY - point[1])]; });
  return rotated;
}
function pointAt(point, vector, distance) {
  return [point[0] + vector[0] * distance, point[1] + vector[1] * distance];
}

function unitVector(from, to) {
  var dx = to[0] - from[0];
  var dy = to[1] - from[1];
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [dx / len, dy / len];
}

function angleLabelSvg(text, x, y, color) {
  return '<text data-angle-label="1" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="11" font-family="Heebo,Arial" font-weight="900" fill="' + (color || '#c9621a') + '" stroke="white" stroke-width="3.4" paint-order="stroke fill" stroke-linejoin="round">' + escapeHtml(text) + '</text>';
}

function angleLabelPosition(previous, corner, next, distance) {
  // Place the label along the external bisector of the corner so it never
  // lands on either arm segment or on the side-dimension labels
  // (centroid-based placement collapses on Z/zigzag shapes).
  var a = unitVector(corner, previous);
  var b = unitVector(corner, next);
  var vx = a[0] + b[0];
  var vy = a[1] + b[1];
  var len = Math.sqrt(vx * vx + vy * vy);
  if (len < 0.001) {
    vx = -a[1];
    vy = a[0];
    len = 1;
  }
  vx /= len;
  vy /= len;
  return [corner[0] - vx * (distance || 22), corner[1] - vy * (distance || 22)];
}

// Drawing rule: a right angle is marked by the corner square only — no "90°"
// text next to it. Angle text is printed only for non-90° bends.
function rightAngleMarkerSvg(previous, corner, next) {
  var a = unitVector(corner, previous);
  var b = unitVector(corner, next);
  var d = 9;
  var p1 = pointAt(corner, a, d);
  var p2 = [p1[0] + b[0] * d, p1[1] + b[1] * d];
  var p3 = pointAt(corner, b, d);
  return '<path d="M ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' L ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + ' L ' + p3[0].toFixed(1) + ',' + p3[1].toFixed(1) + '" fill="none" stroke="#a8b0ba" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/>';
}

function dimensionLabelSvg(text, x, y, width = 38) {
  return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.8" paint-order="stroke fill" stroke-linejoin="round">' + escapeHtml(text) + '</text>';
}

function sideDimensionSvg(start, end, value, center, distance = 18) {
  var mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  var dx = end[0] - start[0];
  var dy = end[1] - start[1];
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / len;
  var ny = dx / len;
  if ((mid[0] + nx * distance - center[0]) * nx + (mid[1] + ny * distance - center[1]) * ny < 0) {
    nx *= -1;
    ny *= -1;
  }
  var label = [mid[0] + nx * distance, mid[1] + ny * distance];
  var text = displayLengthCm(value);
  var width = Math.max(30, Math.min(48, text.length * 7 + 14));
  return '<line x1="' + mid[0].toFixed(1) + '" y1="' + mid[1].toFixed(1) + '" x2="' + label[0].toFixed(1) + '" y2="' + label[1].toFixed(1) + '" stroke="#aeb8c5" stroke-width="0.8"/>' +
    dimensionLabelSvg(text, label[0], label[1], width);
}

function angleMarkerSvg(previous, corner, next, angle, center) {
  if (!isPrintableBendAngle(angle)) return '';
  // 90° היא ברירת המחדל של כיפוף במוט - לא מסמנים אותה בשרטוט.
  // בחישוקים הסימון נשמר - שם יש חוק אחר.
  if (isRightAngleValue(angle)) return '';
  var a = unitVector(corner, previous);
  var b = unitVector(corner, next);
  var p1 = pointAt(corner, a, 13);
  var p2 = pointAt(corner, b, 13);
  var label = angleLabelPosition(previous, corner, next, 22);
  return '<path d="M ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' Q ' + corner[0].toFixed(1) + ',' + corner[1].toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + '" fill="none" stroke="#c9621a" stroke-width="1.4" stroke-linecap="round"/>' +
    angleLabelSvg(angleText(angle), label[0], label[1]);
}

function buildStraightShapeSVG(segment) {
  var length = Number(segment && segment.length_mm || 0);
  var W = 220, H = 80, y = 40, x1 = 22, x2 = 198;
  var text = displayLengthCm(length);
  var s = '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="#1a2332" stroke-width="4" stroke-linecap="round"/>';
  s += '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round"/>';
  s += dimensionLabelSvg(text, W / 2, 18, Math.max(34, Math.min(54, text.length * 7 + 18)));
  s += '<line x1="' + (W / 2).toFixed(1) + '" y1="25" x2="' + (W / 2).toFixed(1) + '" y2="' + (y - 5) + '" stroke="#aeb8c5" stroke-width="0.8"/>';
  return '<svg data-shape-kind="straight-bar" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;max-height:90px;overflow:visible">' + s + '</svg>';
}

function buildOpenUShapeSVG(segments) {
  var leftLeg = +(segments[0].length_mm || 0);
  var bridge = +(segments[1].length_mm || 0);
  var rightLeg = +(segments[2].length_mm || 0);
  var W = 220, H = 100, left = 42, right = 178, top = 24, bottom = 78;
  var midY = (top + bottom) / 2, midX = (left + right) / 2;
  var pd = 'M ' + left + ',' + top + ' L ' + left + ',' + bottom + ' L ' + right + ',' + bottom + ' L ' + right + ',' + top;
  var s = '<path d="' + pd + '" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>';
  s += '<path d="' + pd + '" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  s += sideDimensionSvg([left, top], [left, bottom], leftLeg, [midX, midY], 22);
  s += sideDimensionSvg([left, bottom], [right, bottom], bridge, [midX, midY], 20);
  s += sideDimensionSvg([right, bottom], [right, top], rightLeg, [midX, midY], 22);
  // 90° היא ברירת המחדל של כיפוף במוט - לא מסמנים אותה בשרטוט.
  // בחישוקים הסימון נשמר - שם יש חוק אחר.
  return '<svg data-shape-kind="open-u" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;max-height:100px;overflow:visible">' + s + '</svg>';
}

function buildClosedStirrupSVG(parts) {
  var W = 240, H = 120;
  var horizontal = Math.max(parts.top || 0, parts.bottom || 0, 1);
  var vertical = Math.max(parts.left || 0, parts.right || 0, 1);
  var ratio = horizontal / vertical;
  var maxBoxW = 126, maxBoxH = 82;
  var boxW = ratio >= 1 ? maxBoxW : Math.max(54, Math.min(maxBoxW, maxBoxH * ratio));
  var boxH = ratio >= 1 ? Math.max(54, Math.min(maxBoxH, maxBoxW / ratio)) : maxBoxH;
  var x = (W - boxW) / 2 - 10, y = (H - boxH) / 2 + 4, right = x + boxW, bottom = y + boxH;
  var midX = x + boxW / 2, midY = y + boxH / 2;
  var pd = 'M ' + x.toFixed(1) + ',' + y.toFixed(1) + ' L ' + right.toFixed(1) + ',' + y.toFixed(1) + ' L ' + right.toFixed(1) + ',' + bottom.toFixed(1) + ' L ' + x.toFixed(1) + ',' + bottom.toFixed(1) + ' Z';
  var marker = Math.min(28, Math.max(14, Math.min(boxW, boxH) * 0.28));
  var markerX = right - marker, markerY = y + marker;
  var markerPath = 'M ' + markerX.toFixed(1) + ',' + y.toFixed(1) + ' L ' + markerX.toFixed(1) + ',' + markerY.toFixed(1) + ' L ' + right.toFixed(1) + ',' + markerY.toFixed(1);
  var s = '<path d="' + pd + '" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>';
  s += '<path d="' + pd + '" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  s += '<path data-stirrup-marker="overlap" d="' + markerPath + '" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="square" stroke-linejoin="miter"/>';
  s += '<path d="' + markerPath + '" fill="none" stroke="#3a5070" stroke-width="1.4" stroke-linecap="square" stroke-linejoin="miter"/>';
  if (parts.tailStart > 0) {
    s += '<text data-tail-dim="1" x="' + (markerX - 4).toFixed(1) + '" y="' + (y + marker / 2).toFixed(1) + '" text-anchor="end" dominant-baseline="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.4" paint-order="stroke fill" stroke-linejoin="round">' + displayLengthCm(parts.tailStart) + '</text>';
  }
  if (parts.tailEnd > 0) {
    s += '<text data-tail-dim="1" x="' + ((markerX + right) / 2).toFixed(1) + '" y="' + (markerY + 9).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.4" paint-order="stroke fill" stroke-linejoin="round">' + displayLengthCm(parts.tailEnd) + '</text>';
  }
  [
    { x: midX, y: y - 11, value: parts.top },
    { x: right + 20, y: midY, value: parts.right },
    { x: midX, y: bottom + 13, value: parts.bottom },
    { x: x - 20, y: midY, value: parts.left }
  ].forEach(function(label) {
    s += '<rect x="' + (label.x - 18).toFixed(1) + '" y="' + (label.y - 7).toFixed(1) + '" width="36" height="14" rx="3" fill="white" fill-opacity="0.94"/>';
    s += '<text x="' + label.x.toFixed(1) + '" y="' + label.y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">' + displayLengthCm(label.value) + '</text>';
  });
  [
    [[x, bottom], [x, y], [right, y]],
    [[x, y], [right, y], [right, bottom]],
    [[right, y], [right, bottom], [x, bottom]],
    [[right, bottom], [x, bottom], [x, y]],
  ].forEach(function(points) {
    s += rightAngleMarkerSvg(points[0], points[1], points[2]);
  });
  return '<svg data-shape-kind="closed-stirrup" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;max-height:112px;overflow:visible">' + s + '</svg>';
}

function buildShapeSVG(segments) {
  try {
    if (!segments || !segments.length) {
      return '<svg viewBox="0 0 220 60" style="width:100%;max-height:80px">' +
        '<line x1="12" y1="30" x2="208" y2="30" stroke="#1a2332" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="12" cy="30" r="3" fill="#1a2332"/><circle cx="208" cy="30" r="3" fill="#1a2332"/></svg>';
    }
    if (segments.length === 1) return buildStraightShapeSVG(segments[0]);
    if (isOpenUShapeClient(segments)) return buildOpenUShapeSVG(segments);
    var stirrup = closedStirrupPartsClient(segments);
    if (stirrup) return buildClosedStirrupSVG(stirrup);
    var W=260, H=140, PAD=46;
    var sides = segments.map(function(s){ return +(s.length_mm||0); });
    var angs  = segments.map(function(s){ return s.angle_deg; });
    var visualSides = separateOverlappingSidesClient(proportionalPrintSidesClient(sides), angs);
    var pts = normalizeShapePointsBaseBottomClient(calcShapePointsClient(visualSides, angs));
    var xs=pts.map(function(p){return p[0];}), ys=pts.map(function(p){return p[1];});
    var mnX=Math.min.apply(null,xs), mxX=Math.max.apply(null,xs);
    var mnY=Math.min.apply(null,ys), mxY=Math.max.apply(null,ys);
    var rX=mxX-mnX||1, rY=mxY-mnY||1;
    var sc=Math.min((W-PAD*2)/rX,(H-PAD*2)/rY);
    var oX=PAD+((W-PAD*2)-rX*sc)/2, oY=PAD+((H-PAD*2)-rY*sc)/2;
    var mpts=pts.map(function(p){return [+(oX+(p[0]-mnX)*sc).toFixed(1), +(oY+(p[1]-mnY)*sc).toFixed(1)];});
    var pd='M '+mpts.map(function(p){return p.join(',');}).join(' L ');
    var s='<path d="'+pd+'" fill="none" stroke="#1a2332" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>';
    s+='<path d="'+pd+'" fill="none" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    var center = [mpts.reduce(function(sum, point){ return sum + point[0]; }, 0) / mpts.length, mpts.reduce(function(sum, point){ return sum + point[1]; }, 0) / mpts.length];
    for (var i=0; i<mpts.length-1; i++) {
      s += sideDimensionSvg(mpts[i], mpts[i + 1], sides[i], center, 15);
    }
    for (var i=1; i<mpts.length-1; i++) {
      var a=angs[i-1];
      if (isPrintableBendAngle(a)) {
        s += angleMarkerSvg(mpts[i - 1], mpts[i], mpts[i + 1], a, center);
      }
    }
    return '<svg data-shape-kind="generic-bar" data-scale-mode="print-fit" data-proportional-short-bends="1" preserveAspectRatio="xMidYMid meet" viewBox="0 0 '+W+' '+H+'" style="width:100%;height:100%;max-height:100px;overflow:visible">'+s+'</svg>';
  } catch(e) {
    return '<svg viewBox="0 0 220 60"><line x1="10" y1="30" x2="210" y2="30" stroke="#ccc" stroke-width="2"/></svg>';
  }
}

// ── Build one item card ───────────────────────────────────────────
function shapeSvgHasAngleLabels(svg) {
  return /data-angle-label|\u00b0|&deg;/.test(String(svg || ''));
}

function hasPrintableBends(segments) {
  return Array.isArray(segments) && segments.length > 1 && segments.slice(0, -1).some(function(segment) { return isPrintableBendAngle(segment.angle_deg); });
}

function shapeSvgForCard(item, segments) {
  var cleanSegments = Array.isArray(segments) ? segments : [];
  var generated = buildShapeSVG(cleanSegments);
  return item.shape_svg || generated;
}

function buildCard(item, subQty, totalCards, cardIdx) {
  var cardNum = totalCards > 1 ? (cardIdx+1) + '/' + totalCards : '';
  var itemId = Number(item.parent_item_id || item.id);
  var cardKey = String(item.card_key || item.id).replace(/[^a-zA-Z0-9_-]/g,'');
  var uid     = 'g' + cardKey + (totalCards > 1 ? 'c' + (cardIdx+1) : '');
  var extraSuffix = item.scan_suffix ? '-' + item.scan_suffix : '';
  var barData = ORDER_NUM + '-' + String(itemId).padStart(6,'0') + extraSuffix + (totalCards > 1 ? '-C' + (cardIdx+1) + 'OF' + totalCards : '');
  // A normal camera opens only the public customer portal. The approved scanner
  // inside the work app extracts the code and routes to this production card.
  var workerCode = PUBLIC_SCAN_BASE + '/customer-scan.html?code=' + encodeURIComponent(barData);
  var segs    = item.segments || [];
  var wProp   = item.quantity > 0 ? (item.total_weight * subQty / item.quantity).toFixed(2) : '0.00';
  var isPileAssembly = item.pile_card_type === 'pile_assembly';
  var componentQuantityKnown = !item.pile_component_type || (Number.isFinite(Number(item.pile_component_quantity)) && Number(item.pile_component_quantity) > 0);
  var displayQty = componentQuantityKnown ? subQty : '—';
  var title   = item.virtual_card ? item.shape_name : itemHumanTitle(item);
  var shapeSubtitle = isPileAssembly ? 'כלוב זיון לכלונס עגול · ASSEMBLY' : (item.shape_name ? ('כרטיס ייצור – ' + item.shape_name) : 'כרטיס כיפוף');
  var badge   = cardNum ? '<span class="split-badge">'+cardNum+'</span>' : '';

  var dimHtml = '';
  for (var i=0; i<segs.length; i++) {
    var lbl = String.fromCharCode(0x05D0+i);
    dimHtml += '<span class="dim-seg">'+lbl+': <b>'+displayLengthCm(segs[i].length_mm)+'</b> ס״מ</span>';
    if (i < segs.length-1 && isPrintableBendAngle(segs[i].angle_deg))
      dimHtml += '<span class="dim-ang">'+angleText(segs[i].angle_deg)+'</span>';
  }

  var shapeSvg = shapeSvgForCard(item, segs);
  var elementName = String(item.struct_element || item.structElement || item.element_name || item.elementName || item.element || '').trim();
  var refExtra = elementName || SHORT_REF || CUSTOMER || '';
  var printRef = escapeHtml(itemOrderLineLabel(item)) + (refExtra ? ' · ' + escapeHtml(refExtra) : '');
  var useExactPileDimensions = Boolean(item.pile_component_type || item.pile_card_type === 'pile_assembly');
  var unitLengthCm = useExactPileDimensions
    ? displayPileLengthCmExact(Number(item.unit_length_mm || item.total_length_mm || 0))
    : displayLengthCm(Number(item.unit_length_mm || item.total_length_mm || 0));
  var totalLengthCm = useExactPileDimensions
    ? displayPileLengthCmExact(Number(item.total_length_mm || 0))
    : displayLengthCm(Number(item.total_length_mm || 0));
  var diameterLabel = isPileAssembly ? ((Number(item.diameter || 0) / 10).toFixed(1).replace(/\.0$/, '') + ' cm') : String(item.diameter);
  var allowSplit = !item.virtual_card;
  var splitTools = !allowSplit ? '<div class="pc-screen-tools"><span class="pc-split-state">'+(isPileAssembly?'הרכבת כלונס':'רכיב כלונס')+'</span></div>' : totalCards > 1
    ? '<div class="pc-screen-tools"><div class="pc-split-menu"><span class="pc-split-state">\u05db\u05e8\u05d8\u05d9\u05e1 '+(cardIdx+1)+'/'+totalCards+'</span><button type="button" onclick="setCardSplit('+item.id+',1,event)">\u05d1\u05d8\u05dc \u05e4\u05d9\u05e6\u05d5\u05dc</button></div></div>'
    : '<button class="pc-split-hotspot" type="button" aria-label="\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea \u05e4\u05d9\u05e6\u05d5\u05dc \u05db\u05e8\u05d8\u05d9\u05e1\u05d9\u05d9\u05d4" onclick="openCardSplitMenu('+item.id+',event)"></button><div class="pc-screen-tools"><div class="pc-split-menu"><button type="button" onclick="setCardSplit('+item.id+',2,event)">\u05e4\u05e6\u05dc \u05db\u05e8\u05d8\u05d9\u05e1\u05d9\u05d9\u05d4</button></div></div>';
  var h = '<div class="prod-card'+(isPileAssembly ? ' pile-cage-master-card pile-cage-assembly-card' : (item.pile_component_type ? ' pile-cage-component-card' : ''))+'" data-item-id="'+cardKey+'" data-parent-item-id="'+itemId+'" data-virtual-card="'+(item.virtual_card?1:0)+'" data-picked="1">';
  h += '<button type="button" class="pc-pick" title="\u05e1\u05de\u05df / \u05d1\u05d8\u05dc \u05db\u05e8\u05d8\u05d9\u05e1\u05d9\u05d9\u05d4 \u05d6\u05d5" onclick="togglePickedCard(this,event)">\u2713</button>';
  h += splitTools;
  h += '<div class="pc-print-face">';
  h += '<div class="pc-print-main">';
  var orderShort = (ORDER_NUM.match(/[0-9]/g) || []).join('').slice(-3);
  var orderLabel = orderShort ? '#' + orderShort : ORDER_NUM;
  // Header leads with the order number; the item number moves to the line below.
  h += '<div class="pc-print-head"><b style="white-space:nowrap">'+escapeHtml(orderLabel)+badge+'</b><span class="pc-print-head-meta"><span class="pc-print-customer">'+escapeHtml(CUSTOMER)+'</span><b class="pc-print-diameter">Ø '+escapeHtml(diameterLabel)+'</b></span></div>';
  h += '<div class="pc-print-ref">'+printRef+'</div>';
  h += '<div class="pc-print-shape">'+shapeSvg+'</div>';
  h += isPileAssembly
    ? '<div class="pc-print-bottom"><span>L = '+totalLengthCm+' cm</span><span>CAGES '+displayQty+'</span></div>'
    : '<div class="pc-print-bottom"><span>L = '+totalLengthCm+' cm</span><span>PCS '+displayQty+'</span></div>';
  h += '</div>';
  h += '<div class="pc-print-qr-panel"><div class="pc-print-qr-code" data-worker-card-code="'+escapeHtml(workerCode)+'"></div></div>';
  h += '</div>';
  h += '<div class="pc-head">';
  h += '<div><div class="pc-title">'+badge+escapeHtml(title)+'</div><div class="pc-date">'+escapeHtml(shapeSubtitle)+' · '+PRINT_DATE+'</div></div>';
  h += '<div class="pc-top-barcode"><div class="bc-font-top">'+barData+'</div><div class="bc-label">'+barData+'</div></div>';
  h += '</div>';
  h += '<div class="pc-order-row">';
  h += '<div class="pc-order-label">הזמנה מס:</div>';
  h += '<div class="pc-order-barcode"><div class="bc-font-mid">'+ORDER_NUM+'</div><div class="bc-ord-text">'+ORDER_NUM+'</div></div>';
  h += '<div class="pc-pallet">משטח: <b>'+item.pallet_num+'</b></div>';
  h += '</div>';
  h += '<div class="pc-scan-row"><div class="pc-scan-qr" data-worker-card-code="'+escapeHtml(workerCode)+'"></div><div><div class="pc-scan-label">לקוחות: פורטל · עובדים: סורק באפליקציה</div><div class="pc-scan-text">'+escapeHtml(barData)+'</div></div></div>';
  h += '<div class="pc-wq-row">';
  h += '<div class="pc-wq-cell"><span class="wq-lbl">ק"ג:</span> <span class="wq-val">'+wProp+'</span></div>';
  h += '<div class="pc-wq-sep"></div>';
  h += '<div class="pc-wq-cell"><span class="wq-lbl">כמות:</span> <span class="wq-val">'+displayQty+'</span> יח</div>';
  h += '<div class="pc-wq-sep"></div>';
  h += '<div class="pc-wq-cell"><span class="wq-lbl">לקוח:</span> <span class="wq-cust">'+escapeHtml(CUSTOMER)+'</span></div>';
  h += '</div>';
  var savedWeight = cardWeightFor(item, totalCards, cardIdx);
  var savedActual = savedWeight ? Number(savedWeight.actual_weight_kg || 0) : 0;
  var savedDeviation = savedWeight ? savedWeight.weight_deviation_pct : null;
  h += '<div class="pc-weight-entry">';
  h += '<div><label>משקל רצוי לכרטיסייה</label><div class="pc-weight-chip">'+wProp+' ק"ג</div></div>';
  h += '<div><label>משקל מצוי</label><input id="card-weight-'+uid+'" type="number" min="0" step="0.01" value="'+(savedActual || '')+'" placeholder="ק״ג"></div>';
  h += '<div><label>סטייה</label><div id="card-weight-dev-'+uid+'" class="pc-weight-chip'+deviationClass(savedDeviation)+'">'+fmtPct(savedDeviation)+'</div></div>';
  h += '<button onclick="saveCardWeight('+itemId+','+(cardIdx+1)+','+totalCards+','+subQty+',&quot;'+uid+'&quot;,event)">שמור משקל</button>';
  h += '</div>';
  h += '<div class="pc-shape-area">'+shapeSvg+'</div>';
  if (dimHtml) h += '<div class="pc-dims">'+dimHtml+'</div>';
  h += '<div class="pc-spec-row">';
  h += '<div class="pc-spec-cell"><span class="spec-lbl">קוטר:</span> <b>\xd8'+diameterLabel+'</b></div>';
  h += '<div class="pc-spec-sep"></div>';
  h += '<div class="pc-spec-cell"><span class="spec-lbl">כיתה:</span> <b>'+(item.material_grade||'B500B')+'</b></div>';
  h += '<div class="pc-spec-sep"></div>';
  h += '<div class="pc-spec-cell"><span class="spec-lbl">'+(isPileAssembly?'אורך כלוב':'יחידה / כולל')+':</span> <b>'+unitLengthCm+(isPileAssembly?'':' / '+totalLengthCm)+'</b> ס״מ</div>';
  if (item.struct_element) h += '<div class="pc-spec-sep"></div><div class="pc-spec-cell"><span class="spec-lbl">איבר:</span> '+escapeHtml(item.struct_element)+'</div>';
  h += '</div>';
  if (item.note) h += '<div class="pc-note">⚠ '+escapeHtml(item.note)+'</div>';
  h += '<div class="pc-footer">';
  h += '<div class="bc-font-footer">'+barData+'</div>';
  h += '<div class="pc-brand">SYNTA<br><span class="pc-brand-num">'+item.pallet_num+'</span></div>';
  h += '</div>';
  h += '</div>';
  return h;
}

// ── Generate & render all cards ───────────────────────────────────
function appendCardToA4Pages(container, cardEl, index) {
  if (index % 8 === 0) {
    var page = document.createElement('div');
    page.className = 'cards-page';
    var grid = document.createElement('div');
    grid.className = 'cards-grid';
    page.appendChild(grid);
    container.appendChild(page);
  }
  var grids = container.querySelectorAll('.cards-grid');
  grids[grids.length - 1].appendChild(cardEl);
}

function generateCards() {
  var pages = document.getElementById('cardsGrid');
  pages.innerHTML = '';
  var plan = cardPlan();
  // Items
  for (var i=0; i<plan.length; i++) {
    var row = plan[i];
    try {
      var d2 = document.createElement('div');
      d2.innerHTML = buildCard(row.item, row.subQty, row.totalCards, row.cardIdx);
      if (d2.firstElementChild) appendCardToA4Pages(pages, d2.firstElementChild, i);
    } catch(e2) { console.error('buildCard item', row.item.id, e2); }
  }
}

async function saveCardWeight(itemId, cardIndex, cardTotal, cardQty, uid, event) {
  if (event) event.stopPropagation();
  var input = document.getElementById('card-weight-' + uid);
  var value = Number(input && input.value);
  if (!Number.isFinite(value) || value < 0) { alert('משקל לא תקין'); return; }
  var res = await fetch('/api/orders/' + ORDER_ID + '/production-card-weight', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: itemId, card_index: cardIndex, card_total: cardTotal, card_qty: cardQty, actual_weight_kg: value })
  });
  var body = await res.json().catch(function(){ return {}; });
  if (!res.ok) { alert(body.error || 'שמירת משקל נכשלה'); return; }
  var item = allItems.find(function(row){ return Number(row.id) === Number(itemId); });
  if (item) {
    item.actual_weight_kg = Number(body.item_actual_weight_kg || 0);
    item.card_weights = (item.card_weights || []).filter(function(row){ return !(Number(row.card_total) !== Number(cardTotal) || (Number(row.card_total) === Number(cardTotal) && Number(row.card_index) === Number(cardIndex))); });
    item.card_weights.push({ card_index: cardIndex, card_total: cardTotal, card_qty: cardQty, target_weight_kg: Number(body.card_target_weight_kg || 0), actual_weight_kg: value, weight_deviation_pct: body.card_deviation_pct });
  }
  var dev = document.getElementById('card-weight-dev-' + uid);
  if (dev) { dev.textContent = fmtPct(body.card_deviation_pct); dev.className = 'pc-weight-chip' + deviationClass(body.card_deviation_pct); }
}

function qrFallbackUrl(target, size) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&margin=0&data=' + encodeURIComponent(target);
}

function renderWorkerCardQrCodes() {
  var nodes = document.querySelectorAll('[data-worker-card-code]');
  var jobs = [];
  nodes.forEach(function(node) {
    var target = node.getAttribute('data-worker-card-code') || '';
    var size = node.classList.contains('pc-print-qr-code') ? 128 : 56;
    node.innerHTML = '';
    node.title = target;

    var fallback = document.createElement('img');
    fallback.alt = 'QR - update production status';
    fallback.src = qrFallbackUrl(target, size);
    fallback.setAttribute('data-qr-target', target);
    node.appendChild(fallback);

    if (!(window.QRCode && window.QRCode.toCanvas)) {
      jobs.push(new Promise(function(resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        fallback.onload = finish;
        fallback.onerror = finish;
        setTimeout(finish, 900);
      }));
    }

    if (window.QRCode && window.QRCode.toCanvas) {
      jobs.push(new Promise(function(resolve) {
        var canvas = document.createElement('canvas');
        window.QRCode.toCanvas(canvas, target, { width: size, margin: 0 }, function(err) {
          if (!err) {
            node.innerHTML = '';
            canvas.setAttribute('data-qr-target', target);
            node.appendChild(canvas);
          }
          resolve();
        });
      }));
    }
  });
  return Promise.all(jobs);
}

// Which cards the operator dropped. Held here rather than on the elements,
// because generateCards() rebuilds the grid and would wipe any DOM state —
// that is what used to send every card to the printer regardless of picking.
var unpickedCardKeys = {};

function cardPickKey(card) {
  return card.getAttribute('data-item-id') || card.getAttribute('data-parent-item-id') || '';
}

// A card that is not picked leaves the flow entirely, so the remaining cards
// close ranks instead of printing a page full of holes.
function togglePickedCard(button, event) {
  if (event) event.stopPropagation();
  var card = button.closest('.prod-card');
  if (!card) return;
  var key = cardPickKey(card);
  if (unpickedCardKeys[key]) delete unpickedCardKeys[key];
  else unpickedCardKeys[key] = true;
  refreshPickedCards();
}

function pickAllCards(on) {
  unpickedCardKeys = {};
  if (!on) {
    document.querySelectorAll('.prod-card').forEach(function (card) {
      unpickedCardKeys[cardPickKey(card)] = true;
    });
  }
  refreshPickedCards();
}

// Applies the remembered picking to whatever is currently on the sheet.
// Safe to call after every rebuild.
function refreshPickedCards() {
  var cards = document.querySelectorAll('.prod-card');
  var picked = 0;
  cards.forEach(function (card) {
    var on = !unpickedCardKeys[cardPickKey(card)];
    card.setAttribute('data-picked', on ? '1' : '0');
    if (on) {
      picked++;
      card.removeAttribute('data-export-hide');
    } else {
      // doc-export skips [data-export-hide], so the PDF matches the printout
      card.setAttribute('data-export-hide', '1');
    }
  });
  document.querySelectorAll('.cards-page').forEach(function (page) {
    var any = page.querySelector('.prod-card[data-picked="1"]');
    if (any) { page.removeAttribute('data-empty-page'); page.removeAttribute('data-export-hide'); }
    else { page.setAttribute('data-empty-page', '1'); page.setAttribute('data-export-hide', '1'); }
  });
  var counter = document.getElementById('pcPickCount');
  if (counter) counter.textContent = picked + ' / ' + cards.length;
}

function printCards() {
  if (PREVIEW_ONLY) { alert('\u05d4\u05db\u05e8\u05d8\u05d9\u05e1\u05d9\u05d5\u05ea \u05d1\u05ea\u05e6\u05d5\u05d2\u05d4 \u05d1\u05dc\u05d1\u05d3. \u05d9\u05e9 \u05dc\u05d0\u05e9\u05e8/\u05dc\u05ea\u05db\u05e0\u05df \u05d0\u05ea \u05d4\u05d4\u05d6\u05de\u05e0\u05d4 \u05dc\u05e4\u05e0\u05d9 \u05d4\u05d3\u05e4\u05e1\u05d4.'); return; }
  generateCards();
  refreshPickedCards();
  renderWorkerCardQrCodes().then(function(){

    setTimeout(function(){ window.print(); }, 250);
  });
}
// Init: render fixed production cards and QR codes.
(function() {
  generateCards();
  renderWorkerCardQrCodes();
  refreshPickedCards();
})();
</script>
<script src="/vendor/html2canvas.min.js"></script>
<script src="/vendor/jspdf.umd.min.js"></script>
<script src="/doc-export.js"></script>
</body>
</html>`;
}

module.exports = {
  renderPrintCardsPage,
  expandProductionCardsForOrder,
  _test: {
    pileSnapshotForItem,
    pileMasterShapeSvg,
    pileComponentShapeSvg,
    fallbackPileProductionCards,
    expandPileCageProductionItems,
  },
};


