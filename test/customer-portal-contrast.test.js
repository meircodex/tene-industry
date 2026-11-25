'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

for (const page of ['customer', 'portal', 'portal-requests', 'portal-guarantees']) {
  test(`${page} sets and persists a user contrast override before rendering`, () => {
    const html = fs.readFileSync(path.join(__dirname, '../public', page + '.html'), 'utf8');
    const bootstrap = html.match(/<script data-portal-contrast-bootstrap>([\s\S]*?)<\/script>/);
    assert.ok(bootstrap && bootstrap.index < html.indexOf('<link rel="stylesheet"'));
    assert.match(html, /<html lang="he" dir="rtl" data-tene-portal>/);
    assert.match(html, /id="portalContrastToggle" aria-label="ניגודיות: רגילה \/ גבוהה"/);
    assert.match(html, /class="portal-contrast-normal">רגילה/);
    assert.match(html, /class="portal-contrast-high">גבוהה/);

    const storage = new Map();
    const preference = { matches: true, addEventListener: (_, callback) => { preference.change = callback; } };
    function load() {
      const root = { dataset: {} };
      let ready;
      let toggle;
      const document = {
        documentElement: root,
        getElementById: () => toggle,
        addEventListener: (_, callback) => { ready = callback; },
      };
      vm.runInNewContext(bootstrap[1], {
        document,
        window: { matchMedia: query => {
          assert.equal(query, '(prefers-contrast: more)');
          return preference;
        } },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      });
      const firstPaint = root.dataset.portalContrast;
      toggle = {
        setAttribute: (name, value) => { toggle[name] = value; },
        addEventListener: (_, callback) => { toggle.click = callback; },
      };
      ready();
      return { firstPaint, root, toggle };
    }

    const os = load();
    assert.equal(os.firstPaint, 'high');
    assert.equal(os.toggle['aria-pressed'], 'true');
    os.toggle.click();
    assert.equal(os.root.dataset.portalContrast, 'normal');
    assert.equal(os.toggle['aria-pressed'], 'false');
    assert.equal(storage.get('tene-portal-contrast'), 'normal');

    const saved = load();
    assert.equal(saved.firstPaint, 'normal');
    assert.equal(saved.toggle['aria-pressed'], 'false');
    preference.matches = false;
    preference.change();
    saved.toggle.click();
    preference.change();
    assert.equal(saved.root.dataset.portalContrast, 'high');
    assert.equal(saved.toggle['aria-pressed'], 'true');
    assert.equal(load().firstPaint, 'high');
  });
}
