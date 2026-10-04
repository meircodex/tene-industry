const router = require('express').Router();
const { isTechnicalRecognitionNote } = require('../services/intakeWorkflow');
const productionCards = require('../services/productionCards');
const { itemShapeMetrics } = require('../services/shapeSnapshot');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const {
  buildOrderCommercialSummary,
  classifyOrderItem,
  effectiveItemWeight,
} = require('../services/orderCommercialSummary');

const REVIEW_NOTE_LABEL = '\u05d3\u05d5\u05e8\u05e9 \u05d0\u05d9\u05de\u05d5\u05ea \u05de\u05d5\u05dc \u05de\u05e7\u05d5\u05e8 \u05d4\u05e7\u05dc\u05d9\u05d8\u05d4';

function required(name, value) {
  if (!value) throw new Error(`routes/orderDeliveryCertificate missing dependency: ${name}`);
  return value;
}

function printableItemNote(note) {
  const normalized = String(note || '').trim();
  if (!normalized) return '';
  // This is an internal provenance marker added by the editor. It is not a
  // customer or delivery instruction, so it must never appear on documents.
  if (/^נוסף ידנית בעורך הצורות\.?$/u.test(normalized)) return '';
  return isTechnicalRecognitionNote(normalized) ? REVIEW_NOTE_LABEL : normalized;
}


function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function roundPileCageDeliveryMetrics(item = {}) {
  if (!productionCards.isRoundPileCageItem(item)) return null;
  const snapshot = parseSnapshot(item.shape_snapshot_json || item.shapeSnapshot || item.shape_snapshot || item.shapeData || item.shape_data) || {};
  if (snapshot.validation && (snapshot.validation.ok === false || snapshot.validation.valid === false)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 422 });
  const canonical = calculatePileCage(snapshot);
  if (!canonical.validation?.ok || canonical.productionCards?.length !== 5) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 422 });
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const unitWeightKg = Number(canonical.calculated?.totalWeightKg);
  const physicalLengthMm = Number(canonical.assemblySummary?.pileLengthMm);
  const pileDiameterMm = Number(canonical.assemblySummary?.pileDiameterMm);
  if (!(unitWeightKg > 0) || !(physicalLengthMm > 0) || !(pileDiameterMm > 0)) throw Object.assign(new Error('invalid_round_pile_cage_assembly_metrics'), { statusCode: 422 });
  return { isRoundPileCage: true, totalLengthMm: physicalLengthMm, totalWeightKg: unitWeightKg * quantity, unitWeightKg, pileDiameterMm, quantity };
}

function deliveryItemMetrics(item, industry = null) {
  const pileCage = roundPileCageDeliveryMetrics(item);
  if (pileCage) return pileCage;
  const metrics = itemShapeMetrics(item || {});
  const totalLengthMm = metrics.totalLengthMm || Number(item && item.total_length_mm) || 0;
  // The certificate must match the A4 sheet and billing_weight, which are all
  // driven by items.total_weight — so the stored weight wins and the snapshot
  // is only a fallback for legacy rows without one.
  const legacyWeight = Number(item && item.total_weight) || 0;
  if (legacyWeight > 0) return { totalLengthMm, totalWeightKg: legacyWeight };

  const snapshotWeight = metrics.totalWeightKg || 0;
  if (snapshotWeight > 0) return { totalLengthMm, totalWeightKg: snapshotWeight };

  const kgm = industry && typeof industry.kgPerMeter === 'function'
    ? industry.kgPerMeter(Math.round(Number(item && item.diameter) || 0))
    : 0;
  const quantity = Number(item && item.quantity) || 1;
  const calculatedWeight = kgm && totalLengthMm
    ? Math.round((totalLengthMm / 1000) * kgm * quantity * 10) / 10
    : 0;
  return { totalLengthMm, totalWeightKg: calculatedWeight };
}

