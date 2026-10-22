const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const requiredModules = [
  'Platform Core',
  'Orders',
  'Production',
  'Inventory',
  'Procurement',
  'Fleet Management',
  'Finance',
  'Quality',
  'Maintenance',
  'Customer And External Portals',
  'Dashboard And Reports',
  'Vendor Control And Remote Support',
];

test('module inventory defines every sellable/control module', () => {
  const inventory = read('docs/module-inventory.md');

  for (const moduleName of requiredModules) {
    assert.match(inventory, new RegExp(`## ${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }

  assert.match(inventory, /Every future agent task should name one\s+module and one bounded file set/i);
  assert.match(inventory, /Remote vendor access to customer data must be off by default/);
  assert.match(inventory, /customer-approved, time-limited, read-only by default/);
  assert.match(inventory, /JWT auth is active for guarded routes/);
  assert.match(inventory, /AUTH_BYPASS[\s\S]*production and staging environments/);
  assert.doesNotMatch(inventory, /Auth enforcement is disabled/);
  assert.doesNotMatch(inventory, /spoofable role headers while enforcement is off/);
});

test('module inventory assigns shared core and extracted services to owners', () => {
  const inventory = read('docs/module-inventory.md');

  for (const ownedFile of [
    'auth-core.js',
    'permissions.js',
    'constants.js',
    'status-contracts.js',
    'public/status-contracts-client.js',
    'services/orderNumbers.js',
    'services/productionCards.js',
    'services/inventory.js',
    'services/fleet.js',
    'services/intakeWorkflow.js',
  ]) {
    assert.match(inventory, new RegExp(ownedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(inventory, /Next Agent Assignments/);
  assert.doesNotMatch(inventory, /Security Agent: protect user\/admin\/settings\/database endpoints/);
});

test('shared constants are extracted from the server monolith', () => {
  const constants = read('constants.js');
  const steelWeights = read('modules/steel-rebar/weights.js');
  const server = read('server.js');

  // Steel-specific logic now lives in modules/steel-rebar/
  assert.match(steelWeights, /const REBAR_WEIGHTS = Object\.freeze/);
  assert.match(steelWeights, /const REBAR_KG_PER_M = Object\.freeze/);
  assert.match(steelWeights, /function rebarKgPerMeter/);

  // Universal platform constants stay in constants.js
  assert.match(constants, /const MACHINE_STATES = Object\.freeze/);
  assert.match(constants, /const STATE_TRANSITIONS = Object\.freeze/);
  assert.match(constants, /'ריצה'/);
  assert.doesNotMatch(constants, /\\u05/);

  // constants.js re-exports steel for backward compat
  assert.match(constants, /require\('\.\/modules\/steel-rebar'\)/);

  // server.js keeps universal constants, and resolves steel-specific behavior via industry loader.
  assert.match(server, /require\('\.\/constants'\)/);
  assert.match(server, /moduleLoader\.active\(\)/);
  assert.match(server, /const industry =/);
  assert.doesNotMatch(server, /rebarKgPerMeter/);
  assert.doesNotMatch(server, /const REBAR_WEIGHTS = \{/);
  assert.doesNotMatch(server, /const REBAR_KG_PER_M = Object\.assign/);
  assert.doesNotMatch(server, /const MACHINE_STATES = \[/);
  assert.doesNotMatch(server, /const STATE_TRANSITIONS = \{/);
  assert.doesNotMatch(server, /const VALID_ORDER_TRANSITIONS = \{/);
  assert.doesNotMatch(server, /REBAR_WEIGHTS\[[^\]]+\]\s*\?\?/);
  assert.doesNotMatch(server, /WEIGHTS\[/);
  assert.doesNotMatch(server, /REBAR_KG_PER_M\[/);
  assert.doesNotMatch(server, /diameter\s*\*\s*diameter\s*\*\s*0\.00617/);
});

test('registries reserve vendor control APIs before implementation', () => {
  const apiRegistry = read('docs/api-registry.md');
  const screenRegistry = read('docs/screen-registry.md');
  const permissionRegistry = read('docs/permission-registry.md');

  assert.match(apiRegistry, /## Vendor Control And Remote Support/);
  assert.match(apiRegistry, /\/api\/vendor\/sites\*/);
  assert.match(apiRegistry, /\/api\/vendor\/sites\/:id\/support-session/);
  assert.match(apiRegistry, /customer-approved \+ vendor-admin/);
  assert.match(screenRegistry, /admin\.html/);
  assert.match(permissionRegistry, /admin/);
});

test('change protocol blocks unowned work and duplicate module edits', () => {
  const protocol = read('docs/change-control-protocol.md');
  const template = read('docs/agent-task-template.md');

  assert.match(protocol, /No change is ready unless it has:/);
  assert.match(protocol, /One module owner/);
  assert.match(protocol, /One bounded file scope/);
  assert.match(protocol, /Every task must name exactly one primary owner/);
  assert.match(protocol, /No Duplicate Agent Work/);
  assert.match(template, /Module owner:/);
  assert.match(template, /Allowed write scope:/);
  assert.match(template, /Do not edit:/);
});

test('license entitlements gate module routers from the shared catalog', () => {
  const server = read('server.js');
  const license = read('services/license.js');
  const licenseRoute = read('routes/license.js');

  assert.match(server, /require\('\.\/shared\/module-catalog\.json'\)/);
  assert.match(server, /const licenseService = createLicenseService\(db\)/);
  assert.match(server, /function requireModule\(key\)/);
  assert.match(server, /licensedModuleKeys\.has\(key\)/);
  assert.match(server, /settingsService\.get\('license_modules'/);
  assert.match(server, /code: 'module_not_licensed'/);
  assert.match(licenseRoute, /module\.exports = function createLicenseRouter/);
  assert.match(licenseRoute, /router\.get\('\/license\/modules'/);
  assert.match(licenseRoute, /restricted: Boolean\(enabled\)/);
  assert.match(server, /createLicenseRouter\(\{ readLicensedModules, moduleCatalog \}\)/);
  assert.doesNotMatch(server, /app\.get\('\/api\/license\/modules'/);
  assert.ok(
    server.indexOf("app.use('/api', licenseService.middleware)") < server.indexOf("app.use('/api', requireModule('orders'), createOrdersRouter"),
    'license middleware must mount before module routers'
  );

  for (const [moduleKey, routerName] of [
    ['orders', 'createOrdersRouter'],
    ['production', 'createProductionRouter'],
    ['inventory', 'createInventoryRouter'],
    ['procurement', 'createProcurementRouter'],
    ['finance', 'createFinanceRouter'],
    ['fleet', 'createFleetRouter'],
    ['quality', 'createQualityRouter'],
    ['customers', 'createCustomersRouter'],
    ['intake', 'createIntakeRouter'],
    ['portal', 'createPortalRouter'],
    ['warehouse', 'createWarehouseRouter'],
    ['reports', 'createReportsRouter'],
    ['companies', 'createCompaniesRouter'],
    ['ai', 'createAiRouter'],
    ['bvbs', 'createBvbsRouter'],
  ]) {
    assert.match(server, new RegExp(`app\\.use\\('\\/api', requireModule\\('${moduleKey}'\\), ${routerName}`));
  }

  assert.match(license, /function cacheEntitlements\(entitlements\)/);
  assert.match(license, /license_modules/);
  assert.match(license, /JSON\.stringify\(modules\)/);
  assert.match(license, /license_package/);
  assert.match(license, /license_max_users/);
  assert.match(license, /function activeUsersThisMonth\(\)/);
  assert.match(license, /WHERE last_login >= date\('now','start of month'\)/);
  assert.match(license, /activeUsers,/);
  assert.match(license, /license_users_over/);
  assert.match(license, /result\.usersOverLimit \? '1' : '0'/);
  assert.match(license, /result\.entitlements/);
});

test('admin module board exposes maturity, risk, scope and vendor control', () => {
  const admin = read('public/admin.html');

  assert.match(admin, /מודולים פעילים|בקרת מודולים/);
  assert.match(admin, /moduleStatusGrid/);
  assert.match(admin, /module-card/);
  assert.match(admin, /MODULE_VENDOR_CONTROL/);
  assert.match(admin, /Vendor Control \/ בקרה מרחוק/);
  assert.match(admin, /אין גישה חופשית לנתוני לקוח/);
  assert.match(admin, /status:'frozen'/);
  assert.match(admin, /risk:'high'/);
  assert.match(admin, /screens:\[/);
  assert.match(admin, /apis:\[/);
  assert.match(admin, /next:/);
});

test('module control board does not present combined module ownership', () => {
  const admin = read('public/admin.html');

  for (const requiredModule of ['MODULE_PROCUREMENT', 'MODULE_MAINTENANCE', 'MODULE_REPORTS']) {
    assert.match(admin, new RegExp(requiredModule));
  }

  for (const combinedName of ['Inventory / Procurement', 'Quality / Maintenance', 'Dashboard / Reports']) {
    assert.ok(!admin.includes(combinedName), `combined module name still exists: ${combinedName}`);
  }
  assert.doesNotMatch(admin, /owner:'[^']*\/[^']*'/);
});

test('screen registry assigns one module owner per screen', () => {
  const registry = read('docs/screen-registry.md');
  const rows = registry
    .split(/\r?\n/)
    .filter(line => line.startsWith('| `'));

  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim());
    const owner = cells[2];
    assert.ok(owner, `missing owner in row: ${row}`);
    assert.ok(!owner.includes('/'), `screen owner must be one module, got "${owner}" in row: ${row}`);
  }
});

test('production cards are rendered through a module service', () => {
  const service = read('services/productionCards.js');
  const page = read('services/productionCardPrintPage.js');
  const route = read('routes/productionCards.js');
  const server = read('server.js');

  assert.match(service, /function masterCard/);
  assert.match(service, /function itemCard/);
  assert.match(service, /module\.exports/);
  assert.match(page, /function renderPrintCardsPage/);
  assert.doesNotMatch(page, /cards\.masterCard/);
  assert.match(page, /cards\.itemCard/);
  assert.match(server, /require\('\.\/services\/productionCards'\)/);
  assert.match(route, /printPage\.renderPrintCardsPage/);
  assert.doesNotMatch(route, /function buildSplitMaster/);
  assert.doesNotMatch(server, /productionCards\.masterCard/);
  assert.doesNotMatch(server, /productionCards\.itemCard/);
});

test('order numbers are allocated through an orders module service', () => {
  const service = read('services/orderNumbers.js');
  const server = read('server.js');

  assert.match(service, /function ensureOrderSequence/);
  assert.match(service, /function createOrderNumberAllocator/);
  assert.match(service, /UPDATE order_sequences\s+SET next_value=next_value\+1/);
  assert.match(server, /require\('\.\/services\/orderNumbers'\)/);
  assert.match(server, /const generateOrderNum = createOrderNumberAllocator\(db\)/);
  assert.doesNotMatch(server, /const nextOrderNumTx = db\.transaction/);
});

test('order creation logic lives in an orders module service', () => {
  const service = read('services/orders.js');
  const server = read('server.js');

  assert.match(service, /function createOrderFactory/);
  assert.match(service, /function createOrderFromPayload/);
  assert.match(service, /function validateShapeGeometry/);
  // normalizeFactorySegments/ShapeName הועברו ל-modules/steel-rebar/shapes.js
  const steelShapes = read('modules/steel-rebar/shapes.js');
  assert.match(steelShapes, /function normalizeFactorySegments/);
  assert.match(steelShapes, /function normalizeFactoryShapeName/);
  assert.match(service, /createOrderTransaction: db\.transaction\(createOrderFromPayload\)/);
  assert.match(server, /require\('\.\/services\/orders'\)/);
  assert.match(server, /createOrderFactory\(db, \{/);
  assert.match(server, /settingsService,/);
  assert.doesNotMatch(server, /function createOrderFromPayload/);
  assert.doesNotMatch(server, /function validateShapeGeometry/);
});

test('inventory receiving and bent-shape parsing live in an inventory service', () => {
  const service = read('services/inventory.js');
  const route = read('routes/inventory.js');
  const visionRoute = read('routes/inventoryVision.js');

  assert.match(service, /const MATERIAL_TYPES = new Set\(\['coil', 'straight', 'bent'\]\)/);
  assert.match(service, /function normalizeBendingShapeInput/);
  assert.match(service, /function bendingShapeColumns/);
  assert.match(service, /function normalizeReceiptReviewItem/);
  assert.match(service, /function parseReceiptReviewPayload/);
  assert.match(service, /function allocateOrderItemStock/);
  assert.match(service, /function openProcurementForStockShortages/);
  assert.match(service, /function summarizeStockShortages/);
  assert.match(service, /function normalizeStockAllocationPolicy/);
  assert.match(route, /require\('\.\.\/services\/inventory'\)/);
  assert.match(route, /const \{\s+MATERIAL_TYPES,\s+bendingShapeColumns,\s+normalizeReceiptReviewItem,\s+parseReceiptReviewPayload,\s+\} = require\('\.\.\/services\/inventory'\);/);
  assert.match(visionRoute, /const \{\s+normalizeBendingShapeInput,\s+parseReceiptReviewPayload,\s+\} = require\('\.\.\/services\/inventory'\);/);
});

test('inventory receiving API routes are split out of the server monolith', () => {
  const route = read('routes/inventory.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createInventoryRouter/);
  assert.match(route, /router\.get\('\/inventory\/forecast'/);
  assert.doesNotMatch(route, /axios/);
  assert.doesNotMatch(route, /router\.(get|post|patch)\('\/suppliers/);
  assert.doesNotMatch(route, /router\.post\('\/inventory\/analyze-bending-shape'/);
  assert.doesNotMatch(route, /router\.post\('\/inventory\/scan-label'/);
  assert.doesNotMatch(route, /router\.post\('\/inventory\/receipt-reviews\/analyze'/);
  assert.doesNotMatch(route, /router\.get\('\/steel-prices'/);
  assert.doesNotMatch(route, /router\.get\('\/purchase-orders'/);
  assert.match(server, /createInventoryRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('inventory'\), createInventoryRouter/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/suppliers/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/inventory/);
});

test('inventory OCR and vision routes are split out of inventory receiving', () => {
  const route = read('routes/inventoryVision.js');
  const inventory = read('routes/inventory.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createInventoryVisionRouter/);
  assert.ok(route.includes('routes/inventoryVision missing dependency'));
  for (const routeSnippet of [
    "router.post('/inventory/analyze-bending-shape'",
    "router.post('/inventory/scan-label'",
    "router.post('/inventory/receipt-reviews/analyze'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
    assert.ok(!inventory.includes(routeSnippet), routeSnippet);
  }
  assert.match(route, /axios\.post\('https:\/\/api\.openai\.com\/v1\/responses'/);
  assert.match(route, /parseReceiptReviewPayload/);
  assert.match(server, /createInventoryVisionRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('inventory'\), createInventoryVisionRouter/);
});

test('procurement API routes are split out of inventory', () => {
  const route = read('routes/procurement.js');
  const inventory = read('routes/inventory.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createProcurementRouter/);
  assert.match(route, /router\.get\('\/suppliers'/);
  assert.match(route, /router\.post\('\/suppliers'/);
  assert.match(route, /router\.patch\('\/suppliers\/:id'/);
  assert.match(route, /router\.get\('\/steel-prices'/);
  assert.match(route, /router\.post\('\/steel-prices'/);
  assert.match(route, /router\.get\('\/purchase-orders'/);
  assert.match(route, /router\.patch\('\/purchase-orders\/:id\/receive'/);
  assert.match(server, /createProcurementRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('procurement'\), createProcurementRouter/);
  assert.doesNotMatch(inventory, /router\.(get|post|patch)\('\/suppliers/);
  assert.doesNotMatch(inventory, /router\.get\('\/steel-prices'/);
  assert.doesNotMatch(inventory, /router\.get\('\/purchase-orders'/);
  assert.doesNotMatch(server, /app\.(get|post)\('\/api\/steel-prices/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/purchase-orders/);
});

test('core order API routes are split out of the server monolith', () => {
  const route = read('routes/orders.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createOrdersRouter/);
  assert.match(route, /router\.get\('\/orders'/);
  assert.match(route, /router\.post\('\/order-imports\/preview'/);
  assert.match(route, /router\.post\('\/orders'/);
  assert.match(route, /router\.patch\('\/orders\/:id\/status'/);
  assert.ok(route.includes("router.get('/orders/:id/status-correction-preview'"));
  assert.match(route, /auditLog\('order'/);
  assert.match(route, /wsBroadcast\('new_order'/);
  assert.match(server, /createOrdersRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('orders'\), createOrdersRouter/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/orders(?!\/:id\/(?:print-cards|delivery-certificate|print-a4|margin|costs))/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/order-imports/);
});

test('production card print routes are split out of the server monolith', () => {
  const route = read('routes/productionCards.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createProductionCardsRouter/);
  assert.match(route, /router\.get\('\/orders\/:id\/print-cards'/);
  assert.doesNotMatch(route, /delivery-certificate/);
  assert.doesNotMatch(route, /print-a4/);
  assert.match(route, /printPage\.renderPrintCardsPage/);
  assert.doesNotMatch(route, /function buildSplitMaster/);
  assert.match(server, /createProductionCardsRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('production'\), createProductionCardsRouter/);
  assert.doesNotMatch(server, /app\.get\('\/api\/orders\/:id\/print-cards'/);
  assert.doesNotMatch(server, /function pcMasterCard/);
  assert.doesNotMatch(server, /function pcItemCard/);
});

test('order document routes are split out of production card printing', () => {
  const route = read('routes/orderDocuments.js');
  const delivery = read('routes/orderDeliveryCertificate.js');
  const printA4 = read('routes/orderPrintA4.js');
  const productionCardsRoute = read('routes/productionCards.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createOrderDocumentsRouter/);
  assert.match(route, /createOrderDeliveryCertificateRouter/);
  assert.match(route, /createOrderPrintA4Router/);
  assert.match(route, /required\('industry', deps\.industry\)/);
  assert.match(delivery, /module\.exports = function createOrderDeliveryCertificateRouter/);
  assert.match(delivery, /router\.get\('\/orders\/:id\/delivery-certificate'/);
  assert.match(delivery, /required\('industry', deps\.industry\)/);
  assert.match(printA4, /module\.exports = function createOrderPrintA4Router/);
  assert.match(printA4, /router\.get\('\/orders\/:id\/print-a4'/);
  assert.match(printA4, /required\('tryParseJSON', deps\.tryParseJSON\)/);
  assert.match(server, /createOrderDocumentsRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('production'\), createOrderDocumentsRouter/);
  assert.doesNotMatch(productionCardsRoute, /delivery-certificate/);
  assert.doesNotMatch(productionCardsRoute, /print-a4/);
  assert.doesNotMatch(server, /app\.get\('\/api\/orders\/:id\/delivery-certificate'/);
  assert.doesNotMatch(server, /app\.get\('\/api\/orders\/:id\/print-a4'/);
});

test('finance API routes are split out of the server monolith', () => {
  const route = read('routes/finance.js');
  const invoicesRoute = read('routes/financeInvoices.js');
  const costsRoute = read('routes/financeCosts.js');
  const ledgerRoute = read('routes/financeLedger.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createFinanceRouter/);
  assert.match(route, /router\.get\('\/orders\/:id\/margin'/);
  assert.match(route, /router\.get\('\/finance\/kpis'/);
  assert.match(route, /router\.get\('\/finance\/events'/);
  assert.ok(!route.includes("router.get('/credit'"));
  assert.ok(!route.includes("router.get('/credit/:customerId'"));
  assert.ok(!route.includes("router.patch('/credit/:customerId'"));
  assert.ok(!route.includes("router.post('/credit/:customerId/transaction'"));
  assert.ok(!route.includes("router.get('/credit/:customerId/status'"));
  assert.ok(!route.includes("router.get('/invoices'"));
  assert.ok(!route.includes("router.post('/invoices'"));
  assert.ok(!route.includes("router.patch('/invoices/:id/pay'"));
  assert.ok(!route.includes("router.patch('/invoices/:id/cancel'"));
  assert.ok(!route.includes("router.get('/orders/:id/costs'"));
  assert.ok(!route.includes("router.post('/orders/:id/costs/recalculate'"));
  assert.ok(!route.includes("router.patch('/orders/:id/costs/lock'"));
  assert.ok(!route.includes("router.get('/orders/:id/costs/snapshots'"));
  assert.ok(!route.includes("router.get('/customers/:id/ledger'"));
  assert.ok(!route.includes("router.patch('/customers/:id/credit'"));
  assert.doesNotMatch(route, /customer_credit/);
  assert.doesNotMatch(route, /credit_accounts/);
  assert.doesNotMatch(route, /credit_transactions/);
  assert.doesNotMatch(route, /function calculateOrderCost/);
  assert.match(invoicesRoute, /module\.exports = function createFinanceInvoicesRouter/);
  assert.match(invoicesRoute, /routes\/financeInvoices missing dependency/);
  assert.match(invoicesRoute, /router\.get\('\/invoices'/);
  assert.match(invoicesRoute, /router\.post\('\/invoices'/);
  assert.match(invoicesRoute, /router\.patch\('\/invoices\/:id\/pay'/);
  assert.match(invoicesRoute, /router\.patch\('\/invoices\/:id\/cancel'/);
  assert.match(invoicesRoute, /wsBroadcast\('new_invoice'/);
  assert.match(invoicesRoute, /BUG-36: cannot pay cancelled invoice/);
  assert.match(costsRoute, /module\.exports = function createFinanceCostsRouter/);
  assert.match(costsRoute, /routes\/financeCosts missing dependency/);
  assert.match(costsRoute, /function calculateOrderCost/);
  assert.match(costsRoute, /router\.get\('\/orders\/:id\/costs'/);
  assert.match(costsRoute, /router\.post\('\/orders\/:id\/costs\/recalculate'/);
  assert.match(costsRoute, /router\.patch\('\/orders\/:id\/costs\/lock'/);
  assert.match(costsRoute, /router\.get\('\/orders\/:id\/costs\/snapshots'/);
  assert.match(costsRoute, /wsBroadcast\('cost_update'/);
  assert.match(costsRoute, /requireRole\('manager'\)/);
  assert.match(ledgerRoute, /module\.exports = function createFinanceLedgerRouter/);
  assert.match(ledgerRoute, /routes\/financeLedger missing dependency/);
  assert.match(ledgerRoute, /router\.get\('\/customers\/:id\/ledger'/);
  assert.match(ledgerRoute, /router\.patch\('\/customers\/:id\/credit'/);
  assert.match(ledgerRoute, /customer_credit/);
  assert.match(server, /createFinanceRouter/);
  assert.match(server, /createFinanceInvoicesRouter/);
  assert.match(server, /createFinanceCostsRouter/);
  assert.match(server, /createFinanceLedgerRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('finance'\), createFinanceInvoicesRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('finance'\), createFinanceCostsRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('finance'\), createFinanceLedgerRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('finance'\), createFinanceRouter/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/invoices/);
  assert.doesNotMatch(server, /app\.(get|post|patch)\('\/api\/orders\/:id\/(?:margin|costs)/);
  assert.doesNotMatch(server, /app\.(get|patch)\('\/api\/customers\/:id\/(?:ledger|credit)/);
  assert.doesNotMatch(server, /app\.get\('\/api\/finance\/(?:kpis|events)'/);
  assert.doesNotMatch(server, /app\.(get|patch)\('\/api\/price-list'/);
  assert.ok(!server.includes("app.get('/api/credit'"));
  assert.ok(!server.includes("app.patch('/api/credit/:customerId'"));
  assert.ok(!server.includes("app.post('/api/credit/:customerId/transaction'"));
  assert.doesNotMatch(server, /function calculateOrderCost/);
  assert.match(server, /createReportsRouter/);
  assert.doesNotMatch(server, /app\.get\('\/api\/export\/orders'/);
  assert.doesNotMatch(route, /app\.get\('\/api\/export/);
});

test('finance credit API routes are split from finance ledger and invoices', () => {
  const route = read('routes/financeCredit.js');
  const finance = read('routes/finance.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createFinanceCreditRouter/);
  assert.match(route, /routes\/financeCredit missing dependency/);
  assert.ok(route.includes("router.get('/credit'"));
  assert.ok(route.includes("router.get('/credit/:customerId'"));
  assert.ok(route.includes("router.patch('/credit/:customerId'"));
  assert.ok(route.includes("router.post('/credit/:customerId/transaction'"));
  assert.ok(route.includes("router.get('/credit/:customerId/status'"));
  assert.match(route, /credit_accounts/);
  assert.match(route, /credit_transactions/);
  assert.match(route, /requireAnyRole\(\['finance', 'manager', 'admin'\]\)/);
  assert.match(server, /createFinanceCreditRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('finance'\), createFinanceCreditRouter/);
  assert.doesNotMatch(finance, /credit_accounts/);
  assert.doesNotMatch(finance, /credit_transactions/);
  assert.ok(!server.includes("app.get('/api/credit'"));
  assert.ok(!server.includes("app.patch('/api/credit/:customerId'"));
  assert.ok(!server.includes("app.post('/api/credit/:customerId/transaction'"));
});


test('finance margin never uses selling price list as purchase cost', () => {
  const route = read('routes/finance.js');
  const marginStart = route.indexOf("router.get('/orders/:id/margin'");
  const kpiStart = route.indexOf("router.get('/finance/kpis'", marginStart);
  const marginRoute = route.slice(marginStart, kpiStart);

  assert.match(marginRoute, /steel_price_history/);
  assert.doesNotMatch(marginRoute, /SELECT\s+price_list\s+FROM\s+price_list/i);
  assert.match(marginRoute, /missing_purchase_price_diameters/);
  assert.match(marginRoute, /cost_basis_missing/);
});
test('catalog and pricing routes are split out of the server monolith', () => {
  const route = read('routes/catalog.js');
  const finance = read('routes/finance.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createCatalogRouter/);
  assert.ok(route.includes("router.get('/pricing/price-books'"));
  assert.ok(route.includes("router.post('/pricing/price-books/analyze-upload'"));
  assert.ok(route.includes("router.post('/pricing/price-books'"));
  assert.ok(route.includes("router.patch('/pricing/price-books/:id'"));
  assert.ok(route.includes("router.get('/pricing/price-books/:id/items'"));
  assert.ok(route.includes("router.post('/pricing/price-books/:id/items'"));
  assert.ok(route.includes("router.patch('/pricing/price-books/:id/items/:itemId'"));
  assert.ok(route.includes("router.delete('/pricing/price-books/:id/items/:itemId'"));
  assert.doesNotMatch(route, /router\.(get|patch)\('\/price-list'/);
  assert.doesNotMatch(route, /price_list/);
  assert.ok(route.includes("router.get('/shapes'"));
  assert.ok(route.includes("router.post('/shapes'"));
  assert.ok(route.includes("router.post('/shapes/seed'"));
  assert.match(server, /createCatalogRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('production'), createCatalogRouter"));
  assert.ok(!finance.includes("router.get('/price-list'"));
  assert.ok(!finance.includes("router.patch('/price-list'"));
  assert.ok(!finance.includes("router.get('/pricing/price-books'"));
  assert.ok(!server.includes("app.get('/api/price-list'"));
  assert.ok(!server.includes("app.patch('/api/price-list'"));
  assert.ok(!server.includes("app.get('/api/pricing/price-books'"));
  assert.ok(!server.includes("app.post('/api/pricing/price-books'"));
  assert.ok(!server.includes("app.get('/api/shapes'"));
  assert.ok(!server.includes("app.post('/api/shapes'"));
});

test('intake import and manual parsing live in an intake workflow service', () => {
  const service = read('services/intakeWorkflow.js');
  const server = read('server.js');
  const intakeRoute = read('routes/intake.js');
  const reviewRoute = read('routes/intakeReview.js');

  assert.match(service, /function buildOrderImportPreview/);
  assert.match(service, /function buildIntakeOrderPayload/);
  assert.match(service, /function normalizeIntakeItem/);
  assert.match(service, /function resolveIntakeCustomer/);
  assert.match(service, /function parseDelimitedRows/);
  assert.match(service, /function parseManualIntakeText/);
  assert.match(server, /require\('\.\/services\/intakeWorkflow'\)/);
  assert.match(server, /intakeWorkflow\.buildIntakeOrderPayload/);
  assert.match(server, /intakeWorkflow\.buildOrderImportPreview/);
  assert.match(reviewRoute, /intakeWorkflow\.parseManualIntakeText/);
  assert.match(server, /intakeWorkflow\.resolveIntakeCustomer/);
  assert.match(intakeRoute, /intakeWorkflow\.isStraightOcrShape/);
  assert.match(intakeRoute, /intakeWorkflow\.normalizeOcrLShapeSegments/);
  assert.match(intakeRoute, /total cut length/);
  assert.match(intakeRoute, /visible shape dimensions sum/);
  assert.doesNotMatch(intakeRoute, /assigned to the two end legs/);
  assert.match(server, /intakeWorkflow,\s*wsBroadcast,\s*\}\)\);/);
});

test('intake API routes are split out of the server monolith', () => {
  const route = read('routes/intake.js');
  const channelsRoute = read('routes/intakeChannels.js');
  const trainingRoute = read('routes/intakeTraining.js');
  const reviewRoute = read('routes/intakeReview.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createIntakeRouter/);
  assert.ok(route.includes("router.post('/analyze-image'"));
  assert.match(route, /saveAnalysisToIntake/);
  assert.match(route, /INSERT INTO intake_log/);
  assert.match(route, /wsBroadcast\('new_intake'/);
  assert.ok(!route.includes("router.get('/intake/training'"));
  assert.ok(!route.includes("router.post('/intake/training'"));
  assert.ok(!route.includes("router.delete('/intake/training/:id'"));
  assert.ok(route.includes("router.post('/intake/image'"));
  assert.ok(!route.includes("router.get('/intake/whatsapp'"));
  assert.ok(!route.includes("router.post('/intake/whatsapp'"));
  assert.ok(!route.includes("router.post('/intake/email/poll'"));
  assert.ok(!route.includes("router.get('/intake/log'"));
  assert.ok(!route.includes("router.post('/intake/:id/approve'"));
  assert.ok(!route.includes("router.post('/intake/:id/reject'"));
  assert.ok(!route.includes("router.post('/intake/parse-text'"));
  assert.match(channelsRoute, /module\.exports = function createIntakeChannelsRouter/);
  assert.match(channelsRoute, /routes\/intakeChannels missing dependency/);
  assert.ok(channelsRoute.includes("router.get('/intake/whatsapp'"));
  assert.ok(channelsRoute.includes("router.post('/intake/whatsapp'"));
  assert.ok(channelsRoute.includes("router.post('/intake/email/poll'"));
  assert.match(channelsRoute, /verifyWhatsAppSignature/);
  assert.match(channelsRoute, /wsBroadcast\('new_intake'/);
  assert.match(channelsRoute, /INTAKE_AI_ENABLED/);
  assert.match(trainingRoute, /module\.exports = function createIntakeTrainingRouter/);
  assert.match(trainingRoute, /routes\/intakeTraining missing dependency/);
  assert.ok(trainingRoute.includes("router.get('/intake/training'"));
  assert.ok(trainingRoute.includes("router.post('/intake/training'"));
  assert.ok(trainingRoute.includes("router.delete('/intake/training/:id'"));
  assert.match(trainingRoute, /requireAnyRole\(\['manager', 'admin'\]\)/);
  assert.match(reviewRoute, /module\.exports = function createIntakeReviewRouter/);
  assert.match(reviewRoute, /routes\/intakeReview missing dependency/);
  assert.ok(reviewRoute.includes("router.get('/intake/log'"));
  assert.ok(reviewRoute.includes("router.post('/intake/:id/approve'"));
  assert.ok(reviewRoute.includes("router.post('/intake/:id/reject'"));
  assert.ok(reviewRoute.includes("router.post('/intake/parse-text'"));
  assert.match(reviewRoute, /createOrderFromPayload/);
  assert.match(reviewRoute, /req\.body\?\.parsed_data/);
  assert.match(reviewRoute, /intake_training_examples/);
  assert.match(reviewRoute, /wsBroadcast\('new_order'/);
  assert.match(server, /createIntakeRouter/);
  assert.match(server, /createIntakeChannelsRouter/);
  assert.match(server, /createIntakeTrainingRouter/);
  assert.match(server, /createIntakeReviewRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('intake'), createIntakeTrainingRouter"));
  assert.ok(server.includes("app.use('/api', requireModule('intake'), createIntakeReviewRouter"));
  assert.ok(server.includes("app.use('/api', requireModule('intake'), createIntakeChannelsRouter"));
  assert.ok(server.includes("app.use('/api', requireModule('intake'), createIntakeRouter"));
  assert.ok(!server.includes("app.post('/api/analyze-image'"));
  assert.ok(!server.includes("app.get('/api/intake/training'"));
  assert.ok(!server.includes("app.post('/api/intake/training'"));
  assert.ok(!server.includes("app.delete('/api/intake/training/:id'"));
  assert.ok(!server.includes("app.post('/api/intake/image'"));
  assert.ok(!server.includes("app.get('/api/intake/whatsapp'"));
  assert.ok(!server.includes("app.post('/api/intake/whatsapp'"));
  assert.ok(!server.includes("app.post('/api/intake/email/poll'"));
  assert.ok(!server.includes("app.get('/api/intake/log'"));
  assert.ok(!server.includes("app.post('/api/intake/:id/approve'"));
  assert.ok(!server.includes("app.post('/api/intake/:id/reject'"));
  assert.ok(!server.includes("app.post('/api/intake/parse-text'"));
});

test('OCR document intake is explicitly routed by module, not AI guessing', () => {
  const intakeRoute = read('routes/intake.js');
  const inventoryPage = read('public/inventory.html');
  const orderPage = read('public/index.html');

  assert.match(intakeRoute, /function requestedOcrDocumentType/);
  assert.match(intakeRoute, /document_type_hint/);
  assert.match(intakeRoute, /wrong_document_route/);
  assert.match(intakeRoute, /CUSTOMER ORDER \/ BAR SCHEDULE/);
  assert.doesNotMatch(intakeRoute, /First identify the document format/);
  assert.match(orderPage, /id="ocrDocumentType"/);
  assert.match(orderPage, /fd\.append\('document_type_hint'/);
  assert.match(inventoryPage, /document_type_hint', 'supplier_delivery'/);
  assert.match(inventoryPage, /accept="image\/\*,\.pdf,application\/pdf"/);
});

test('fleet vehicle health and input normalization live in a fleet service', () => {
  const service = read('services/fleet.js');
  const route = read('routes/fleet.js');
  const server = read('server.js');

  assert.match(service, /function vehicleHealth/);
  assert.match(service, /function vehicleInput/);
  assert.match(service, /טסט/);
  assert.match(service, /ביטוח/);
  assert.match(service, /טיפול לפי ק"מ/);
  assert.match(route, /require\('\.\.\/services\/fleet'\)/);
  assert.match(route, /fleetService\.vehicleHealth/);
  assert.match(route, /fleetService\.vehicleInput/);
  assert.doesNotMatch(server, /function vehicleHealth/);
  assert.doesNotMatch(server, /function vehicleInput/);
});

test('customer CRM project and site API routes are split out of the server monolith', () => {
  const route = read('routes/customers.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createCustomersRouter/);
  assert.ok(route.includes('routes/customers missing dependency'));
  assert.ok(!route.includes("router.get('/customers/:id/token'"));
  assert.ok(!route.includes("router.post('/customers/:id/token/rotate'"));
  assert.ok(!route.includes('c.portal_token'));

  for (const routeSnippet of [
    "router.get('/customers'",
    "router.get('/customers/:id'",
    "router.post('/customers'",
    "router.patch('/customers/:id'",
    "router.get('/projects'",
    "router.get('/projects/:id'",
    "router.post('/projects'",
    "router.patch('/projects/:id'",
    "router.get('/sites'",
    "router.post('/sites'",
    "router.patch('/sites/:id'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
  }

  assert.match(server, /createCustomersRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('customers'), createCustomersRouter"));
  for (const forbiddenSnippet of [
    "app.get('/api/customers',",
    "app.get('/api/customers/:id',",
    "app.post('/api/customers',",
    "app.patch('/api/customers/:id',",
    "app.get('/api/projects'",
    "app.post('/api/projects'",
    "app.patch('/api/projects/:id'",
    "app.get('/api/sites'",
    "app.post('/api/sites'",
    "app.patch('/api/sites/:id'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }

  assert.ok(!server.includes("app.get('/api/customers/:id/token'"));
  assert.ok(!server.includes("app.patch('/api/customers/:id/pricing'"));
});

test('auth identity routes are split out of admin and server monolith', () => {
  const route = read('routes/auth.js');
  const admin = read('routes/admin.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createAuthRouter/);
  assert.ok(route.includes('routes/auth missing dependency'));
  assert.ok(route.includes("router.post('/auth/login'"));
  assert.ok(route.includes("router.post('/auth/refresh'"));
  assert.ok(route.includes("router.post('/auth/logout'"));
  assert.ok(route.includes("router.post('/users/login'"));
  assert.match(route, /refreshCookie/);
  assert.match(route, /parseCookies/);
  assert.doesNotMatch(route, /router[.](get|post|patch)\('\/settings/);
  assert.doesNotMatch(route, /router[.](get|post|patch)\('\/users'/);
  assert.doesNotMatch(admin, /router[.]post\('\/auth\//);

  assert.match(server, /createAuthRouter/);
  assert.ok(server.includes("app.use('/api', createAuthRouter"));
  assert.ok(!server.includes("app.post('/api/auth/login'"));
  assert.ok(!server.includes("app.post('/api/auth/refresh'"));
  assert.ok(!server.includes("app.post('/api/auth/logout'"));
  assert.ok(!server.includes("app.post('/api/users/login'"));
});

test('customer portal and portal management routes are split out of the server monolith', () => {
  const route = read('routes/portal.js');
  const adminRoute = read('routes/portalAdmin.js');
  const accessService = read('services/portalAccess.js');
  const customers = read('routes/customers.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createPortalRouter/);
  assert.ok(route.includes('routes/portal missing dependency'));
  assert.ok(route.includes("router.post('/c/auth'"));
  assert.ok(route.includes("router.post('/c/auth/verify'"));
  assert.ok(route.includes("router.get('/c/me'"));
  assert.ok(route.includes("router.get('/c/price-list'"));
  assert.ok(route.includes("router.post('/c/quote'"));
  assert.ok(route.includes("router.post('/c/order'"));
  assert.ok(route.includes("router.get('/c/guarantee-documents'"));
  assert.ok(route.includes("router.post('/c/guarantee-documents'"));
  assert.ok(route.includes("router.get('/c/approve/:token'"));
  assert.ok(route.includes("router.post('/c/approve'"));
  assert.ok(route.includes("router.get('/c/orders/:orderId'"));
  assert.ok(!route.includes("router.get('/customers/:id/token'"));
  assert.ok(!route.includes("router.post('/customers/:id/token/rotate'"));
  assert.ok(!route.includes("router.delete('/customers/:id/token'"));
  assert.ok(!route.includes("router.patch('/customers/:id/pricing'"));
  assert.match(route, /createPortalAccessService/);
  assert.match(route, /customerPortalAuthLimiter/);
  assert.match(route, /customerPortalActionLimiter/);
  assert.match(route, /required\('upload',\s+deps\.upload\)/);
  assert.match(route, /customer_guarantee_documents/);
  assert.match(route, /portal_guarantee_uploaded/);

  assert.match(adminRoute, /module[.]exports = function createPortalAdminRouter/);
  assert.ok(adminRoute.includes('routes/portalAdmin missing dependency'));
  assert.ok(adminRoute.includes("router.get('/customers/:id/token'"));
  assert.ok(adminRoute.includes("router.post('/customers/:id/token/rotate'"));
  assert.ok(adminRoute.includes("router.delete('/customers/:id/token'"));
  assert.ok(adminRoute.includes("router.patch('/customers/:id/pricing'"));
  assert.match(adminRoute, /requireAnyRole\(\['office', 'manager', 'admin'\]\)/);
  assert.match(adminRoute, /createPortalAccessService/);
  assert.match(accessService, /module[.]exports = \{ createPortalAccessService \}/);
  assert.match(accessService, /CUSTOMER_PORTAL_COLS/);
  assert.match(accessService, /function resolveCustomer/);
  assert.match(accessService, /function issuePortalOtp/);
  assert.match(accessService, /function verifyPortalOtp/);
  assert.match(accessService, /function portalAuthResponse/);

  assert.ok(!customers.includes("router.get('/customers/:id/token'"));
  assert.ok(!customers.includes("router.patch('/customers/:id/pricing'"));

  assert.match(server, /createPortalRouter/);
  assert.match(server, /createPortalAdminRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('portal'), createPortalAdminRouter"));
  assert.ok(server.includes("app.use('/api', requireModule('portal'), createPortalRouter"));
  assert.match(server, /createPortalRouter\(\{[\s\S]*upload,[\s\S]*PORT,[\s\S]*IS_TEST,[\s\S]*\}\)/);
  for (const forbiddenSnippet of [
    "app.get('/api/customers/:id/token'",
    "app.post('/api/customers/:id/token/rotate'",
    "app.delete('/api/customers/:id/token'",
    "app.patch('/api/customers/:id/pricing'",
    "app.post('/api/c/auth'",
    "app.post('/api/c/auth/verify'",
    "app.get('/api/c/me'",
    "app.get('/api/c/price-list'",
    "app.post('/api/c/quote'",
    "app.post('/api/c/order'",
    "app.get('/api/c/guarantee-documents'",
    "app.post('/api/c/guarantee-documents'",
    "app.get('/api/c/approve/:token'",
    "app.post('/api/c/approve'",
    "app.get('/api/c/orders/:orderId'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }
});

test('admin settings users audit and database routes are split out of the server monolith', () => {
  const route = read('routes/admin.js');
  const auth = read('routes/auth.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createAdminRouter/);
  assert.ok(route.includes('routes/admin missing dependency'));
  assert.ok(route.includes("router.get('/settings'"));
  assert.ok(route.includes("router.post('/settings'"));
  assert.ok(route.includes("router.post('/settings/test/:service'"));
  assert.ok(route.includes("router.get('/audit-log'"));
  assert.ok(route.includes("router.get('/users'"));
  assert.ok(route.includes("router.get('/kiosk/operators'"));
  assert.ok(route.includes("router.post('/users'"));
  assert.ok(route.includes("router.patch('/users/:id'"));
  assert.ok(route.includes("router.get('/admin/data-audit'"));
  assert.ok(route.includes("router.get('/admin/database/download'"));
  assert.ok(route.includes("router.post('/admin/database/upload'"));
  assert.match(route, /getDb/);
  assert.match(route, /setDb/);
  assert.match(route, /validateUploadedDatabase/);
  assert.match(route, /allowDatabaseUpload/);
  assert.doesNotMatch(auth, /router[.](get|post|patch)\('\/settings/);
  assert.doesNotMatch(auth, /router[.](get|post|patch)\('\/admin\//);

  assert.match(server, /createAdminRouter/);
  assert.ok(server.includes("app.use('/api', createAdminRouter"));
  for (const forbiddenSnippet of [
    "app.get('/api/settings'",
    "app.post('/api/settings'",
    "app.post('/api/settings/test/:service'",
    "app.get('/api/audit-log'",
    "app.get('/api/users'",
    "app.get('/api/kiosk/operators'",
    "app.post('/api/users'",
    "app.patch('/api/users/:id'",
    "app.get('/api/admin/data-audit'",
    "app.get('/api/admin/database/download'",
    "app.post('/api/admin/database/upload'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }
  assert.ok(server.includes("app.get('/api/health'"));
});

test('quality API routes are split out of the server monolith without maintenance ownership', () => {
  const route = read('routes/quality.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createQualityRouter/);
  assert.ok(route.includes('routes/quality missing dependency'));
  assert.ok(!route.includes('requireRole'));
  assert.ok(route.includes('INSERT INTO quality_checks'));
  assert.ok(route.includes('UPDATE items SET qc_status'));
  assert.match(route, /itemShapeMetrics/);
  assert.match(route, /shape_v2_total_weight_kg/);

  for (const routeSnippet of [
    "router.get('/quality'",
    "router.post('/quality'",
    "router.get('/quality/stats'",
    "router.get('/incidents'",
    "router.post('/incidents'",
    "router.patch('/incidents/:id'",
    "router.get('/ncr'",
    "router.post('/ncr'",
    "router.patch('/ncr/:id'",
    "router.get('/capa'",
    "router.post('/capa'",
    "router.patch('/capa/:id'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
  }

  for (const forbiddenRouteSnippet of [
    "router.get('/maintenance'",
    "router.post('/maintenance'",
    "router.patch('/maintenance/:id'",
    "router.get('/maintenance/stats'",
    "router.get('/loto'",
    "router.post('/loto'",
    "router.patch('/loto/:id/release'",
    "router.get('/pm-schedule'",
    "router.post('/pm-schedule'",
  ]) {
    assert.ok(!route.includes(forbiddenRouteSnippet), forbiddenRouteSnippet);
  }

  assert.match(server, /createQualityRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('quality'), createQualityRouter"));
});

test('maintenance API routes are split from quality and mounted as their own module', () => {
  const route = read('routes/maintenance.js');
  const quality = read('routes/quality.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createMaintenanceRouter/);
  assert.ok(route.includes('routes/maintenance missing dependency'));
  assert.ok(route.includes("wsBroadcast('machine_update'"));
  assert.ok(route.includes('UPDATE machines SET status='));

  for (const routeSnippet of [
    "router.get('/maintenance'",
    "router.post('/maintenance'",
    "router.patch('/maintenance/:id'",
    "router.get('/maintenance/stats'",
    "router.get('/loto'",
    "router.post('/loto'",
    "router.patch('/loto/:id/release'",
    "router.get('/pm-schedule'",
    "router.post('/pm-schedule'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
    assert.ok(!quality.includes(routeSnippet), `quality still owns ${routeSnippet}`);
  }

  assert.match(server, /createMaintenanceRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('maintenance'), createMaintenanceRouter"));
  for (const forbiddenSnippet of [
    "app.get('/api/quality'",
    "app.post('/api/quality'",
    "app.get('/api/maintenance'",
    "app.post('/api/maintenance'",
    "app.patch('/api/maintenance/:id'",
    "app.get('/api/incidents'",
    "app.post('/api/incidents'",
    "app.patch('/api/incidents/:id'",
    "app.get('/api/ncr'",
    "app.post('/api/ncr'",
    "app.patch('/api/ncr/:id'",
    "app.get('/api/capa'",
    "app.post('/api/capa'",
    "app.patch('/api/capa/:id'",
    "app.get('/api/loto'",
    "app.post('/api/loto'",
    "app.patch('/api/loto/:id/release'",
    "app.get('/api/pm-schedule'",
    "app.post('/api/pm-schedule'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }
});

test('production execution API routes are split out of the server monolith', () => {
  const route = read('routes/production.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createProductionRouter/);
  for (const routeSnippet of [
    "router.get('/workers'",
    "router.post('/workers'",
    "router.post('/scan'",
    "router.get('/production-queue'",
    "router.get('/production-events'",
    "router.patch('/items/:id/status'",
    "router.get('/items/:id/status-correction-preview'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
  }
  assert.ok(route.includes("wsBroadcast('machine_assign'"));
  assert.match(route, /createProductionMachinesRouter/);
  assert.match(route, /checkOrderComplete/);
  assert.match(route, /actual_weight_kg/);
  assert.match(route, /weight_deviation_pct/);
  assert.match(route, /SELECT i\.\*, p\.order_id, o\.order_num, o\.status AS order_status/);
  assert.match(route, /\(\(actualWeight - targetWeight\) \/ targetWeight\) \* 100/);
  assert.match(route, /i\.actual_weight_kg, i\.weight_deviation_pct/);
  assert.ok(!route.includes("router.get('/machines'"));
  assert.ok(!route.includes("router.post('/machines'"));
  assert.ok(!route.includes("router.patch('/machines/:id/config'"));
  assert.ok(!route.includes("router.patch('/machines/:id/state'"));
  assert.doesNotMatch(route, /router\.get\('\/reports\/waste'/);
  assert.doesNotMatch(route, /router\.get\('\/waste\/summary'/);
  assert.match(server, /createProductionRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('production'), createProductionRouter"));

  for (const forbiddenSnippet of [
    "app.get('/api/workers'",
    "app.post('/api/workers'",
    "app.get('/api/machines'",
    "app.post('/api/machines'",
    "app.patch('/api/machines/:id/config'",
    "app.patch('/api/machines/:id/state'",
    "app.post('/api/scan'",
    "app.get('/api/production-queue'",
    "app.get('/api/production-events'",
    "app.patch('/api/items/:id/status'",
    "app.get('/api/kpi/tons-today'",
    "app.get('/api/kpi/shift-summary'",
    "app.get('/api/machines/oee'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }

  assert.match(server, /createProductionMetricsRouter/);
  assert.match(server, /createProductionShiftsRouter/);
  assert.ok(server.includes("createWarehouseRouter"));
  assert.ok(server.includes("createReportsRouter"));
});

test('production machine routes are split out of production execution', () => {
  const route = read('routes/productionMachines.js');
  const production = read('routes/production.js');

  assert.match(route, /module[.]exports = function createProductionMachinesRouter/);
  assert.ok(route.includes('routes/productionMachines missing dependency'));
  for (const routeSnippet of [
    "router.get('/machines'",
    "router.post('/machines'",
    "router.delete('/machines/:id'",
    "router.post('/machines/:id/send-params'",
    "router.post('/machines/:id/assign'",
    "router.patch('/machines/:id/config'",
    "router.post('/machines/:id/complete'",
    "router.patch('/machines/:id/state'",
    "router.get('/machines/:id/state-log'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
    assert.ok(!production.includes(routeSnippet), routeSnippet);
  }
  assert.match(route, /MACHINE_STATES/);
  assert.match(route, /STATE_TRANSITIONS/);
  assert.match(route, /modbus\.writeParams/);
  assert.match(route, /checkOrderComplete/);
});

test('production KPI routes are split out of production execution', () => {
  const route = read('routes/productionMetrics.js');
  const production = read('routes/production.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createProductionMetricsRouter/);
  assert.ok(route.includes('routes/productionMetrics missing dependency'));
  for (const routeSnippet of [
    "router.get('/kpi/tons-today'",
    "router.get('/machines/oee'",
    "router.get('/kpi/shift-summary'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
    assert.ok(!production.includes(routeSnippet), routeSnippet);
  }
  assert.match(route, /productionActuals[.]getDailyProductionActuals/);
  assert.doesNotMatch(route, /SUM\(i[.]total_weight\)/);
  assert.match(server, /createProductionMetricsRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('production'), createProductionMetricsRouter"));
  assert.doesNotMatch(server, /app\.(get|post|patch|delete)\('\/api\/(?:kpi\/tons-today|kpi\/shift-summary|machines\/oee)/);
});

test('production shifts and machine stop routes are split out of production execution', () => {
  const route = read('routes/productionShifts.js');
  const production = read('routes/production.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createProductionShiftsRouter/);
  assert.ok(route.includes('routes/productionShifts missing dependency'));
  for (const routeSnippet of [
    "router.get('/shifts'",
    "router.post('/shifts'",
    "router.patch('/shifts/:id/end'",
    "router.get('/downtime-reasons'",
    "router.get('/machine-stops'",
    "router.post('/machine-stops'",
    "router.patch('/machine-stops/:id/end'",
  ]) {
    assert.ok(route.includes(routeSnippet), routeSnippet);
    assert.ok(!production.includes(routeSnippet), routeSnippet);
  }
  assert.match(route, /INSERT INTO production_events/);
  assert.match(server, /createProductionShiftsRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('production'), createProductionShiftsRouter"));
  assert.doesNotMatch(server, /app\.(get|post|patch|delete)\('\/api\/(?:shifts|machine-stops|downtime-reasons)/);
});

test('warehouse package and delivery note routes are split out of the server monolith', () => {
  const route = read('routes/warehouse.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createWarehouseRouter/);
  assert.ok(route.includes('routes/warehouse missing dependency'));
  assert.ok(route.includes("router.get('/packages'"));
  assert.ok(route.includes("router.post('/packages'"));
  assert.ok(route.includes("router.patch('/packages/:id/ship'"));
  assert.ok(route.includes("router.get('/delivery-notes'"));
  assert.ok(route.includes("router.post('/delivery-notes'"));
  assert.match(route, /package_code/);
  assert.match(route, /note_num/);
  assert.match(server, /createWarehouseRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('warehouse'), createWarehouseRouter"));
  for (const forbiddenSnippet of [
    "app.get('/api/packages'",
    "app.post('/api/packages'",
    "app.patch('/api/packages/:id/ship'",
    "app.get('/api/delivery-notes'",
    "app.post('/api/delivery-notes'",
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }
});

test('dashboard reports KPI and export routes are split out of the server monolith', () => {
  const route = read('routes/reports.js');
  const server = read('server.js');

  assert.match(route, /module[.]exports = function createReportsRouter/);
  assert.ok(route.includes('routes/reports missing dependency'));
  assert.ok(route.includes("router.get('/dashboard'"));
  assert.ok(route.includes("router.get('/reports/summary'"));
  assert.ok(route.includes("router.get('/reports/waste'"));
  assert.ok(route.includes("router.get('/waste/summary'"));
  assert.ok(route.includes("router.get('/kpi/monthly'"));
  assert.ok(route.includes("router.get('/export/orders'"));
  assert.ok(route.includes("router.get('/export/packages'"));
  assert.ok(route.includes("router.get('/export/inventory'"));
  assert.match(route, /function toCSV/);
  assert.match(route, /statusContracts[.]ITEM_STATUS[.]DONE/);
  assert.match(route, /itemShapeMetrics/);
  assert.match(route, /function orderCreatedWeightByDate/);
  assert.match(route, /function wasteSummaryByDiameter/);
  assert.match(route, /function periodWasteRows/);
  assert.match(route, /function machineEfficiencyByPeriod/);
  assert.match(route, /function reportDataQuality/);
  assert.match(route, /shape_v2_item_count/);
  assert.doesNotMatch(route, /SUM\(i[.]total_weight\)/);
  assert.doesNotMatch(route, /ai[.]analyzeWastePatterns/);
  assert.match(server, /createReportsRouter/);
  assert.ok(server.includes("app.use('/api', requireModule('reports'), createReportsRouter"));
  for (const forbiddenSnippet of [
    "app.get('/api/dashboard'",
    "app.get('/api/reports/summary'",
    "app.get('/api/reports/waste'",
    "app.get('/api/waste/summary'",
    "app.get('/api/kpi/monthly'",
    "app.get('/api/export/orders'",
    "app.get('/api/export/packages'",
    "app.get('/api/export/inventory'",
    'function toCSV',
  ]) {
    assert.ok(!server.includes(forbiddenSnippet), forbiddenSnippet);
  }
});

test('fleet API routes are split out of the server monolith', () => {
  const route = read('routes/fleet.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createFleetRouter/);
  assert.match(route, /require\('\.\.\/services\/fleet'\)/);
  assert.match(route, /function vehiclePortfolioRows/);
  assert.match(route, /function driverRows/);
  assert.match(route, /router\.get\('\/vehicles'/);
  assert.match(route, /router\.post\('\/vehicles'/);
  assert.match(route, /router\.patch\('\/vehicles\/:id'/);
  assert.match(route, /router\.get\('\/vehicles\/:id\/events'/);
  assert.match(route, /router\.post\('\/vehicles\/:id\/events'/);
  assert.match(route, /router\.get\('\/vehicles\/:id\/documents'/);
  assert.match(route, /router\.post\('\/vehicles\/:id\/documents'/);
  assert.match(route, /router\.get\('\/drivers'/);
  assert.match(route, /router\.post\('\/drivers'/);
  assert.match(route, /router\.patch\('\/drivers\/:id'/);
  assert.match(route, /router\.delete\('\/drivers\/:id'/);
  assert.match(route, /router\.get\('\/drivers\/:id\/vehicle-events'/);
  assert.match(route, /router\.post\('\/drivers\/:id\/vehicle-events'/);
  assert.match(route, /router\.patch\('\/drivers\/:id\/location'/);
  assert.doesNotMatch(route, /router\.(get|post|patch|delete)\('\/deliveries/);
  assert.doesNotMatch(route, /intakeNotify/);
  assert.doesNotMatch(route, /priorityUpdate/);
  assert.doesNotMatch(route, /createAlert\('delivery_problem'/);
  assert.match(server, /createFleetRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('fleet'\), createFleetRouter/);
  assert.doesNotMatch(server, /app\.(get|post|patch|delete)\('\/api\/vehicles/);
  assert.doesNotMatch(server, /app\.(get|post|patch|delete)\('\/api\/drivers/);
  assert.doesNotMatch(server, /function vehiclePortfolioRows/);
  assert.doesNotMatch(server, /function driverRows/);
  assert.match(server, /createPriorityRouter/);
  assert.match(server, /createWarehouseRouter/);
});

test('logistics delivery routes are split out of fleet', () => {
  const route = read('routes/logistics.js');
  const fleet = read('routes/fleet.js');
  const server = read('server.js');

  assert.match(route, /module\.exports = function createLogisticsRouter/);
  assert.ok(route.includes('routes/logistics missing dependency'));
  assert.match(route, /router\.get\('\/deliveries'/);
  assert.match(route, /router\.post\('\/deliveries'/);
  assert.match(route, /router\.post\('\/deliveries\/:id\/depart'/);
  assert.match(route, /router\.post\('\/deliveries\/:id\/confirm'/);
  assert.match(route, /router\.post\('\/deliveries\/:id\/problem'/);
  assert.match(route, /intakeNotify/);
  assert.match(route, /priorityUpdate/);
  assert.match(route, /createAlert\('delivery_problem'/);
  assert.match(server, /createLogisticsRouter/);
  assert.match(server, /app\.use\('\/api', requireModule\('logistics'\), createLogisticsRouter/);
  assert.doesNotMatch(fleet, /router\.(get|post|patch|delete)\('\/deliveries/);
  assert.doesNotMatch(server, /app\.(get|post|patch|delete)\('\/api\/deliveries/);
});

test('remaining utility API routes are split out of the server monolith', () => {
  const server = read('server.js');
  const alerts = read('routes/alerts.js');
  const companies = read('routes/companies.js');
  const priority = read('routes/priority.js');
  const ai = read('routes/ai.js');
  const search = read('routes/search.js');
  const bvbs = read('routes/bvbs.js');

  assert.match(alerts, /module[.]exports = function createAlertsRouter/);
  assert.ok(alerts.includes("router.get('/alerts'"));
  assert.ok(alerts.includes("router.post('/alerts'"));
  assert.ok(alerts.includes("router.patch('/alerts/:id/resolve'"));

  assert.match(companies, /module[.]exports = function createCompaniesRouter/);
  assert.ok(companies.includes("router.get('/companies'"));
  assert.ok(companies.includes("router.post('/companies'"));
  assert.ok(companies.includes("router.patch('/companies/:id'"));
  assert.ok(companies.includes("router.get('/holdings'"));

  assert.match(priority, /module[.]exports = function createPriorityRouter/);
  assert.ok(priority.includes("router.post('/priority/sync/:orderId'"));
  assert.ok(priority.includes("router.get('/priority/status'"));

  assert.match(ai, /module[.]exports = function createAiRouter/);
  assert.ok(ai.includes("router.post('/ai/predict'"));
  assert.ok(ai.includes("router.get('/ai/predict-order/:orderId'"));
  assert.ok(ai.includes("router.get('/ai/waste-patterns'"));
  assert.ok(ai.includes("router.get('/ai/machine-efficiency'"));

  assert.match(search, /module[.]exports = function createSearchRouter/);
  assert.ok(search.includes("router.get('/search'"));

  assert.match(bvbs, /module[.]exports = function createBvbsRouter/);
  assert.match(bvbs, /function parseBVBSLine/);
  assert.match(bvbs, /function parseBVBS/);
  assert.ok(bvbs.includes("router.post('/bvbs/parse'"));
  assert.ok(bvbs.includes("router.post('/bvbs/create-order'"));

  for (const forbidden of [
    "app.get('/api/alerts'",
    "app.post('/api/alerts'",
    "app.patch('/api/alerts/:id/resolve'",
    "app.get('/api/companies'",
    "app.post('/api/companies'",
    "app.patch('/api/companies/:id'",
    "app.get('/api/holdings'",
    "app.post('/api/priority/sync/:orderId'",
    "app.get('/api/priority/status'",
    "app.post('/api/ai/predict'",
    "app.get('/api/ai/predict-order/:orderId'",
    "app.get('/api/ai/waste-patterns'",
    "app.get('/api/ai/machine-efficiency'",
    "app.get('/api/search'",
    "app.post('/api/bvbs/parse'",
    "app.post('/api/bvbs/create-order'",
    'function parseBVBSLine',
    'function parseBVBS',
  ]) {
    assert.ok(!server.includes(forbidden), forbidden);
  }
});


test('database startup schema migrations and seed data are extracted from server', () => {
  const startup = read('db/startup.js');
  const coreSchema = read('db/coreSchema.js');
  const seed = read('db/seed.js');
  const vehicleMigrations = read('db/vehicleMigrations.js');
  const server = read('server.js');

  assert.match(startup, /require\('\.\/coreSchema'\)/);
  assert.doesNotMatch(startup, /function ensureCoreSchema\(db\)/);
  assert.match(startup, /function runCoreMigrations\(db\)/);
  assert.doesNotMatch(startup, /function seedCoreData\(db\)/);
  assert.match(startup, /require\('\.\/seed'\)/);
  assert.match(startup, /require\('\.\/vehicleMigrations'\)/);
  assert.doesNotMatch(startup, /CREATE TABLE IF NOT EXISTS customers/);
  assert.match(startup, /function addCol\(table, col, def\)/);
  assert.match(startup, /addCol\('items',\s+'actual_weight_kg'/);
  assert.match(startup, /addCol\('items',\s+'weight_deviation_pct'/);
  assert.match(startup, /addCol\('items',\s+'spiral_diameter_mm'/);
  assert.match(startup, /addCol\('items',\s+'spiral_turns'/);
  assert.match(startup, /ensureVehicleCompatibility\(db\)/);
  assert.doesNotMatch(startup, /function ensureVehicleEventsSchema/);
  assert.doesNotMatch(startup, /function migrateDriverVehicleRows/);
  assert.match(coreSchema, /function ensureCoreSchema\(db\)/);
  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS customers/);
  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS orders/);
  assert.match(coreSchema, /actual_weight_kg REAL/);
  assert.match(coreSchema, /spiral_diameter_mm REAL/);
  assert.match(coreSchema, /spiral_turns REAL/);
  assert.match(coreSchema, /weight_deviation_pct REAL/);
  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS purchase_orders/);
  assert.match(coreSchema, /ensureFinanceSchema\(db\)/);
  assert.match(seed, /function seedCoreData\(db\)/);
  assert.match(seed, /INSERT OR IGNORE INTO downtime_reasons/);
  assert.match(seed, /INSERT OR IGNORE INTO companies/);
  assert.match(seed, /INSERT OR IGNORE INTO machines/);
  assert.match(seed, /INSERT OR IGNORE INTO shapes/);
  assert.match(vehicleMigrations, /function ensureVehicleCompatibility\(db\)/);
  assert.match(vehicleMigrations, /function ensureVehicleEventsSchema/);
  assert.match(vehicleMigrations, /function migrateDriverVehicleRows/);
  assert.match(vehicleMigrations, /vehicle_events_new/);
  assert.match(server, /require\('\.\/db\/startup'\)/);
  assert.match(server, /ensureCoreSchema\(db\)/);
  assert.match(server, /runCoreMigrations\(db\)/);
  assert.match(server, /seedCoreData\(db\)/);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS customers/);
  assert.doesNotMatch(server, /function addCol\(table, col, def\)/);
  assert.doesNotMatch(server, /INSERT OR IGNORE INTO downtime_reasons/);
});


test('realtime websocket transport is extracted from server', () => {
  const realtime = read('realtime/ws.js');
  const server = read('server.js');

  assert.match(realtime, /function createRealtimeServer\(deps\)/);
  assert.match(realtime, /new WebSocketServer\(\{ noServer: true \}\)/);
  assert.match(realtime, /function wsBroadcast\(type, data\)/);
  assert.match(realtime, /const eventStats = new Map\(\)/);
  assert.match(realtime, /function getEventStats\(\)/);
  assert.match(realtime, /server\.on\('upgrade', onUpgrade\)/);
  assert.match(realtime, /modbus\.onUpdate/);
  assert.match(realtime, /machines_state/);
  assert.match(server, /require\('\.\/realtime\/ws'\)/);
  assert.match(server, /const realtime = createRealtimeServer\(\{ server, db, modbus, authService, applyAuthBypass \}\)/);
  assert.match(server, /const wsBroadcast = realtime\.wsBroadcast/);
  assert.doesNotMatch(server, /new WebSocketServer/);
  assert.doesNotMatch(server, /function wsBroadcast\(type, data\)/);
  assert.doesNotMatch(server, /wss\.on\('connection'/);
  assert.doesNotMatch(server, /server\.on\('upgrade'/);
});

test('module map control plane reads route manifests and live websocket events', () => {
  const service = read('services/moduleMap.js');
  const admin = read('routes/admin.js');
  const server = read('server.js');

  assert.match(service, /function createModuleMapService/);
  assert.match(service, /function snapshot\(\)/);
  assert.match(service, /flowStatus/);
  assert.match(admin, /router\.get\('\/admin\/module-map'/);
  assert.match(admin, /moduleMap\.snapshot\(\)/);
  assert.match(server, /createModuleMapService/);
  assert.match(server, /getEventStats: realtime\.getEventStats/);
  assert.match(server, /moduleMap,/);
});

test('event-producing route modules declare module-map manifests', () => {
  const files = [
    'routes/orders.js',
    'routes/portal.js',
    'routes/intakeChannels.js',
    'routes/intakeReview.js',
    'routes/financeInvoices.js',
    'routes/financeCosts.js',
    'routes/inventory.js',
    'routes/inventoryVision.js',
    'routes/production.js',
    'routes/productionMachines.js',
    'routes/fleet.js',
    'routes/logistics.js',
    'routes/quality.js',
    'routes/maintenance.js',
    'routes/alerts.js',
    'routes/bvbs.js',
  ];

  for (const file of files) {
    const source = read(file);
    const broadcasts = [...source.matchAll(/wsBroadcast\('([^']+)'/g)].map(match => match[1]);
    assert.match(source, /module\.exports\.manifest = \{/);
    assert.match(source, /produces:/);
    for (const event of broadcasts) {
      assert.match(source, new RegExp(`event: '${event}'`), `${file} missing manifest event ${event}`);
    }
  }
});

test('every route module declares a module-map manifest', () => {
  const routeDir = path.join(root, 'routes');
  const server = read('server.js');
  const routeFiles = fs.readdirSync(routeDir)
    .filter(file => file.endsWith('.js'))
    .sort();

  for (const file of routeFiles) {
    const source = read(`routes/${file}`);
    assert.match(source, /module\.exports\.manifest = \{/, `routes/${file} missing module-map manifest`);
    assert.match(source, /['"]?id['"]?\s*:/, `routes/${file} manifest missing id`);
    assert.match(source, /['"]?label['"]?\s*:/, `routes/${file} manifest missing label`);
    assert.match(source, /['"]?consumes['"]?\s*:/, `routes/${file} manifest missing consumes`);
    assert.match(source, /['"]?produces['"]?\s*:/, `routes/${file} manifest missing produces`);
    assert.ok(server.includes(`file: 'routes/${file}'`), `routes/${file} missing from server module-map routeModules`);
  }
});


test('scheduled background jobs are extracted from server', () => {
  const scheduler = read('jobs/scheduler.js');
  const server = read('server.js');

  assert.match(scheduler, /function createScheduler\(deps\)/);
  assert.match(scheduler, /cron\.schedule/);
  assert.match(scheduler, /settingsService\.getNum\('URGENT_ORDER_WAIT_MINUTES'/);
  assert.match(scheduler, /intake\.pollEmail/);
  assert.match(scheduler, /new_intake_email/);
  assert.match(scheduler, /createBackupService/);
  assert.match(scheduler, /db\.backup/);
  assert.match(server, /require\('\.\/jobs\/scheduler'\)/);
  assert.match(server, /const scheduler = createScheduler\(\{/);
  assert.match(server, /scheduler\.stop\(\)/);
  assert.doesNotMatch(server, /require\('node-cron'\)/);
  assert.doesNotMatch(server, /cron\.schedule/);
  assert.doesNotMatch(server, /createBackupService/);
  assert.doesNotMatch(server, /intake\.pollEmail/);
  assert.doesNotMatch(server, /new_intake_email/);
});


test('finance schema is extracted from server startup', () => {
  const financeSchema = read('db/financeSchema.js');
  const coreSchema = read('db/coreSchema.js');
  const server = read('server.js');

  assert.match(financeSchema, /function ensureFinanceSchema\(db\)/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS order_costs/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS cost_snapshots/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS customer_credit/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS financial_events/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS steel_prices/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS pricing_price_books/);
  assert.match(financeSchema, /CREATE TABLE IF NOT EXISTS pricing_price_items/);
  assert.doesNotMatch(coreSchema, /CREATE TABLE IF NOT EXISTS price_list/);
  assert.match(coreSchema, /require\('\.\/financeSchema'\)/);
  assert.match(coreSchema, /ensureFinanceSchema\(db\)/);
  assert.doesNotMatch(server, /FINANCIAL SCHEMA BOOTSTRAP/);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS order_costs/);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS customer_credit/);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS steel_prices/);
});


test('auth request middleware is extracted from server', () => {
  const auth = read('middleware/auth.js');
  const server = read('server.js');

  assert.match(auth, /function createAuthMiddleware\(deps\)/);
  assert.match(auth, /function optionalAuth\(req, _res, next\)/);
  assert.match(auth, /function applyAuthBypass\(req\)/);
  assert.match(auth, /function verifyWhatsAppSignature\(req, res, next\)/);
  assert.match(auth, /AUTH_BYPASS === 'true' && process\.env\.NODE_ENV === 'development'/);
  assert.match(auth, /authService\.verifyAccessToken\(token\)/);
  assert.match(auth, /crypto\.timingSafeEqual/);
  assert.match(server, /require\('\.\/middleware\/auth'\)/);
  assert.match(server, /createAuthMiddleware\(\{ authService, getRolePermission \}\)/);
  assert.doesNotMatch(server, /function bearerToken\(req\)/);
  assert.doesNotMatch(server, /function optionalAuth\(req, _res, next\)/);
  assert.doesNotMatch(server, /function applyAuthBypass\(req\)/);
  assert.doesNotMatch(server, /function verifyWhatsAppSignature\(req, res, next\)/);
});


test('database connection safety is extracted from server', () => {
  const connection = read('db/connection.js');
  const server = read('server.js');

  assert.match(connection, /function createDatabaseConnection\(/);
  assert.match(connection, /function snapshotDatabaseFiles\(sourcePath, backupBase\)/);
  assert.match(connection, /SKIP_STARTUP_DB_SNAPSHOT/);
  assert.match(connection, /ALLOW_EMPTY_DB_INIT/);
  assert.match(connection, /journal_mode = WAL/);
  assert.match(connection, /foreign_keys = ON/);
  assert.match(server, /require\('\.\/db\/connection'\)/);
  assert.match(server, /createDatabaseConnection\(\{ env: process\.env, rootDir: __dirname \}\)/);
  assert.doesNotMatch(server, /function snapshotDatabaseFiles\(sourcePath, backupBase\)/);
  assert.doesNotMatch(server, /DB_EXISTS_AT_STARTUP/);
  assert.doesNotMatch(server, /SKIP_STARTUP_DB_SNAPSHOT/);
  assert.doesNotMatch(server, /journal_mode = WAL/);
});


test('industry module is resolved through the loader, not hardcoded', () => {
  const server = read('server.js');
  const loader = read('services/moduleLoader.js');
  const steel = read('modules/steel-rebar/index.js');
  const settings = read('services/settings.js');

  assert.match(server, /createModuleLoader/);
  assert.match(server, /moduleLoader\.active\(\)/);
  assert.match(server, /=\s*industry;/);
  assert.match(loader, /ACTIVE_INDUSTRY_MODULE/);
  assert.match(loader, /'steel-rebar'/);
  assert.match(steel, /kgPerMeter:/);
  assert.match(steel, /assignResource:/);
  assert.match(steel, /normalizeSegments:/);
  assert.match(steel, /normalizeShapeName:/);
  assert.match(steel, /parseBatchFile:/);
  assert.match(steel, /weightPerUnit/);
  assert.match(settings, /ACTIVE_INDUSTRY_MODULE/);
  assert.doesNotMatch(server, /rebarKgPerMeter,\s*\n\}\s*=\s*constants/);
});


test('routes use the active industry contract for steel-specific calculations', () => {
  const server = read('server.js');
  const routeFiles = [
    'routes/orders.js',
    'routes/portal.js',
    'routes/financeCosts.js',
    'routes/bvbs.js',
    'routes/productionCards.js',
  ];

  for (const file of routeFiles) {
    const source = read(file);
    assert.match(source, /required\('industry', deps\.industry\)/, file);
    assert.doesNotMatch(source, /required\('rebarKgPerMeter'/, file);
  }

  assert.match(server, /createOrderFactory\(db, \{[\s\S]*industry,[\s\S]*\}\)/);
  assert.doesNotMatch(server, /createBvbsRouter\(\{[\s\S]*rebarKgPerMeter/);
  assert.doesNotMatch(server, /createPortalRouter\(\{[\s\S]*autoAssignMachine/);
});
