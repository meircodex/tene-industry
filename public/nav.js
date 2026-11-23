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
    { group:'בקרה', href:'/bugs.html', icon:'🛠️', label:'תקלות', id:'bugs' },
    { group:'בקרה', href:'/warroom.html', icon:'🚨', label:'War Room', id:'warroom' },
    { group:'בקרה', href:'/reports.html', icon:'📈', label:'דוחות', id:'reports' },

    { group:'ניהול', href:'/finance.html', icon:'💰', label:'פיננסים', id:'finance' },
    { group:'ניהול', href:'/profitability.html', icon:'📊', label:'ריווחיות', id:'profitability' },
    { group:'ניהול', href:'/pricing.html', icon:'₪', label:'מחירונים', id:'pricing' },
    { group:'ניהול', href:'/projects.html', icon:'🏗️', label:'פרויקטים', id:'projects' },
    { group:'ניהול', href:'/holdings.html', icon:'🏢', label:'אחזקות', id:'holdings' },
    { group:'ניהול', href:'/admin.html', icon:'⚙️', label:'ניהול מערכת', id:'admin' },
  ];

  const BOTTOM_IDS = ['dashboard', 'orders', 'production-queue', 'inventory'];
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
    profitability: 'finance',
    projects: 'companies',
    holdings: 'companies',
  };
  // One navigation policy for desktop, mobile and subsequent access refreshes.
  const PRIMARY_IDS = ['new','dashboard','orders','production-queue','inventory','procurement','customers','reports'];
  const REMOVED_NAV_IDS = new Set(['delivery-admin','driver','holdings','warroom']);
  const SETTINGS_IDS = ['machine','kiosk','production-setup','scanner','worker-visual','support','bugs','admin'];
  function buildNavigation(links) {
    const remaining=new Map(links.filter(l=>!REMOVED_NAV_IDS.has(l.id)).map(l=>[l.id,l]));
    const take=id=>{const link=remaining.get(id);remaining.delete(id);return link?{key:id,link,children:[]}:null;};
    const roots=PRIMARY_IDS.map(take).filter(Boolean);
    const customers=roots.find(n=>n.key==='customers'),projects=take('projects');
    if(customers&&projects)customers.children.push(projects);
    const settings=SETTINGS_IDS.map(take).filter(Boolean);
    const finance=take('finance'),financeChildren=['profitability','pricing'].map(take).filter(Boolean);
    const more=[...remaining.values()].map(link=>({key:link.id,link,children:[]}));
    if(projects&&!customers)more.push(projects);
    if(finance){finance.children=financeChildren;more.push(finance);}
    else if(financeChildren.length)more.push({key:'finance-tools',label:'כספים',icon:'💰',children:financeChildren});
    if(more.length)roots.push({key:'more',label:'עוד',icon:'⋯',children:more});
    if(settings.length)roots.push({key:'settings',label:'הגדרות',icon:'⚙️',children:settings});
    return roots;
  }
  const navExpansion=new Map();
  let licensedModules=null,roleScreens=null;
  function permittedLink(link) {
    const moduleKey=LINK_MODULES[link.id],enabled=licensedModules;
    if(enabled&&moduleKey&&!enabled.has(moduleKey))return false;
    if(!roleScreens)return true;
    if(link.id==='dashboard'||link.id==='scanner')return true;
    const screenMap={new:'new-order',pricing:'finance',profitability:'finance'};
    return roleScreens.has(link.id)||roleScreens.has(screenMap[link.id]);
  }
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
    .ib-link.ib-active { background:#F8EDE4; color:#8A3E0C; box-shadow:inset -3px 0 0 #C45C12; }
    .ib-link-icon, .ib-dl-icon, .ib-bn-icon,
    .ib-link-label, .ib-dl-label, .ib-bn-label { pointer-events:none; }
    .ib-link-icon, .ib-dl-icon, .ib-bn-icon { flex-shrink:0; }
    #ib-hamburger, #ib-search-btn, #ib-drawer-close {
      border:0; background:none; cursor:pointer; color:#526070;
      border-radius:8px; line-height:1;
    }
    #ib-hamburger { display:none; padding:6px; font-size:22px; margin-right:auto; }
    #ib-search-btn { padding:7px 10px; font-size:12px; font-weight:800; font-family:Heebo,Arial,sans-serif; }
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
    .ib-bn.ib-active { color:#8A3E0C; }
    #ib-toast {
      position:fixed; bottom:72px; left:50%; transform:translateX(-50%);
      padding:10px 22px; border-radius:10px; font-family:Heebo,Arial,sans-serif;
      font-weight:800; font-size:13px; z-index:999; direction:rtl; white-space:nowrap;
      pointer-events:none; box-shadow:0 4px 18px rgba(0,0,0,.16); opacity:0; transition:opacity .4s;
    }
    #ib-search-bar {
      position:fixed; inset:0; z-index:900; display:none;
      align-items:flex-start; justify-content:center; padding-top:76px;
      background:rgba(26,35,48,.46); font-family:Heebo,Arial,sans-serif;
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
      border:1px solid #D7DEE6;
      background:#fff;
      color:#8A3E0C;
      border-radius:999px;
      min-height:36px;
      padding:7px 13px;
      display:inline-flex; align-items:center; gap:6px;
      font-family:Heebo,Arial,sans-serif;
      font-size:13px; font-weight:900;
      cursor:pointer;
      box-shadow:0 6px 18px rgba(2,26,72,.10);
    }
    .ib-window-back-btn:hover { border-color:#C45C12; background:#F8EDE4; }
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
        background:#F7F8FA;
        border-bottom:0; border-left:1px solid #D7DEE6;
        box-shadow:none;
      }
      #ib-logo { margin:0 0 8px; padding:4px 0 12px; border-bottom:1px solid #D7DEE6; }
      #ib-logo-icon { width:118px; height:auto; }
      #ib-links { display:flex; flex-direction:column; gap:4px; overflow-x:hidden; overflow-y:auto; padding:0 2px 10px; }
      .ib-group-label { display:block; }
      .ib-link {
        min-height:40px; padding:8px 10px; border-radius:10px;
        color:#3E4C5A; font-size:12px; font-weight:800;
      }
      .ib-link:hover { background:#EEF1F4; color:#1A2330; }
      .ib-link.ib-active {
        background:#F8EDE4;
        color:#8A3E0C; box-shadow:inset -3px 0 0 #C45C12;
      }
      #ib-hamburger { display:none; }
    }
    @media(max-width:640px) {
      #ib-bottom { display:grid; }
      body { padding-bottom:64px !important; }
    }

    /* Compact hierarchy; secondary screens stay behind role-filtered controls. */
    .ib-nav-row{display:flex;align-items:center;min-width:0}.ib-nav-row>a{flex:1;min-width:0}
    .ib-nav-toggle{font:inherit;cursor:pointer;border:0;background:transparent;color:inherit;text-align:start}
    .ib-nav-row>.ib-nav-toggle:not(.ib-nav-caret){width:100%}.ib-nav-chevron{margin-inline-start:auto;font-size:15px}
    .ib-nav-caret{flex:none;min-width:28px;min-height:36px;padding:4px;border-radius:6px;color:#718397}
    .ib-nav-children{padding-inline-start:12px;margin:2px 0 5px}.ib-nav-children a{font-size:12px;min-height:34px;padding:7px 8px}.ib-nav-children[hidden]{display:none}
    .ib-nav-toggle:focus-visible{outline:2px solid #C45C12;outline-offset:2px}.ib-new-order{background:#C45C12!important;color:white!important;justify-content:center;margin-bottom:7px}
    #ib-bottom{grid-template-columns:none;grid-auto-columns:1fr;grid-auto-flow:column}#ib-bottom button{border:0;background:transparent;padding:0}
    .ib-mark::before{content:attr(data-letter)}
    @media(min-width:1024px){#ib-links{gap:2px}.ib-nav-toggle.ib-link,.ib-nav-caret{color:#3E4C5A}.ib-nav-children{border-inline-start:1px solid #D7DEE6}.ib-nav-row .ib-link{padding-inline-end:4px}.ib-link{min-height:36px;padding:7px 8px}}
    @media(max-width:1023px){#ib-links{display:none}#ib-hamburger{display:flex;align-items:center}}
    @media(pointer:coarse){.ib-nav-caret,.ib-nav-toggle,.ib-nav-children a{min-height:44px}.ib-nav-caret{min-width:44px}}
  `;

  function escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  const MARKS = {
    dashboard:'דש', orders:'הז', new:'חד', intake:'קל', customers:'לק',
    'production-queue':'תו', 'worker-visual':'אס', machine:'מכ', kiosk:'תח',
    'production-setup':'יי', warehouse:'מס', inventory:'מל', procurement:'רכ',
    quality:'אי', maintenance:'תז', support:'תמ', bugs:'תק', reports:'דו',
    finance:'כס', profitability:'רו', pricing:'מח', projects:'פר', admin:'נה',
    scanner:'סר', more:'עוד', settings:'הג'
  };

  function renderNavLinks(linkClass) {
    const drawer=linkClass==='ib-dl',iconClass=drawer?'ib-dl-icon':'ib-link-icon',labelClass=drawer?'ib-dl-label':'ib-link-label';
    const includesActive=node=>node.link?.id===activeId||node.children.some(includesActive);
    const mark=id=>'<span class="'+iconClass+' ib-mark" data-mark="'+escapeAttr(id)+'" data-letter="'+escapeAttr(MARKS[id]||'')+'" aria-hidden="true"></span>';
    const anchor=node=>'<a href="'+escapeAttr(node.link.href)+'" class="'+linkClass+' '+ia(node.link.id)+(node.key==='new'?' ib-new-order':'')+'" title="'+escapeAttr(node.link.label)+'" aria-label="'+escapeAttr(node.link.label)+'"'+(node.link.id===activeId?' aria-current="page"':'')+'>'+mark(node.link.id)+'<span class="'+labelClass+'">'+escapeAttr(node.link.label)+'</span></a>';
    const render=node=>{
      if(!node.children.length)return anchor(node);
      const open=navExpansion.has(node.key)?navExpansion.get(node.key):includesActive(node),id=linkClass+'-'+node.key+'-children';
      const button='<button type="button" class="ib-nav-toggle '+(node.link?'ib-nav-caret':linkClass)+'" data-nav-group="'+escapeAttr(node.key)+'" aria-expanded="'+open+'" aria-controls="'+id+'"'+(node.link?' aria-label="אפשרויות '+escapeAttr(node.link.label)+'"':'')+'>'+(node.link?'':(mark(node.key)+'<span class="'+labelClass+'">'+escapeAttr(node.label)+'</span>'))+'<span class="ib-nav-chevron" aria-hidden="true">'+(open?'⌃':'⌄')+'</span></button>';
      return '<div class="ib-nav-branch '+(includesActive(node)?'ib-nav-current':'')+'"><div class="ib-nav-row">'+(node.link?anchor(node):'')+button+'</div><div id="'+id+'" class="ib-nav-children"'+(open?'':' hidden')+'>'+node.children.map(render).join('')+'</div></div>';
    };
    return buildNavigation(visibleLinks).map(render).join('');
  }

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  function renderBottomLinks() {
    return BOTTOM_IDS.map(id=>visibleLinks.find(l=>l.id===id)).filter(Boolean)
      .map(l=>'<a href="'+escapeAttr(l.href)+'" class="ib-bn '+ia(l.id)+'" title="'+escapeAttr(l.label)+'" aria-label="'+escapeAttr(l.label)+'"><span class="ib-bn-icon ib-mark" data-mark="'+escapeAttr(l.id)+'" data-letter="'+escapeAttr(MARKS[l.id]||'')+'" aria-hidden="true"></span><span class="ib-bn-label">'+escapeAttr(l.label)+'</span></a>').join('')+
      '<button type="button" class="ib-bn ib-open-menu" aria-label="תפריט"><span class="ib-bn-icon" aria-hidden="true">☰</span><span class="ib-bn-label">עוד</span></button>';
  }

  function renderShellLinks() {
    const links = renderNavLinks('ib-link');
    const drawerLinks = renderNavLinks('ib-dl');
    const topLinks = document.getElementById('ib-links');
    const drawerLinksEl = document.getElementById('ib-drawer-links');
    const bottom = document.getElementById('ib-bottom');
    if (topLinks) topLinks.innerHTML = links;
    if (drawerLinksEl) drawerLinksEl.innerHTML = drawerLinks;
    if (bottom) bottom.innerHTML = renderBottomLinks();
  }

  function rebuildVisibleLinks() {
    visibleLinks = LINKS.filter(permittedLink);
    renderShellLinks();
  }
  function applyLicensedModules(data) {
    if(!data)return;
    if(!data.restricted){licensedModules=null;rebuildVisibleLinks();return;}
    if(!Array.isArray(data.modules))return;
    licensedModules=new Set(data.modules);
    rebuildVisibleLinks();
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
    let token = sessionStorage.getItem('ib_access_token') || localStorage.getItem('ib_access_token');
    if(!token){try{token=await window.IronBendAuth?.refreshAccessToken();}catch{}if(!token){gotoLogin();return;}}
    let res;
    try {
      res = await fetch('/api/access/me', { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      return; // network blip: leave the shell; server-side guards still protect data
    }
    if (res.status === 401) { gotoLogin(); return; }
    if (!res.ok) return;
    try {
      const { screens,role } = await res.json();
      if (!Array.isArray(screens)) return;
      if(role)localStorage.setItem('ib_role',role);
      const visibleIds = new Set(screens.map(s => s.id));
      // Role-gate the current page: if this screen is hidden for the role,
      // send the user to the dashboard (always allowed) instead of the shell.
      const screenId = currentScreenId();
      if (screenId && screenId !== 'dashboard' && !visibleIds.has(screenId)) {
        location.replace('/dashboard.html');
        return;
      }
      roleScreens=visibleIds;
      rebuildVisibleLinks();
    } catch {}
  }

  const topnav = document.createElement('nav');
  topnav.id = 'ib-topnav';
  topnav.innerHTML =
    '<a href="/dashboard.html" id="ib-logo" title="דשבורד" aria-label="דשבורד"><img id="ib-logo-icon" data-brand-logo src="/brand/tene-pdf-logo.jpg" alt="לוגו"></a>' +
    '<div id="ib-links">' + renderNavLinks('ib-link') + '</div>' +
    '<button id="ib-search-btn" title="חיפוש (Ctrl+K)" aria-label="חיפוש">חיפוש</button>' +
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
    '<div id="ib-drawer-links">' + renderNavLinks('ib-dl') + '</div>';

  const bottomNav = document.createElement('nav');
  bottomNav.id = 'ib-bottom';
  bottomNav.innerHTML = renderBottomLinks();

  const toast = document.createElement('div');
  toast.id = 'ib-toast';

  const searchOverlay = document.createElement('div');
  searchOverlay.id = 'ib-search-bar';
  searchOverlay.innerHTML =
    '<div id="ib-search-box">' +
      '<input id="ib-search-input" type="text" placeholder="חיפוש הזמנה, לקוח או חבילה" autocomplete="off">' +
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
  // A manager can change a linked user's role while their screen remains open.
  setInterval(()=>{if(!document.hidden)applyAccessControl();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)applyAccessControl();});
  watchWindowBackControls();

    document.getElementById('ib-hamburger')?.addEventListener('click', openDrawer);
    document.getElementById('ib-drawer-close')?.addEventListener('click', closeDrawer);
    document.getElementById('ib-search-btn')?.addEventListener('click', openSearch);
    overlay.addEventListener('click', closeDrawer);
    drawer.addEventListener('click',e=>{if(e.target.closest('a.ib-dl'))closeDrawer();});
    bottomNav.addEventListener('click',e=>{if(e.target.closest('.ib-open-menu'))openDrawer();});
    function toggleGroup(e,scope){
      const button=e.target.closest('[data-nav-group]');if(!button)return;e.stopPropagation();
      const key=button.dataset.navGroup;navExpansion.set(key,button.getAttribute('aria-expanded')!=='true');
      renderShellLinks();scope.querySelector('[data-nav-group="'+key+'"]')?.focus();
    }
    topnav.addEventListener('click',e=>toggleGroup(e,topnav));
    drawer.addEventListener('click',e=>toggleGroup(e,drawer));
    function collapseGroups(){
      const expanded=document.querySelectorAll('[data-nav-group][aria-expanded="true"]');
      if(!expanded.length)return;for(const button of expanded)navExpansion.set(button.dataset.navGroup,false);renderShellLinks();
    }
    document.addEventListener('click',e=>{if(!topnav.contains(e.target)&&!drawer.contains(e.target)&&!bottomNav.contains(e.target))collapseGroups();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')collapseGroups();});
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
