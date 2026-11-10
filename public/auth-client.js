(function () {
  if (window.IronBendAuth?.installed) return;

  const nativeFetch = window.fetch.bind(window);
  const ACCESS_KEY = 'ib_access_token';
  const ROLE_KEY = 'ib_role';
  const USER_KEY = 'ib_user';
  const DEVICE_KEY = 'ironbend_device_credential_v1';

  function accessToken() {
    return sessionStorage.getItem(ACCESS_KEY) || localStorage.getItem(ACCESS_KEY);
  }

  function currentUser() {
    return {
      username: sessionStorage.getItem(USER_KEY) || localStorage.getItem(USER_KEY) || '',
      role: sessionStorage.getItem(ROLE_KEY) || localStorage.getItem(ROLE_KEY) || '',
    };
  }

  function deviceCredential() {
    return localStorage.getItem(DEVICE_KEY) || '';
  }

  function clearSession() {
    for (const storage of [sessionStorage, localStorage]) {
      storage.removeItem(ACCESS_KEY);
      storage.removeItem(ROLE_KEY);
      storage.removeItem(USER_KEY);
    }
  }

  function storeSession(result, remember = true) {
    if (!result?.access_token || !result?.user) throw new Error('Invalid auth response');
    const primary = remember ? localStorage : sessionStorage;
    const secondary = remember ? sessionStorage : localStorage;

    secondary.removeItem(ACCESS_KEY);
    secondary.removeItem(USER_KEY);
    primary.setItem(ACCESS_KEY, result.access_token);
    primary.setItem(USER_KEY, result.user.username || '');

    // Role is display/navigation state only. Server permissions come from JWT.
    primary.setItem(ROLE_KEY, result.user.role || '');
    localStorage.setItem(ROLE_KEY, result.user.role || '');
  }

  // Single-flight refresh: a dashboard fires many API calls at once, and when
  // the access token expires they all get 401 together. Without this, each one
  // POSTs /api/auth/refresh with the same rotating cookie — the first rotates
  // it and the rest fail with a revoked token, forcing a spurious re-login.
  // One shared promise means concurrent 401s share a single refresh.
  let refreshInFlight = null;
  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const response = await nativeFetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) return null;
        const result = await response.json();
        storeSession(result, true);
        return result.access_token;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  function isApiUrl(url) {
    return url.startsWith('/api/') || url.includes('/api/');
  }

  function isAuthUrl(url) {
    return url.includes('/api/auth/');
  }

  function isQrWorkflowUrl(url) {
    return url.includes('/api/qr-access/') || url.includes('/api/device-enrollment/')
      || url.includes('/api/worker-invitations/activation') || url.includes('/api/worker-card')
      || url.includes('/api/loading/card-sessions');
  }

  function showAuthNotice(status) {
    if (document.getElementById('ib-auth-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'ib-auth-notice';
    notice.dir = 'rtl';
    notice.style.cssText = [
      'position:fixed',
      'left:18px',
      'bottom:18px',
      'z-index:2000',
      'max-width:420px',
      'background:#ffffff',
      'border:1px solid rgba(184,50,39,0.28)',
      'box-shadow:0 14px 40px rgba(0,0,0,0.18)',
      'border-radius:12px',
      'padding:14px 16px',
      'font-family:Heebo,Arial,sans-serif',
      'color:#1a2533',
    ].join(';');
    const message = status === 403
      ? 'השרת עובד, אבל אין למשתמש הנוכחי הרשאה לפעולה הזו.'
      : 'השרת עובד, אבל נדרשת התחברות מחדש כדי לטעון נתונים.';
    notice.innerHTML = `
      <div style="font-weight:900;margin-bottom:4px">נדרשת התחברות</div>
      <div style="font-size:13px;color:#526070;margin-bottom:10px">${message}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" id="ib-auth-dismiss" style="border:1px solid rgba(0,0,0,0.16);background:#fff;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer">סגור</button>
        <button type="button" id="ib-auth-login" style="border:0;background:#c9621a;color:#fff;border-radius:8px;padding:7px 12px;font-weight:900;cursor:pointer">להתחברות</button>
      </div>
    `;
    document.body.appendChild(notice);
    document.getElementById('ib-auth-dismiss')?.addEventListener('click', () => notice.remove());
    document.getElementById('ib-auth-login')?.addEventListener('click', () => {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
    });
  }

  function webSocketUrl(path = '/') {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URL(path, `${protocol}://${location.host}`);
    const token = accessToken();
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  function presentResponse(response, url, method) {
    if (!window.IronBendMessages || !isApiUrl(url) || typeof response.json !== 'function') return response;
    const json = response.json.bind(response);
    const context = { status: response.status, path: url, method,
      requestId: response.headers?.get?.('X-Request-Id') };
    response.json = async () => {
      let data;
      try { data = await json(); }
      catch (cause) { throw new Error(window.IronBendMessages.text('invalid_json_response', context), { cause }); }
      if (data && typeof data === 'object' && typeof data.error === 'string' && !data.user_message) {
        data.user_message = window.IronBendMessages.text(data.error, { ...context, requestId: data._requestId || context.requestId });
      }
      return data;
    };
    return response;
  }

  async function authFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const isApi = isApiUrl(url);
    const isAuth = isAuthUrl(url);
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    const token = accessToken();
    const device = deviceCredential();

    headers.delete('x-user-role');
    headers.delete('x-user-id');
    if (isApi && !isAuth && token) headers.set('Authorization', `Bearer ${token}`);
    if (isApi && device) headers.set('X-IronBend-Device', device);

    const method = init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET';
    const send = async () => {
      try { return await nativeFetch(input, { ...init, headers, credentials: init.credentials || 'same-origin' }); }
      catch (cause) {
        if (!isApi || !window.IronBendMessages) throw cause;
        const error = new Error(window.IronBendMessages.text(cause, { path: url, method }), { cause });
        error.name = cause.name || 'Error';
        throw error;
      }
    };
    let response = await send();
    if (response.status === 401 && isApi && !isAuth) {
      let refreshedToken;
      try { refreshedToken = await refreshAccessToken(); }
      catch (cause) {
        if (!window.IronBendMessages) throw cause;
        throw new Error(window.IronBendMessages.text(cause, { path: url, method }), { cause });
      }
      if (refreshedToken) {
        headers.set('Authorization', `Bearer ${refreshedToken}`);
        response = await send();
      }
    }
    if (isApi && !isAuth && !isQrWorkflowUrl(url) && (response.status === 401 || response.status === 403)) {
      showAuthNotice(response.status);
      window.dispatchEvent(new CustomEvent('ironbend:auth-denied', {
        detail: { status: response.status, url },
      }));
      if (response.status === 403 && window.showToast) {
        window.showToast('אין הרשאה לפעולה זו', true);
      }
    }
    return presentResponse(response, url, method);
  }

  window.IronBendAuth = {
    installed: true,
    fetch: authFetch,
    nativeFetch,
    accessToken,
    currentUser,
    deviceCredential,
    storeSession,
    clearSession,
    refreshAccessToken,
    webSocketUrl,
  };

  window.__ironBendFetchInstalled = true;
  window.fetch = authFetch;
})();
