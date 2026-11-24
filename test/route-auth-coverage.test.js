const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const routesDir = path.join(repoRoot, 'routes');
const permissionsPath = path.join(repoRoot, 'permissions.js');

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function readStringLiteral(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  for (let i = index + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      value += source[i + 1] || '';
      i += 1;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
  }
  return null;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractExpressRoutes(source, options = {}) {
  const routePattern = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(/g;
  const routes = [];
  let match;
  while ((match = routePattern.exec(source))) {
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex < 0) continue;
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    const args = source.slice(openIndex + 1, closeIndex);
    const routeStart = args.search(/['"`]/);
    if (routeStart < 0) continue;
    const literal = readStringLiteral(args, routeStart);
    if (!literal) continue;
    const routePath = literal.value.startsWith('/api/')
      ? literal.value
      : `${options.basePath || ''}${literal.value}`;
    routes.push({
      method: match[1].toUpperCase(),
      path: routePath,
      call: source.slice(match.index, closeIndex + 1),
      disabled: /if\s*\(\s*false\s*\)\s*$/.test(before),
      line: lineNumberAt(source, match.index),
      file: options.file || 'server.js',
    });
    routePattern.lastIndex = closeIndex + 1;
  }
  return routes;
}

const PUBLIC_OR_SCOPED_API_ROUTES = new Set([
  'POST /api/machine-integration/automatic/challenge', // allowlisted installation key/source; bounded 60-second challenge, no credential
  'POST /api/machine-integration/automatic/connect', // one-use Ed25519 proof against deployment-provisioned machine scope
  'POST /api/auth/system-link/preview', // hashed, bounded 15-minute single-use capability; no session issued
  'POST /api/auth/system-link/claim', // rate-limited atomic claim; never accepts a user id or requested role
  'POST /api/worker-portal/logout', // retired: constant 410; no cookie clearing, authentication or state mutation
  'GET /api/health',
  'GET /api/branding',
  'GET /api/license/modules',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/users/login',
  'POST /api/device-enrollment/requests',
  'GET /api/device-enrollment/status',
  'GET /api/qr-access/mode',
  'POST /api/qr-access/scan',
  'GET /api/worker-invitations/activation',
  'POST /api/worker-invitations/activation',
  'POST /api/c/auth',
  'POST /api/c/auth/verify',
  'GET /api/c/me',
  'GET /api/c/shapes',
  'GET /api/c/shape-definitions',
  'GET /api/c/price-list',
  'POST /api/c/quote',
  'POST /api/c/order',
  'GET /api/c/approve/:token',
  'POST /api/c/approve',
  'GET /api/c/orders/:orderId',
  'GET /api/intake/whatsapp',
  'POST /api/intake/whatsapp',
]);

const AUTH_GUARD_MARKERS = [
  'stationAccess(', // verified source credential OR the explicit role guard; never a role supplied by headers
  'stationOrRole(', // same narrow credential policy for activity-free card snapshots only
  'requireRole(',
  'requireAnyRole(',
  'requireQrPermission(',
  'analyzeImageAuthorization',
  'analyzeBendingShapeAuthorization',
  'customerPortalAuthLimiter',
  'customerPortalActionLimiter',
  'webhookLimiter',
  'verifyWhatsAppSignature',
  'authLoginLimiter',
  'agentTokenAuthorization',
  'agentActivationAuthorization',
  'if (!refreshToken && !req.auth)',
];

test('every active API route declares auth, scoped portal access, or a public allowlist entry', () => {
  const serverSource = fs.readFileSync(serverPath, 'utf8');
  const sources = [
    { file: 'server.js', source: serverSource, basePath: '' },
  ];
  if (fs.existsSync(routesDir)) {
    for (const fileName of fs.readdirSync(routesDir).filter(file => file.endsWith('.js'))) {
      const rootMountedMarketing = fileName === 'marketing.js'
        && /app\.use\(createMarketingRouter\(/.test(serverSource);
      sources.push({
        file: `routes/${fileName}`,
        source: fs.readFileSync(path.join(routesDir, fileName), 'utf8'),
        basePath: rootMountedMarketing ? '' : '/api',
      });
    }
  }

  const routes = sources.flatMap(source => extractExpressRoutes(source.source, source))
    .filter(route => route.path.startsWith('/api/'))
    .filter(route => !route.disabled);

  assert.ok(routes.length > 100, 'route scanner should see the server API surface');

  const missing = routes.filter(route => {
    const key = `${route.method} ${route.path}`;
    return !PUBLIC_OR_SCOPED_API_ROUTES.has(key) &&
      !AUTH_GUARD_MARKERS.some(marker => route.call.includes(marker));
  });

  assert.deepEqual(
    missing.map(route => `${route.method} ${route.path} at ${route.file}:${route.line}`),
    [],
    'API routes must not be added without an explicit auth guard or public/scoped allowlist entry'
  );
});

test('server authorization does not trust spoofable browser role headers', () => {
  const server = fs.readFileSync(serverPath, 'utf8');
  const permissions = fs.readFileSync(permissionsPath, 'utf8');

  assert.equal(/req\.headers\[['"]x-user-role['"]\]/.test(server), false);
  assert.equal(/req\.get\(['"]x-user-role['"]\)/.test(server), false);
  assert.equal(/req\.headers\[['"]x-user-role['"]\]/.test(permissions), false);
  assert.equal(/req\.get\(['"]x-user-role['"]\)/.test(permissions), false);
  assert.match(permissions, /if \(!req\.auth\)/);
});
