const router = require('express').Router();
const QRCode = require('qrcode');
const { customerScanUrl } = require('../services/publicScanLinks');
const { buildOrderCommercialSummary, summaryLine } = require('../services/orderCommercialSummary');

function required(name, value) {
  if (!value) throw new Error(`routes/orderPrintA4 missing dependency: ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isShapeEditorProvenance(note) {
  const normalized = String(note || '').trim();
  // This is an internal marker added by the shape editor, not a production
  // instruction. Older records may include a comma before the editor label.
  return /^נוסף\s+ידנית(?:[,.·\s]+(?:בעורך|עורך|נערך)\s+הצורות)?\.?$/u.test(normalized);
}

function formatPrintNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return digits === 0 ? '0' : '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const THAI_PRINT_LABELS = Object.freeze({
  printA4: 'พิมพ์ A4',
  splitByDiameter: 'แยกแต่ละขนาดเส้นผ่านศูนย์กลางคนละหน้า',
  order: 'ใบสั่งงาน',
  items: 'รายการ',
  productionTitle: 'ใบสั่งผลิต – ดัดเหล็กเสริม',
  productionSubtitle: 'ใบงานผลิต IronBend',
  project: 'โครงการ',
  site: 'สถานที่ / อาคาร',
  customer: 'ลูกค้า',
  orderDate: 'วันที่สั่ง',
  deliveryDate: 'วันที่ส่งมอบ',
  scanOrderQr: 'QR – เปิดการโหลดใบสั่งงาน',
  totalItems: 'รายการทั้งหมด',
  totalWeight: 'น้ำหนักรวม (กก.)',
  pallets: 'พาเลท',
  productionWeightSummary: 'สรุปน้ำหนักการผลิต',
  materialAndProducts: 'วัสดุและสินค้า',
  cutting: 'ตัด',
  bending: 'ดัด',
  spiralProcessing: 'ขึ้นรูปเกลียว',
  notes: 'หมายเหตุ',
  workTypeBreakdown: 'รายละเอียดตามประเภทงาน',
  diameter: 'Ø ขนาด',
  shape: 'รูปทรง',
  totalLengthCm: 'L รวม<br>(ซม.)',
  quantity: 'จำนวน',
  kg: 'กก.',
  inspection: 'ตรวจ',
  printed: 'พิมพ์เมื่อ',
  signature: 'ลายเซ็น',
  total: 'รวม',
  grandTotal: 'รวมทั้งหมด',
  diameterGroup: 'ขนาด Ø',
  noCommercialData: 'ไม่มีข้อมูลสรุปการผลิต',
  commercialSections: {
    material: 'เหล็กแปรรูป',
    processing: 'งานแปรรูปเหล็ก',
    finished_products: 'สินค้าเหล็กสำเร็จรูป',
  },
  commercialLines: {
    processed_rebar_kg: 'เหล็กเส้นแปรรูป',
    round_wire_coil_kg: 'ลวดกลมม้วน',
    cutting_kg: 'ตัด',
    bending_kg: 'ดัด',
    spiral_processing_kg: 'ขึ้นรูปเหล็กเกลียว (Ø ไม่เกิน 12)',
    chairs_units: 'เหล็กรอง',
    rings_units: 'ปลอก / ห่วง',
    lifting_units: 'หูยก / อุปกรณ์ยก',
    mesh_kg: 'ตะแกรงเหล็กมาตรฐาน',
    pile_cages_kg: 'กรงเหล็กเสาเข็ม',
  },
});

function commercialLineValue(line, language = 'he') {
  const thai = language === 'th';
  if (!line) return thai ? '0.00 กก.' : '0.00 קג';
  return line.unit === 'unit'
    ? formatPrintNumber(line.value, 0) + (thai ? ' ชิ้น' : ' יח׳')
    : formatPrintNumber(line.value, 2) + (thai ? ' กก.' : ' קג');
}

function buildA4ProductionSummary({ order, allItems, tryParseJSON, language = 'he' }) {
  const thai = language === 'th';
  const localizeSection = section => thai
    ? (THAI_PRINT_LABELS.commercialSections[section.key] || section.label)
    : section.label;
  const localizeLine = line => thai
    ? (THAI_PRINT_LABELS.commercialLines[line.key] || line.label)
    : line.label;
  const commercialSummary = buildOrderCommercialSummary(allItems);
  const totals = {
    quantity: allItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    weight: commercialSummary.material_weight_kg,
    lengthMm: allItems.reduce((sum, item) => sum + Number(item.total_length_mm || 0) * Number(item.quantity || 0), 0),
    cuttingWeight: summaryLine(commercialSummary, 'cutting_kg')?.value || 0,
    bendingWeight: summaryLine(commercialSummary, 'bending_kg')?.value || 0,
    spiralWeight: summaryLine(commercialSummary, 'spiral_processing_kg')?.value || 0,
  };

  const bucketRows = commercialSummary.sections.map(section => {
    const rows = section.lines.map(line => '<tr data-commercial-summary-line="' + escapeHtml(line.key) + '"><td>' + escapeHtml(localizeLine(line)) + '</td><td>' + commercialLineValue(line, language) + '</td></tr>').join('');
    return '<tr class="commercial-section-row"><td colspan="2">' + escapeHtml(localizeSection(section)) + '</td></tr>' + rows;
  }).join('') || '<tr><td colspan="2">' + (thai ? THAI_PRINT_LABELS.noCommercialData : 'אין נתוני סיכום מסחרי') + '</td></tr>';

  const notes = [order.notes, order.general_notes, order.production_notes, order.driver_notes]
    .filter(Boolean)
    .join(' / ');

  return {
    totals,
    bucketRows,
    commercialSummary,
    notes: escapeHtml(notes || '-'),
    // The production form is used on the shop floor, so its project line must
    // identify the current delivery site.  Legacy project records can retain
    // an old label (for example "רכבת לוד") after an order is moved to a new
    // site (for example "כרמי גת").
    project: escapeHtml(order.site_name || order.project_name || order.project || '-'),
    site: escapeHtml(order.site_name || order.building || order.delivery_address || '-'),
  };
}

module.exports = function createOrderPrintA4Router(deps) {
  const db = required('db', deps.db);
  const requireAnyRole = required('requireAnyRole', deps.requireAnyRole);
  const tryParseJSON = required('tryParseJSON', deps.tryParseJSON);
  const productionCards = deps.productionCards || require('../services/productionCards');
  const settingsService = deps.settingsService || null;

// ── PRINT A4 ──────────────────────────────────────────────────────
router.get('/orders/:id/print-a4', requireAnyRole(['office', 'production', 'manager', 'admin']), async (req, res) => {
  const language = String(req.query.lang || '').toLowerCase() === 'th' ? 'th' : 'he';
  const thai = language === 'th';
  const label = (key, hebrew) => thai ? (THAI_PRINT_LABELS[key] || hebrew) : hebrew;
  const textDirection = thai ? 'ltr' : 'rtl';
  const totalTextAlign = thai ? 'left' : 'right';
  const order = db.prepare(`SELECT o.*, c.name as customer_name, c.phone as customer_phone,
      p.name as project_name, COALESCE(cs.name, legacy_site.name) as site_name
    FROM orders o
    LEFT JOIN customers c ON o.customer_id=c.id
    LEFT JOIN projects p ON o.project_id=p.id
    LEFT JOIN customer_sites cs ON o.site_id=cs.id
    LEFT JOIN sites legacy_site ON o.site_id=legacy_site.id
    WHERE o.id=?`).get(req.params.id);
  if (!order) return res.status(404).send('הזמנה לא נמצאה');

  const pallets = db.prepare('SELECT * FROM pallets WHERE order_id=? ORDER BY pallet_num').all(order.id);
  pallets.forEach(p => {
    p.items = db.prepare('SELECT * FROM items WHERE pallet_id=? ORDER BY id').all(p.id);
    p.items.forEach(item => { item._palletNum = p.pallet_num; });
  });
  const allItems = pallets.flatMap(p => p.items);

  const fmtDate = d => {
    const dt = d ? new Date(d) : new Date();
    return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
  };
  const printDate = fmtDate(order.created_at);
  const delivDate = order.delivery_date ? fmtDate(order.delivery_date) : '—';

  const allItemsJson = JSON.stringify(allItems.map((it, idx) => ({
    rowNum:         idx + 1,
    segments:       tryParseJSON(it.segments, []),
    diameter:       it.diameter || '',
    shape_name:     it.shape_name || '',
    quantity:       it.quantity || 1,
    total_length_mm:it.total_length_mm || 0,
    total_length_cm:(Number(it.total_length_mm||0)/10),
    total_weight:   it.total_weight || 0,
    material_grade: it.material_grade || 'B500B',
    struct_element: it.struct_element || '',
    note:           isShapeEditorProvenance(it.note) ? '' : (it.note || ''),
    pallet_num:     it._palletNum || 1,
    shape_svg:      productionCards.itemShapeSvg(it),
  })));

  // Optional mode: split the item table so each diameter starts on its own
  // printed page — one sheet per bending machine / operator. Default OFF: the
  // classic sheet keeps items in their entered order. ?split_by_diameter=1
  // (or the toolbar toggle) turns grouping on.
  const splitByDiameter = String(req.query.split_by_diameter || '') === '1';
  const safeCustomer = (order.customer_name || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const totalWeight  = (order.total_weight || 0).toFixed(1);
  const productionSummary = buildA4ProductionSummary({ order, allItems, tryParseJSON, language });
  // A normal phone camera always opens the public customer-registration page.
  // Only the approved scanner inside the work app interprets the embedded code.
  const orderQrToken = customerScanUrl(req, `TENE-ORDER-${order.id}`, settingsService);
  const orderQrDataUrl = await QRCode.toDataURL(orderQrToken, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 224,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="${language}" dir="${textDirection}">
<head>
<meta charset="UTF-8">
<title>${label('printA4', 'הדפסת A4')} – ${order.order_num}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&family=Noto+Sans+Thai:wght@400;700;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:${thai ? "'Noto Sans Thai','Leelawadee UI',Tahoma,Arial,sans-serif" : "'Heebo',Arial,sans-serif"};background:#f5f5f5;color:#1a2332;direction:${textDirection};padding:14px;}

/* Screen toolbar */
.no-print{margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.btn-print{padding:9px 24px;background:#1a2332;color:#fff;border:none;border-radius:7px;
  cursor:pointer;font-size:14px;font-family:inherit;font-weight:700;}
.btn-print:hover{background:#c9621a;}

/* Page wrapper */
.page{background:#fff;max-width:210mm;margin:0 auto;padding:14mm 12mm 12mm;
  box-shadow:0 2px 12px rgba(0,0,0,0.12);}

/* Header */
.hdr{display:grid;grid-template-columns:34mm 1fr 30mm;gap:8mm;align-items:center;
  border-bottom:3px solid #1a2332;padding-bottom:10px;margin-bottom:12px;}
.hdr-logo{width:32mm;height:auto;display:block;}
.hdr-main{min-width:0;}
.hdr-title{font-size:22px;font-weight:900;color:#1a2332;}
.hdr-sub{font-size:13px;color:#555;margin-top:3px;}
.hdr-right{text-align:left;}
.order-qr{width:27mm;height:27mm;border:1px solid #cfd8e3;display:flex;align-items:center;justify-content:center;background:#fff;justify-self:end;}
.order-qr canvas,.order-qr img{width:25mm!important;height:25mm!important;display:block;}
.order-num{font-size:28px;font-weight:900;color:#c9621a;line-height:1;}
.hdr-meta{font-size:11px;color:#666;margin-top:4px;line-height:1.6;}

/* Summary row */
.summary{display:flex;gap:0;margin-bottom:12px;border:1px solid #ddd;border-radius:6px;overflow:hidden;}
.sum-cell{flex:1;padding:8px 12px;border-left:1px solid #ddd;text-align:center;}
.sum-cell:last-child{border-left:none;}
.sum-label{font-size:10px;color:#888;margin-bottom:2px;}
.sum-val{font-size:16px;font-weight:900;color:#1a2332;}
.production-summary{display:grid;grid-template-columns:1.1fr .9fr;gap:10px;margin-bottom:12px;}
.prod-summary-box{border:1px solid #d0d7e0;border-radius:6px;overflow:hidden;background:#fff;}
.prod-summary-box h2{font-size:12px;background:#eef3fb;color:#1a2332;padding:6px 9px;border-bottom:1px solid #d0d7e0;}
.prod-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #d0d7e0;}
.prod-summary-grid div{padding:6px 8px;border-left:1px solid #d0d7e0;text-align:center;min-width:0;}
.prod-summary-grid div:last-child{border-left:none;}
.prod-summary-grid span{display:block;font-size:9px;color:#667;font-weight:700;}
.prod-summary-grid b{display:block;font-size:13px;color:#1a2332;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.prod-breakdown{width:100%;border-collapse:collapse;font-size:10.5px;}
.prod-breakdown td{border-bottom:1px solid #e1e6ed;padding:5px 8px;}
.prod-breakdown td:last-child{text-align:left;direction:ltr;font-weight:900;}
.prod-breakdown .commercial-section-row td{background:#f3f6fa;color:#34465e;text-align:right;direction:rtl;font-weight:900;}
.prod-notes{font-size:10px;line-height:1.45;padding:7px 9px;color:#333;min-height:24px;}

/* Table */
.items-table{width:100%;border-collapse:collapse;font-size:11px;}
.items-table th{background:#1a2332;color:#fff;padding:7px 6px;text-align:center;
  font-size:11px;font-weight:700;border:1px solid #1a2332;}
.items-table td{padding:5px 5px;border:1px solid #d0d7e0;vertical-align:middle;text-align:center;}
.items-table tr:nth-child(even) td{background:#f7f9fc;}
.items-table tr:hover td{background:#eef3fb;}
.row-num{font-weight:900;font-size:13px;color:#1a2332;min-width:20px;}
.diam{font-weight:900;font-size:13px;color:#c9621a;}
.shape-td{min-width:120px;max-width:180px;padding:3px!important;}
.shape-svg{display:block;margin:0 auto;}
.len-val{font-size:13px;font-weight:900;}
.qty-val{font-size:15px;font-weight:900;color:#1a2332;}
.wt-val{font-size:12px;font-weight:700;}
.note-row td{background:#fff8e1!important;color:#856404;font-size:10px;padding:3px 8px!important;text-align:right!important;}
.check-box{width:18px;height:18px;border:1.5px solid #aaa;border-radius:3px;display:inline-block;}

/* Totals */
.totals-row{background:#1a2332!important;}
.totals-row td{color:#fff!important;font-weight:900;font-size:12px;padding:7px 6px!important;
  border-color:#1a2332!important;}

/* Footer */
.footer{margin-top:14px;display:flex;justify-content:space-between;align-items:center;
  border-top:2px solid #1a2332;padding-top:8px;font-size:10px;color:#888;}
.footer-brand{font-weight:900;color:#c9621a;font-size:13px;}

/* Diameter grouping */
.items-table thead{display:table-header-group;}
tbody.diam-group .group-head td{background:#1a2332;color:#fff;font-weight:900;font-size:12.5px;
  padding:7px 10px;text-align:right;letter-spacing:.02em;}
tbody.diam-group .group-head td .gh-count{font-weight:700;opacity:.8;font-size:11px;}
tbody.diam-group .group-sub td{background:#eef2f7;color:#1a2332;font-weight:900;font-size:11.5px;
  padding:6px 6px;border-top:1.5px solid #1a2332;}
tbody.diam-split{break-before:page;page-break-before:always;}
tbody.diam-split.first{break-before:auto;page-break-before:auto;}
tbody.diam-group tr{break-inside:avoid;page-break-inside:avoid;}
body[data-print-language="th"] .hdr-right{text-align:right;}
body[data-print-language="th"] .prod-breakdown td:last-child{direction:ltr;text-align:right;}
body[data-print-language="th"] .prod-breakdown .commercial-section-row td{text-align:left;direction:ltr;}
body[data-print-language="th"] .note-row td{text-align:left!important;}
body[data-print-language="th"] tbody.diam-group .group-head td{text-align:left;}

@media print{
  body{background:#fff;padding:0;}
  .no-print{display:none!important;}
  .page{box-shadow:none;padding:8mm 8mm 8mm;max-width:100%;}
  .production-summary{grid-template-columns:1.1fr .9fr;gap:8px;}
  @page{size:A4 portrait;margin:0;}
}
</style>
</head>
<body data-print-language="${language}">

<div class="no-print">
  <button class="btn-print" onclick="window.print()">🖨️ ${label('printA4', 'הדפס A4')}</button>
  <button class="btn-print" onclick="IronBendDocExport.download({ button: this, filename: 'הדפסת A4 ${order.order_num}' })">⬇️ הורד PDF</button>
  <button class="btn-print" onclick="IronBendDocExport.send({ button: this, filename: 'הדפסת A4 ${order.order_num}' })">📤 שלח</button>
  <button class="btn-print" onclick="switchPrintLanguage('${thai ? 'he' : 'th'}')">${thai ? 'עברית' : 'ไทย'}</button>
  <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#1a2332;cursor:pointer;">
    <input type="checkbox" ${splitByDiameter ? 'checked' : ''} onchange="toggleDiamSplit(this)">
    ${label('splitByDiameter', 'כל קוטר בעמוד נפרד')}
  </label>
  <span style="font-size:13px;color:#555;">${label('order', 'הזמנה')} ${order.order_num} · ${safeCustomer} · ${allItems.length} ${label('items', 'פריטים')}</span>
</div>

<div class="page">
  <!-- Header -->
  <div class="hdr">
    <img class="hdr-logo" src="/brand/tene-pdf-logo.jpg" alt="TENA">
    <div class="hdr-main">
      <div class="hdr-title">${label('productionTitle', 'טופס ייצור – כיפוף ברזל')}</div>
      <div class="hdr-sub">${label('productionSubtitle', 'IronBend Production Sheet')}</div>
      <div class="hdr-meta">${label('project', 'פרויקט')}: <b>${productionSummary.project}</b> · ${label('site', 'אתר / בניין')}: <b>${productionSummary.site}</b></div>
    </div>
    <div class="hdr-right">
      <div class="order-num">${order.order_num}</div>
      <div class="hdr-meta">
        ${label('customer', 'לקוח')}: <b>${safeCustomer}</b><br>
        ${label('orderDate', 'תאריך הזמנה')}: <b>${printDate}</b><br>
        ${label('deliveryDate', 'תאריך מסירה')}: <b>${delivDate}</b>
      </div>
    </div>
      <div class="order-qr" data-order-code="${escapeHtml(orderQrToken)}" title="לקוחות: פורטל לקוחות · עובדים: סריקה מתוך האפליקציה">
        <img src="${orderQrDataUrl}" alt="QR לפורטל לקוחות או לסורק העבודה המובנה">
      </div>
  </div>

  <!-- Summary -->
  <div class="summary">
    <div class="sum-cell"><div class="sum-label">${label('totalItems', 'סה"כ פריטים')}</div><div class="sum-val">${allItems.length}</div></div>
    <div class="sum-cell"><div class="sum-label">${label('totalWeight', 'סה"כ ק"ג')}</div><div class="sum-val">${totalWeight}</div></div>
    <div class="sum-cell"><div class="sum-label">${label('pallets', 'משטחים')}</div><div class="sum-val">${pallets.length}</div></div>
    <div class="sum-cell"><div class="sum-label">${label('order', 'הזמנה')}</div><div class="sum-val">${order.order_num}</div></div>
  </div>
  <!-- Production summary -->
  <div class="production-summary">
    <div class="prod-summary-box">
      <h2>${label('productionWeightSummary', 'סיכום משקלים לייצור')}</h2>
      <div class="prod-summary-grid">
        <div><span>${label('materialAndProducts', 'חומר ומוצרים')}</span><b>${formatPrintNumber(productionSummary.totals.weight, 2)} ${label('kg', 'קג')}</b></div>
        <div><span>${label('cutting', 'חיתוך')}</span><b>${formatPrintNumber(productionSummary.totals.cuttingWeight, 2)} ${label('kg', 'קג')}</b></div>
        <div><span>${label('bending', 'כיפוף')}</span><b>${formatPrintNumber(productionSummary.totals.bendingWeight, 2)} ${label('kg', 'קג')}</b></div>
        <div><span>${label('spiralProcessing', 'עיבוד ספירלה')}</span><b>${formatPrintNumber(productionSummary.totals.spiralWeight, 2)} ${label('kg', 'קג')}</b></div>
      </div>
      <div class="prod-notes"><b>${label('notes', 'הערות')}:</b> ${productionSummary.notes}</div>
    </div>
    <div class="prod-summary-box">
      <h2>${label('workTypeBreakdown', 'פירוט לפי סוג עבודה')}</h2>
      <table class="prod-breakdown"><tbody>${productionSummary.bucketRows}</tbody></table>
    </div>
  </div>
  <!-- Items table -->
  <table class="items-table" id="itemsTable">
    <thead>
      <tr>
        <th>#</th>
        <th>${label('diameter', '⌀ נ\'')}</th>
        <th>${label('shape', 'צורה')}</th>
        <th>${label('totalLengthCm', 'L סה"כ<br>(ס"מ)')}</th>
        <th>${label('quantity', 'כמות')}</th>
        <th>${label('kg', 'ק"ג')}</th>
        <th>${label('inspection', '✓')}</th>
      </tr>
    </thead>
    <tbody id="tableBody"></tbody>
  </table>

  <!-- Footer -->
  <div class="footer">
    <div>${label('printed', 'הודפס')}: ${printDate} · IronBend</div>
    <div class="footer-brand">${label('order', 'הזמנה')} ${order.order_num}</div>
    <div>${label('signature', 'חתימה')}: _______________</div>
  </div>
</div>

<script>
var allItems = ${allItemsJson};
var splitByDiameter = ${splitByDiameter ? 'true' : 'false'};
var printLabels = ${JSON.stringify({
  total: label('total', 'סה"כ'),
  grandTotal: label('grandTotal', 'סה"כ כללי'),
  diameterGroup: label('diameterGroup', 'קוטר Ø'),
  items: label('items', 'פריטים'),
})};
var totalTextAlign = '${totalTextAlign}';

// window.URL is used explicitly: inline handlers resolve identifiers against
// document first, where document.URL is a string that shadows the constructor.
function toggleDiamSplit(input){
  var u = new window.URL(window.location.href);
  u.searchParams.set('split_by_diameter', input.checked ? '1' : '0');
  window.location.href = u.href;
}

function switchPrintLanguage(language){
  var u = new window.URL(window.location.href);
  u.searchParams.set('lang', language);
  window.location.href = u.href;
}

function itemRowHtml(it, uid) {
  return '<td class="row-num">'+it.rowNum+'</td>'+
    '<td class="diam">Ø'+it.diameter+'</td>'+
    '<td class="shape-td"><div class="shape-svg" id="'+uid+'">'+(it.shape_svg||'')+'</div></td>'+
    '<td><span class="len-val">'+it.total_length_cm+'</span></td>'+
    '<td><span class="qty-val">'+it.quantity+'</span></td>'+
    '<td><span class="wt-val">'+(it.total_weight||0).toFixed(1)+'</span></td>'+
    '<td><span class="check-box"></span></td>';
}

function buildFlatTable() {
  // Original mode: items in their entered order, one table, one total row.
  var tbody = document.getElementById('tableBody');
  var totalQty = 0, totalWt = 0;
  for (var i=0; i<allItems.length; i++) {
    var it = allItems[i];
    totalQty += it.quantity; totalWt += (it.total_weight||0);
    var row = document.createElement('tr');
    row.innerHTML = itemRowHtml(it, 'sv'+i);
    tbody.appendChild(row);
    if (it.note) {
      var noteRow = document.createElement('tr');
      noteRow.className = 'note-row';
      noteRow.innerHTML = '<td colspan="7">⚠ '+it.note+'</td>';
      tbody.appendChild(noteRow);
    }
  }
  var totRow = document.createElement('tr');
  totRow.className = 'totals-row';
  totRow.innerHTML =
    '<td colspan="4" style="text-align:'+totalTextAlign+';padding-right:10px!important;">'+printLabels.total+'</td>'+
    '<td>'+totalQty+'</td>'+
    '<td>'+totalWt.toFixed(1)+'</td>'+
    '<td></td>';
  tbody.appendChild(totRow);
}

function buildTable() {
  if (!splitByDiameter) { buildFlatTable(); return; }

  var table = document.getElementById('itemsTable');
  var oldBody = document.getElementById('tableBody');
  if (oldBody) oldBody.remove();

  // By-diameter mode: group items by diameter (ascending). Each group becomes
  // its own <tbody> so it can start on a fresh printed page while the header
  // row repeats.
  var groups = {};
  var order = [];
  for (var i=0; i<allItems.length; i++) {
    var d = Number(allItems[i].diameter) || 0;
    if (!groups[d]) { groups[d] = []; order.push(d); }
    groups[d].push(allItems[i]);
  }
  order.sort(function(a,b){ return a-b; });

  var totalQty = 0, totalWt = 0, uidN = 0;
  order.forEach(function(d, gi) {
    var items = groups[d];
    var gQty = 0, gWt = 0;
    var body = document.createElement('tbody');
    body.className = 'diam-group' + (splitByDiameter ? ' diam-split' : '') + (gi === 0 ? ' first' : '');

    var head = document.createElement('tr');
    head.className = 'group-head';
    head.innerHTML = '<td colspan="7">'+printLabels.diameterGroup+d+' <span class="gh-count">· '+items.length+' '+printLabels.items+'</span></td>';
    body.appendChild(head);

    items.forEach(function(it) {
      gQty += it.quantity; gWt += (it.total_weight||0);
      totalQty += it.quantity; totalWt += (it.total_weight||0);
      var row = document.createElement('tr');
      row.innerHTML = itemRowHtml(it, 'sv'+(uidN++));
      body.appendChild(row);
      if (it.note) {
        var noteRow = document.createElement('tr');
        noteRow.className = 'note-row';
        noteRow.innerHTML = '<td colspan="7">⚠ '+it.note+'</td>';
        body.appendChild(noteRow);
      }
    });

    var sub = document.createElement('tr');
    sub.className = 'group-sub';
    sub.innerHTML =
      '<td colspan="4" style="text-align:'+totalTextAlign+';padding-right:10px!important;">'+printLabels.total+' Ø'+d+'</td>'+
      '<td>'+gQty+'</td>'+
      '<td>'+gWt.toFixed(1)+'</td>'+
      '<td></td>';
    body.appendChild(sub);
    table.appendChild(body);
  });

  // Grand total (only when more than one diameter — otherwise the group
  // subtotal already is the total).
  if (order.length > 1) {
    var totBody = document.createElement('tbody');
    var totRow = document.createElement('tr');
    totRow.className = 'totals-row';
    totRow.innerHTML =
      '<td colspan="4" style="text-align:'+totalTextAlign+';padding-right:10px!important;">'+printLabels.grandTotal+'</td>'+
      '<td>'+totalQty+'</td>'+
      '<td>'+totalWt.toFixed(1)+'</td>'+
      '<td></td>';
    totBody.appendChild(totRow);
    table.appendChild(totBody);
  }
}

buildTable();
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
  "id": "order-print-a4",
  "label": "Order A4 Print",
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
