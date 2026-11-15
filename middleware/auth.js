'use strict';

const crypto = require('crypto');

function required(name, value) {
  if (!value) throw new Error(`middleware/auth missing dependency: ${name}`);
  return value;
}

function createAuthMiddleware(deps) {
  const authService = required('authService', deps.authService);
  const getRolePermission = required('getRolePermission', deps.getRolePermission);
  const authBypassEnabled = process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'development';
  const authBypassRole = getRolePermission(process.env.AUTH_BYPASS_ROLE || 'admin')?.role || 'admin';
  let authBypassWarned = false;

  function bearerToken(req) {
    const header = String(req.headers.authorization || '');
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  function applyAuthBypass(req) {
    if (!authBypassEnabled || req.auth) return;
    if (!authBypassWarned) {
      console.warn(`[AUTH] AUTH_BYPASS=true is enabled. All API requests run as ${authBypassRole}. Disable after setup/testing.`);
      authBypassWarned = true;
    }
    req.auth = {
      sub: 'auth-bypass',
      username: 'auth-bypass',
      role: authBypassRole,
    };
    req.authBypass = true;
  }

  function optionalAuth(req, _res, next) {
    const token = bearerToken(req);
    if (token) {
      try { req.auth = authService.verifyAccessToken(token); } catch (_) {}
    }
    applyAuthBypass(req);
    if(req.auth?.portal_only){
      const path=req.path.replace(/^\/api(?=\/)/,'');
      if(!path.startsWith('/worker-portal/')&&!['/auth/login','/auth/worker-login','/auth/refresh','/auth/logout'].includes(path))return _res.status(403).json({error:'worker_portal_only'});
    }
    next();
  }

  function requireAuth(req, res, next) {
    optionalAuth(req, res, () => {
      if (req.auth) return next();
      return res.status(401).json({ error: 'Authentication required' });
    });
  }

  function verifyWhatsAppSignature(req, res, next) {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) return next();
    const signature = String(req.headers['x-hub-signature-256'] || '');
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.sendStatus(403);
    }
    return next();
  }

  return {
    applyAuthBypass,
    bearerToken,
    optionalAuth,
    requireAuth,
    verifyWhatsAppSignature,
  };
}

module.exports = { createAuthMiddleware };
