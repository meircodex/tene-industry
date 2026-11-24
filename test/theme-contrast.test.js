'use strict';

/**
 * WCAG AA color contrast for the two visual themes.
 * Serves the local design fixture only. Does not open a database
 * and is not loaded by server.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { AxeBuilder } = require('@axe-core/playwright');
const { demoBody } = require('../scripts/local-design-demo.js');

const ROOT = path.join(__dirname, '..', 'public');
const MODULES = {
  '/shapeSnapshot.js': path.join(__dirname, '..', 'services', 'shapeSnapshot.js'),
  '/steelRebarShapes.js': path.join(__dirname, '..', 'modules', 'steel-rebar', 'shapes.js'),
  '/shapeCommercial.js': path.join(__dirname, '..', 'modules', 'steel-rebar', 'shape-commercial.js'),
  '/shapeRecognition.js': path.join(__dirname, '..', 'modules', 'steel-rebar', 'shape-recognition.js'),
};
const PAGES = [
  ['dashboard', '/dashboard.html', '.action-item, .muted-state'],
  ['orders', '/orders.html', '.order-row'],
  ['new-order', '/index.html', 'h1'],
  ['queue', '/production-queue.html', '.queue-item, .empty-state'],
  ['inventory', '/inventory.html', 'h1, .page-title, main'],
];
const THEMES = ['command', 'blueprint'];

function contentType(file) {
  return {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  }[path.extname(file)] || 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const raw = req.url || '/';
    const url = decodeURIComponent(raw.split('?')[0]);
    if (url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(demoBody(raw)));
      return;
    }
    const file = MODULES[url] || path.join(ROOT, url === '/' ? 'index.html' : url);
    const allowed = file.startsWith(ROOT) || Object.values(MODULES).includes(file);
    if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': contentType(file) });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function violationText(theme, name, results) {
  return results.violations.flatMap(violation => (violation.nodes || []).map(node => {
    const data = (node.any || []).map(check => check.data && (check.data.contrastRatio || check.message)).filter(Boolean).join(' ');
    return `${theme} ${name}: ${node.target.join(' ')} ${data}`.trim();
  })).join('\n');
}

function chromiumOptions() {
  const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return options;
}

function stopServer(server) {
  if (!server) return Promise.resolve();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

test('theme contrast meets WCAG AA on the main screens', { timeout: 180000 }, async (t) => {
  const server = await startServer();
  let browser;
  const failures = [];
  try {
    try {
      browser = await chromium.launch(chromiumOptions());
    } catch (error) {
      t.skip(`Chromium is not available for the contrast check (${error.message}). Set PLAYWRIGHT_CHROMIUM_PATH to a Chrome or Chromium binary.`);
      return;
    }
    const { port } = server.address();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('ib_access_token', 'design-preview');
      sessionStorage.setItem('ib_access_token', 'design-preview');
    });
    const page = await context.newPage();
    for (const theme of THEMES) {
      for (const [name, href, ready] of PAGES) {
        await page.goto(`http://127.0.0.1:${port}${href}?theme=${theme}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector(ready, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        if (results.violations.length) failures.push(violationText(theme, name, results));
      }
    }
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, failures.join('\n\n'));
});
