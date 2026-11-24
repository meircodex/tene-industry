'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSettingsService } = require('../services/settings');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-marketing-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  BCRYPT_ROUNDS: '4',
  DB_PATH: path.join(tmpDir, 'test.db'),
  BACKUP_DIR: path.join(tmpDir, 'backups'),
  BASE_URL: 'https://factory.example',
});
delete process.env.MARKETING_HOSTS;
delete process.env.PUBLIC_SITE_URL;

const { server, closeServer, db } = require('../server');
const settings = createSettingsService(db);

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise(resolve => closeServer(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      headers: host ? { Host: host } : {},
    }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function schemaFrom(html) {
  return JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1])['@graph'];
}

test('landing returns indexable Hebrew HTML with metadata, matching FAQ schema and no unconfigured phone', async () => {
  const { status, headers, body } = await request('/tene');
  assert.equal(status, 200);
  assert.match(headers['content-type'], /text\/html/);
  assert.equal(headers['cache-control'], 'public, max-age=300');
  assert.equal(headers['x-robots-tag'], undefined);
  assert.match(body, /<html lang="he" dir="rtl">/);
  assert.equal([...body.matchAll(/<h1>/g)].length, 1);
  assert.match(body, /<h1>כיפוף וחיתוך ברזל לבנייה לפי תכנית<\/h1>/);
  assert.ok(body.match(/<title>([^<]+)<\/title>/)[1].length <= 60);
  assert.ok(body.match(/<meta name="description" content="([^"]+)">/)[1].length <= 155);
  assert.match(body, /rel="canonical" href="https:\/\/factory\.example\/tene"/);
  assert.match(body, /property="og:image" content="https:\/\/factory\.example\/brand\/tene-social\.png"/);
  assert.match(body, /hreflang="he" href="https:\/\/factory\.example\/tene"/);
  assert.match(body, /hreflang="x-default" href="https:\/\/factory\.example\/tene"/);
  assert.doesNotMatch(body, /tel:|<script\s+src=/);
  const [business, faq] = schemaFrom(body);
  assert.equal(business['@type'], 'LocalBusiness');
  assert.equal(business.taxID, '517312872');
  assert.equal(business.telephone, undefined);
  assert.equal(faq['@type'], 'FAQPage');
  const visible = [...body.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)]
    .map(([, question, answer]) => [question, answer]);
  assert.equal(visible.length, 6);
  assert.deepEqual(faq.mainEntity.map(question => [question.name, question.acceptedAnswer.text]), visible);
});

test('configured phone is sourced from branding and renders as a callable number', async () => {
  settings.set('BRAND_SUPPORT_PHONE', '+1 (202) 555-0100');
  try {
    const { body } = await request('/tene');
    assert.equal([...body.matchAll(/href="tel:\+12025550100"/g)].length, 2);
    assert.equal(schemaFrom(body)[0].telephone, '+1 (202) 555-0100');
  } finally {
    settings.set('BRAND_SUPPORT_PHONE', '');
  }
});

test('robots and sitemap expose only the landing on the standard host', async () => {
  const robots = await request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers['content-type'], /text\/plain/);
  assert.equal(robots.headers['x-robots-tag'], undefined);
  assert.equal(robots.body, 'User-agent: *\nAllow: /tene\nDisallow: /api/\nSitemap: https://factory.example/sitemap.xml\n');
  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers['content-type'], /application\/xml/);
  assert.equal(sitemap.headers['x-robots-tag'], undefined);
  assert.deepEqual([...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [
    'https://factory.example/tene',
  ]);
});

test('other HTML is noindex and root keeps serving the staff entry by default', async () => {
  for (const pathname of ['/customer.html?token=fixture', '/login.html', '/not-a-real-page']) {
    const { headers } = await request(pathname);
    assert.match(headers['content-type'], /text\/html/, pathname);
    assert.equal(headers['x-robots-tag'], 'noindex, nofollow', pathname);
  }
  const root = await request('/');
  const index = await request('/index.html');
  assert.equal(root.status, 200);
  assert.equal(root.body, index.body);
  assert.equal(root.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(root.headers['cache-control'], /no-store/);
  const health = await request('/api/health');
  assert.equal(health.headers['x-robots-tag'], undefined);
});

test('matching Host serves the marketing root and public URL takes precedence', async () => {
  process.env.MARKETING_HOSTS = ' other.example, TENE.example ';
  process.env.PUBLIC_SITE_URL = 'https://tene.example/';
  try {
    const root = await request('/', 'tene.example');
    assert.equal(root.status, 200);
    assert.match(root.body, /rel="canonical" href="https:\/\/tene\.example\/"/);
    assert.equal(root.headers['cache-control'], 'public, max-age=300');
    assert.equal(root.headers.pragma, undefined);
    assert.equal(root.headers['x-robots-tag'], undefined);
    const existing = await request('/', 'tene.example.attacker.example');
    assert.equal(existing.body, (await request('/index.html')).body);
    const robots = await request('/robots.txt', 'tene.example');
    assert.match(robots.body, /Allow: \/\n/);
    const sitemap = await request('/sitemap.xml', 'tene.example');
    assert.match(sitemap.body, /<loc>https:\/\/tene\.example\/<\/loc>/);
    const landing = await request('/tene', 'tene.example');
    assert.match(landing.body, /rel="canonical" href="https:\/\/tene\.example\/tene"/);
  } finally {
    delete process.env.MARKETING_HOSTS;
    delete process.env.PUBLIC_SITE_URL;
  }
});
