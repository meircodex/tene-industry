const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { loadPortalClient } = require('./helpers/customer-portal-client');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('customer portal exposes customer-facing item description text', () => {
  const customerPage = read('public/customer.html');
  const indexPage = read('public/index.html');
  const portalRoute = read('routes/portal.js');

  assert.match(customerPage, /שייך ל \/ תיאור ללקוח/);
  assert.match(customerPage, /placeholder="לדוגמה: קיר חומה מבנה 103, קומה 2"/);
  assert.match(customerPage, /portalCustomerItemDescription/);
  assert.match(customerPage, /customerDescription/);
  assert.match(customerPage, /שייך ל \/ תיאור:/);
  const client = loadPortalClient();
  assert.equal(client.json("portalOrderItemPayload({ note: 'קיר חומה מבנה 103' })").note, 'קיר חומה מבנה 103');
  assert.match(indexPage, /<th>שייך ל \/ תיאור ללקוח<\/th>/);
  assert.match(indexPage, /placeholder="לדוגמה: קיר חומה מבנה 103, קומה 2"/);
  assert.match(indexPage, /שייך ל \/ תיאור <textarea/);
  assert.match(portalRoute, /<th>שייך ל \/ תיאור<\/th>/);
});
