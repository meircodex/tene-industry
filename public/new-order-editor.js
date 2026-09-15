(function () {
  if (window.NewOrderEditor && window.NewOrderEditor.installed) return;

  const TITLES = { customer: 'לקוח', site: 'אתר', delivery: 'אספקה', source: 'מקור / OCR' };
  const NEW_ORDER_DRAFTS_KEY = 'ironbend:new-order:drafts:v2';
  const LEGACY_ORDER_DRAFT_KEY = 'ironbend:new-order:draft:v1';
  const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const DRAFT_AUTOSAVE_MS = 2000;
  const MAX_LOCAL_DRAFTS = 20;
  let currentDraftId = null;
  let draftAutosaveTimer = null;
  let draftStatusTimer = null;
  let isRestoringDraft = false;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function formatKg(value) { const n = Number(value || 0); return (Number.isFinite(n) ? n : 0).toLocaleString('he-IL', { maximumFractionDigits: 1 }) + ' ק"ג'; }
  function setTextSafe(id, value) { const el = document.getElementById(id); if (el) el.textContent = value == null ? '' : String(value); }
  function shortDate(value) { const d = new Date(String(value || '') + 'T00:00:00'); return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit' }); }
  function normalizePanel(type) { return ['customer','site','delivery','source'].includes(type) ? type : ''; }
  function numeric(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function formatCm(value) { const n = numeric(value, 0); return n > 0 ? (n / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' \u05e1\u05f4\u05de' : '-'; }
  function formatMeters(value) { const n = numeric(value, 0); return n > 0 ? (n / 1000).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' \u05de\u05f3' : '-'; }
  function jsArg(value) { const n = Number(value); return Number.isFinite(n) && String(value).trim() !== '' ? String(n) : JSON.stringify(String(value)); }
  function orderLinesGridGuidesHtml() { return '<div class="order-lines-grid-guides" aria-hidden="true">' + '<span></span>'.repeat(9) + '</div>'; }

  function setupOrderLinesTable() {
    const container = document.getElementById('palletsContainer');
    if (!container) return;
    container.classList.add('order-lines-body');
    if (container.closest('.order-lines-table')) return;
    const table = document.createElement('div');
    table.className = 'order-lines-table';
    const head = document.createElement('div');
    head.className = 'order-lines-head';
    head.innerHTML = '<span>\u05de\u05e1\u05f3</span><span>\u05d0\u05dc\u05de\u05e0\u05d8</span><span>\u05e6\u05d5\u05e8\u05d4 \u05d5\u05de\u05d9\u05d3\u05d5\u05ea</span><span>\u05e7\u05d5\u05d8\u05e8 <small style="opacity:.7;font-weight:800">\u05de\u05f4\u05de</small></span><span>\u05db\u05de\u05d5\u05ea</span><span class="desktop-only-cell">\u05d0\u05d5\u05e8\u05da <small style="opacity:.7;font-weight:800">\u05e1\u05f4\u05de</small></span><span class="desktop-only-cell">\u05e1\u05d4\u05f4\u05db <small style="opacity:.7;font-weight:800">\u05de\u05f3</small></span><span>\u05de\u05e9\u05e7\u05dc</span><span></span>';
    container.parentNode.insertBefore(table, container);
    table.append(container);
    container.prepend(head);
    container.insertAdjacentHTML('beforeend', orderLinesGridGuidesHtml());
  }
  function injectKbdEntryStyles() {
    if (document.getElementById('kbd-entry-styles')) return;
    const style = document.createElement('style');
    style.id = 'kbd-entry-styles';
    style.textContent =
      'body[data-page="new"] .line-len-cm{width:100%!important;max-width:76px!important;height:30px!important;' +
      'border:1.5px solid #d0dcea!important;border-radius:7px!important;text-align:center!important;' +
      'font-weight:900!important;font-size:13px!important;font-family:inherit!important;color:var(--text,#0f234b)!important;' +
      'background:#f7fafd!important;padding:0 4px!important;box-sizing:border-box!important;direction:ltr!important}' +
      'body[data-page="new"] .line-len-cm::placeholder{color:#aebfce!important;font-weight:700!important;font-size:11px!important}' +
      'body[data-page="new"] .line-len-cm:focus{outline:none!important;border-color:#4a90d9!important;background:#fff!important;box-shadow:0 0 0 2px rgba(74,144,217,.18)!important}' +
      'body[data-page="new"] .line-diameter-select:focus,body[data-page="new"] .line-qty:focus{box-shadow:0 0 0 2px rgba(74,144,217,.18)!important}';
    document.head.appendChild(style);
  }
  function setupDom() {
    injectKbdEntryStyles();
    const main = document.querySelector('body[data-page="new"] .main');
    if (main) main.classList.add('order-min-page');
    document.querySelector('.order-pro-header')?.classList.add('order-min-header');
    document.querySelector('.order-pro-title')?.classList.add('order-min-title');
    document.querySelector('.order-pro-actions')?.classList.add('order-min-actions');
    document.querySelector('.order-pro-kicker')?.remove();
    document.querySelector('.order-more-action')?.remove();
    document.querySelector('.order-pro-context')?.classList.add('order-min-context');
    wireContextChip('noCustomerContextCard', 'customer');
    wireContextChip('noSiteContextCard', 'site');
    wireContextChip('noDeliveryContextCard', 'delivery');
    wireContextChip('noSourceContextCard', 'source');
    document.querySelector('.order-pro-editor')?.classList.add('order-min-editor');
    const items = document.getElementById('items-section');
    if (items) {
      items.classList.add('order-min-items');
      const h = items.querySelector('.items-header h2'); if (h) h.textContent = 'פרטי ההזמנה';
      const p = items.querySelector('.items-header p'); if (p) p.textContent = 'צורות, כמויות ומשקל';
    }
    document.querySelectorAll('.secondary-import-shape, [data-open-intake]').forEach(importBtn => {
      importBtn.classList.add('secondary-import');
      importBtn.setAttribute('type', 'button');
      importBtn.dataset.quickImport = '1';
      importBtn.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        openQuickOrderImport();
      };
    });
    ensureQuickOrderImportInput();
    const inspector = document.querySelector('.order-pro-inspector');
    if (inspector) {
      inspector.classList.add('order-min-inspector');
      inspector.id = 'orderInspector';
      if (!document.getElementById('inspectorEditHost')) {
        const host = document.createElement('div');
        host.id = 'inspectorEditHost';
        host.className = 'inspector-edit-shell';
        host.hidden = true;
        inspector.prepend(host);
      }
    }
    document.getElementById('orderSetupDrawer')?.classList.add('order-legacy-setup-store');
    document.querySelector('.summary-bar > .submit-btn')?.remove();
    document.querySelector('.no-bottom-actions')?.remove();
    ensureDraftsUi();
  }

  function wireContextChip(id, panel) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.dataset.context = panel;
    btn.onclick = () => minToggleInspectorPanel(panel);
    btn.querySelector('em')?.remove();
  }

  function panelElementFor(type) {
    const panel = normalizePanel(type);
    if (panel === 'customer') return document.getElementById('customer-section');
    if (panel === 'site' || panel === 'delivery') return document.getElementById('delivery-section');
    if (panel === 'source') return document.getElementById('order-import-section-anchor');
    return null;
  }

  function returnSetupPanelsToStore() {
    const store = document.getElementById('orderSetupDrawer');
    document.querySelectorAll('[data-setup-panel]').forEach(panel => {
      panel.hidden = true;
      panel.classList.remove('is-active', 'is-open', 'is-inspector-panel');
      panel.style.setProperty('display', 'none', 'important');
      const details = panel.querySelector('details'); if (details) details.open = false;
      if (store && panel.parentElement !== store) store.appendChild(panel);
    });
  }

  function renderMovedPanel(host, type) {
    const panel = panelElementFor(type);
    if (!panel) return;
    panel.hidden = false;
    panel.classList.add('is-active', 'is-open', 'is-inspector-panel');
    panel.style.setProperty('display', 'block', 'important');
    const details = panel.querySelector('details'); if (details) details.open = true;
    host.appendChild(panel);
  }

  function minRenderCustomerInspector(host) { renderMovedPanel(host, 'customer'); }
  function minRenderDeliveryInspector(host, type = 'delivery') { renderMovedPanel(host, type); }
  function minRenderSourceInspector(host) { renderMovedPanel(host, 'source'); }

  function minRenderDefaultInspector() {
    const host = document.getElementById('inspectorEditHost');
    const summary = document.getElementById('summary-section');
    const inventory = document.getElementById('liveInventoryPanel');
    returnSetupPanelsToStore();
    if (host) { host.hidden = true; host.replaceChildren(); }
    if (summary) summary.style.removeProperty('display');
    if (inventory) inventory.style.removeProperty('display');
    minRenderOrderSummary(); minRenderInventorySummary(); minRenderPricingSummary();
  }

  function minRenderInspector(activePanel = '') {
    const inspector = document.getElementById('orderInspector');
    const host = document.getElementById('inspectorEditHost');
    const panel = normalizePanel(activePanel);
    if (!inspector || !host) return;
    inspector.dataset.activePanel = panel;
    document.querySelectorAll('.context-chip').forEach(btn => btn.classList.toggle('is-active', btn.dataset.context === panel));
    if (!panel) { minRenderDefaultInspector(); return; }
    document.getElementById('summary-section')?.style.setProperty('display', 'none', 'important');
    document.getElementById('liveInventoryPanel')?.style.setProperty('display', 'none', 'important');
    returnSetupPanelsToStore();
    host.hidden = false;
    host.replaceChildren();
    const head = document.createElement('div');
    head.className = 'inspector-head';
    head.innerHTML = '<h2>' + escapeHtml(TITLES[panel] || 'פרטי הזמנה') + '</h2><button type="button" class="inspector-close">סגור</button>';
    head.querySelector('button').addEventListener('click', minCloseInspectorPanel);
    const body = document.createElement('div');
    body.className = 'inspector-body';
    host.append(head, body);
    if (panel === 'customer') minRenderCustomerInspector(body);
    else if (panel === 'source') minRenderSourceInspector(body);
    else minRenderDeliveryInspector(body, panel);
  }

  function minToggleInspectorPanel(type) {
    const inspector = document.getElementById('orderInspector');
    const next = normalizePanel(type);
    minRenderInspector((inspector?.dataset.activePanel || '') === next ? '' : next);
  }
  function minCloseInspectorPanel() { minRenderInspector(''); }

  function minEnsureDefaultPallet() {
    if (!Array.isArray(pallets)) pallets = [];
    if (!pallets.length) pallets.push({ id: Date.now(), maxWeight: 500, items: [] });
    const pallet = pallets[0];
    if (pallet && !pallet.items.length) {
      pallet.items.push({ id: Date.now(), shapeId: null, shapeEmoji: null, shapeName: '', shapeSides: [], shapeAngles: [], diameter: 0, length: 0, qty: 0, note: '', raw_material_id: 'auto' });
    }
    return pallet;
  }

  function minAddShapeNow(family = 'bar') {
    const pallet = minEnsureDefaultPallet();
    if (!pallet || typeof window.addItem !== 'function') return;
    window.addItem(pallet.id);
  }

  let intakeDraftRows = [];

  function showQuickImportMessage(message) {
    if (typeof window.showToast === 'function' && document.getElementById('ib-toast')) {
      window.showToast(message);
      return;
    }
    let toast = document.getElementById('_toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = '_toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;max-width:min(520px,calc(100vw - 24px));padding:11px 18px;border-radius:10px;background:#1f2937;color:#fff;font-family:Heebo,Arial,sans-serif;font-weight:800;font-size:14px;direction:rtl;text-align:center;box-shadow:0 12px 30px rgba(15,23,42,.22);transition:opacity .25s;opacity:0';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3800);
  }

  function readJsonStorage(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }

  function writeJsonStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function draftTime(value) {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) && time > 0 ? time : 0;
  }

  function createDraftId() {
    return 'draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getCurrentDraftOwner() {
    const user = window.IronBendAuth?.currentUser?.() || window.IronBendAuth?.user || null;
    const owner = user?.id || user?.sub || user?.username || user?.name || user?.role || '';
    return owner ? String(owner) : '';
  }

  function getDraftStore() {
    const raw = readJsonStorage(NEW_ORDER_DRAFTS_KEY, {});
    const store = {
      version: 2,
      activeDraftId: raw?.activeDraftId || '',
      drafts: Array.isArray(raw?.drafts) ? raw.drafts : [],
    };
    const now = Date.now();
    store.drafts = store.drafts
      .filter(draft => draft && draft.status !== 'deleted')
      .filter(draft => draft.status === 'submittedOffline' || now - draftTime(draft.updatedAt || draft.createdAt) <= DRAFT_TTL_MS)
      .sort((a, b) => draftTime(b.updatedAt || b.createdAt) - draftTime(a.updatedAt || a.createdAt))
      .slice(0, MAX_LOCAL_DRAFTS);

    const legacy = readJsonStorage(LEGACY_ORDER_DRAFT_KEY, null);
    const legacySavedAt = legacy?.savedAt || '';
    const hasLegacyEquivalent = store.drafts.some(draft =>
      draft.legacyKey === LEGACY_ORDER_DRAFT_KEY ||
      (legacySavedAt && draft.payload?.savedAt === legacySavedAt)
    );
    if (legacy && isMeaningfulOrderDraft(legacy) && !hasLegacyEquivalent) {
      const legacyId = 'legacy_' + (draftTime(legacy.savedAt) || Date.now());
      store.drafts.unshift(buildDraftRecord(legacy, {
        draftId: legacyId,
        createdAt: legacy.savedAt || new Date().toISOString(),
        updatedAt: legacy.savedAt || new Date().toISOString(),
        legacyKey: LEGACY_ORDER_DRAFT_KEY,
      }));
    }
    return store;
  }

  function saveDraftStore(store) {
    const normalized = {
      version: 2,
      activeDraftId: store?.activeDraftId || '',
      drafts: (Array.isArray(store?.drafts) ? store.drafts : [])
        .filter(draft => draft && draft.status !== 'deleted')
        .sort((a, b) => draftTime(b.updatedAt || b.createdAt) - draftTime(a.updatedAt || a.createdAt))
        .slice(0, MAX_LOCAL_DRAFTS),
    };
    writeJsonStorage(NEW_ORDER_DRAFTS_KEY, normalized);
    return normalized;
  }

  function visibleDrafts() {
    return getDraftStore().drafts.filter(draft => draft.status === 'active');
  }

  function draftItemCount(payload = {}) {
    return (payload.pallets || []).reduce((sum, pallet) => sum + ((pallet.items || []).length), 0);
  }

  function draftEstimatedWeight(payload = {}) {
    let total = 0;
    (payload.pallets || []).forEach(pallet => (pallet.items || []).forEach(item => {
      if (typeof window.calcItemWeight === 'function') {
        try { total += Number(window.calcItemWeight(item)) || 0; } catch {}
      } else {
        total += Number(item.totalWeight || item.total_weight || item.weight || 0) || 0;
      }
    }));
    return total;
  }

  function draftItems(payload = {}) {
    return (payload.pallets || []).flatMap(pallet => Array.isArray(pallet?.items) ? pallet.items : []);
  }

  function firstNonEmpty(values = []) {
    return values.map(value => String(value || '').trim()).find(Boolean) || '';
  }

  function firstUnique(values = [], limit = 2) {
    const seen = new Set();
    return values
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .filter(value => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  function isMeaningfulOrderDraft(draft = {}) {
    const customer = draft.customer || {};
    const delivery = draft.delivery || {};
    const hasItems = draftItemCount(draft) > 0;
    return Boolean(
      String(customer.name || customer.phone || customer.id || '').trim() ||
      String(delivery.siteName || delivery.siteId || delivery.address || '').trim() ||
      String(draft.notes || delivery.driverNotes || '').trim() ||
      hasItems
    );
  }

  function buildDraftSummary(payload = {}) {
    const customer = payload.customer || {};
    const delivery = payload.delivery || {};
    const items = draftItems(payload);
    const itemsCount = draftItemCount(payload);
    const estimatedWeightKg = draftEstimatedWeight(payload);
    const siteOrAddress = firstNonEmpty([delivery.siteName, delivery.address]) || 'ללא אתר';
    const elementNames = firstUnique(items.map(item => firstNonEmpty([
      item?.structElement,
      item?.struct_element,
      item?.elementName,
      item?.element_name,
      item?.element,
    ])));
    const shapeNames = firstUnique(items.map(item => firstNonEmpty([
      item?.shapeName,
      item?.shape_name,
      item?.name,
    ])));
    return {
      customerName: String(customer.name || '').trim(),
      siteName: String(delivery.siteName || '').trim(),
      siteOrAddress,
      deliveryDate: String(delivery.date || '').trim(),
      itemsCount,
      estimatedWeightKg,
      elementNames,
      shapeNames,
    };
  }

  function buildDraftTitle(summary = {}) {
    const parts = [
      summary.customerName || 'טיוטה ללא לקוח',
      summary.siteOrAddress || summary.siteName || '',
      summary.itemsCount ? summary.itemsCount + ' פריטים' : '',
    ].filter(Boolean);
    return parts.join(' / ') || 'טיוטת הזמנה';
  }

  function buildDraftRecord(payload = {}, meta = {}) {
    const now = new Date().toISOString();
    const summary = buildDraftSummary(payload);
    return {
      draftId: meta.draftId || createDraftId(),
      title: buildDraftTitle(summary),
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
      draftOwner: meta.draftOwner ?? getCurrentDraftOwner(),
      summary,
      payload,
      status: meta.status || 'active',
      legacyKey: meta.legacyKey || '',
    };
  }

  function setDraftStatus(text) {
    const label = document.getElementById('draftStateLabel');
    if (label) label.textContent = text;
    const mini = document.getElementById('orderDraftAutosaveState');
    if (mini) mini.textContent = text;
  }

  function updateDraftsButton() {
    const count = visibleDrafts().length;
    const countEl = document.getElementById('orderDraftsCount');
    if (countEl) {
      countEl.textContent = String(count);
      countEl.hidden = count <= 0;
    }
    const btn = document.getElementById('orderDraftsButton');
    if (btn) btn.setAttribute('aria-label', count ? 'טיוטות: ' + count : 'טיוטות');
  }

  function relativeDraftTime(value) {
    const diff = Math.max(0, Date.now() - draftTime(value));
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'עודכן עכשיו';
    if (minutes < 60) return 'עודכן לפני ' + minutes + ' דק׳';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return 'עודכן לפני ' + hours + ' שע׳';
    const days = Math.floor(hours / 24);
    return 'עודכן לפני ' + days + ' ימים';
  }

  function draftNameLine(summary = {}) {
    const names = Array.isArray(summary.elementNames) && summary.elementNames.length
      ? summary.elementNames
      : (Array.isArray(summary.shapeNames) ? summary.shapeNames : []);
    return names.filter(Boolean).slice(0, 2).join(', ');
  }

  function draftDisplaySummary(draft = {}) {
    return {
      ...buildDraftSummary(draft.payload || {}),
      ...(draft.summary || {}),
    };
  }

  function draftPrimaryLine(summary = {}) {
    return [
      summary.customerName || 'טיוטה ללא לקוח',
      summary.siteOrAddress || summary.siteName || 'ללא אתר',
    ].filter(Boolean).join(' / ');
  }

  function draftMetaLine(summary = {}) {
    return [
      summary.deliveryDate ? shortDate(summary.deliveryDate) : '',
      (summary.itemsCount || 0) + ' פריטים',
      formatKg(summary.estimatedWeightKg || 0),
    ].filter(Boolean).join(' · ');
  }

  function updateDraftRestoreBannerContent() {
    const banner = document.getElementById('orderDraftRestoreBanner');
    if (!banner) return;
    const draft = visibleDrafts()[0];
    const summary = draft ? draftDisplaySummary(draft) : {};
    const relative = draft ? relativeDraftTime(draft.updatedAt) : '';
    const nameLine = draftNameLine(summary);
    const detail = draft ? [
      draftPrimaryLine(summary),
      draftMetaLine(summary),
      relative,
    ].filter(Boolean).join(' · ') : 'נמצאו טיוטות שלא נשמרו';
    const info = banner.querySelector('.order-drafts-banner-info');
    if (info) {
      info.innerHTML = `
        <strong>נמצאה טיוטה</strong>
        <span>${escapeHtml(detail)}</span>
        ${nameLine ? `<small>${escapeHtml(nameLine)}</small>` : ''}
      `;
    }
  }

  function ensureDraftsUi() {
    const header = document.querySelector('body[data-page="new"] .order-min-header, body[data-page="new"] .order-pro-header');
    if (!header || document.getElementById('orderDraftsButton')) return;
    header.classList.add('order-drafts-anchor');
    const actions = header.querySelector('.order-min-actions, .order-pro-actions') || header;
    const wrap = document.createElement('div');
    wrap.className = 'order-drafts-ui';
    wrap.innerHTML = `
      <button type="button" id="orderDraftsButton" class="order-drafts-button" aria-expanded="false">
        <span>טיוטות</span><b id="orderDraftsCount" hidden>0</b>
      </button>
      <span id="orderDraftAutosaveState" class="order-drafts-save-state">טיוטה לא נשמרה</span>
      <div id="orderDraftsPopover" class="order-drafts-popover" hidden></div>
    `;
    actions.prepend(wrap);
    document.getElementById('orderDraftsButton')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const popover = document.getElementById('orderDraftsPopover');
      if (popover && !popover.hidden) closeDraftsPopover();
      else openDraftsPopover();
    });
    ensureDraftRestoreBanner();
    updateDraftsButton();
  }

  function ensureDraftRestoreBanner() {
    const main = document.querySelector('body[data-page="new"] .main');
    const existing = document.getElementById('orderDraftRestoreBanner');
    if (existing) return existing;
    if (!main) return null;
    const banner = document.createElement('section');
    banner.id = 'orderDraftRestoreBanner';
    banner.className = 'order-drafts-banner';
    banner.hidden = true;
    banner.innerHTML = `
      <div class="order-drafts-banner-info">
        <strong>נמצאה טיוטה</strong>
        <span>נמצאו טיוטות שלא נשמרו</span>
      </div>
      <div class="order-drafts-banner-actions">
        <button type="button" data-draft-action="continue-last">המשך האחרונה</button>
        <button type="button" data-draft-action="open-list">פתח רשימה</button>
        <button type="button" data-draft-action="dismiss">התעלם</button>
      </div>
    `;
    const context = main.querySelector('.order-min-context, .order-pro-context');
    if (context) main.insertBefore(banner, context.nextSibling);
    else main.prepend(banner);
    banner.addEventListener('click', event => {
      const action = event.target.closest('[data-draft-action]')?.dataset.draftAction;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'continue-last') continueDraft(visibleDrafts()[0]?.draftId);
      if (action === 'open-list') openDraftsPopover();
      if (action === 'dismiss') hideDraftRestoreBanner();
    });
    return banner;
  }

  function showDraftRestoreBanner() {
    ensureDraftsUi();
    const banner = ensureDraftRestoreBanner();
    if (!banner) return;
    banner.hidden = visibleDrafts().length === 0;
    updateDraftRestoreBannerContent();
  }

  function hideDraftRestoreBanner() {
    const banner = document.getElementById('orderDraftRestoreBanner');
    if (banner) banner.hidden = true;
  }

  function renderDraftsPopover() {
    const popover = document.getElementById('orderDraftsPopover');
    if (!popover) return;
    const drafts = visibleDrafts();
    if (!drafts.length) {
      popover.innerHTML = '<div class="order-drafts-empty">אין טיוטות שמורות.</div>';
      return;
    }
    popover.innerHTML = `
      <div class="order-drafts-head">
        <strong>טיוטות הזמנה</strong>
        <button type="button" class="order-drafts-close" onclick="closeDraftsPopover()">×</button>
      </div>
      <div class="order-drafts-list">
        ${drafts.map(draft => {
          const s = draftDisplaySummary(draft);
          const nameLine = draftNameLine(s);
          return `
            <article class="order-draft-row" data-draft-id="${escapeHtml(draft.draftId)}">
              <div class="order-draft-main">
                <strong>${escapeHtml(draftPrimaryLine(s))}</strong>
                <span>${escapeHtml(draftMetaLine(s))}</span>
                ${nameLine ? `<em>${escapeHtml(nameLine)}</em>` : ''}
                <small>${escapeHtml(relativeDraftTime(draft.updatedAt))}</small>
              </div>
              <div class="order-draft-actions">
                <button type="button" onclick="continueDraft('${escapeHtml(draft.draftId)}')">המשך</button>
                <button type="button" class="danger" onclick="deleteDraft('${escapeHtml(draft.draftId)}')">מחק</button>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;
  }

  function openDraftsPopover() {
    ensureDraftsUi();
    renderDraftsPopover();
    const popover = document.getElementById('orderDraftsPopover');
    const btn = document.getElementById('orderDraftsButton');
    if (popover) popover.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function closeDraftsPopover() {
    const popover = document.getElementById('orderDraftsPopover');
    const btn = document.getElementById('orderDraftsButton');
    if (popover) popover.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function restoreDraftPayload(payload = {}) {
    isRestoringDraft = true;
    try {
      localStorage.setItem(LEGACY_ORDER_DRAFT_KEY, JSON.stringify(payload));
      if (typeof window.restoreOrderDraft === 'function') window.restoreOrderDraft();
      else if (Array.isArray(payload.pallets)) { pallets = payload.pallets; minRenderPallets(); }
    } finally {
      setTimeout(() => { isRestoringDraft = false; }, 600);
    }
  }

  function continueDraft(draftId) {
    const store = getDraftStore();
    const draft = store.drafts.find(row => row.draftId === draftId);
    if (!draft) return;
    currentDraftId = draft.draftId;
    store.activeDraftId = draft.draftId;
    saveDraftStore(store);
    restoreDraftPayload(draft.payload || {});
    hideDraftRestoreBanner();
    closeDraftsPopover();
    setDraftStatus('טיוטה שוחזרה');
    updateDraftsButton();
  }

  function deleteDraft(draftId) {
    if (!draftId) return;
    if (!confirm('למחוק את הטיוטה?')) return;
    const store = getDraftStore();
    store.drafts = store.drafts.filter(draft => draft.draftId !== draftId);
    if (store.activeDraftId === draftId) store.activeDraftId = '';
    if (currentDraftId === draftId) currentDraftId = null;
    saveDraftStore(store);
    updateDraftsButton();
    renderDraftsPopover();
    if (!visibleDrafts().length) hideDraftRestoreBanner();
  }

  function deleteAllSubmittedOrExpiredDrafts() {
    const store = getDraftStore();
    const now = Date.now();
    store.drafts = store.drafts.filter(draft => {
      if (draft.status === 'submitted' || draft.status === 'deleted') return false;
      return now - draftTime(draft.updatedAt || draft.createdAt) <= DRAFT_TTL_MS;
    });
    saveDraftStore(store);
    updateDraftsButton();
  }

  function removeActiveDraft({ submittedOffline = false } = {}) {
    if (!currentDraftId) return;
    const store = getDraftStore();
    if (submittedOffline) {
      store.drafts = store.drafts.map(draft => draft.draftId === currentDraftId ? { ...draft, status: 'submittedOffline', updatedAt: new Date().toISOString() } : draft);
    } else {
      store.drafts = store.drafts.filter(draft => draft.draftId !== currentDraftId);
    }
    if (store.activeDraftId === currentDraftId) store.activeDraftId = '';
    currentDraftId = null;
    saveDraftStore(store);
    try { localStorage.removeItem(LEGACY_ORDER_DRAFT_KEY); } catch {}
    updateDraftsButton();
  }

  function captureCurrentDraftRecord() {
    if (typeof window.captureOrderDraft !== 'function') return null;
    const payload = window.captureOrderDraft();
    if (!isMeaningfulOrderDraft(payload)) return null;
    return buildDraftRecord(payload, { draftId: currentDraftId || createDraftId() });
  }

  function saveActiveDraftNow(options = {}) {
    if (isRestoringDraft) return null;
    const record = captureCurrentDraftRecord();
    if (!record) {
      if (!options.silent) setDraftStatus('אין טיוטה לשמירה');
      return null;
    }
    const store = getDraftStore();
    const existing = currentDraftId ? store.drafts.find(draft => draft.draftId === currentDraftId) : null;
    record.draftId = existing?.draftId || currentDraftId || record.draftId;
    record.createdAt = existing?.createdAt || record.createdAt;
    record.legacyKey = existing?.legacyKey || '';
    currentDraftId = record.draftId;
    store.activeDraftId = record.draftId;
    store.drafts = [record, ...store.drafts.filter(draft => draft.draftId !== record.draftId && draft.legacyKey !== LEGACY_ORDER_DRAFT_KEY)];
    saveDraftStore(store);
    try { localStorage.setItem(LEGACY_ORDER_DRAFT_KEY, JSON.stringify(record.payload)); } catch {}
    setDraftStatus(options.silent ? 'נשמר לפני רגע' : 'טיוטה נשמרה');
    clearTimeout(draftStatusTimer);
    draftStatusTimer = setTimeout(() => setDraftStatus('נשמר לפני רגע'), 1200);
    updateDraftsButton();
    hideDraftRestoreBanner();
    return record;
  }

  function scheduleDraftAutosave() {
    if (isRestoringDraft) return;
    clearTimeout(draftAutosaveTimer);
    const pending = typeof window.captureOrderDraft === 'function' ? window.captureOrderDraft() : null;
    if (!pending || !isMeaningfulOrderDraft(pending)) return;
    setDraftStatus('שומר...');
    draftAutosaveTimer = setTimeout(() => saveActiveDraftNow({ silent: true }), DRAFT_AUTOSAVE_MS);
  }

  function ensureQuickOrderImportInput() {
    let input = document.getElementById('quickOrderImportInput');
    if (input) return input;
    input = document.createElement('input');
    input.id = 'quickOrderImportInput';
    input.type = 'file';
    input.hidden = true;
    input.accept = 'image/*,.pdf,.csv,.txt';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) handleQuickOrderImportFile(file, input);
      else input.value = '';
    });
    document.body.appendChild(input);
    return input;
  }

  function openQuickOrderImport() {
    const input = ensureQuickOrderImportInput();
    input.value = '';
    input.click();
  }

  function isQuickCsvFile(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    return name.endsWith('.csv') || name.endsWith('.txt') || type.includes('csv') || type.includes('text/plain');
  }

  function handleQuickOrderImportFile(file, input) {
    if (!file) return;
    if (isQuickCsvFile(file)) {
      importQuickCsvFile(file, input);
      return;
    }
    importQuickOcrFile(file, input);
  }

  function openIntakePanel(mode = 'manual') {
    openQuickOrderImport();
  }

  function closeIntakePanel() {
    return undefined;
  }

  function setIntakeMode(mode = 'manual') {
    return undefined;
  }

  const STRUCT_ELEMENT_ALIASES = [
    'מיקום',
    'שם אלמנט',
    'שם האלמנט',
    'אלמנט',
    'מיקום אלמנט',
    'שייך ל',
    'struct_element',
    'structElement',
    'elementName',
    'element_name',
    'element',
    'location',
    'mark',
    'item_label',
    'itemLabel',
  ];

  function normalizeIntakeRow(row = {}) {
    return {
      elementName: String(rowValue(row, STRUCT_ELEMENT_ALIASES)).trim(),
      shape: String(row.shape || row.shapeName || row['צורה'] || 'מוט ישר').trim() || 'מוט ישר',
      diameter: numeric(row.diameter ?? row['קוטר'] ?? row.barDiameter ?? row.barDiameterMm, 0),
      quantity: numeric(row.quantity ?? row.qty ?? row['כמות'], 0),
      length: numeric(row.length ?? row.lengthMm ?? row['אורך'] ?? row['אורך בממ'] ?? row['אורך במ״מ'], 0),
      note: String(row.note || row.notes || row['הערה'] || '').trim(),
    };
  }

  function validateIntakeRow(row = {}) {
    const normalized = normalizeIntakeRow(row);
    const missing = [];
    if (!(normalized.diameter > 0)) missing.push('חסר קוטר');
    if (!(normalized.quantity > 0)) missing.push('חסרה כמות');
    if (!(normalized.length > 0)) missing.push('חסר אורך');
    return { ok: missing.length === 0, message: missing.join(', ') || 'תקין', row: normalized };
  }

  function parseDelimitedLine(line = '', delimiter = ',') {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === delimiter && !quoted) { out.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    out.push(current.trim());
    return out;
  }

  function detectDelimiter(line = '') {
    if (line.includes('\t')) return '\t';
    if (line.includes(';')) return ';';
    return ',';
  }

  function rowValue(row, names) {
    for (const name of names) {
      if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name];
    }
    return '';
  }

  function parseIntakeCsvText(text = '') {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return [];
    const delimiter = detectDelimiter(lines[0]);
    const headers = parseDelimitedLine(lines[0], delimiter).map(h => h.trim());
    return lines.slice(1).map(line => {
      const cells = parseDelimitedLine(line, delimiter);
      const raw = {};
      headers.forEach((header, index) => { raw[header] = cells[index] || ''; });
      return normalizeIntakeRow({
        elementName: rowValue(raw, STRUCT_ELEMENT_ALIASES),
        shape: rowValue(raw, ['צורה', 'shape', 'shapeName', 'shape_name']),
        diameter: rowValue(raw, ['קוטר', 'diameter', 'barDiameter', 'barDiameterMm']),
        quantity: rowValue(raw, ['כמות', 'quantity', 'qty']),
        length: rowValue(raw, ['אורך', 'אורך בממ', 'אורך במ״מ', 'length', 'lengthMm']),
        note: rowValue(raw, ['הערה', 'note', 'notes']),
      });
    });
  }

  function importQuickCsvFile(file, input) {
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseIntakeCsvText(reader.result || '');
      const added = addIntakeRowsToOrder(rows, { silentInvalid: true });
      if (added > 0) showQuickImportMessage(`${added} שורות נוספו להזמנה`);
      else showQuickImportMessage('CSV בסיסי יטופל בשלב הבא. אפשר להוסיף צורה ידנית.');
      if (input) input.value = '';
    };
    reader.onerror = () => {
      showQuickImportMessage('לא ניתן לקרוא את הקובץ. אפשר להשתמש ב+ הוסף צורה.');
      if (input) input.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  async function importQuickOcrFile(file, input) {
    const documentType = document.getElementById('ocrDocumentType')?.value || 'order';
    if (typeof window.routeNonOrderOcrDocument === 'function' && window.routeNonOrderOcrDocument(documentType)) {
      if (input) input.value = '';
      return;
    }
    try {
      if (typeof window.ensureOcrSession === 'function') {
        const hasSession = await window.ensureOcrSession();
        if (!hasSession) throw new Error('OCR_AUTH_REQUIRED');
      }
      const fd = new FormData();
      fd.append('image', file);
      fd.append('save_to_intake', 'true');
      fd.append('document_type_hint', documentType);
      const fetcher = window.IronBendAuth?.fetch ? window.IronBendAuth.fetch.bind(window.IronBendAuth) : fetch;
      const response = await fetcher('/api/analyze-image?save_to_intake=true', { method: 'POST', body: fd });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.code || data.error || 'OCR_FAILED');
      const items = data?.parsed?.items || data?.items || [];
      if (Array.isArray(items) && items.length) {
        const added = addIntakeRowsToOrder(items.map(item => normalizeIntakeRow(item)), { silentInvalid: true });
        showQuickImportMessage(added > 0 ? `${added} שורות נוספו להזמנה` : 'OCR הסתיים, אבל לא נמצאו שורות תקינות להוספה.');
        return;
      }
      const intakeId = data.intakeId || data.intake_id || data.id || null;
      if (intakeId && typeof window.intakeReviewUrl === 'function') {
        window.location.href = window.intakeReviewUrl(intakeId);
        return;
      }
      showQuickImportMessage('OCR הסתיים, אבל לא נמצאו שורות להוספה.');
    } catch (err) {
      const rawMessage = String(err?.message || err || '');
      const message = /quota|billing|OPENAI|Document recognition failed/i.test(rawMessage)
        ? 'OCR לא זמין כרגע. אפשר להשתמש ב+ הוסף צורה.'
        : typeof window.ocrErrorMessage === 'function'
          ? window.ocrErrorMessage(err)
          : 'OCR לא זמין כרגע. אפשר להשתמש ב+ הוסף צורה.';
      showQuickImportMessage(message || 'OCR לא זמין כרגע. אפשר להשתמש ב+ הוסף צורה.');
    } finally {
      if (input) input.value = '';
    }
  }

  function buildIntakeStraightSnapshot({ length, diameter, quantity }) {
    if (typeof window.buildStraightBarSnapshot === 'function') return window.buildStraightBarSnapshot({ length, diameter, qty: quantity });
    const unitWeight = window.IronBendRebar?.itemWeightKg ? window.IronBendRebar.itemWeightKg({ diameter, qty: 1, sides: [length], length }) : 0;
    const base = {
      shapeId: 'straight_bar',
      shapeType: 'straight_bar',
      family: 'bars',
      source: 'new_order_intake_panel',
      displayName: 'מוט ישר',
      data: { sides: [length], angles: [], diameter, lengthMm: length, totalLengthMm: length, quantity },
      calculated: { unitLengthMm: length, totalLengthMm: length * quantity, unitWeightKg: unitWeight, weightKg: unitWeight, totalWeightKg: unitWeight * quantity },
      machineOutput: { generic: { family: 'bars', shapeType: 'straight_bar', sides: [length], angles: [], diameter, totalLengthMm: length }, machineProfiles: {} },
      validation: { valid: length > 0 && diameter > 0 && quantity > 0, errors: [], warnings: [] },
    };
    return window.IronBendShapeSnapshot?.buildFullShapeSnapshot ? window.IronBendShapeSnapshot.buildFullShapeSnapshot(base) : { contractVersion: 2, shapeVersion: 1, approvedAt: new Date().toISOString(), ...base };
  }

  function createOrderItemFromIntakeRow(row = {}) {
    const result = validateIntakeRow(row);
    const item = result.row;
    const quantity = Math.max(1, numeric(item.quantity, 1));
    const length = numeric(item.length, 0);
    const diameter = numeric(item.diameter, 12);
    const elementName = item.elementName || '';
    return {
      id: Date.now() + Math.floor(Math.random() * 100000),
      shapeId: 'straight_bar',
      shapeEmoji: '━',
      shapeName: item.shape || 'מוט ישר',
      family: 'bars',
      shapeSides: [length],
      shapeAngles: [],
      diameter,
      length,
      qty: quantity,
      quantity,
      note: item.note || '',
      raw_material_id: 'auto',
      structElement: elementName,
      struct_element: elementName,
      elementName,
      shapeSnapshot: buildIntakeStraightSnapshot({ length, diameter, quantity }),
    };
  }

  function addIntakeRowsToOrder(rows = intakeDraftRows, options = {}) {
    const checkedRows = (Array.isArray(rows) ? rows : []).map(validateIntakeRow);
    const validRows = checkedRows.filter(result => result.ok).map(result => result.row);
    const invalidRows = checkedRows.filter(result => !result.ok).map(result => result.row);
    if (!validRows.length) {
      if (!options.silentInvalid) showQuickImportMessage('אין שורות תקינות להוספה. בדוק קוטר, כמות ואורך.');
      return 0;
    }
    const pallet = minEnsureDefaultPallet();
    validRows.forEach(row => pallet.items.push(createOrderItemFromIntakeRow(row)));
    renderPallets();
    if (typeof window.updateSummary === 'function') window.updateSummary();
    intakeDraftRows = invalidRows;
    if (!options.silentInvalid) {
      if (typeof window.showToast === 'function') window.showToast('השורות התקינות נוספו להזמנה');
    }
    return validRows.length;
  }

  function minGetAllVisibleOrderItems() {
    const rows = (pallets || []).flatMap(pallet => (pallet.items || []).map(item => ({ palletId: pallet.id, item })));
    const total = rows.length;
    return rows.map((row, index) => ({ ...row, orderLineNo: index + 1, orderTotalLines: total }));
  }

  function minRenderEmptyItemsState() { return ''; }

  function minRenderAddRow(nextNum) {
    const palletId = (pallets && pallets[0]) ? pallets[0].id : 0;
    // Adding an item opens the shape editor directly \u2014 the whole item (sides,
    // diameter, quantity) is entered there with the keyboard.
    const addCall = (typeof window.addItem === 'function' ? 'window.addItem(' : 'window.addEmptyRow(') + palletId + ')';
    return '<div class="order-line-add-row"><button type="button" class="line-add-btn" onclick="' + addCall + '" title="\u05d4\u05d5\u05e1\u05e3 \u05e4\u05e8\u05d9\u05d8">+ \u05d4\u05d5\u05e1\u05e3 \u05e4\u05e8\u05d9\u05d8</button></div>';
  }

  function lineContract(item = {}) { return typeof window.itemShapeContract === 'function' ? window.itemShapeContract(item) : null; }
  function lineData(item = {}) { const contract = lineContract(item); const snapshot = typeof item.shapeSnapshot === 'object' && item.shapeSnapshot ? item.shapeSnapshot : null; return contract?.data || snapshot?.data || snapshot || {}; }
  function lineSteelFinish(item = {}) { const data = lineData(item); return String(item.steelFinish || item.steel_finish || data.steelFinish || data.steel_finish || '').toLowerCase() === 'smooth' ? 'smooth' : 'ribbed'; }
  function lineSides(item = {}) { if (typeof window.itemShapeSides === 'function') return window.itemShapeSides(item); const data = lineData(item); if (Array.isArray(item.shapeSides)) return item.shapeSides.map(Number).filter(v => Number.isFinite(v) && v > 0); if (Array.isArray(data.sides)) return data.sides.map(Number).filter(v => Number.isFinite(v) && v > 0); const length = numeric(item.length || item.totalLengthMm || data.lengthMm || data.totalLengthMm, 0); return length > 0 ? [length] : []; }
  function lineAngles(item = {}) { if (typeof window.itemShapeAngles === 'function') return window.itemShapeAngles(item); const data = lineData(item); return Array.isArray(data.angles) ? data.angles.map(Number).filter(Number.isFinite) : []; }
  function lineQty(item = {}) { return Math.max(0, numeric(item.qty ?? item.quantity ?? lineData(item).quantity, 0)); }
  function lineDiameter(item = {}) { const data = lineData(item); if (isRoundPileCageLine(item) && typeof window.roundPileCageVisualData === 'function') return numeric(window.roundPileCageVisualData(item).longitudinalDiameterMm, 20); return numeric(item.diameter ?? item.barDiameter ?? data.diameter ?? data.barDiameter ?? 0, 0); }
  function isLineSpiral(item = {}) { const contract = lineContract(item); return item.family === 'spirals' || contract?.family === 'spirals' || (typeof window.isSpiralOrderItem === 'function' && window.isSpiralOrderItem(item)); }
  function getSpiralFields(item = {}) { if (typeof window.spiralFieldsFromShapeData === 'function') return window.spiralFieldsFromShapeData(item); const data = lineData(item); return { spiralDiameterMm: numeric(item.spiral_diameter_mm || item.spiralDiameterMm || data.spiralDiameterMm || data.diameterMm, 0), spiralTurns: numeric(item.spiral_turns || item.spiralTurns || data.spiralTurns || data.turns, 0), spiralHeightMm: numeric(item.spiral_height_mm || item.spiralHeightMm || data.spiralHeightMm || data.heightMm, 0) }; }
  function isLineRing(item = {}) { const contract = lineContract(item); const data = lineData(item); return contract?.shapeType === 'ring' || data.shapeType === 'ring' || data.specialty === 'ring' || (typeof window.isStandaloneRingItem === 'function' && window.isStandaloneRingItem(item)); }
  function getRingFields(item = {}) { if (typeof window.ringFieldsFromShapeData === 'function') return window.ringFieldsFromShapeData(item); const data = lineData(item); const ringDiameterMm = numeric(data.ringDiameterMm || data.bendingDiameterMm || data.spiralDiameterMm || data.ringDiameter || data.spiralDiameter, 0); const overlapMm = Math.max(0, numeric(data.overlapMm ?? data.overlap, 0)); return { ringDiameterMm, overlapMm, circumferenceMm: Math.PI * ringDiameterMm, totalLengthMm: (Math.PI * ringDiameterMm) + overlapMm }; }
  function getLineUnitLengthMm(item = {}) { const data = lineData(item); const calculated = lineContract(item)?.calculated || item.shapeSnapshot?.calculated || {}; if (isRoundPileCageLine(item) && typeof window.roundPileCageVisualData === 'function') return numeric(window.roundPileCageVisualData(item).pileLengthMm, 0); if (isLineRing(item)) { const ring = getRingFields(item); return numeric(calculated.totalLengthMm ?? calculated.unitLengthMm ?? ring.totalLengthMm ?? item.length, 0); } if (isLineSpiral(item)) { const spiral = getSpiralFields(item); if (typeof window.spiralLengthMm === 'function' && spiral.spiralDiameterMm > 0 && spiral.spiralTurns > 0) return window.spiralLengthMm(spiral.spiralDiameterMm, spiral.spiralTurns); } const sides = lineSides(item); const sideTotal = sides.reduce((sum, length) => sum + numeric(length, 0), 0); if (sideTotal > 0) return sideTotal; return numeric(item.length ?? item.totalLengthMm ?? data.lengthMm ?? data.totalLengthMm ?? calculated.unitLengthMm ?? calculated.totalLengthMm, 0); }
  function formatLineLength(item = {}) { return formatCm(getLineUnitLengthMm(item)); }
  function formatLineTotalLength(item = {}) { return formatMeters(getLineUnitLengthMm(item) * lineQty(item)); }
  function formatLineWeight(item = {}) { const weight = typeof window.calcItemWeight === 'function' ? window.calcItemWeight(item) : 0; return formatKg(weight); }
  function isRoundPileCageLine(item = {}) { return typeof window.isRoundPileCageItem === 'function' && window.isRoundPileCageItem(item); }
  function formatLineShapeDims(item = {}) { const data = lineData(item); if (isRoundPileCageLine(item)) { const pile = typeof window.roundPileCageVisualData === 'function' ? window.roundPileCageVisualData(item) : {}; const diameter = numeric(pile.pileDiameterMm, 0); const length = numeric(pile.pileLengthMm, 0); return `PILE CAGE · Ø${diameter ? (diameter / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }) : '—'} ס״מ · L ${length ? (length / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) : '—'} ס״מ`; } if (isLineRing(item)) { const ring = getRingFields(item); const diameterCm = ring.ringDiameterMm > 0 ? (ring.ringDiameterMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }) : '—'; const overlapCm = ring.overlapMm > 0 ? (ring.overlapMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }) : '0'; return `טבעת · Ø${diameterCm} ס״מ · חפיפה ${overlapCm} ס״מ`; } if (isLineSpiral(item)) { const spiral = getSpiralFields(item); const parts = []; if (spiral.spiralDiameterMm > 0) parts.push('Ø' + (spiral.spiralDiameterMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' ס״מ'); if (spiral.spiralHeightMm > 0) parts.push('H=' + (spiral.spiralHeightMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' ס״מ'); if (spiral.spiralTurns > 0) parts.push('N=' + spiral.spiralTurns.toLocaleString('he-IL')); return parts.join(' · ') || 'ספירלה'; } const family = lineContract(item)?.family || item.family || ''; const width = numeric(data.widthMm || data.width || item.widthMm || item.width, 0); const height = numeric(data.heightMm || data.height || item.heightMm || item.height, 0); if ((family === 'mesh' || family === 'meshes') && width > 0 && height > 0) return 'רשת ' + (width / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + '×' + (height / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' ס״מ'; const sides = lineSides(item); if (sides.length) { const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''); return sides.slice(0, 4).map((length, index) => labels[index] + '=' + (numeric(length, 0) / 10).toLocaleString('he-IL', { maximumFractionDigits: 3 }) + ' ס״מ').join(' · '); } return 'צורה'; }
  function renderLineShapeSketch(item = {}) {
    const sides = lineSides(item);
    const angles = lineAngles(item);
    if (isRoundPileCageLine(item) || sides.length || item.shapeId) {
      if (typeof window.itemPreviewSvg === 'function') {
        const svg = window.itemPreviewSvg(item, sides, angles);
        if (svg) return svg;
      }
    }
    return '<div class="line-shape-empty"><span>+</span><small>\u05d1\u05d7\u05e8 \u05e6\u05d5\u05e8\u05d4</small></div>';
  }
  function lineTitle(item = {}) { if (item.shapeName || item.displayName) return item.shapeName || item.displayName; if (isLineRing(item)) return 'טבעת עגולה'; if (isLineSpiral(item)) return '\u05e1\u05e4\u05d9\u05e8\u05dc\u05d4'; const family = lineContract(item)?.family || item.family || ''; if (family === 'mesh' || family === 'meshes') return '\u05e8\u05e9\u05ea'; return '\u05de\u05d5\u05d8 \u05d9\u05e9\u05e8'; }

  function updateLineQuantity(palletId, itemId, input) {
    if (input && !input.isConnected) return;
    const next = Math.max(1, numeric(input?.value, 1));
    if (input) input.value = String(next);
    const pallet = (pallets || []).find((entry) => String(entry.id) === String(palletId));
    const item = (pallet?.items || []).find((entry) => String(entry.id) === String(itemId));
    if (item && numeric(item.qty, 1) === next) return;
    if (typeof window.updateItem === 'function') window.updateItem(palletId, itemId, 'qty', next);
    scheduleDraftAutosave();
  }

  function updateLineDiameter(palletId, itemId, select) {
    const [rawDiameter, rawFinish] = String(select?.value ?? '').split('|');
    const next = Number(rawDiameter) || 12;
    const steelFinish = rawFinish === 'smooth' ? 'smooth' : 'ribbed';
    const pallet = (pallets || []).find((entry) => String(entry.id) === String(palletId));
    const item = (pallet?.items || []).find((entry) => String(entry.id) === String(itemId));
    if (!item) return;
    item.steelFinish = steelFinish;
    if (item.shapeSnapshot?.data && typeof item.shapeSnapshot.data === 'object') item.shapeSnapshot.data.steelFinish = steelFinish;
    if (typeof window.updateItem === 'function') {
      window.updateItem(palletId, itemId, 'diameter', next);
      window.updateItem(palletId, itemId, 'steelFinish', steelFinish);
    }
    scheduleDraftAutosave();
  }

  function lineElementName(item = {}) {
    return String(item.structElement || item.struct_element || item.elementName || item.element_name || item.element || item.memberName || item.member_name || '').trim();
  }

  function updateLineElementName(palletId, itemId, input) {
    if (input && !input.isConnected) return;
    const next = String(input?.value || '').trim();
    const pallet = (pallets || []).find(entry => String(entry.id) === String(palletId));
    const item = (pallet?.items || []).find(entry => String(entry.id) === String(itemId));
    if (item) {
      item.structElement = next;
      item.struct_element = next;
      item.elementName = next;
    }
    if (typeof window.updateItem === 'function') window.updateItem(palletId, itemId, 'structElement', next);
    scheduleDraftAutosave();
  }

  // Sides are stored in mm; the row edits them in cm. Empty when no shape yet.
  function sidesToCmString(item = {}) {
    const sides = Array.isArray(item.shapeSides) && item.shapeSides.length
      ? item.shapeSides
      : (Number(item.length) > 0 ? [Number(item.length)] : []);
    if (!sides.length) return '';
    return sides.map(mm => {
      const cm = Number(mm) / 10;
      return Math.abs(cm - Math.round(cm)) < 0.001 ? String(Math.round(cm)) : cm.toFixed(1);
    }).join('/');
  }

  // Reads a cm length (single number = straight bar) or a cm sides list like
  // "20/670/20" (simple bent, 90° bends) and stores it back in mm.
  function updateLineLengthCm(palletId, itemId, input) {
    if (input && !input.isConnected) return;
    const pallet = (pallets || []).find(entry => String(entry.id) === String(palletId));
    const item = (pallet?.items || []).find(entry => String(entry.id) === String(itemId));
    if (!item) return;
    const cmParts = String(input?.value || '').split(/[\/,\s]+/).map(v => parseFloat(v)).filter(v => Number.isFinite(v) && v > 0);
    if (!cmParts.length) {
      item.shapeSides = []; item.shapeAngles = []; item.length = 0;
      item.shapeId = null; item.shapeName = ''; item.shapeSnapshot = null;
      if (typeof window.updateItem === 'function') window.updateItem(palletId, itemId, 'length', 0);
      scheduleDraftAutosave();
      return;
    }
    const mmSides = cmParts.map(cm => Math.round(cm * 10));
    const total = mmSides.reduce((sum, v) => sum + v, 0);
    const diameter = Number(item.diameter) || 12;
    const qty = Math.max(1, Number(item.qty) || 1);
    item.family = 'bars';
    item.shapeSides = mmSides;
    item.length = total;
    if (mmSides.length === 1) {
      item.shapeId = 'straight_bar'; item.shapeName = 'מוט ישר'; item.shapeAngles = [];
      item.shapeSnapshot = typeof window.buildStraightBarSnapshot === 'function'
        ? window.buildStraightBarSnapshot({ length: total, diameter, qty })
        : null;
    } else {
      item.shapeId = 'bent_bar'; item.shapeName = 'מוט מכופף';
      item.shapeAngles = mmSides.slice(0, -1).map(() => 90);
      item.shapeSnapshot = null; // sides + angles carry the geometry to the server
    }
    if (typeof window.updateItem === 'function') window.updateItem(palletId, itemId, 'length', total);
    scheduleDraftAutosave();
  }

  // Keyboard-only entry across the item grid: Enter walks the fields and adds a
  // fresh row at the end; Up/Down move between rows in the same column.
  const KBD_SEQUENCE = ['line-element', 'line-diameter-select', 'line-qty'];
  function kbdFieldClass(el) {
    return el && el.classList ? KBD_SEQUENCE.find(c => el.classList.contains(c)) : null;
  }
  function kbdFocus(row, cls) {
    const f = row && row.querySelector('.' + cls);
    if (!f) return false;
    f.focus();
    if (typeof f.select === 'function') { try { f.select(); } catch (_) {} }
    return true;
  }
  function kbdFocusFirst(row) {
    for (const c of KBD_SEQUENCE) { if (kbdFocus(row, c)) return true; }
    return false;
  }
  function handleGridKeydown(event) {
    // Shift+Enter opens the shape editor for a new item — from anywhere on the
    // order page, as long as the editor itself isn't open (it uses Shift+Enter
    // internally to jump to the diameter).
    if (event.key === 'Enter' && event.shiftKey) {
      if (document.getElementById('seOverlay') && document.getElementById('seOverlay').classList.contains('show')) return;
      if (!document.querySelector('.order-lines-body')) return;
      event.preventDefault();
      const focusedRow = event.target.closest && event.target.closest('.order-line-row');
      const pallet = (focusedRow ? (pallets || []).find(p => (p.items || []).some(it => String(it.id) === focusedRow.dataset.itemId)) : null)
        || (pallets || [])[0];
      if (pallet && typeof window.addItem === 'function') window.addItem(pallet.id);
      return;
    }
    const cls = kbdFieldClass(event.target);
    if (!cls) return;
    const row = event.target.closest('.order-line-row');
    const container = event.target.closest('.order-lines-body');
    if (!row || !container) return;
    const rows = Array.from(container.querySelectorAll('.order-line-row'));
    const rowIdx = rows.indexOf(row);

    // Arrows only move between rows — they never change a select/number value.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = event.key === 'ArrowDown' ? rows[rowIdx + 1] : rows[rowIdx - 1];
      if (target) { event.preventDefault(); if (!kbdFocus(target, cls)) kbdFocusFirst(target); }
    }
  }

  function renderCompactOrderLine(palletId, item, itemIndex = 0, orderTotalLines = 1) {
    const id = String(item.id); const palletArg = jsArg(palletId); const itemArg = jsArg(id); const qty = lineQty(item); const diameter = lineDiameter(item); const dims = formatLineShapeDims(item); const length = formatLineLength(item); const totalLength = formatLineTotalLength(item); const weight = formatLineWeight(item); const elementName = lineElementName(item); const openCall = 'openShapeEditor(' + palletArg + ',' + itemArg + ')'; const updateQtyCall = 'updateLineQuantity(' + palletArg + ',' + itemArg + ',this)'; const updateElementCall = 'updateLineElementName(' + palletArg + ',' + itemArg + ',this)'; const updateDiamCall = 'updateLineDiameter(' + palletArg + ',' + itemArg + ',this)'; const lineLabel = orderTotalLines > 0 ? (itemIndex + 1) + '/' + orderTotalLines : String(itemIndex + 1);
    const steelFinish = lineSteelFinish(item);
    const diaOptions = [5.5,6,8,'8|smooth',10,'10|smooth',12,14,16,18,20,22,25,28,32,36,40].map(option => {
      const raw = String(option); const smooth = raw.endsWith('|smooth'); const d = Number(raw.replace('|smooth', ''));
      const selected = d === diameter && (smooth ? steelFinish === 'smooth' : steelFinish !== 'smooth');
      return `<option value="${raw}"${selected ? ' selected' : ''}>\u00d8${d}${smooth ? ' חלק' : ''}</option>`;
    }).join('');
    const isPileCage = isRoundPileCageLine(item);
    const hasShape = !!(isPileCage || item.shapeId || (item.shapeSides && item.shapeSides.length));
    const emptyDash = '<span class="line-val-empty">\u2014</span>';
    // The length column shows the cut length of one piece as a single number in
    // cm (not the per-side breakdown); sides are entered in the shape editor.
    const unitLenCm = Math.round((getLineUnitLengthMm(item) || 0) / 10);
    const lengthCell = hasShape && unitLenCm > 0
      ? '<b>' + unitLenCm.toLocaleString('he-IL') + '</b>'
      : emptyDash;
    const totalLengthCell = hasShape ? escapeHtml(totalLength) : emptyDash;
    const weightCell = hasShape ? escapeHtml(weight) : emptyDash;
    if (window.IronBendOrderLineRenderer) return window.IronBendOrderLineRenderer.render({
      id, lineLabel, elementName, qty, diameter, hasShape, isPileCage,
      shapeSketch: renderLineShapeSketch(item), diameterOptions: diaOptions,
      unitLengthCm, totalLength, weight,
      openCall, updateQtyCall, updateElementCall, updateDiamCall,
      deleteCall: 'removeItem(' + palletArg + ',' + itemArg + ')'
    });
    return `<article class="order-line-row${hasShape ? '' : ' no-shape-yet'}${isPileCage ? ' line-round-pile-cage' : ''}" id="item-row-${escapeHtml(id)}" data-item-id="${escapeHtml(id)}"${isPileCage ? ' data-shape-kind="round_pile_cage"' : ''}><div class="line-index">${escapeHtml(lineLabel)}</div><input class="line-element" type="text" value="${escapeHtml(elementName)}" placeholder="\u05e7\u05d5\u05e8\u05d4 / \u05e7\u05d5\u05de\u05d4 / \u05e6\u05d9\u05e8" aria-label="\u05d0\u05dc\u05de\u05e0\u05d8" onchange="${updateElementCall}" onblur="${updateElementCall}"><button type="button" class="line-shape" onclick="${openCall}" title="\u05e4\u05ea\u05d7 \u05e2\u05d5\u05e8\u05da \u05e6\u05d5\u05e8\u05d4"><span class="line-shape-sketch">${renderLineShapeSketch(item)}</span>${isPileCage ? '<span class="line-pile-cage-tag">PILE CAGE</span>' : ''}</button><select class="line-diameter-select" onchange="${updateDiamCall}" aria-label="\u05e7\u05d5\u05d8\u05e8"><option value="" disabled>\u00d8</option>${diaOptions}</select><input class="line-qty" type="number" min="1" step="1" value="${escapeHtml(qty)}" inputmode="numeric" aria-label="\u05db\u05de\u05d5\u05ea" onfocus="this.select()" oninput="this.value=this.value.replace(/[^0-9]/g,'')" onchange="${updateQtyCall}" onblur="${updateQtyCall}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"><div class="line-length desktop-only-cell">${lengthCell}</div><div class="line-total-length desktop-only-cell">${totalLengthCell}</div><div class="line-weight">${weightCell}</div><button type="button" class="line-delete" onclick="removeItem(${palletArg},${itemArg})" title="\u05de\u05d7\u05e7 \u05e4\u05e8\u05d9\u05d8" aria-label="\u05de\u05d7\u05e7 \u05e4\u05e8\u05d9\u05d8">&times;</button><div class="line-mobile-meta"><span>${isPileCage ? 'PILE CAGE' : escapeHtml(elementName || '\u05dc\u05dc\u05d0 \u05d0\u05dc\u05de\u05e0\u05d8')}</span><span>\u00d8${escapeHtml(diameter.toLocaleString('he-IL', { maximumFractionDigits: 1 }))}</span><span>${hasShape ? escapeHtml(totalLength) : '\u2014'}</span><span>${hasShape ? escapeHtml(weight) : '\u2014'}</span></div></article>`;
  }

  function minRenderItemCard(palletId, item, itemIndex = 0) { const total = minGetAllVisibleOrderItems().length || 1; return renderCompactOrderLine(palletId, item, itemIndex, total); }
  function minRenderPallets() {
    setupOrderLinesTable();
    const container = document.getElementById('palletsContainer');
    if (!container) return;
    // Preserve keyboard focus + caret across the row rebuild, so a full order
    // can be typed without touching the mouse.
    const active = document.activeElement;
    let focusSave = null;
    if (active && active.closest) {
      const rowEl = active.closest('.order-line-row');
      const cls = kbdFieldClass(active);
      if (rowEl && cls && rowEl.dataset.itemId) {
        focusSave = { itemId: rowEl.dataset.itemId, cls,
          s: (typeof active.selectionStart === 'number') ? active.selectionStart : null,
          e: (typeof active.selectionEnd === 'number') ? active.selectionEnd : null };
      }
    }
    minEnsureDefaultPallet();
    const rows = minGetAllVisibleOrderItems();
    const nextNum = rows.length + 1;
    const headerHtml = container.querySelector(':scope > .order-lines-head')?.outerHTML || '';
    const gridGuidesHtml = container.querySelector(':scope > .order-lines-grid-guides')?.outerHTML || orderLinesGridGuidesHtml();
    container.innerHTML = headerHtml + gridGuidesHtml + (rows.length ? rows.map(({ palletId, item, orderLineNo, orderTotalLines }) => renderCompactOrderLine(palletId, item, orderLineNo - 1, orderTotalLines)).join('') : minRenderEmptyItemsState()) + minRenderAddRow(nextNum);
    setTextSafe('itemsCountPill', rows.length + ' \u05e4\u05e8\u05d9\u05d8\u05d9\u05dd');
    setTextSafe('noItemsCount', rows.length);
    if (typeof window.updateSummary === 'function') window.updateSummary();
    if (focusSave) {
      const rowEl = container.querySelector('.order-line-row[data-item-id="' + focusSave.itemId + '"]');
      const field = rowEl && rowEl.querySelector('.' + focusSave.cls);
      if (field) {
        field.focus();
        if (focusSave.s != null && typeof field.setSelectionRange === 'function') {
          try { field.setSelectionRange(focusSave.s, focusSave.e); } catch (_) {}
        }
      }
    }
    scheduleDraftAutosave();
  }
  function minRenderOrderSummary() { if (typeof window.updateSummary === 'function') window.updateSummary(); }
  function minHasItems() {
    return (pallets || []).some(pallet => (pallet.items || []).length > 0);
  }

  function minRenderInventorySummary() {
    if (typeof window.renderLiveInventoryPanel === 'function') window.renderLiveInventoryPanel();
    const stockCard = document.getElementById('stockPreviewCard');
    if (stockCard) stockCard.style.setProperty('display', minHasItems() ? '' : 'none', 'important');
    minPruneZeroInventoryRows();
  }

  function minPruneZeroInventoryRows() {
    const panel = document.getElementById('liveInventoryPanel');
    if (!panel || !minHasItems()) return;
    panel.querySelectorAll('.inventory-compact-row').forEach(row => {
      const text = (row.textContent || '').replace(/\s+/g, ' ');
      const zeroRequired = /\u05e0\u05d3\u05e8\u05e9\s*0(?:[.,]0)?\s*\u05e7/.test(text);
      const zeroShortage = /\u05d7\u05e1\u05e8\s*0(?:[.,]0)?\s*\u05e7/.test(text);
      if (zeroRequired && zeroShortage) row.remove();
    });
    const rows = panel.querySelectorAll('.inventory-compact-row');
    if (!rows.length) {
      panel.innerHTML = '<section class="inspector-card"><h3>\u05de\u05dc\u05d0\u05d9</h3><p>\u05de\u05dc\u05d0\u05d9 \u05d9\u05d9\u05d1\u05d3\u05e7 \u05d0\u05d7\u05e8\u05d9 \u05d4\u05d5\u05e1\u05e4\u05ea \u05e4\u05e8\u05d9\u05d8\u05d9\u05dd.</p></section>';
    }
  }

  function minRenderPricingSummary() {
    if (typeof window.applyPricingPreviewAccess === 'function') window.applyPricingPreviewAccess();
    const card = document.getElementById('pricingPreviewCard');
    if (!card) return;
    const total = (document.getElementById('summaryPriceTotal')?.textContent || '').trim();
    const perKg = (document.getElementById('summaryPricePerKg')?.textContent || '').trim();
    const useful = minHasItems() && total && total !== '-' && !/\?{3,}/.test(perKg);
    card.classList.toggle('is-hidden', !useful);
    if (useful) card.style.removeProperty('display');
    else card.style.setProperty('display', 'none', 'important');
  }

  function selectedSiteLabelSafe() {
    if (typeof window.selectedSiteLabel === 'function') return window.selectedSiteLabel();
    return (document.getElementById('deliverySiteName')?.value || document.getElementById('deliveryAddress')?.value || '').trim();
  }

  function minUpdateContextStrip(totalWeight = 0) {
    const customer = (document.getElementById('customerSearch')?.value || '').trim();
    const site = selectedSiteLabelSafe();
    const address = (document.getElementById('deliveryAddress')?.value || '').trim();
    const date = (document.getElementById('deliveryDate')?.value || '').trim();
    const time = (document.getElementById('deliveryTime')?.value || '').trim();
    const priority = (document.getElementById('orderPriority')?.value || '').trim();
    const channel = (document.getElementById('orderChannel')?.value || '').trim();
    const delivery = [date ? shortDate(date) : '', time, priority].filter(Boolean).join(' · ') || address || 'לא נקבע';
    const count = (pallets || []).reduce((sum, pallet) => sum + ((pallet.items || []).length), 0);
    setTextSafe('noCustomerName', customer || 'לא נבחר');
    setTextSafe('noSiteName', site || 'לא נבחר');
    setTextSafe('noDeliveryAddress', delivery);
    setTextSafe('noOrderSource', channel || 'טלפון');
    setTextSafe('noItemsCount', count);
  }

  function bindDraftAutosaveTriggers() {
    const ids = [
      'customerSearch',
      'customerPhone',
      'customerTaxId',
      'customerPriorityId',
      'contactName',
      'contactPhone',
      'orderSiteId',
      'deliverySiteName',
      'deliveryAddress',
      'deliveryDate',
      'deliveryTime',
      'orderPriority',
      'driverNotes',
      'generalNotes',
      'orderChannel',
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.draftAutosaveBound === '1') return;
      el.dataset.draftAutosaveBound = '1';
      el.addEventListener('input', scheduleDraftAutosave);
      el.addEventListener('change', scheduleDraftAutosave);
    });
    // Keyboard-only grid navigation (delegated once; survives row re-renders).
    if (!document.body.dataset.gridKbdBound) {
      document.body.dataset.gridKbdBound = '1';
      document.addEventListener('keydown', handleGridKeydown);
    }
  }

  function wrapDraftAwareGlobals() {
    if (window.NewOrderEditorDrafts?.wrapped) return;
    const originalSaveDraftNow = window.saveDraftNow;
    window.saveDraftNow = function saveDraftNowV2() {
      const record = saveActiveDraftNow({ silent: false });
      if (!record && typeof originalSaveDraftNow === 'function') return originalSaveDraftNow();
      if (record && typeof showQuickImportMessage === 'function') showQuickImportMessage('הטיוטה נשמרה');
      return record;
    };

    const originalClearOrderDraft = window.clearOrderDraft;
    window.clearOrderDraft = function clearOrderDraftV2() {
      if (typeof originalClearOrderDraft === 'function') originalClearOrderDraft();
      removeActiveDraft();
    };

    const originalSubmitOrder = window.submitOrder;
    if (typeof originalSubmitOrder === 'function') {
      window.submitOrder = async function submitOrderDraftAware(...args) {
        const result = await originalSubmitOrder.apply(this, args);
        const successOverlay = document.getElementById('successOverlay');
        if (successOverlay?.classList.contains('show')) {
          const offline = /ממתין|סנכרון|offline/i.test(document.getElementById('successOrderNum')?.textContent || '');
          removeActiveDraft({ submittedOffline: offline });
        }
        return result;
      };
    }

    const originalNewOrder = window.newOrder;
    if (typeof originalNewOrder === 'function') {
      window.newOrder = function newOrderDraftAware(...args) {
        currentDraftId = null;
        closeDraftsPopover();
        hideDraftRestoreBanner();
        return originalNewOrder.apply(this, args);
      };
    }

    window.NewOrderEditorDrafts = { ...(window.NewOrderEditorDrafts || {}), wrapped: true };
  }

  function bindEscClose() { document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeIntakePanel(); minCloseInspectorPanel(); closeDraftsPopover(); } }); }
  function bindOutsideClick() {
    document.addEventListener('click', event => {
      const popover = document.getElementById('orderDraftsPopover');
      if (popover && !popover.hidden && !event.target.closest('.order-drafts-ui')) closeDraftsPopover();
      const inspector = document.getElementById('orderInspector');
      if (!inspector?.dataset.activePanel) return;
      if (event.target.closest('#orderInspector') || event.target.closest('.context-chip')) return;
      minCloseInspectorPanel();
    });
  }

  function applyMinimalLayout() {
    const main = document.querySelector('body[data-page="new"] .main.order-min-page');
    if (main) {
      main.style.setProperty('display', window.innerWidth <= 900 ? 'block' : 'grid', 'important');
      main.style.setProperty('direction', 'ltr', 'important');
      main.style.setProperty('overflow-x', 'hidden', 'important');
    }
    document.querySelectorAll('.progress-bar,#orderSetupDrawer,.no-bottom-actions,.order-more-action,.summary-bar>.submit-btn,.no-internal-stat,.add-pallet-btn').forEach(el => el.style.setProperty('display', 'none', 'important'));
  }

  function exposeGlobals() {
    window.updateContextStrip = minUpdateContextStrip;
    window.toggleInspectorPanel = minToggleInspectorPanel;
    window.closeInspectorPanel = minCloseInspectorPanel;
    window.renderInspector = minRenderInspector;
    window.renderCustomerInspector = minRenderCustomerInspector;
    window.renderDeliveryInspector = minRenderDeliveryInspector;
    window.renderSourceInspector = minRenderSourceInspector;
    window.ensureDefaultPallet = minEnsureDefaultPallet;
    window.addShapeNow = minAddShapeNow;
    window.getAllVisibleOrderItems = minGetAllVisibleOrderItems;
    window.renderPallets = minRenderPallets;
    window.renderEmptyItemsState = minRenderEmptyItemsState;
    window.renderCompactOrderLine = renderCompactOrderLine;
    window.formatLineShapeDims = formatLineShapeDims;
    window.formatLineLength = formatLineLength;
    window.formatLineTotalLength = formatLineTotalLength;
    window.formatLineWeight = formatLineWeight;
    window.renderLineShapeSketch = renderLineShapeSketch;
    window.updateLineQuantity = updateLineQuantity;
    window.updateLineDiameter = updateLineDiameter;
    window.updateLineLengthCm = updateLineLengthCm;
    window.lineElementName = lineElementName;
    window.updateLineElementName = updateLineElementName;
    window.renderItemCard = minRenderItemCard;
    window.renderDefaultInspector = minRenderDefaultInspector;
    window.renderInventorySummary = minRenderInventorySummary;
    window.renderPricingSummary = minRenderPricingSummary;
    window.renderOrderSummary = minRenderOrderSummary;
    window.openIntakePanel = openIntakePanel;
    window.closeIntakePanel = closeIntakePanel;
    window.openQuickOrderImport = openQuickOrderImport;
    window.handleQuickOrderImportFile = handleQuickOrderImportFile;
    window.addIntakeRowsToOrder = addIntakeRowsToOrder;
    window.createOrderItemFromIntakeRow = createOrderItemFromIntakeRow;
    window.validateIntakeRow = validateIntakeRow;
    window.getDraftStore = getDraftStore;
    window.saveDraftStore = saveDraftStore;
    window.createDraftId = createDraftId;
    window.captureCurrentDraftRecord = captureCurrentDraftRecord;
    window.scheduleDraftAutosave = scheduleDraftAutosave;
    window.saveActiveDraftNow = saveActiveDraftNow;
    window.renderDraftsPopover = renderDraftsPopover;
    window.openDraftsPopover = openDraftsPopover;
    window.closeDraftsPopover = closeDraftsPopover;
    window.continueDraft = continueDraft;
    window.deleteDraft = deleteDraft;
    window.deleteAllSubmittedOrExpiredDrafts = deleteAllSubmittedOrExpiredDrafts;
    window.showDraftRestoreBanner = showDraftRestoreBanner;
    window.hideDraftRestoreBanner = hideDraftRestoreBanner;
    window.isMeaningfulOrderDraft = isMeaningfulOrderDraft;
  }

  function boot() {
    if (document.body?.getAttribute('data-page') !== 'new') return;
    setupDom(); exposeGlobals(); wrapDraftAwareGlobals(); bindEscClose(); bindOutsideClick(); bindDraftAutosaveTriggers(); applyMinimalLayout();
    deleteAllSubmittedOrExpiredDrafts();
    minUpdateContextStrip(); minRenderDefaultInspector(); minRenderPallets();
    if (visibleDrafts().length) showDraftRestoreBanner();
    window.NewOrderEditor = { installed: true, applyMinimalLayout, renderInspector: minRenderInspector };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('load', () => { setupDom(); bindDraftAutosaveTriggers(); applyMinimalLayout(); minUpdateContextStrip(); minRenderPricingSummary(); minRenderInventorySummary(); updateDraftsButton(); if (visibleDrafts().length && !currentDraftId) showDraftRestoreBanner(); });
  window.addEventListener('resize', applyMinimalLayout);
  setTimeout(() => { setupDom(); bindDraftAutosaveTriggers(); applyMinimalLayout(); minUpdateContextStrip(); minRenderPricingSummary(); minRenderInventorySummary(); updateDraftsButton(); if (visibleDrafts().length && !currentDraftId) showDraftRestoreBanner(); }, 250);
  setTimeout(() => { setupDom(); bindDraftAutosaveTriggers(); applyMinimalLayout(); minUpdateContextStrip(); minRenderPricingSummary(); minRenderInventorySummary(); updateDraftsButton(); if (visibleDrafts().length && !currentDraftId) showDraftRestoreBanner(); }, 800);
})();