function deliverySectionKey(item) {
  const kind = classifyOrderItem(item).kind;
  return {
    pile_cage: 'cage',
    lift_package: 'lifts',
    mesh: 'mesh',
    spiral: 'spiral',
    chair: 'chairs',
    ring: 'hoops',
    lifting: 'lifting',
    bent_rebar: 'bent_rebar',
    straight_rebar: 'straight_rebar',
  }[kind] || kind;
}

module.exports = function createOrderDeliveryCertificateRouter(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const industry = required('industry', deps.industry);

// ── DELIVERY CERTIFICATE ─────────────────────────────────────────
router.get('/orders/:id/delivery-certificate', requireAnyRole(['office', 'warehouse', 'driver', 'manager', 'admin']), (req, res) => {
  const order = db.prepare(`SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
    FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=?`).get(req.params.id);
  if (!order) return res.status(404).send('הזמנה לא נמצאה');

  const pallets = db.prepare('SELECT * FROM pallets WHERE order_id=? ORDER BY pallet_num').all(order.id);
  pallets.forEach(p => { p.items = db.prepare('SELECT * FROM items WHERE pallet_id=? ORDER BY id').all(p.id); });
  const allItems = pallets.flatMap(p => p.items);
  const requestedItemStatus = String(req.query.item_status || '').trim();
  const selectedItems = requestedItemStatus
    ? allItems.filter(item => String(item.status || '').trim() === requestedItemStatus)
    : allItems;
  if (requestedItemStatus && !selectedItems.length) {
    return res.status(409).send(`אין פריטים בסטטוס ${requestedItemStatus} לתעודת משלוח`);
  }

  const fmtDate = d => {
    const dt = d ? new Date(d) : new Date();
    return `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`;
  };
  const today = fmtDate();
  const delivDate = order.delivery_date ? fmtDate(order.delivery_date) : '—';

  const calcItemWeight = it => effectiveItemWeight(it, roundPileCageDeliveryMetrics(it)).weightKg;
  const commercialSummary = buildOrderCommercialSummary(selectedItems);
  const wTotal = commercialSummary.material_weight_kg;
  // 3% weight-gap addition — same factor as orders.billing_weight (routes/orders.js).
  // Optional: ?waste3=0 renders the certificate without the addition rows.
  const includeWaste = String(req.query.waste3 || '1') !== '0';
  const wWaste = wTotal * 0.03;
  const wBilling = wTotal * 1.03;
  const fmt1 = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
  const fmt2 = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const fmtTon = v => (Number(v || 0) / 1000).toFixed(2);

  // Position range label
  const posLabel = requestedItemStatus === 'הועמס'
    ? 'תעודת משלוח חלקית לפי פריטים שהועמסו'
    : selectedItems.length > 0
      ? 'תעודת משלוח לפי פריטים שסופקו וסיכום סעיפי עבודה'
    : 'תעודת משלוח';

  const workSummaryRowsHtml = commercialSummary.sections.map(section => {
    const rows = section.lines.map(line => {
      const value = line.unit === 'unit'
        ? fmt1(line.value) + ' &#1497;&#1495;&#1523;'
        : fmt2(line.value) + ' &#1511;&#1524;&#1490;';
      return '<div class="sum-row" data-commercial-summary-line="' + line.key + '"><span class="sum-lbl">' + line.label + ':</span><span class="sum-val">' + value + '</span></div>';
    }).join('');
    return '<div class="summary-group-title">' + section.label + '</div>' + rows;
  }).join('');

  const summaryTotalsHtml = includeWaste ? `
      <div class="sum-row">
        <span class="sum-lbl">סה"כ משקל תיאורטי:</span>
        <span class="sum-val">${fmt2(wTotal)} ק"ג</span>
      </div>
      <div class="sum-row" style="color:#c0392b;">
        <span class="sum-lbl" style="color:#c0392b;">תוספת 3% פערי משקלים:</span>
        <span class="sum-val" style="color:#c0392b;font-weight:900;">${fmt2(wWaste)} ק"ג</span>
      </div>
      <div class="sum-row sum-total">
        <span class="sum-lbl"><b>סה"כ משקל לחיוב:</b></span>
        <span class="sum-val"><b>${fmt2(wBilling)} ק"ג</b></span>
      </div>` : `
      <div class="sum-row sum-total">
        <span class="sum-lbl"><b>סה"כ משקל:</b></span>
        <span class="sum-val"><b>${fmt2(wTotal)} ק"ג</b></span>
      </div>`;

  const tfootTotalsHtml = includeWaste ? `
      <tr>
        <td colspan="4" style="text-align:right;background:#eef3f8;color:#1a2332;">סה"כ משקל תיאורטי:</td>
        <td class="total-val" style="background:#eef3f8;color:#1a2332;">${fmt2(wTotal)}</td>
        <td style="background:#eef3f8;"></td>
        <td style="background:#eef3f8;color:#1a2332;">סה"כ פריטים בתעודה · ${selectedItems.length}</td>
      </tr>
      <tr>
        <td colspan="4" style="text-align:right;background:#fff;color:#c0392b;">תוספת 3% פערי משקלים:</td>
        <td class="total-val" style="background:#fff;color:#c0392b;">${fmt2(wWaste)}</td>
        <td style="background:#fff;"></td>
        <td style="background:#fff;"></td>
      </tr>
      <tr>
        <td colspan="4" style="text-align:right;">סה"כ משקל לחיוב:</td>
        <td class="total-val">${fmt2(wBilling)}</td>
        <td></td>
        <td></td>
      </tr>` : `
      <tr>
        <td colspan="4" style="text-align:right;">סה"כ משקל</td>
        <td class="total-val">${fmt2(wTotal)}</td>
        <td></td>
        <td>סה"כ פריטים בתעודה · ${selectedItems.length}</td>
      </tr>`;

  // Build table rows
  let rows = '';
  selectedItems.forEach((item, idx) => {
    const itemMetrics = deliveryItemMetrics(item, industry);
    const posNum = idx + 1;
    const pileCageMetrics = roundPileCageDeliveryMetrics(item);
    const diam   = pileCageMetrics ? `${(pileCageMetrics.pileDiameterMm / 10).toFixed(1).replace(/\.0$/, '')} cm` : (item.diameter || '–');
    const lenCm  = itemMetrics.totalLengthMm ? Math.round(itemMetrics.totalLengthMm / 10) : '–';
    const qty    = item.quantity || 1;
    const wt     = fmt1(calcItemWeight(item));
    const notes  = [pileCageMetrics ? 'PILE CAGE · כלוב זיון לכלונס עגול' : '', item.struct_element, item.struct_floor, item.sheet_num, printableItemNote(item.note)].filter(Boolean).join(' · ') || '–';

    const shapeSvg = productionCards.itemShapeSvg(item);

    rows += `
      <tr>
        <td class="c">${posNum}</td>
        <td class="c"><b>${pileCageMetrics ? 'CAGE Ø' : 'Ø'}${diam}</b></td>
        <td class="c">${lenCm}</td>
        <td class="c">${qty}</td>
        <td class="c"><b>${wt}</b></td>
        <td class="shape-cell">
          <div class="delivery-shape">${shapeSvg}</div>
        </td>
        <td>${notes}</td>
      </tr>`;
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<title>ריכוז תעודת משלוח – ${order.order_num}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;700;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Heebo',Arial,sans-serif;direction:rtl;background:#f0f2f5;padding:18px;color:#1a2332;}

/* ── Screen toolbar ── */
.toolbar{margin-bottom:14px;display:flex;gap:10px;align-items:center;}
.btn-print{padding:9px 22px;background:#1a2332;color:#fff;border:none;border-radius:6px;
  cursor:pointer;font-size:14px;font-family:inherit;font-weight:700;}
.btn-print:hover{background:#c9621a;}
.btn-back{padding:9px 16px;background:#eee;color:#1a2332;border:1px solid #ccc;
  border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;text-decoration:none;display:inline-block;}

/* ── A4 page ── */
.page{background:#fff;width:210mm;min-height:297mm;margin:0 auto;padding:14mm 12mm;
  box-shadow:0 4px 20px rgba(0,0,0,0.15);}
.cert-pages{display:flex;flex-direction:column;gap:16px;align-items:center;}
.cert-pages .page{height:297mm;min-height:297mm;margin:0;padding:12mm 12mm 10mm;
  display:flex;flex-direction:column;overflow:hidden;position:relative;}
.page-body{flex:1 1 auto;overflow:hidden;}
.page-num{position:absolute;bottom:4mm;left:0;right:0;text-align:center;font-size:10px;color:#66707c;}

/* ── Header ── */
.doc-title{text-align:center;font-size:22px;font-weight:900;color:#1a2332;letter-spacing:0.5px;margin-bottom:4px;}
.doc-subtitle{text-align:center;font-size:12px;color:#555;font-style:italic;margin-bottom:14px;}
.meta-row{display:flex;justify-content:space-between;font-size:11px;color:#444;
  border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:6px 4px;margin-bottom:14px;}
.meta-item{display:flex;gap:5px;}
.meta-lbl{color:#888;}
.meta-val{font-weight:700;}

/* ── Summary box ── */
.summary-box{background:#f7fafc;border:2px solid #1a2332;border-radius:4px;
  padding:12px 16px;margin-bottom:16px;display:inline-block;float:left;min-width:92mm;box-shadow:0 1px 0 rgba(26,35,50,.12);}
.summary-title{font-size:12px;font-weight:900;color:#1a2332;margin-bottom:9px;text-align:center;border-bottom:2px solid #1a2332;padding-bottom:5px;}
.sum-row{display:flex;justify-content:space-between;gap:24px;font-size:12px;margin-bottom:5px;}
.summary-group-title{font-size:11px;font-weight:900;color:#526276;background:#eef2f7;margin:8px -6px 5px;padding:3px 6px;}
.sum-lbl{color:#444;}
.sum-val{font-weight:700;color:#1a2332;}
.sum-total{border-top:1.5px solid #1a2332;margin-top:6px;padding-top:6px;}
.sum-total .sum-val{font-size:14px;color:#c9621a;}
.clearfix::after{content:'';display:table;clear:both;}

/* ── Table ── */
.section-title{font-size:13px;font-weight:900;color:#1a2332;margin-bottom:8px;
  border-bottom:2px solid #1a2332;padding-bottom:4px;}
table{width:100%;border-collapse:collapse;font-size:10.5px;}
thead th{background:#1a2332;color:#fff;padding:7px 5px;text-align:center;font-weight:700;
  border:1px solid #1a2332;}
tbody tr:nth-child(even){background:#f7f9fc;}
tbody tr:hover{background:#eaf2ff;}
tbody td{padding:5px 5px;border:1px solid #d0d8e4;vertical-align:middle;}
td.c{text-align:center;}
.shape-cell{text-align:center;padding:3px 5px;width:38mm;}
.delivery-shape{width:36mm;height:23mm;margin:0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.delivery-shape svg{width:100%!important;height:100%!important;max-height:none!important;display:block;}
tfoot td{background:#1a2332;color:#fff;font-weight:900;padding:8px 6px;
  border:1px solid #1a2332;text-align:center;}
tfoot .total-val{font-size:14px;color:#f0a060;}

/* ── Footer ── */
.doc-footer{margin-top:18px;border-top:1px solid #ddd;padding-top:8px;
  display:flex;justify-content:space-between;font-size:10px;color:#888;}
.company-name{font-weight:900;color:#1a2332;font-size:12px;}

@media print{
  body{background:#fff;padding:0;}
  .toolbar{display:none!important;}
  .cert-pages{display:block;}
  .page{box-shadow:none;margin:0;width:210mm;}
  .cert-pages .page{break-after:page;page-break-after:always;}
  .cert-pages .page:last-child{break-after:auto;page-break-after:auto;}
  /* Fallback when the paginator did not run: keep rows whole per page. */
  tbody tr{break-inside:avoid;page-break-inside:avoid;}
  tfoot{display:table-row-group;}
  @page{size:A4 portrait;margin:0;}
}
</style>
</head>
<body>

<div class="toolbar">
  <a href="/orders.html" class="btn-back">← חזור להזמנות</a>
  <button class="btn-print" onclick="window.print()">🖨️ הדפס</button>
  <button class="btn-print" onclick="IronBendDocExport.download({ button: this, filename: 'תעודת משלוח ${order.order_num}' })">⬇️ הורד PDF</button>
  <button class="btn-print" onclick="IronBendDocExport.send({ button: this, filename: 'תעודת משלוח ${order.order_num}' })">📤 שלח</button>
  <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#1a2332;cursor:pointer;">
    <input type="checkbox" ${includeWaste ? 'checked' : ''} onchange="toggleWaste3(this)">
    תוספת 3% פערי משקלים
  </label>
  <span style="font-size:13px;color:#666;">הזמנה ${order.order_num} · ${order.customer_name || ''}</span>
</div>

<div class="page" id="certSource">

  <!-- Header -->
  <div class="doc-title">ריכוז תעודת משלוח וסיכום משקלים סופי</div>
  <div class="doc-subtitle">${posLabel}</div>

  <div class="meta-row">
    <div class="meta-item"><span class="meta-lbl">לקוח:</span><span class="meta-val">${order.customer_name || '—'}</span></div>
    <div class="meta-item"><span class="meta-lbl">הזמנה מס':</span><span class="meta-val">${order.order_num}</span></div>
    <div class="meta-item"><span class="meta-lbl">תאריך אספקה:</span><span class="meta-val">${delivDate}</span></div>
    <div class="meta-item"><span class="meta-lbl">תאריך הפקה:</span><span class="meta-val">${today}</span></div>
  </div>

  <!-- Summary box -->
  <div class="clearfix">
    <div class="summary-box" data-summary-contract="steel-cutting-bending">
      <div class="summary-title">&#1505;&#1497;&#1499;&#1493;&#1501; &#1505;&#1506;&#1497;&#1508;&#1497; &#1506;&#1489;&#1493;&#1491;&#1492; &#1500;&#1502;&#1513;&#1500;&#1493;&#1495;</div>
      ${workSummaryRowsHtml}
${summaryTotalsHtml}
    </div>
  </div>

  <!-- Detail table -->
  <div class="section-title">טבלת פירוט אלמנטים מלאה ומאוחדת</div>
  <table>
    <thead>
      <tr>
        <th>פוזיציה</th>
        <th>קוטר<br>(מ"מ)</th>
        <th>אורך<br>(ס"מ)</th>
        <th>כמות<br>(יח')</th>
        <th>משקל<br>(ק"ג)</th>
        <th>צורה</th>
        <th>מקור המידע / הערות</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>${tfootTotalsHtml}
    </tfoot>
  </table>

  <!-- Footer -->
  <div class="doc-footer">
    <div>
      <div class="company-name">טנא תעשיות ברזל בע"מ</div>
      <div>תעודה זו מהווה אישור לפרטי המשלוח המפורטים לעיל</div>
    </div>
    <div style="text-align:left;">
      <div>חתימה ואישור: _______________</div>
      <div style="margin-top:4px;">תאריך קבלה: _______________</div>
    </div>
  </div>

</div><!-- /page -->
<div class="cert-pages" id="certPages"></div>
<script>
// Inline handlers resolve identifiers against document first, where
// document.URL is a string that shadows the URL constructor — so the
// toggle lives here as a named function using window.URL explicitly.
function toggleWaste3(input){
  var u = new window.URL(window.location.href);
  u.searchParams.set('waste3', input.checked ? '1' : '0');
  window.location.href = u.href;
}
(function(){
  function paginate(){
    var source = document.getElementById('certSource');
    var target = document.getElementById('certPages');
    if (!source || !target) return;
    var table = source.querySelector('table');
    if (!table) return;
    // The source stays intact (hidden) and pages are built from clones, so
    // pagination can re-run cleanly after webfonts finish loading.
    target.innerHTML = '';
    var thead = table.querySelector('thead');
    var tfootSource = table.querySelector('tfoot');
    var tfoot = tfootSource ? tfootSource.cloneNode(true) : null;
    var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr')).map(function(row){ return row.cloneNode(true); });
    var blocksBefore = [];
    var blocksAfter = [];
    var seenTable = false;
    Array.prototype.slice.call(source.children).forEach(function(node){
      if (node === table) { seenTable = true; return; }
      (seenTable ? blocksAfter : blocksBefore).push(node.cloneNode(true));
    });

    var pages = [];
    var currentBody = null, currentTable = null, currentTbody = null;
    function newPage(){
      var page = document.createElement('div');
      page.className = 'page';
      currentBody = document.createElement('div');
      currentBody.className = 'page-body';
      page.appendChild(currentBody);
      target.appendChild(page);
      pages.push(page);
      currentTable = null; currentTbody = null;
    }
    function ensureTable(){
      if (currentTable) return;
      currentTable = document.createElement('table');
      if (thead) currentTable.appendChild(thead.cloneNode(true));
      currentTbody = document.createElement('tbody');
      currentTable.appendChild(currentTbody);
      currentBody.appendChild(currentTable);
    }
    function overflows(){
      return currentBody.scrollHeight > currentBody.clientHeight + 1;
    }
    function place(node, needsTable){
      function append(){
        if (needsTable) {
          ensureTable();
          if (node.tagName === 'TFOOT') currentTable.appendChild(node);
          else currentTbody.appendChild(node);
        } else {
          currentBody.appendChild(node);
        }
      }
      append();
      if (!overflows()) return;
      var alone = needsTable
        ? currentBody.childElementCount === 1 && currentTbody.childElementCount <= 1
        : currentBody.childElementCount === 1;
      if (alone) return; // a single block taller than a page stays where it is
      node.parentNode.removeChild(node);
      newPage();
      append();
    }

    newPage();
    blocksBefore.forEach(function(node){ place(node, false); });
    rows.forEach(function(row){ place(row, true); });
    if (tfoot) place(tfoot, true);
    blocksAfter.forEach(function(node){ place(node, false); });

    source.style.display = 'none';
    pages.forEach(function(page, index){
      var num = document.createElement('div');
      num.className = 'page-num';
      num.textContent = 'עמוד ' + (index + 1) + ' מתוך ' + pages.length;
      page.appendChild(num);
    });
  }
  function run(){
    try { paginate(); } catch (err) {
      var source = document.getElementById('certSource');
      var target = document.getElementById('certPages');
      if (target) target.innerHTML = '';
      if (source) source.style.display = '';
    }
  }
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
  // Text metrics change once webfonts arrive — repaginate with final fonts.
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function(){ setTimeout(run, 0); });
  }
})();
</script>
<script src="/vendor/html2canvas.min.js"></script>
<script src="/vendor/jspdf.umd.min.js"></script>
<script src="/doc-export.js"></script>
</body>
</html>`);
});

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "order-delivery-certificate",
  "label": "Order Delivery Certificate",
  "consumes": [
    {
      "table": "orders"
    },
    {
      "table": "items"
    }
  ],
  "produces": []
};
module.exports._test = { roundPileCageDeliveryMetrics, deliveryItemMetrics, deliverySectionKey };
