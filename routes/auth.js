const router = require('express').Router();

function required(name, value) {
  if (!value) throw new Error(`routes/auth missing dependency: ${name}`);
  return value;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const pos = part.indexOf('=');
        return pos === -1
          ? [decodeURIComponent(part), '']
          : [decodeURIComponent(part.slice(0, pos)), decodeURIComponent(part.slice(pos + 1))];
      })
  );
}

function refreshCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Number(process.env.REFRESH_TOKEN_DAYS || 7) * 24 * 60 * 60;
  return `refresh_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${maxAge}${secure}`;
}

module.exports = function createAuthRouter(deps) {
  const authService = required('authService', deps.authService);
  const authLoginLimiter = required('authLoginLimiter', deps.authLoginLimiter);

  router.post('/auth/worker-login', authLoginLimiter, (req,res)=>{
    const result=authService.authenticateWorker(req.body||{},{ipAddress:req.ip,userAgent:req.headers['user-agent']});
    if(!result.ok)return res.status(result.status).json({error:result.error});
    res.append('Set-Cookie',refreshCookie(result.refreshToken));res.json({access_token:result.accessToken,user:result.user});
  });

  router.post('/auth/login', authLoginLimiter, (req, res) => {
    const result = authService.authenticate(req.body, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.append('Set-Cookie', refreshCookie(result.refreshToken));
    res.json({ access_token: result.accessToken, user: result.user });
  });

  router.post('/auth/refresh', (req, res) => {
    const result = authService.refresh(parseCookies(req).refresh_token, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.append('Set-Cookie', refreshCookie(result.refreshToken));
    res.json({ access_token: result.accessToken, user: result.user });
  });

  router.post('/auth/logout', (req, res) => {
    const refreshToken = parseCookies(req).refresh_token;
    if (!refreshToken && !req.auth) {
      res.setHeader('Set-Cookie', 'refresh_token=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0');
      return res.status(401).json({ error: 'Logout requires an active session' });
    }
    if(req.auth?.portal_only)authService.revokePortalSessions(req.auth.sub);
    else authService.logout(refreshToken);
    res.setHeader('Set-Cookie', 'refresh_token=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0');
    res.json({ success: true });
  });

  router.post('/users/login', (req, res) => {
    res.status(410).json({ error: 'Legacy login is disabled. Use /api/auth/login.' });
  });

  return router;
};

module.exports.manifest = {
  screens: [],
  access: { default: 'hidden', roles: { admin: 'edit' } },
  "id": "auth",
  "label": "Auth",
  "consumes": [
    {
      "table": "users"
    },
    {
      "table": "refresh_tokens"
    }
  ],
  "produces": []
};
