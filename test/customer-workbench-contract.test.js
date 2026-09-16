const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('customer detail exposes modular workbench read model without owning orders or invoices', () => {
  const route = read('routes/customers.js');
  assert.match(route, /c\.workbench\s*=\s*\{/);
  assert.match(route, /c\.sites_summary\s*=\s*sites/);
  assert.match(route, /active_price_book/);
  assert.match(route, /profitability/);
  assert.doesNotMatch(route, /INSERT\s+INTO\s+orders/i);
  assert.doesNotMatch(route, /INSERT\s+INTO\s+invoices/i);
});

test('customer screen links order creation through order screen with customer context', () => {
  const page = read('public/customers.html');
  assert.match(page, /function renderCustomerWorkbench/);
  assert.match(page, /function renderCustomerSitesSummary/);
  assert.match(page, /function quickCreateSite/);
  assert.match(page, /new URLSearchParams\(\{/);
  assert.match(page, /customer_id: String\(id\)/);
  assert.match(page, /customer_name: c\.name/);
  assert.match(page, /\/api\/customers\/' \+ customerId \+ '\/portal-sites/);
});

test('customer workbench exposes an admin-only active portal support session', () => {
  const page = read('public/customers.html');
  const adminRoute = read('routes/portalAdmin.js');
  const portal = read('public/customer.html');
  assert.match(page, /function isSystemAdmin\(\)/);
  assert.match(page, /function openPortalAsCustomer\(id\)/);
  assert.match(page, /מנהל לקוח – כל האתרים וההרשאות/);
  assert.match(page, /if \(!users\.length\) \{\s*launchPortalSupport\(id\);/);
  assert.doesNotMatch(page, /אין ללקוח משתמש פורטל פעיל\. יש להגדיר משתמש תחילה/);
  assert.match(page, /\/portal-preview/);
  assert.match(adminRoute, /portal-preview', requireAnyRole\(\['admin'\]\)/);
  assert.match(portal, /מצב סיוע למנהל מערכת/);
  assert.match(portal, /supportPreview/);
  assert.match(page, /כניסה לפורטל כלקוח/);
  assert.match(page, /fPortalCanCreateSites/);
  assert.match(portal, /renderCustomerProfilePanel\(\);/);
  assert.match(portal, /function configurePortalActions\(\)/);
});

test('customer portal action buttons are capability-gated and point to defined handlers', () => {
  const portal = read('public/customer.html');
  const handlerNames = [...portal.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1])
    .filter(name => name !== 'document');
  for (const handler of new Set(handlerNames)) {
    assert.match(portal, new RegExp(`(?:async\\s+)?function\\s+${handler}\\s*\\(`), `missing handler for ${handler}`);
  }
  assert.match(portal, /newOrder\.hidden = !canOrder/);
  assert.match(portal, /quote\.hidden = !canQuote/);
  assert.match(portal, /project\.hidden = !canOpenProjects/);
  assert.match(portal, /hasOwnProperty\.call\(data, 'supportPreview'\)/);
  assert.doesNotMatch(portal, /body\.support-preview \.portal-action-grid/);
});

test('customer workbench avoids browser prompts and hands off customer and site context', () => {
  const page = read('public/customers.html');
  assert.match(page, /id="siteModalBackdrop"/);
  assert.match(page, /function openSiteModal/);
  assert.match(page, /classList\.add\('open'\)/);
  assert.match(page, /function saveCustomerSite/);
  assert.doesNotMatch(page, /prompt\(/);
  assert.match(page, /ironbend:new-order:draft:v1/);
  assert.match(page, /siteId: site\?\.id/);
  assert.match(page, /siteName: site\?\.name/);
  assert.match(page, /params\.set\('site_id'/);
  assert.match(page, /openPriceListFor/);
  assert.match(page, /\/pricing\.html\?/);
});

test('pricing screen can open in customer context from the customer card', () => {
  const pricing = read('public/pricing.html');
  assert.match(pricing, /initialCustomerId/);
  assert.match(pricing, /initialCustomerName/);
  assert.match(pricing, /Number\(book\.customer_id\) === Number\(initialCustomerId\)/);
  assert.match(pricing, /existing\.customer_id \|\| initialCustomerId/);
});

test('customer list bootstraps with initial retry instead of requiring manual refresh', () => {
  const page = read('public/customers.html');
  assert.match(page, /function bootstrapCustomerList/);
  assert.match(page, /loadList\('', \{ initial: true \}\)/);
  assert.match(page, /initialListRetryCount < 3/);
  assert.match(page, /setTimeout\(\(\) => loadList\(lastCustomerQuery, \{ initial: true \}\), delay\)/);
  assert.match(page, /DOMContentLoaded/);
});

test('pricing screen explains customer price book connection', () => {
  const pricing = read('public/pricing.html');
  assert.match(pricing, /customerContextBar/);
  assert.match(pricing, /function isInitialCustomerBook/);
  assert.match(pricing, /function prepareCustomerPriceBook/);
  assert.match(pricing, /customer_id: state\.mode === 'customer' \? \(existing\.customer_id \|\| initialCustomerId \|\| null\) : null/);
  assert.match(pricing, /state\.editing = Boolean\(initialCustomerId\)/);
});

test('pricing customer handoff can return and clones a clean customer price book', () => {
  const pricing = read('public/pricing.html');
  const customers = read('public/customers.html');
  assert.match(pricing, /id="backToCustomerBtn"/);
  assert.match(pricing, /\/customers\.html\?customer_id=/);
  assert.match(pricing, /function customerBookCode/);
  assert.match(pricing, /cloneSourceBook/);
  assert.match(pricing, /id: null/);
  assert.match(pricing, /source_type: existing\.source_type \|\| \(source\.id \? 'customer_copy' : 'manual'\)/);
  assert.match(customers, /requestedCustomerId/);
  assert.match(customers, /selectCustomer\(requestedCustomerId\)/);
});

test('customer price book handoff activates pricing consumers and customer profitability summary', () => {
  const pricing = read('public/pricing.html');
  const customers = read('public/customers.html');
  const route = read('routes/customers.js');
  assert.match(pricing, /status: existing\.status \|\| \(customerPriceBook \? 'active' : 'draft'\)/);
  assert.match(route, /today_margin_pct/);
  assert.match(route, /LEFT JOIN order_costs oc ON oc\.order_id=o\.id/);
  assert.match(customers, /רווח היום/);
  assert.match(customers, /מרווח היום/);
});

test('customer card exposes unbilled delivery-to-billing queue without owning invoice creation', () => {
  const route = read('routes/customers.js');
  const page = read('public/customers.html');
  assert.match(route, /unbilledOrders/);
  assert.match(route, /LEFT JOIN order_billing ob ON ob\.order_id=o\.id/);
  assert.match(route, /ob\.order_id IS NULL/);
  assert.doesNotMatch(route, /INSERT\s+INTO\s+invoices/i);
  assert.match(page, /function renderCustomerBillingQueue/);
  assert.match(page, /kind=delivery-certificate/);
  assert.match(page, /function recordCustomerBilling/);
  assert.match(page, /\/api\/orders\/' \+ orderId \+ '\/costs\/billing/);
});

test('customer card shows billing amount on each order row', () => {
  const route = read('routes/customers.js');
  const page = read('public/customers.html');
  assert.match(route, /suggested_amount/);
  assert.match(route, /billing_status/);
  assert.match(route, /billing_source/);
  assert.match(route, /price_book_items/);
  assert.match(route, /price_book_weight/);
  assert.match(route, /calcOrderPriceForCustomer/);
  assert.match(route, /const pricer = deps\.pricer \|\| null/);
  assert.match(read('server.js'), /createCustomersRouter\(\{[\s\S]*pricer,/);
  assert.match(route, /\\u05e0\\u05e9\\u05dc\\u05d7\\u05d4/);
  assert.match(page, /function billingAmountLabel/);
  assert.match(page, /function billingStatusLabel/);
  assert.match(page, /function billingSourceText/);
  assert.match(page, /price_book_items/);
  assert.match(page, /billingAmountLabel\(o\)/);
  assert.match(page, /billingStatusLabel\(o\)/);
  assert.match(page, /\\u05e1\\u05db\\u05d5\\u05dd \\u05dc\\u05d7\\u05d9\\u05d5\\u05d1/);
});

test('customer card prices orders from active price book diameter ranges', () => {
  const route = read('routes/customers.js');
  assert.match(route, /function priceItemMatchesDiameter/);
  assert.match(route, /\\u2013/);
  assert.match(route, /function priceOrderFromActiveBookItems/);
  assert.match(route, /priceForDiameter\(item\.diameter\)/);
  assert.match(route, /billingWeight \/ itemWeight/);
});

test('customer billing uses pallet items and explains missing pricing instead of silent zero', () => {
  const route = read('routes/customers.js');
  const page = read('public/customers.html');
  assert.match(route, /LEFT JOIN pallets p ON p\.id=i\.pallet_id/);
  assert.match(route, /i\.order_id=\? OR p\.order_id=\?/);
  assert.match(route, /EXISTS \([\s\S]*pricing_price_items/);
  assert.match(route, /billing_reason/);
  assert.match(route, /no_price_book/);
  assert.match(page, /function billingReasonText/);
  assert.match(page, /billingReasonText\(row\)/);
});

test('customer card keeps orders above billing sites and secondary details', () => {
  const page = read('public/customers.html');
  assert.match(page, /function renderCustomerOrders/);
  const workbench = page.indexOf('renderCustomerWorkbench(c)');
  const orders = page.indexOf('renderCustomerOrders(c, orders)');
  const billing = page.indexOf('renderCustomerBillingQueue(c)');
  const sites = page.indexOf('renderCustomerSitesSummary(c)');
  const info = page.indexOf('// ── Info grid ──');
  assert.ok(workbench > -1 && orders > workbench);
  assert.ok(billing > orders);
  assert.ok(sites > billing);
  assert.ok(info > sites);
});


test('customer card has quick navigation and order document links', () => {
  const page = read('public/customers.html');
  assert.match(page, /function renderCustomerJumpNav/);
  assert.match(page, /customerOrdersSection/);
  assert.match(page, /customerBillingSection/);
  assert.match(page, /customerSitesSection/);
  assert.match(page, /customerDetailsSection/);
  assert.match(page, /kind=print-a4/);
  assert.match(page, /kind=delivery-certificate/);
  assert.match(page, /PDF \\u05d4\\u05d6\\u05de\\u05e0\\u05d4/);
});
