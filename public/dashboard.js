const WS_URL = () => window.IronBendAuth?.webSocketUrl?.('/') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const TODAY = new Date().toISOString().slice(0, 10);
let ws, dashData = null, alertsData = [], inventoryForecast = [], productionQueueItems = [], todayDeliveries = [], shiftSummary = null, _wsDelay = 1000;
let dashboardDrilldownData = null, dashboardDrilldownRequest = 0, dashboardDrilldownTrigger = null;

function applyDataContractBadges() {
  if (window.IronBendDataContracts) window.IronBendDataContracts.applyDataContracts(document);
}

function escHtml(s) {
  return window.IronBendSafe
    ? window.IronBendSafe.escapeHtml(s)
    : String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function formatKg(value) { return Math.round(Number(value || 0)).toLocaleString('he-IL') + ' ק"ג'; }
function formatTons(value, digits = 1) {
  const tons = Number(value || 0);
  return tons.toLocaleString('he-IL', { maximumFractionDigits: digits, minimumFractionDigits: tons > 0 && tons < 10 ? 1 : 0 });
}
function statusBadgeClass(status) {
  const s = String(status || '');
  if (s.includes('הושלם') || s.includes('סופק')) return 's-done';
  if (s.includes('ייצור')) return 's-prod';
  if (s.includes('אישור') || s.includes('ממתין')) return 's-pend';
  if (s.includes('חסר') || s.includes('בוטל')) return 's-risk';
  return '';
}

function drillWeightSourceLabel(source) {
  const labels = {
    production_event: 'דיווח ייצור',
    legacy_card_snapshot: 'משקל כרטיס שמור',
    completed_item_actual: 'משקל בפועל בכרטיס',
    completed_item_theoretical: 'משקל תאורטי בהשלמה',
    current_item_actual: 'משקל בפועל בכרטיס',
    theoretical: 'משקל תאורטי',
  };
  return labels[source] || 'ללא משקל זמין';
}
function dashboardNumber(value, digits = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString('he-IL', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : '—';
}
function formatDrillKg(value) { return `${dashboardNumber(value, 3)} ק"ג`; }

function updateTime() {
  const now = new Date();
  const time = now.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  const date = now.toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long' });
  const h = now.getHours();
  let shiftLabel = 'משמרת לילה', shiftRange = '22:00-06:00';
  if (h >= 6 && h < 14) { shiftLabel = 'משמרת בוקר'; shiftRange = '06:00-14:00'; }
  if (h >= 14 && h < 22) { shiftLabel = 'משמרת אחה"צ'; shiftRange = '14:00-22:00'; }
  setText('headerClock', time);
  setText('shiftBadge', `${shiftLabel} · ${shiftRange}`);
  setText('dayHeaderText', `${date} · ${time}`);
}

function connectWS() {
  try {
    ws = new WebSocket(WS_URL());
    ws.onopen = () => { _wsDelay = 1000; };
    ws.onerror = () => ws.close();
    ws.onclose = () => { _wsDelay = Math.min(_wsDelay * 2, 30000); setTimeout(connectWS, _wsDelay); };
    ws.onmessage = e => {
      try {
        const { type, data } = JSON.parse(e.data);
        if (type === 'machines_state') renderMachinesCompact(data);
        if (type === 'machine_update') fetchDashboard();
        if (type === 'alert') fetchDashboard();
        if (['new_order','order_status','order_complete'].includes(type)) fetchDashboard();
      } catch {}
    };
  } catch {}
}

async function fetchDashboard() {
  try {
    const [dashboardRes, queueRes, ordersRes, forecastRes, alertsRes, shiftRes] = await Promise.all([
      fetch('/api/dashboard'),
      fetch('/api/production-queue'),
      fetch('/api/orders?date=' + encodeURIComponent(TODAY)),
      fetch('/api/inventory/forecast').catch(() => null),
      fetch('/api/alerts').catch(() => null),
      fetch('/api/kpi/shift-summary').catch(() => null)
    ]);
    dashData = await dashboardRes.json();
    const productionQueue = await queueRes.json().catch(() => ({ items: [] }));
    const ordersToday = await ordersRes.json().catch(() => []);
    productionQueueItems = productionQueue.items || [];
    todayDeliveries = Array.isArray(ordersToday) ? ordersToday : [];
    inventoryForecast = forecastRes && forecastRes.ok ? await forecastRes.json().catch(() => []) : [];
    alertsData = alertsRes && alertsRes.ok ? await alertsRes.json().catch(() => []) : [];
    shiftSummary = shiftRes && shiftRes.ok ? await shiftRes.json().catch(() => null) : null;

    renderKPIs(dashData);
    renderDailyProductionPlan();
    renderActionCenter();
    renderTodayDeliveries();
    renderProdQueue(productionQueue.items || []);
    renderStockShortages();
    renderProductionCardsSummary();
    renderMachinesCompact(dashData.machines || []);
    renderWasteByMachine(dashData.wasteByMachine || []);
    applyDataContractBadges();
  } catch (err) {
    console.warn('dashboard load failed', err);
  }
}

function renderKPIs(d) {
  const producedWeightToday = Number(d.producedWeightToday || 0);
  const producedTonsToday = Number(d.producedTonsToday || (producedWeightToday / 1000) || 0);
  const completedItemsToday = Number(d.itemsDone ?? d.completedToday ?? 0);
  const deliveryWeight = todayDeliveries.reduce((sum, o) => sum + Number(o.total_weight || o.billing_weight || 0), 0);
  const shortageCount = relevantShortages().length;

  document.getElementById('kpiOrdersToday').textContent = todayDeliveries.length || 0;
  document.getElementById('kpiWeightToday').textContent = producedWeightToday.toFixed(0) + ' ק"ג יוצרו';
  document.getElementById('kpiInProd').textContent = d.inProduction ?? 0;
  document.getElementById('kpiItemsProd').textContent = (d.itemsInProduction || 0) + ' פריטים';
  document.getElementById('kpiDone').textContent = completedItemsToday;
  document.getElementById('kpiItemsDone').textContent = completedItemsToday + ' פריטים';
  document.getElementById('kpiUrgent').textContent = d.urgentOpen || 0;
  document.getElementById('kpiWaste').textContent = (d.wasteAvgPct || 0) + '%';
  document.getElementById('kpiPending').textContent = d.pending ?? 0;
  document.getElementById('kpiTonsToday').textContent = formatTons(producedTonsToday) + ' ט';
  document.getElementById('qsWeight').textContent = producedWeightToday.toFixed(0) + ' ק"ג';

  setText('todayDeliveryWeight', deliveryWeight > 0 ? formatKg(deliveryWeight) + ' לצאת' : 'אין צפי משקל');
  setText('stockShortageKpi', shortageCount);
  setText('deliveriesTodayKpi', todayDeliveries.length || 0);
  setText('deliveriesTodaySub', deliveryWeight > 0 ? formatTons(deliveryWeight / 1000) + ' טון' : 'הזמנות');
}

function productionReference() {
  const deliveryWeightKg = todayDeliveries.reduce((sum, o) => sum + Number(o.total_weight || o.billing_weight || 0), 0);
  if (deliveryWeightKg > 0) return { type: 'forecast', label: 'צפי יציאה היום לפי אספקות', kg: deliveryWeightKg };
  return { type: 'none', label: 'יעד יומי לא הוגדר', kg: 0 };
}
function currentShiftBounds() {
  if (!shiftSummary?.shiftType) return null;
  const now = new Date(), start = new Date(now), end = new Date(now);
  if (shiftSummary.shiftType === 'morning') { start.setHours(6,0,0,0); end.setHours(14,0,0,0); }
  else if (shiftSummary.shiftType === 'afternoon') { start.setHours(14,0,0,0); end.setHours(22,0,0,0); }
  else { start.setHours(22,0,0,0); end.setDate(end.getDate() + (now.getHours() >= 22 ? 1 : 0)); end.setHours(6,0,0,0); }
  return { start, end };
}
function calculateProductionPace(actualKg, targetKg) {
  if (!targetKg) return { status: 'muted', badge: 'ללא יעד', text: 'אין יעד/צפי לחישוב קצב' };
  const bounds = currentShiftBounds();
  if (!bounds) return { status: 'muted', badge: 'ללא נתון משמרת', text: 'מוצג אחוז ביצוע בלבד' };
  const now = new Date();
  const elapsed = Math.max(0, Math.min(1, (now - bounds.start) / (bounds.end - bounds.start)));
  const actual = Math.max(0, Math.min(2, actualKg / targetKg));
  if (actual < elapsed - 0.08) return { status: 'behind', badge: 'בפיגור', text: 'נדרש להגביר קצב' };
  if (actual > elapsed + 0.08) return { status: 'ahead', badge: 'מקדים', text: 'הביצוע מקדים את קצב המשמרת' };
  return { status: 'ok', badge: 'בקצב', text: 'הביצוע תואם את קצב המשמרת' };
}
function renderDailyProductionPlan() {
  const actualKg = Number(dashData?.producedWeightToday || 0);
  const ref = productionReference();
  const pct = ref.kg > 0 ? Math.min(160, (actualKg / ref.kg) * 100) : 0;
  const remainingKg = ref.kg > 0 ? Math.max(0, ref.kg - actualKg) : 0;
  const pace = calculateProductionPace(actualKg, ref.kg);
  const plan = document.getElementById('dailyProductionPlan');
  plan.classList.toggle('is-behind', pace.status === 'behind');
  plan.classList.toggle('is-ahead', pace.status === 'ahead');
  setText('productionPlanSubtitle', ref.label);
  setText('productionActualTons', formatTons(actualKg / 1000));
  setText('productionTargetTons', ref.kg > 0 ? formatTons(ref.kg / 1000) : '—');
  setText('productionPercent', ref.kg > 0 ? Math.round(Math.min(100, pct)) + '%' : '—');
  setText('productionRemainingTons', ref.kg > 0 ? 'נותרו ' + formatTons(remainingKg / 1000) + ' טון' : 'לא הוגדר יעד יומי');
  setText('productionPaceText', pace.text);
  document.getElementById('productionProgressFill').style.setProperty('--progress', Math.min(100, pct) + '%');
  const badge = document.getElementById('productionPaceBadge');
  badge.textContent = pace.badge;
  badge.className = 'pace-badge ' + (pace.status === 'behind' ? 'is-behind' : pace.status === 'ahead' ? 'is-ahead' : pace.status === 'ok' ? '' : 'is-muted');
  const overall = document.getElementById('overallStatusBadge');
  overall.textContent = pace.badge;
  overall.className = 'status-pill ' + (pace.status === 'behind' ? 'is-behind' : pace.status === 'ahead' ? 'is-ahead' : pace.status === 'ok' ? 'is-ok' : '');
}

function relevantShortages() {
  const queueDiameters = new Set((productionQueueItems || []).map(item => String(item.diameter || '').trim()).filter(Boolean));
  return (inventoryForecast || [])
    .filter(row => row.alert && row.alert !== 'ok')
    .filter(row => !queueDiameters.size || queueDiameters.has(String(row.diameter || '').trim()))
    .slice(0, 6);
}
function renderActionCenter() {
  const actions = [];
  const portalAwaitingCustomerApproval = Number(dashData?.portalAwaitingCustomerApproval || 0);
  const pending = Number(dashData?.pending || 0), urgent = Number(dashData?.urgentOpen || 0);
  const todayNotReady = todayDeliveries.filter(o => !String(o.status || '').includes('סופק') && !String(o.status || '').includes('הושלם'));
  const shortages = relevantShortages();
  const notPrinted = productionQueueItems.filter(item => item.status && String(item.status).includes('ממתין')).length;
  const machineProblems = (dashData?.machines || []).filter(m => machineStateClass(m) === 'error');
  if (portalAwaitingCustomerApproval) actions.push({ level:'warning', title:`${portalAwaitingCustomerApproval} הזמנות פורטל ממתינות לאישור לקוח`, sub:'תור נפרד — לא מאושרות ולא משוחררות לייצור', href:'/orders.html?status=' + encodeURIComponent('ממתינה לאישור לקוח') });
  if (shortages.length) actions.push({ level:'danger', title:`${shortages.length} קטרים בחוסר מלאי`, sub:shortages.map(s => `Ø${s.diameter}`).join(' · '), href:'/inventory.html' });
  if (todayNotReady.length) actions.push({ level:'warning', title:`${todayNotReady.length} אספקות היום עדיין לא מוכנות`, sub:'בדוק סטטוס ייצור/מחסן לפני יציאה', href:'/orders.html?date=' + encodeURIComponent(TODAY) });
  if (pending) actions.push({ level:'warning', title:`${pending} הזמנות ממתינות לאישור`, sub:'נדרש אישור לפני שחרור לייצור', href:'/orders.html?status=' + encodeURIComponent('ממתינה לאישור') });
  if (urgent) actions.push({ level:'danger', title:`${urgent} הזמנות דחופות פתוחות`, sub:'לתעדף בתור הייצור והאספקה', href:'/orders.html?priority=' + encodeURIComponent('דחוף') });
  if (notPrinted) actions.push({ level:'info', title:`${notPrinted} פריטים ממתינים לשחרור/כרטיסיות`, sub:'פתח כרטיסיות רק לפריטים שדורשים פעולה', href:'/production-queue.html' });
  if (machineProblems.length) actions.push({ level:'danger', title:`${machineProblems.length} מכונות בחריגה`, sub:machineProblems.map(m => m.name).join(' · '), href:'/machine.html' });
  setText('actionCountPill', actions.length);
  const host = document.getElementById('actionCenterList');
  if (!actions.length) { host.innerHTML = '<div class="muted-state">אין כרגע חריגות שמחייבות פעולה.</div>'; return; }
  host.innerHTML = actions.map(action => `<div class="action-item"><span class="action-dot ${action.level === 'danger' ? 'danger' : action.level === 'warning' ? 'warning' : ''}"></span><div class="action-copy"><div class="action-title">${escHtml(action.title)}</div><div class="action-sub">${escHtml(action.sub)}</div></div><a class="action-link" href="${escHtml(action.href)}">פתח</a></div>`).join('');
}
function renderTodayDeliveries() {
  setText('todayDeliveriesCount', todayDeliveries.length);
  const tbody = document.getElementById('todayDeliveriesBody');
  if (!todayDeliveries.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted-state">אין אספקות מתוכננות להיום.</td></tr>'; return; }
  tbody.innerHTML = todayDeliveries.map(o => `<tr><td><span class="order-num">${escHtml(o.order_num || o.id)}</span></td><td>${escHtml(o.customer_name || '—')}</td><td>${escHtml(o.delivery_address || o.site_name || o.project_name || '—')}</td><td><span class="weight-val">${formatKg(o.total_weight || o.billing_weight || 0)}</span></td><td><span class="status-badge ${statusBadgeClass(o.status)}">${escHtml(o.status || '—')}</span></td><td><button class="inline-detail-btn" type="button" data-dashboard-drilldown="order" data-dashboard-order-id="${Number(o.id)}">כרטיסים</button></td></tr>`).join('');
}
function renderProdQueue(items) {
  const queueItems = items || [];
  document.getElementById('prodQueueCount').textContent = queueItems.length;
  const host = document.getElementById('prodQueueBody');
  if (!queueItems.length) { host.innerHTML = '<div class="muted-state">אין פריטים בתור ייצור.</div>'; return; }
  const shortages = relevantShortages();
  host.innerHTML = `<table class="data-table"><thead><tr><th>הזמנה</th><th>לקוח</th><th>משקל</th><th>סטטוס</th><th></th></tr></thead><tbody>${queueItems.slice(0, 18).map(item => { const risk = shortages.some(s => String(s.diameter) === String(item.diameter)); return `<tr><td><span class="order-num">${escHtml(item.order_num || '—')}</span></td><td>${escHtml(item.customer_name || '—')} ${item.diameter ? `<span style="color:var(--dim);font-weight:800">Ø${escHtml(item.diameter)}</span>` : ''}</td><td><span class="weight-val">${formatKg(item.weight || 0)}</span></td><td><span class="status-badge ${risk ? 's-risk' : statusBadgeClass(item.status)}">${risk ? 'חסר מלאי' : escHtml(item.status || '—')}</span></td><td><button class="inline-detail-btn" type="button" data-dashboard-drilldown="card" data-dashboard-item-id="${Number(item.id)}">פירוט</button></td></tr>`; }).join('')}</tbody></table>`;
}
function renderStockShortages() {
  const shortages = relevantShortages();
  const host = document.getElementById('stockShortagesPanel');
  if (!shortages.length) { host.innerHTML = '<div class="muted-state">אין חוסרי מלאי רלוונטיים כרגע.</div>'; return; }
  host.innerHTML = `<div class="compact-list">${shortages.map(row => { const diameter = Number(row.diameter); const canDrill = Number.isFinite(diameter) && diameter > 0; return `<div class="compact-row"><span>Ø${escHtml(row.diameter)} · ${row.alert === 'critical' ? 'חוסר קריטי' : 'אזהרה'} ${canDrill ? `<button class="inline-detail-btn" type="button" data-dashboard-drilldown="shortage" data-dashboard-diameter="${diameter}">כרטיסים</button>` : ''}</span><strong>${formatKg(row.on_hand_kg || 0)}</strong></div>`; }).join('')}</div><a class="action-link" href="/procurement.html" style="margin-top:12px">פתח רכש/מלאי</a>`;
}
function renderProductionCardsSummary() {
  const waiting = productionQueueItems.filter(item => String(item.status || '').includes('ממתין')).length;
  const inProd = productionQueueItems.filter(item => String(item.status || '').includes('ייצור')).length;
  const weight = productionQueueItems.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  document.getElementById('productionCardsSummary').innerHTML = `<div class="compact-list"><div class="compact-row"><span>פריטים בתור</span><strong>${productionQueueItems.length}</strong></div><div class="compact-row"><span>ממתינים</span><strong>${waiting}</strong></div><div class="compact-row"><span>בייצור</span><strong>${inProd}</strong></div><div class="compact-row"><span>משקל בתור</span><strong>${formatKg(weight)}</strong></div></div>${productionQueueItems.length ? '<a class="action-link" href="/production-queue.html" style="margin-top:12px">פתח תור ייצור</a>' : ''}`;
}
function machineStateClass(m) {
  if (m.status === 'בייצור') return 'running';
  if (m.status === 'תקלה' || m.status === 'שגיאת תקשורת' || m.connected === 0) return 'error';
  if (m.connected || m.status === 'פנוי') return 'online';
  return 'idle';
}
function renderMachinesCompact(machines) {
  const host = document.getElementById('machinesCompactStrip');
  if (!machines?.length) { host.innerHTML = '<span class="machine-chip">אין מכונות</span>'; setText('machinesOnlineCount', '0/0'); return; }
  let online = 0;
  host.innerHTML = machines.map(m => { const cls = machineStateClass(m); if (cls !== 'idle' && cls !== 'error') online++; return `<span class="machine-chip ${cls}">${escHtml(m.name || ('מכונה ' + m.id))} · ${escHtml(m.status || 'לא מחובר')}</span>`; }).join('');
  setText('machinesOnlineCount', `${online}/${machines.length}`);
}
function renderWasteByMachine(wasteByMachine) {
  const totalWaste = (wasteByMachine || []).reduce((sum, row) => sum + Number(row.waste || 0), 0);
  const totalQty = (wasteByMachine || []).reduce((sum, row) => sum + Number(row.qty || 0), 0);
  if (totalQty > 0 && !dashData?.wasteAvgPct) setText('kpiWaste', ((totalWaste / totalQty) * 100).toFixed(1) + '%');
}
async function fetchTonsToday() {
  try { const d = await fetch('/api/kpi/tons-today').then(r => r.json()); if (d && Number.isFinite(Number(d.tons))) document.getElementById('kpiTonsToday').textContent = formatTons(d.tons) + ' ט'; } catch {}
}
async function fetchInventoryForecast() {
  try { inventoryForecast = await fetch('/api/inventory/forecast').then(r => r.json()); renderStockShortages(); renderActionCenter(); } catch {}
}

function drillSummaryCells(summary = {}) {
  const cells = [];
  if (Number.isFinite(Number(summary.order_count))) cells.push(['הזמנות', dashboardNumber(summary.order_count, 0)]);
  if (Number.isFinite(Number(summary.card_count))) cells.push(['כרטיסים', dashboardNumber(summary.card_count, 0)]);
  if (Number.isFinite(Number(summary.quantity))) cells.push(['כמות כוללת', dashboardNumber(summary.quantity, 2)]);
  if (Number.isFinite(Number(summary.ledger_weight_kg))) cells.push(['משקל מדווח', formatDrillKg(summary.ledger_weight_kg)]);
  else if (Number.isFinite(Number(summary.displayed_weight_kg))) cells.push(['משקל', formatDrillKg(summary.displayed_weight_kg)]);
  if (Number.isFinite(Number(summary.actual_waste))) cells.push(['פחת בפועל', dashboardNumber(summary.actual_waste, 2)]);
  if (Number.isFinite(Number(summary.unweighed_completed_items)) && summary.unweighed_completed_items > 0) cells.push(['ללא משקל', dashboardNumber(summary.unweighed_completed_items, 0)]);
  return cells.slice(0, 4).map(([label, value]) => `<div class="drill-summary-cell"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong></div>`).join('');
}

function cardDrillHtml(card, { detail = false } = {}) {
  const title = `${card.shape_name || 'פריט ייצור'}${card.diameter_mm ? ` · Ø${dashboardNumber(card.diameter_mm, 1)}` : ''}`;
  const quantity = Number.isFinite(Number(card.quantity)) ? `כמות ${dashboardNumber(card.quantity, 2)}` : 'כמות לא זמינה';
  const produced = Number(card.produced_quantity || 0);
  const production = produced > 0 ? `יוצר ${dashboardNumber(produced, 2)}` : (card.status || 'ללא מצב');
  const weight = Number.isFinite(Number(card.display_weight_kg)) ? formatDrillKg(card.display_weight_kg) : 'ללא משקל זמין';
  const source = drillWeightSourceLabel(card.weight_source);
  const length = Number.isFinite(Number(card.total_length_mm)) && Number(card.total_length_mm) > 0 ? `אורך ליחידה ${IronBendDisplayUnits.formatLengthCmFromMm(card.total_length_mm)}` : 'אורך לא זמין';
  const order = card.order_num ? `הזמנה ${card.order_num}` : 'ללא הזמנה';
  const geometry = Array.isArray(card.geometry) && card.geometry.length
    ? card.geometry.map((segment, index) => `צלע ${index + 1}: ${Number.isFinite(Number(segment.length_mm)) ? IronBendDisplayUnits.formatLengthCmFromMm(segment.length_mm) : '—'}${Number.isFinite(Number(segment.angle_deg)) ? ` · ${dashboardNumber(segment.angle_deg, 1)}°` : ''}`).join(' | ')
    : '';
  if (!detail) {
    return `<button class="drill-entry" type="button" data-dashboard-drill-entry="${Number(card.item_id)}"><span class="drill-entry-main"><span class="drill-entry-title">${escHtml(title)} <span class="status-badge ${statusBadgeClass(card.status)}">${escHtml(card.status || '—')}</span></span><span class="drill-entry-sub">${escHtml(order)} · ${escHtml(quantity)} · ${escHtml(production)}</span><span class="drill-entry-meta"><span class="drill-data-pill">${escHtml(length)}</span><span class="drill-data-pill">${escHtml(weight)} · ${escHtml(source)}</span></span></span><span class="drill-entry-arrow" aria-hidden="true">‹</span></button>`;
  }
  return `<article class="drill-card-detail"><h3>${escHtml(title)}</h3><div class="drill-detail-grid"><div><span>הזמנה</span><strong>${escHtml(order)}</strong></div><div><span>מצב</span><strong>${escHtml(card.status || '—')}</strong></div><div><span>כמות</span><strong>${escHtml(quantity)}</strong></div><div><span>אורך ליחידה</span><strong>${escHtml(length)}</strong></div><div><span>משקל מוצג</span><strong>${escHtml(weight)}</strong></div><div><span>מקור משקל</span><strong>${escHtml(source)}</strong></div>${Number.isFinite(Number(card.theoretical_weight_kg)) ? `<div><span>משקל תאורטי</span><strong>${escHtml(formatKg(card.theoretical_weight_kg))}</strong></div>` : ''}${Number.isFinite(Number(card.actual_waste)) && card.actual_waste > 0 ? `<div><span>פחת בפועל</span><strong>${escHtml(dashboardNumber(card.actual_waste, 2))}</strong></div>` : ''}</div>${geometry ? `<p class="drill-geometry"><strong>גאומטריה שמורה:</strong> ${escHtml(geometry)}</p>` : ''}${card.order_url ? `<a class="drill-order-link" href="${escHtml(card.order_url)}">פתח הזמנה מלאה</a>` : ''}</article>`;
}

function orderDrillHtml(order) {
  const title = `הזמנה ${order.order_num || `#${order.order_id}`}`;
  const customer = order.customer_name || 'לקוח לא מזוהה';
  const weight = Number.isFinite(Number(order.display_weight_kg)) ? formatDrillKg(order.display_weight_kg) : 'ללא משקל זמין';
  return `<button class="drill-entry" type="button" data-dashboard-drill-entry="${Number(order.order_id)}"><span class="drill-entry-main"><span class="drill-entry-title">${escHtml(title)} <span class="status-badge ${statusBadgeClass(order.status)}">${escHtml(order.status || '—')}</span></span><span class="drill-entry-sub">${escHtml(customer)}${order.delivery_date ? ` · אספקה ${escHtml(order.delivery_date)}` : ''}</span><span class="drill-entry-meta"><span class="drill-data-pill">${escHtml(weight)}</span>${order.priority ? `<span class="drill-data-pill">${escHtml(order.priority)}</span>` : ''}</span></span><span class="drill-entry-arrow" aria-hidden="true">‹</span></button>`;
}

function renderDashboardDrilldown(data) {
  const overlay = document.getElementById('dashboardDrilldown');
  const list = document.getElementById('dashboardDrilldownList');
  setText('dashboardDrilldownTitle', data.title || 'פירוט נתון');
  setText('dashboardDrilldownSubtitle', data.subtitle || '');
  document.getElementById('dashboardDrilldownSummary').innerHTML = drillSummaryCells(data.summary || '');
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    list.innerHTML = '<div class="muted-state">אין כרגע רשומות להצגה.</div>';
  } else if (data.metric === 'card') {
    list.innerHTML = entries.map(card => cardDrillHtml(card, { detail: true })).join('');
  } else {
    list.innerHTML = entries.map(entry => entry.kind === 'order' ? orderDrillHtml(entry) : cardDrillHtml(entry)).join('');
  }
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  document.querySelector('[data-dashboard-drilldown-close]')?.focus();
}

function closeDashboardDrilldown() {
  const overlay = document.getElementById('dashboardDrilldown');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  dashboardDrilldownData = null;
  dashboardDrilldownTrigger?.focus?.();
  dashboardDrilldownTrigger = null;
}

async function openDashboardDrilldown(metric, params = {}, trigger = null) {
  const overlay = document.getElementById('dashboardDrilldown');
  const list = document.getElementById('dashboardDrilldownList');
  if (!overlay || !list) return;
  dashboardDrilldownTrigger = trigger;
  const requestId = ++dashboardDrilldownRequest;
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  setText('dashboardDrilldownTitle', 'טוען פירוט…');
  setText('dashboardDrilldownSubtitle', 'הנתונים נמשכים ממקור המידע של המדד.');
  document.getElementById('dashboardDrilldownSummary').innerHTML = '';
  list.innerHTML = '<div class="muted-state">טוען רשומות…</div>';
  const query = new URLSearchParams({ metric });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  });
  try {
    const response = await fetch(`/api/dashboard/drilldown?${query.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (requestId !== dashboardDrilldownRequest) return;
    if (!response.ok) throw new Error(data.user_message || data.error || 'dashboard_drilldown_failed');
    dashboardDrilldownData = data;
    renderDashboardDrilldown(data);
  } catch (error) {
    if (requestId !== dashboardDrilldownRequest) return;
    setText('dashboardDrilldownTitle', 'לא ניתן להציג פירוט');
    setText('dashboardDrilldownSubtitle', 'לא בוצע שינוי בנתונים. נסה שוב או פנה למנהל המערכת.');
    list.innerHTML = `<div class="muted-state">${escHtml(error.message || 'שגיאה בטעינת הפירוט')}</div>`;
  }
}

document.addEventListener('click', event => {
  const closeButton = event.target.closest('[data-dashboard-drilldown-close]');
  if (closeButton) { closeDashboardDrilldown(); return; }
  const trigger = event.target.closest('[data-dashboard-drilldown]');
  if (trigger) {
    event.preventDefault();
    openDashboardDrilldown(trigger.dataset.dashboardDrilldown, {
      order_id: trigger.dataset.dashboardOrderId,
      item_id: trigger.dataset.dashboardItemId,
      diameter: trigger.dataset.dashboardDiameter,
    }, trigger);
    return;
  }
  const entryButton = event.target.closest('[data-dashboard-drill-entry]');
  if (entryButton && dashboardDrilldownData) {
    const id = Number(entryButton.dataset.dashboardDrillEntry);
    const entry = (dashboardDrilldownData.entries || []).find(candidate => Number(candidate.kind === 'order' ? candidate.order_id : candidate.item_id) === id);
    if (entry) openDashboardDrilldown(entry.kind === 'order' ? 'order' : 'card', entry.kind === 'order' ? { order_id: entry.order_id } : { item_id: entry.item_id }, entryButton);
    return;
  }
  if (event.target.id === 'dashboardDrilldown') closeDashboardDrilldown();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDashboardDrilldown(); });

function bootDashboard() {
  updateTime();
  applyDataContractBadges();
  connectWS();
  fetchDashboard();
  setInterval(updateTime, 1000);
  setInterval(fetchDashboard, 15000);
  setInterval(fetchInventoryForecast, 120000);
}
bootDashboard();
