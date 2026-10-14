// IronBend shared navigation shell.
(function () {
  if (!window.IronBendAuth && !document.querySelector('script[src="/auth-client.js"]')) {
    const authScript = document.createElement('script');
    authScript.src = '/auth-client.js';
    authScript.async = false;
    document.head.appendChild(authScript);
  }

  // מיתוג white-label — נטען מנקודה אחת לכל הדפים
  if (!document.querySelector('script[src="/brand-client.js"]')) {
    const brandScript = document.createElement('script');
    brandScript.src = '/brand-client.js';
    brandScript.async = false;
    document.head.appendChild(brandScript);
  }

  if (!document.querySelector('script[src="/ui-tuner.js"]')) {
    const uiTunerScript = document.createElement('script');
    uiTunerScript.src = '/ui-tuner.js';
    uiTunerScript.async = false;
    document.head.appendChild(uiTunerScript);
  }

  const LINKS = [
    { group:'ראשי', href:'/dashboard.html', icon:'📊', label:'דשבורד', id:'dashboard' },
    { group:'ראשי', href:'/scan.html', icon:'📷', label:'סריקה', id:'scanner' },
    { group:'ראשי', href:'/orders.html', icon:'📋', label:'הזמנות', id:'orders' },
    { group:'ראשי', href:'/index.html', icon:'➕', label:'הזמנה חדשה', id:'new' },
    { group:'ראשי', href:'/intake.html', icon:'📬', label:'קליטת הזמנות', id:'intake' },
    { group:'ראשי', href:'/customers.html', icon:'👥', label:'לקוחות', id:'customers' },

    { group:'ייצור', href:'/production-queue.html', icon:'🏭', label:'תור ייצור', id:'production-queue' },
    { group:'ייצור', href:'/worker-visual.html', icon:'🧾', label:'דשבורד איסוף', id:'worker-visual' },
    { group:'ייצור', href:'/machine.html', icon:'🔧', label:'מכונות', id:'machine' },
    { group:'ייצור', href:'/kiosk.html', icon:'🖥️', label:'תחנת עבודה', id:'kiosk' },
    { group:'ייצור', href:'/production-setup.html', icon:'⚙️', label:'הגדרות ייצור', id:'production-setup' },

    { group:'תפעול', href:'/warehouse.html', icon:'📦', label:'מחסן', id:'warehouse' },
    { group:'תפעול', href:'/inventory.html', icon:'🗄️', label:'מלאי', id:'inventory' },
    { group:'תפעול', href:'/procurement.html', icon:'🛒', label:'רכש', id:'procurement' },
    { group:'תפעול', href:'/delivery-admin.html', icon:'🚚', label:'ניהול צי', id:'delivery-admin' },
    { group:'תפעול', href:'/driver.html', icon:'🚚', label:'מסך נהג', id:'driver' },

    { group:'בקרה', href:'/quality.html', icon:'🔍', label:'איכות', id:'quality' },
    { group:'בקרה', href:'/maintenance.html', icon:'🛠️', label:'תחזוקה', id:'maintenance' },
    { group:'בקרה', href:'/support.html', icon:'🧑‍💻', label:'תמיכה מרחוק', id:'support' },
    { group:'בקרה', href:'/bugs.html', icon:'🐞', label:'דיווחי באגים', id:'bugs' },
    { group:'בקרה', href:'/warroom.html', icon:'🚨', label:'War Room', id:'warroom' },
    { group:'בקרה', href:'/reports.html', icon:'📈', label:'דוחות', id:'reports' },

    { group:'ניהול', href:'/finance.html', icon:'💰', label:'פיננסים', id:'finance' },
    { group:'ניהול', href:'/profitability.html', icon:'📊', label:'ריווחיות', id:'profitability' },
    { group:'ניהול', href:'/pricing.html', icon:'₪', label:'מחירונים', id:'pricing' },
    { group:'ניהול', href:'/projects.html', icon:'🏗️', label:'פרויקטים', id:'projects' },
    { group:'ניהול', href:'/holdings.html', icon:'🏢', label:'אחזקות', id:'holdings' },
    { group:'ניהול', href:'/admin.html', icon:'⚙️', label:'ניהול מערכת', id:'admin' },
  ];

  const BOTTOM_IDS = ['dashboard', 'scanner', 'orders', 'new', 'admin'];
  const LINK_MODULES = {
    orders: 'orders',
    new: 'orders',
    intake: 'intake',
    customers: 'customers',
    'production-queue': 'production',
    'worker-visual': 'production',
    machine: 'production',
    kiosk: 'production',
    'production-setup': 'production',
    warehouse: 'warehouse',
    inventory: 'inventory',
    procurement: 'procurement',
    'delivery-admin': 'fleet',
    driver: 'fleet',
    quality: 'quality',
    maintenance: 'quality',
    warroom: 'reports',
    reports: 'reports',
    finance: 'finance',
    pricing: 'finance',
    projects: 'companies',
    holdings: 'companies',
  };
  let visibleLinks = LINKS.slice();
  const path = location.pathname.replace(/^\//, '') || 'dashboard.html';
  const activeId = (LINKS.find(l => l.href.replace('/', '') === path) || {}).id || '';
  const ia = id => id === activeId ? 'ib-active' : '';

  const CSS = `
    html { scrollbar-gutter: stable; }
    body { padding-top:56px; }
    #ib-topnav {
      position:fixed; top:0; left:0; right:0; z-index:300;
      height:56px; width:100%; padding:0 16px;
      display:flex; align-items:center; gap:8px;
      background:linear-gradient(180deg,#fff 0%,#f2f5f9 100%);
      border-bottom:1px solid rgba(2,26,72,.12);
      box-shadow:0 3px 16px rgba(0,0,0,.10);
      font-family:Heebo,Arial,sans-serif;
    }
    #ib-logo {
      display:flex; align-items:center; justify-content:center;
      text-decoration:none; margin-left:12px; flex-shrink:0;
    }
    #ib-logo-icon { width:164px; height:auto; object-fit:contain; display:block; }
    #ib-links { display:flex; gap:2px; flex:1; overflow-x:auto; scrollbar-width:none; }
    #ib-links::-webkit-scrollbar { display:none; }
    .ib-group-label { display:none; color:rgba(255,255,255,.42); font-size:10px; font-weight:900; padding:10px 10px 4px; }
    .ib-link, .ib-dl, .ib-bn {
      text-decoration:none; cursor:pointer;
      touch-action:manipulation;
    }
    .ib-link {
      display:flex; align-items:center; gap:6px;
      min-height:36px; padding:6px 11px; border-radius:7px;
      color:#526070; font-size:12.5px; font-weight:700;
      white-space:nowrap; flex-shrink:0;
    }
    .ib-link:hover { background:rgba(0,0,0,.05); color:#1a2533; }
    .ib-link.ib-active { background:rgba(201,98,26,.10); color:#c9621a; box-shadow:inset 0 -2px 0 #c9621a; }
    .ib-link-icon, .ib-dl-icon, .ib-bn-icon,
    .ib-link-label, .ib-dl-label, .ib-bn-label { pointer-events:none; }
    .ib-link-icon, .ib-dl-icon, .ib-bn-icon { flex-shrink:0; }
    #ib-hamburger, #ib-search-btn, #ib-drawer-close {
      border:0; background:none; cursor:pointer; color:#526070;
      border-radius:8px; line-height:1;
    }
    #ib-hamburger { display:none; padding:6px; font-size:22px; margin-right:auto; }
    #ib-search-btn { padding:7px 10px; font-size:17px; }
    #ib-hamburger:hover, #ib-search-btn:hover, #ib-drawer-close:hover { background:rgba(0,0,0,.06); }
    #ib-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:400; }
    #ib-overlay.open { display:block; }
    #ib-drawer {
      position:fixed; top:0; right:0; bottom:0; width:270px; z-index:401;
      transform:translateX(100%); transition:transform .27s cubic-bezier(.4,0,.2,1);
      display:flex; flex-direction:column; background:#fff;
      box-shadow:-4px 0 28px rgba(0,0,0,.14); font-family:Heebo,Arial,sans-serif;
    }
    #ib-drawer.open { transform:translateX(0); }
    #ib-drawer-head {
      height:58px; display:flex; align-items:center; gap:10px; flex-shrink:0;
      padding:0 16px; border-bottom:1px solid rgba(0,0,0,.09);
      background:linear-gradient(180deg,#fff 0%,#f8fafc 100%);
    }
    #ib-drawer-logo { width:176px; height:auto; object-fit:contain; display:block; }
    #ib-drawer-close { font-size:20px; padding:6px; margin-left:auto; }
    #ib-drawer-links { flex:1; overflow-y:auto; padding:8px; }
    .ib-drawer-group { padding:12px 10px 5px; color:#8fa0b0; font-size:11px; font-weight:900; }
    .ib-dl {
      display:flex; align-items:center; gap:12px;
      padding:11px 14px; border-radius:9px; margin-bottom:2px;
      color:#526070; font-size:14px; font-weight:700;
    }
    .ib-dl:hover { background:rgba(0,0,0,.04); color:#1a2533; }
    .ib-dl.ib-active { background:rgba(201,98,26,.10); color:#c9621a; }
    .ib-dl-icon { width:24px; text-align:center; font-size:17px; }
    #ib-bottom {
      display:none; position:fixed; bottom:0; right:0; left:0; z-index:300;
      height:60px; grid-template-columns:repeat(5,1fr);
      background:linear-gradient(180deg,#f8fafc 0%,#fff 100%);
      border-top:1px solid rgba(0,0,0,.10);
      box-shadow:0 -3px 14px rgba(0,0,0,.08);
    }
    .ib-bn {
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
      color:#8fa0b0; font-size:10px; font-weight:700; font-family:Heebo,Arial,sans-serif;
    }
    .ib-bn-icon { font-size:20px; line-height:1; }
    .ib-bn:hover { color:#526070; }
    .ib-bn.ib-active { color:#c9621a; }
    #ib-toast {
      position:fixed; bottom:72px; left:50%; transform:translateX(-50%);
      padding:10px 22px; border-radius:10px; font-family:Heebo,Arial,sans-serif;
      font-weight:800; font-size:13px; z-index:999; direction:rtl; white-space:nowrap;
      pointer-events:none; box-shadow:0 4px 18px rgba(0,0,0,.16); opacity:0; transition:opacity .4s;
    }
    #ib-search-bar {
      position:fixed; inset:0; z-index:900; display:none;
      align-items:flex-start; justify-content:center; padding-top:76px;
      background:rgba(2,12,28,.42); font-family:Heebo,Arial,sans-serif;
    }
    #ib-search-box { width:min(620px,92vw); background:#fff; border-radius:14px; box-shadow:0 24px 80px rgba(0,0,0,.24); overflow:hidden; }
    #ib-search-input { width:100%; border:0; border-bottom:1px solid #e2e8f0; padding:16px 18px; font:inherit; outline:0; }
    #ib-search-results { max-height:420px; overflow:auto; padding:8px; }
    body[data-page="pricing"] #ib-topnav,
    body[data-page="pricing"] #ib-bottom,
    body[data-page="pricing"] #ib-drawer,
    body[data-page="pricing"] #ib-search-bar {
      display:none !important;
    }
    .ib-sr-empty { padding:18px; color:#64748b; text-align:center; }
    .ib-sr-item { display:flex; gap:10px; padding:11px; border-radius:9px; text-decoration:none; color:#172234; }
    .ib-sr-item:hover { background:#f5f8fb; }
    .ib-sr-icon { font-size:18px; flex-shrink:0; }
    .ib-sr-ref { font-weight:900; }
    .ib-sr-label { color:#64748b; font-size:12px; }
    .ib-window-back-row {
      position:sticky; top:0; z-index:35;
      display:flex; justify-content:flex-start;
      padding:10px 12px 0;
      pointer-events:none;
    }
    .ib-window-back-btn {
      pointer-events:auto;
      border:1px solid rgba(2,26,72,.14);
      background:#fff;
      color:#c9621a;
      border-radius:999px;
      min-height:36px;
      padding:7px 13px;
      display:inline-flex; align-items:center; gap:6px;
      font-family:Heebo,Arial,sans-serif;
      font-size:13px; font-weight:900;
      cursor:pointer;
      box-shadow:0 6px 18px rgba(2,26,72,.10);
    }
    .ib-window-back-btn:hover { border-color:#c9621a; background:#fff7ef; }
    @media(max-width:768px) {
      #ib-logo-icon { width:132px; height:auto; }
      #ib-links { display:none; }
      #ib-hamburger { display:flex; align-items:center; }
    }
    @media(min-width:1024px) {
      body { padding-top:0 !important; padding-right:156px !important; padding-left:0 !important; }
      #ib-topnav {
        inset:0 0 0 auto; width:156px; height:100vh; padding:16px 10px;
        flex-direction:column; align-items:stretch; gap:14px;
        background:linear-gradient(180deg,#071c3b 0%,#021A48 58%,#00112f 100%);
        border-bottom:0; border-left:1px solid rgba(255,255,255,.10);
        box-shadow:-8px 0 32px rgba(2,26,72,.20);
      }
      #ib-logo { margin:0 0 8px; padding:4px 0 12px; border-bottom:1px solid rgba(255,255,255,.12); }
      #ib-logo-icon { width:118px; height:auto; filter:drop-shadow(0 8px 18px rgba(0,0,0,.28)); }
      #ib-links { display:flex; flex-direction:column; gap:4px; overflow-x:hidden; overflow-y:auto; padding:0 2px 10px; }
      .ib-group-label { display:block; }
      .ib-link {
        min-height:40px; padding:8px 10px; border-radius:10px;
        color:rgba(255,255,255,.82); font-size:12px; font-weight:800;
      }
      .ib-link:hover { background:rgba(255,255,255,.10); color:#fff; }
      .ib-link.ib-active {
        background:linear-gradient(135deg,rgba(223,80,0,.96),rgba(240,138,36,.88));
        color:#fff; box-shadow:0 10px 24px rgba(223,80,0,.25);
      }
      #ib-hamburger { display:none; }
    }
    @media(max-width:640px) {
      #ib-bottom { display:grid; }
      body { padding-bottom:64px !important; }
    }
  `;

  function escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function renderNavLinks(linkClass, groupClass) {
    let currentGroup = '';
    return visibleLinks.map(l => {
      const heading = l.group !== currentGroup
        ? (currentGroup = l.group, '<div class="'+groupClass+'">'+escapeAttr(l.group)+'</div>')
        : '';
      const isDrawer = linkClass === 'ib-dl';
      const iconClass = isDrawer ? 'ib-dl-icon' : 'ib-link-icon';
      const labelClass = isDrawer ? 'ib-dl-label' : 'ib-link-label';
      return heading +
        '<a href="'+escapeAttr(l.href)+'" class="'+linkClass+' '+ia(l.id)+'" title="'+escapeAttr(l.label)+'" aria-label="'+escapeAttr(l.label)+'">' +
          '<span class="'+iconClass+'" aria-hidden="true">'+escapeAttr(l.icon)+'</span>' +
          '<span class="'+labelClass+'">'+escapeAttr(l.label)+'</span>' +
        '</a>';
    }).join('');
  }

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  function renderBottomLinks() {
    return visibleLinks
      .filter(l => BOTTOM_IDS.includes(l.id))
      .map(l =>
        '<a href="'+escapeAttr(l.href)+'" class="ib-bn '+ia(l.id)+'" title="'+escapeAttr(l.label)+'" aria-label="'+escapeAttr(l.label)+'">' +
          '<span class="ib-bn-icon" aria-hidden="true">'+escapeAttr(l.icon)+'</span>' +
          '<span class="ib-bn-label">'+escapeAttr(l.label)+'</span>' +
        '</a>'
      ).join('');
  }

  function renderShellLinks() {
    const links = renderNavLinks('ib-link', 'ib-group-label');
    const drawerLinks = renderNavLinks('ib-dl', 'ib-drawer-group');
    const topLinks = document.getElementById('ib-links');
    const drawerLinksEl = document.getElementById('ib-drawer-links');
    const bottom = document.getElementById('ib-bottom');
    if (topLinks) topLinks.innerHTML = links;
    if (drawerLinksEl) drawerLinksEl.innerHTML = drawerLinks;
    if (bottom) bottom.innerHTML = renderBottomLinks();
  }

  function applyLicensedModules(data) {
    if (!data || !data.restricted || !Array.isArray(data.modules)) return;
    const enabled = new Set(data.modules);
    visibleLinks = LINKS.filter(link => {
      const moduleKey = LINK_MODULES[link.id];
      return !moduleKey || enabled.has(moduleKey);
    });
    renderShellLinks();
  }

  async function refreshLicensedModules() {
    try {
      const res = await fetch('/api/license/modules');
      if (!res.ok) return;
      applyLicensedModules(await res.json());
    } catch {}
  }

  function gotoLogin() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace('/login.html?redirect=' + next);
  }

  // nav.js is present only on protected app pages. Map the current page to its
  // registered manifest screen id so we can redirect away when the role may not
  // see it. Only screens whose manifest id is known to match are gated here;
  // pages without a cleanly-registered screen (e.g. pricing, profitability) are
  // left to server-side data guards so an admin is never wrongly bounced.
  const GATEABLE = {
    'orders': 'orders', 'new': 'new-order', 'intake': 'intake', 'customers': 'customers',
    'production-queue': 'production-queue', 'worker-visual': 'worker-visual', 'machine': 'machine',
    'kiosk': 'kiosk', 'production-setup': 'production-setup', 'warehouse': 'warehouse',
    'inventory': 'inventory', 'procurement': 'procurement', 'delivery-admin': 'delivery-admin',
    'driver': 'driver', 'quality': 'quality', 'maintenance': 'maintenance', 'warroom': 'warroom',
    'reports': 'reports', 'finance': 'finance', 'projects': 'projects', 'holdings': 'holdings',
    'admin': 'admin',
  };
  function currentScreenId() {
    const here = location.pathname.replace(/^\//, '') || 'dashboard.html';
    const link = LINKS.find(l => l.href.replace('/', '') === here);
    return link ? (GATEABLE[link.id] || null) : null;
  }

  async function applyAccessControl() {
    // No token at all → this page requires login. window.fetch is patched to
    // auto-refresh, so a merely-expired token still resolves below; we only
    // land here with a truly-absent session.
    const token = localStorage.getItem('ib_access_token') || sessionStorage.getItem('ib_access_token');
    if (!token) { gotoLogin(); return; }
    let res;
    try {
      res = await fetch('/api/access/me', { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      return; // network blip: leave the shell; server-side guards still protect data
    }
    if (res.status === 401) { gotoLogin(); return; }
    if (!res.ok) return;
    try {
      const { screens } = await res.json();
      if (!Array.isArray(screens)) return;
      const visibleIds = new Set(screens.map(s => s.id));
      // Role-gate the current page: if this screen is hidden for the role,
      // send the user to the dashboard (always allowed) instead of the shell.
      const screenId = currentScreenId();
      if (screenId && screenId !== 'dashboard' && !visibleIds.has(screenId)) {
        location.replace('/dashboard.html');
        return;
      }
      // Map screen IDs back to nav link IDs (some overlap, some differ)
      visibleLinks = LINKS.filter(link => {
        // Dashboard and the authenticated in-app scanner are universal shell
        // actions; the destination workflow still enforces its own role.
        if (link.id === 'dashboard' || link.id === 'scanner') return true;
        // Direct match
        if (visibleIds.has(link.id)) return true;
        // Map nav id → screen id
        const screenMap = {
          'new': 'new-order',
          'production-queue': 'production-queue',
          'worker-visual': 'worker-visual',
          'machine': 'machine',
          'kiosk': 'kiosk',
          'production-setup': 'production-setup',
          'delivery-admin': 'delivery-admin',
        };
        const mapped = screenMap[link.id];
        return mapped ? visibleIds.has(mapped) : false;
      });
      renderShellLinks();
    } catch {}
  }

  const topnav = document.createElement('nav');
  topnav.id = 'ib-topnav';
  topnav.innerHTML =
    '<a href="/dashboard.html" id="ib-logo" title="דשבורד" aria-label="דשבורד"><img id="ib-logo-icon" data-brand-logo src="/brand/tene-pdf-logo.jpg" alt="לוגו"></a>' +
    '<div id="ib-links">' + renderNavLinks('ib-link', 'ib-group-label') + '</div>' +
    '<button id="ib-search-btn" title="חיפוש (Ctrl+K)" aria-label="חיפוש">🔍</button>' +
    '<button id="ib-hamburger" aria-label="תפריט">☰</button>';

  const overlay = document.createElement('div');
  overlay.id = 'ib-overlay';

  const drawer = document.createElement('div');
  drawer.id = 'ib-drawer';
  drawer.innerHTML =
    '<div id="ib-drawer-head">' +
      '<a href="/dashboard.html" title="דשבורד" aria-label="דשבורד"><img id="ib-drawer-logo" data-brand-logo src="/brand/tene-pdf-logo.jpg" alt="לוגו"></a>' +
      '<button id="ib-drawer-close" aria-label="סגור">✕</button>' +
    '</div>' +
    '<div id="ib-drawer-links">' + renderNavLinks('ib-dl', 'ib-drawer-group') + '</div>';

  const bottomNav = document.createElement('nav');
  bottomNav.id = 'ib-bottom';
  bottomNav.innerHTML = renderBottomLinks();

  const toast = document.createElement('div');
  toast.id = 'ib-toast';

  const searchOverlay = document.createElement('div');
  searchOverlay.id = 'ib-search-bar';
  searchOverlay.innerHTML =
    '<div id="ib-search-box">' +
      '<input id="ib-search-input" type="text" placeholder="🔍  חיפוש הזמנה, לקוח, חבילה..." autocomplete="off">' +
      '<div id="ib-search-results"><div class="ib-sr-empty">הקלד לפחות 2 תווים לחיפוש</div></div>' +
    '</div>';

  function openDrawer() {
    drawer.classList.add('open');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  function openSearch() {
    searchOverlay.style.display = 'flex';
    setTimeout(() => document.getElementById('ib-search-input')?.focus(), 50);
  }

  function closeSearch() {
    searchOverlay.style.display = 'none';
    const input = document.getElementById('ib-search-input');
    const results = document.getElementById('ib-search-results');
    if (input) input.value = '';
    if (results) results.innerHTML = '<div class="ib-sr-empty">הקלד לפחות 2 תווים לחיפוש</div>';
  }

  const windowPanelSelector = [
    '.modal-overlay.open > .modal',
    '.modal-overlay.show > .modal',
    '.modal-bg.open > .modal',
    '.modal-bg.show > .modal',
    '.modal-backdrop.open > .modal',
    '.modal-backdrop.show > .modal',
    '.status-modal-overlay.open > .modal',
    '.detail-overlay.show > .detail-panel',
    '.intake-fullscreen.open > .intake-fullscreen-inner',
    '.receipt-fullscreen.open > .receipt-fullscreen-inner',
    '.edit-overlay.show > .edit-panel',
    '.img-modal-overlay.show > .img-modal',
    '#seOverlay.show > #seModal',
    'dialog[open]'
  ].join(',');

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  const windowShellSelector = [
    '.modal-overlay',
    '.modal-bg',
    '.modal-backdrop',
    '.status-modal-overlay',
    '.detail-overlay',
    '.intake-fullscreen',
    '.receipt-fullscreen',
    '.edit-overlay',
    '.img-modal-overlay',
    '#seOverlay'
  ].join(',');

  function closeWindowPanel(panel) {
    // Window back must never click a broad generic button. It either calls an
    // explicit close/back control or closes only the containing overlay shell.
    if (panel?.matches?.('dialog[open]') && typeof panel.close === 'function') {
      panel.close();
      document.body.style.overflow = '';
      return;
    }

    const closeCandidate = Array.from(panel.querySelectorAll(
      '.modal-close, .detail-close, .img-modal-close, .se-close, .close-btn, [data-close], [data-window-back]'
    )).find(el => {
      if (el.classList.contains('ib-window-back-btn') || !isVisible(el)) return false;
      const action = String(el.getAttribute('onclick') || '').toLowerCase();
      const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
      return /close|back|showscreen/.test(action) || /close|back/.test(aria);
    });
    if (closeCandidate) {
      closeCandidate.click();
      return;
    }

    const shell = panel.closest(windowShellSelector);
    if (!shell) return;
    shell.classList.remove('open', 'show');
    shell.removeAttribute('aria-modal');
    if (getComputedStyle(shell).display !== 'none') shell.style.display = 'none';
    document.body.style.overflow = '';
  }

  function topWindowPanel() {
    const panels = Array.from(document.querySelectorAll(windowPanelSelector)).filter(isVisible);
    return panels[panels.length - 1] || null;
  }

  function closeTopWindowPanel() {
    const panel = topWindowPanel();
    if (!panel) return false;
    closeWindowPanel(panel);
    return true;
  }

  function enhanceWindowBackControls(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(windowPanelSelector).forEach(panel => {
      // Order detail already owns a sticky header with an explicit close control.
      // Adding the generic sticky "back" row here overlaps its order identifier
      // while scrolling on narrow screens.
      if (panel.matches('.detail-panel')) return;
      if (panel.querySelector(':scope > .ib-window-back-row')) return;
      const row = document.createElement('div');
      row.className = 'ib-window-back-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ib-window-back-btn';
      btn.setAttribute('aria-label', '\u05d7\u05d6\u05e8\u05d4');
      btn.textContent = '\u2190 \u05d7\u05d6\u05e8\u05d4';
      btn.addEventListener('click', () => closeWindowPanel(panel));
      row.appendChild(btn);
      panel.insertBefore(row, panel.firstChild);
    });
  }

  function watchWindowBackControls() {
    enhanceWindowBackControls(document);
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.addedNodes.length) {
          enhanceWindowBackControls(document);
          break;
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'open']
    });
    window.IronBendWindowBack = { closeTop: closeTopWindowPanel, enhance: enhanceWindowBackControls };
  }

  function mount() {
    document.querySelectorAll('nav.topnav, .topnav').forEach(el => el.remove());
    document.body.insertBefore(topnav, document.body.firstChild);
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
  document.body.appendChild(bottomNav);
  document.body.appendChild(toast);
  document.body.appendChild(searchOverlay);
  refreshLicensedModules();
  applyAccessControl();
  watchWindowBackControls();

    document.getElementById('ib-hamburger')?.addEventListener('click', openDrawer);
    document.getElementById('ib-drawer-close')?.addEventListener('click', closeDrawer);
    document.getElementById('ib-search-btn')?.addEventListener('click', openSearch);
    overlay.addEventListener('click', closeDrawer);
    drawer.querySelectorAll('.ib-dl').forEach(a => a.addEventListener('click', closeDrawer));
    searchOverlay.addEventListener('click', e => { if (e.target === searchOverlay) closeSearch(); });

    const input = document.getElementById('ib-search-input');
    let searchTimer;
    input?.addEventListener('input', function () {
      clearTimeout(searchTimer);
      const q = this.value.trim();
      const resultsEl = document.getElementById('ib-search-results');
      if (q.length < 2) {
        resultsEl.innerHTML = '<div class="ib-sr-empty">הקלד לפחות 2 תווים לחיפוש</div>';
        return;
      }
      resultsEl.innerHTML = '<div class="ib-sr-empty">מחפש...</div>';
      searchTimer = setTimeout(async () => {
        try {
          const _searchToken = localStorage.getItem('ib_access_token') || sessionStorage.getItem('ib_access_token');
          const r = await fetch('/api/search?q=' + encodeURIComponent(q), {
            headers: _searchToken ? { Authorization: 'Bearer ' + _searchToken } : {}
          });
          const { results = [] } = await r.json();
          resultsEl.innerHTML = results.length
            ? results.map(res =>
                '<a class="ib-sr-item" href="' + escapeAttr(res.url) + '" onclick="closeSearch&&closeSearch()">' +
                  '<span class="ib-sr-icon">' + escapeAttr(res.icon) + '</span>' +
                  '<div><div class="ib-sr-ref">' + escapeAttr(res.ref) + '</div>' +
                  '<div class="ib-sr-label">' + escapeAttr(res.label || '') + (res.status ? ' · ' + escapeAttr(res.status) : '') + '</div></div>' +
                '</a>'
              ).join('')
            : '<div class="ib-sr-empty">לא נמצאו תוצאות</div>';
        } catch (_) {
          resultsEl.innerHTML = '<div class="ib-sr-empty">שגיאת חיפוש</div>';
        }
      }, 280);
    });
    input?.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && closeTopWindowPanel()) {
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
      }
    });
  }

  window.closeSearch = closeSearch;
  window.showToast = function (msg, isError) {
    const t = document.getElementById('ib-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = isError ? '#b83227' : '#1a7a42';
    t.style.color = 'white';
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('online', () => window.showToast && window.showToast('החיבור חזר'));
  window.addEventListener('offline', () => window.showToast && window.showToast('אין חיבור לרשת', true));
})();
