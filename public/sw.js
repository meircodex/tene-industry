const CACHE_VERSION = 'ironbend-v25';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;

const STATIC_ASSETS = [
  '/index.html',
  '/dashboard.html',
  '/scan.html',
  '/worker-invite.html',
  '/worker-manifest.json',
  '/customer-scan.html',
  '/orders.html',
  '/machine.html',
  '/offline.html',
  '/manifest.json',
  '/brand/tene-pdf-logo.jpg',
  '/offline-db.js',
  'https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap',
];

const API_CACHE_URLS = [
  '/api/orders',
  '/api/customers',
  '/api/dashboard',
  '/api/machines',
];

// ── INSTALL ───────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS.filter(u => !u.startsWith('http') || navigator.onLine)))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== STATIC_CACHE && k !== API_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and WebSocket
  if (e.request.method !== 'GET' || url.protocol === 'ws:') return;

  // API: network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirstAPI(e.request));
    return;
  }

  // HTML pages: network-first (always get fresh content)
  if (url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(networkFirstHTML(e.request));
    return;
  }

  // JS and CSS: always network-first so code changes are seen immediately
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    e.respondWith(networkFirstHTML(e.request));
    return;
  }

  // Other static assets (images, icons, fonts): cache-first
  e.respondWith(cacheFirstStatic(e.request));
});

async function networkFirstAPI(request) {
  const url = new URL(request.url);
  const shouldCache = API_CACHE_URLS.some(u => url.pathname.startsWith(u));
  try {
    const response = await fetch(request);
    if (response.ok && shouldCache) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // A scan acknowledgment must come from the server, never an offline copy.
    if (url.pathname.startsWith('/api/worker-card') || url.pathname.startsWith('/api/qr-access')) {
      return new Response(JSON.stringify({ error: 'scan_confirmation_unavailable', offline: true }), {
        status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    const cached = await caches.match(request);
    return cached ?? new Response(JSON.stringify({ offline: true, data: [] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function networkFirstHTML(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match('/offline.html') ?? new Response('<h1>אין חיבור</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const offline = await caches.match('/offline.html');
    return offline ?? new Response('<h1>אין חיבור לאינטרנט</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
}

// ── BACKGROUND SYNC ───────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-orders') {
    e.waitUntil(syncPendingOrders());
  }
});

async function syncPendingOrders() {
  const db = await openDB();
  const pending = await getAllPending(db);
  for (const item of pending) {
    try {
      const r = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      if (r.ok) {
        const result = await r.json();
        await deletePending(db, item.id);
        // Notify all clients
        const clients = await self.clients.matchAll();
        clients.forEach(c => c.postMessage({ type: 'order_synced', localId: item.id, orderNum: result.orderNum }));
      }
    } catch { /* will retry next sync */ }
  }
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'IronBend', {
      body: data.body ?? '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      dir: 'rtl',
      lang: 'he',
      data: { url: data.url ?? '/dashboard.html' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});

// ── INDEXEDDB HELPERS ─────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ironbend-offline', 2);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('pending_orders')) {
        db.createObjectStore('pending_orders', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_orders', 'readonly');
    const req = tx.objectStore('pending_orders').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function deletePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_orders', 'readwrite');
    const req = tx.objectStore('pending_orders').delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
