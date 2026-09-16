const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('client auth contract has a single fetch wrapper source', () => {
  const authClient = read('public/auth-client.js');
  const nav = read('public/nav.js');

  assert.match(authClient, /window\.IronBendAuth/);
  assert.match(authClient, /window\.fetch = authFetch/);
  assert.match(authClient, /showAuthNotice/);
  assert.match(authClient, /השרת עובד/);
  assert.match(authClient, /\/login\.html\?next=/);
  assert.doesNotMatch(nav, /window\.fetch\s*=/);
  assert.match(nav, /auth-client\.js/);
});

test('browser clients do not send spoofable role headers', () => {
  const publicFiles = fs.readdirSync(path.join(root, 'public'))
    .filter(file => /\.(html|js)$/.test(file))
    .map(file => `public/${file}`);

  const offenders = publicFiles
    .filter(file => file !== 'public/auth-client.js')
    .filter(file => /x-user-role|x-user-id/.test(read(file)));

  assert.deepEqual(offenders, []);

  const authClient = read('public/auth-client.js');
  assert.match(authClient, /headers\.delete\('x-user-role'\)/);
  assert.match(authClient, /headers\.delete\('x-user-id'\)/);
});

test('login stores sessions through IronBendAuth', () => {
  const login = read('public/login.html');

  assert.match(login, /src="\/auth-client\.js"/);
  assert.match(login, /IronBendAuth\.storeSession/);
  assert.doesNotMatch(login, /setItem\('ib_access_token'/);
  assert.doesNotMatch(login, /Demo mode/i);
  assert.doesNotMatch(login, /דמו/);
  assert.doesNotMatch(login, /PIN 1234/);
  assert.match(login, /requestedNext\.startsWith\('\/'\)/);
  assert.match(login, /!requestedNext\.startsWith\('\/\/'\)/);
});

test('QR scanning supports open mode and passwordless one-time device activation in secure mode', () => {
  const authClient = read('public/auth-client.js');
  const scanner = read('public/scan.html');
  const workerInvite = read('public/worker-invite.html');
  const nativeBridge = read('public/native-bridge.js');
  const warehouse = read('public/warehouse.html');
  const admin = read('public/admin.html');

  assert.match(authClient, /ironbend_device_credential_v1/);
  assert.match(authClient, /X-IronBend-Device/);
  assert.match(scanner, /\/api\/device-enrollment\/status/);
  assert.match(scanner, /\/api\/qr-access\/mode/);
  assert.match(scanner, /\/api\/qr-access\/scan/);
  assert.match(scanner, /קישור ההזמנה האישי/);
  assert.match(scanner, /deviceApproved/);
  assert.doesNotMatch(scanner, /IronBendAuth\?\.accessToken/);
  assert.match(workerInvite, /\/api\/worker-invitations\/activation/);
  assert.match(workerInvite, /ironbend_device_credential_v1/);
  assert.doesNotMatch(workerInvite, /id="username"/);
  assert.doesNotMatch(workerInvite, /id="pin"/);
  assert.match(nativeBridge, /appUrlOpen/);
  assert.match(nativeBridge, /customer-scan\.html/);
  assert.match(warehouse, /requireApprovedScanningDevice/);
  assert.match(warehouse, /\/api\/device-enrollment\/status/);
  assert.match(admin, /id="tab-devices"/);
  assert.match(admin, /reviewDevice/);
  assert.match(admin, /\/api\/device-enrollment\/requests/);
  assert.match(admin, /\/api\/qr-access\/mode/);
  assert.match(admin, /\/api\/worker-profiles/);
  assert.match(admin, /saveWorkerProfile/);
  assert.match(admin, /צור ושלח QR/);
});

test('public portal is a secure handoff to customer portal', () => {
  const portal = read('public/portal.html');

  assert.match(portal, /הגישה לפורטל הלקוחות מתבצעת באמצעות קישור או קוד מאובטח/);
  assert.match(portal, /href=\"\/customer\.html\"/);
  assert.doesNotMatch(portal, /\/api\/orders\?order_num=/);
  assert.doesNotMatch(portal, /DEMO_ORDERS/);
  assert.doesNotMatch(portal, /1042/);
  assert.doesNotMatch(portal, /1055/);
  assert.doesNotMatch(portal, /גבעון מתכות בע\"?מ/);
  assert.doesNotMatch(portal, /אזה\"?ת/);
  assert.doesNotMatch(portal, /wa\.me/);
});

test('production card preview mode shows cards but locks printing before approval', () => {
  const productionCardsRoute = read('routes/productionCards.js');
  const productionCardsPage = read('services/productionCardPrintPage.js');

  assert.match(productionCardsRoute, /const previewOnly = allItems\.length && !canCreateProductionCards\(order\)/);
  assert.match(productionCardsRoute, /X-Production-Cards-Preview-Only/);
  assert.match(productionCardsPage, /previewOnly = false/);
  assert.match(productionCardsPage, /preview-locked/);
  assert.match(productionCardsPage, /print-blocked-page/);
  assert.match(productionCardsPage, /if \(PREVIEW_ONLY\)/);
  assert.match(productionCardsPage, /orders\.html\?id=/);
});
test('production card split does not add a generic split master card', () => {
  const productionCardsRoute = read('services/productionCardPrintPage.js');
  const orderPrintA4Route = read('routes/orderPrintA4.js');

  assert.match(productionCardsRoute, /function cardPlan\(\)/);
  assert.doesNotMatch(productionCardsRoute, /function buildSplitMaster\(\)/);
  assert.doesNotMatch(productionCardsRoute, /d\.innerHTML = buildSplitMaster\(\)/);
  assert.doesNotMatch(productionCardsRoute, /cards\.masterCard/);
  assert.match(productionCardsRoute, /pile-cage-master-card/);
  assert.doesNotMatch(productionCardsRoute, /setup-panel/);
  assert.doesNotMatch(productionCardsRoute, /setupBody/);
  assert.doesNotMatch(productionCardsRoute, /onSplitChange/);
  assert.doesNotMatch(productionCardsRoute, /splitCfg/);
  assert.match(productionCardsRoute, /var cardSplits = \{\}/);
  assert.match(productionCardsRoute, /function setCardSplit\(itemId, count, event\)/);
  assert.match(productionCardsRoute, /pc-screen-tools/);
  assert.match(productionCardsRoute, /Math\.min\(2, Number\(cardSplits\[item\.id\]/);
  assert.match(productionCardsRoute, /buildCard\(row\.item, row\.subQty, row\.totalCards, row\.cardIdx\)/);
  assert.match(productionCardsRoute, /function isOpenUShapeClient\(segments\)/);
  assert.match(productionCardsRoute, /function buildOpenUShapeSVG\(segments\)/);
  assert.match(productionCardsRoute, /data-shape-kind="open-u"/);
  assert.match(productionCardsRoute, /function printCards\(\)[\s\S]*generateCards\(\);[\s\S]*window\.print\(\);/);
  assert.match(productionCardsRoute, /'-C' \+ \(cardIdx\+1\) \+ 'OF' \+ totalCards/);
  assert.match(productionCardsRoute, /@page\{size:A4 portrait;margin:0!important;\}/);
  assert.doesNotMatch(productionCardsRoute, /order-summary-sheet/);
  assert.doesNotMatch(productionCardsRoute, /data-order-url/);
  assert.match(orderPrintA4Route, /tene-pdf-logo\.jpg/);
  assert.match(orderPrintA4Route, /data-order-code/);
  assert.match(orderPrintA4Route, /customerScanUrl\(req, `TENE-ORDER-/);
  assert.doesNotMatch(orderPrintA4Route, /web\+ironbend:\/\/open\/order\//);
  assert.doesNotMatch(orderPrintA4Route, /data-order-url/);
  assert.match(orderPrintA4Route, /buildA4ProductionSummary/);
  assert.match(orderPrintA4Route, /buildOrderCommercialSummary/);
  assert.match(orderPrintA4Route, /bucketRows/);
  assert.doesNotMatch(orderPrintA4Route, /optionalWeightRows/);
  assert.doesNotMatch(orderPrintA4Route, /byBucket/);
  assert.doesNotMatch(orderPrintA4Route, /byDiameter/);
  assert.doesNotMatch(orderPrintA4Route, /diameterRows/);
  assert.match(orderPrintA4Route, /label\('cutting', 'חיתוך'\)/);
  assert.match(orderPrintA4Route, /label\('bending', 'כיפוף'\)/);
  assert.match(productionCardsRoute, /data-worker-card-code/);
  assert.match(productionCardsRoute, /customer-scan\.html\?code=/);
  assert.doesNotMatch(productionCardsRoute, /web\+ironbend:\/\/open\/card\//);
  assert.doesNotMatch(productionCardsRoute, /worker-visual\.html\?scan=1&card=/);
  assert.match(productionCardsRoute, /renderWorkerCardQrCodes/);
  assert.match(productionCardsRoute, /qrFallbackUrl/);
  assert.match(productionCardsRoute, /api\.qrserver\.com\/v1\/create-qr-code/);
  assert.match(productionCardsRoute, /data-qr-target/);
  assert.match(productionCardsRoute, /renderWorkerCardQrCodes\(\)\.then/);
  assert.match(productionCardsRoute, /function openCardSplitMenu\(itemId, event\)/);
  assert.match(productionCardsRoute, /pc-split-hotspot/);
  assert.match(productionCardsRoute, /data-split-menu-open/);
  assert.doesNotMatch(productionCardsRoute, /\\u05e4\\u05e6\\u05dc \\u05dc-2/);
  assert.match(productionCardsRoute, /grid-template-columns:repeat\(2,105mm\)/);
  assert.match(productionCardsRoute, /cards-pages/);
  assert.match(productionCardsRoute, /cards-page/);
  assert.match(productionCardsRoute, /renderA4CardPages/);
  assert.match(productionCardsRoute, /appendCardToA4Pages/);
  assert.match(productionCardsRoute, /index % 8 === 0/);
  assert.match(productionCardsRoute, /page-break-after:always/);
  assert.match(productionCardsRoute, /width:210mm/);
  assert.match(productionCardsRoute, /grid-template-columns:repeat\(2, 105mm\)/);
  assert.match(productionCardsRoute, /grid-auto-rows:74\.25mm/);
  assert.match(productionCardsRoute, /height:74\.25mm!important/);
  assert.match(productionCardsRoute, /pc-print-face/);
  assert.match(productionCardsRoute, /grid-template-columns:minmax\(0,1fr\) 27mm/);
  assert.match(productionCardsRoute, /pc-print-qr-code/);
});

test('customer portal uses clear logout wording', () => {
  const customerPage = read('public/customer.html');

  assert.match(customerPage, /onclick="logoutPortal\(\)">התנתק<\/button>/);
  assert.doesNotMatch(customerPage, /החלף לקוח \/ יציאה/);
});

test('customer portal UI uses OTP verification before storing token', () => {
  const customer = read('public/customer.html');

  assert.match(customer, /id="authOtpField"/);
  assert.match(customer, /\/api\/c\/auth\/verify/);
  assert.match(customer, /otpRequired/);
  assert.match(customer, /completeAuth\(data\.data\)/);
});

test('customer portal links use public base URL instead of localhost fallback', () => {
  const portalAccess = read('services/portalAccess.js');
  const portalAdminRoute = read('routes/portalAdmin.js');
  const portalRoute = read('routes/portal.js');

  assert.match(portalAccess, /settingsService\.get\('BASE_URL'/);
  assert.match(portalAccess, /function portalLink/);
  assert.match(portalAccess, /encodeURIComponent\(token\)/);
  assert.match(portalAdminRoute, /x-forwarded-host/);
  assert.match(portalAdminRoute, /portalAuthResponse\(c, \{ baseUrl: requestPublicBaseUrl\(req\) \}\)/);
  assert.match(portalAdminRoute, /configuredBaseUrl\(requestPublicBaseUrl\(req\)\)/);
  assert.match(portalRoute, /x-forwarded-host/);
  assert.match(portalRoute, /portalAccess\.portalLink\(token, \{ baseUrl: requestPublicBaseUrl\(req\) \}\)/);
});

test('customer portal exposes quote before order submission', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');

  assert.match(portalRoute, /router\.post\('\/c\/quote'/);
  assert.match(customerPage, /function showQuoteScreen/);
  assert.match(customerPage, /id="quoteActionPanel"/);
  assert.match(customerPage, /הצעת מחיר לפני הזמנה/);
  assert.match(customerPage, /קבל הצעת מחיר/);
  assert.match(customerPage, /onclick="showQuoteScreen\(\)"/);
});

test('customer portal order rows share the factory order-item visual contract', () => {
  const customer = read('public/customer.html');
  const factory = read('public/index.html');
  const sharedRowStyles = read('public/order-item-row.css');

  assert.match(customer, /\/order-item-row\.css\?v=1/);
  assert.match(factory, /\/order-item-row\.css\?v=1/);
  assert.match(customer, /ib-order-line-card/);
  assert.match(customer, /item-shape-preview no-item-preview shape-preview/);
  assert.match(customer, /item-metrics no-item-metrics/);
  assert.match(customer, /duplicatePortalItem/);
  assert.match(sharedRowStyles, /grid-template-columns:150px minmax\(0,1fr\) auto/);
});

test('customer profile changes lock after first edit and route to internal approval', () => {
  const portalRoute = read('routes/portal.js');
  const customersRoute = read('routes/customers.js');
  const customerPage = read('public/customer.html');
  const customersPage = read('public/customers.html');
  const schema = read('db/coreSchema.js');

  assert.match(schema, /customer_profile_change_requests/);
  assert.match(schema, /portal_profile_locked_at/);
  assert.match(portalRoute, /pendingApproval/);
  assert.match(portalRoute, /portal_profile_locked_at=CURRENT_TIMESTAMP/);
  assert.match(customersRoute, /profile-change-requests\/:requestId\/approve/);
  assert.match(customersRoute, /profile-change-requests\/:requestId\/reject/);
  assert.match(customerPage, /שלח בקשת שינוי/);
  assert.match(customerPage, /בקשת השינוי נשלחה לאישור/);
  assert.match(customersPage, /בקשות שינוי פרטי לקוח/);
  assert.match(customersPage, /approveProfileChange/);
});

test('customer portal has a site-and-manager-first home and editable profile', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');

  assert.match(customerPage, /אתרים ומנהלי עבודה/);
  assert.match(customerPage, /id="homeTabProfile"/);
  assert.match(customerPage, /id="homeSectionProfile"/);
  assert.match(customerPage, /id="customerProfilePanel"/);
  assert.match(customerPage, /function openProjectPanel/);
  assert.match(customerPage, /function renderCustomerProfilePanel/);
  assert.match(customerPage, /function saveCustomerProfile/);
  assert.match(customerPage, /\/api\/c\/profile/);
  assert.match(portalRoute, /router\.post\('\/c\/profile'/);
  assert.match(portalRoute, /UPDATE customers SET name=\?,email=\?,address=\?,contact_name=\?,contact_phone=\?,portal_profile_locked_at=CURRENT_TIMESTAMP WHERE id=\?/);
});

test('customer portal home uses role-aware section navigation', () => {
  const customerPage = read('public/customer.html');

  assert.match(customerPage, /id="portalHomeTabs"/);
  assert.match(customerPage, /id="homeTabOrders"/);
  assert.match(customerPage, /id="homeTabProfile"/);
  assert.match(customerPage, /id="homeTabSites"/);
  assert.match(customerPage, /id="homeTabFinance"/);
  assert.match(customerPage, /id="homeTabPriceList"/);
  assert.match(customerPage, /id="homeTabDocs"/);
  assert.match(customerPage, /id="homeSectionOrders"/);
  assert.match(customerPage, /id="homeSectionProfile"/);
  assert.match(customerPage, /id="homeSectionSites"/);
  assert.match(customerPage, /id="homeSectionFinance"/);
  assert.match(customerPage, /id="homeSectionPriceList"/);
  assert.match(customerPage, /id="homeSectionDocs"/);
  assert.match(customerPage, /function setHomeSection\(name\)/);
  assert.match(customerPage, /function updatePortalHomeTabs\(\)/);
  assert.match(customerPage, /homeTabFinance'\s*,\s*financeVisible/);
  assert.match(customerPage, /homeTabPriceList'\s*,\s*priceVisible/);
  assert.match(customerPage, /setHomeSection\(currentHomeSection\(\)\)/);
});

test('customer CRM can rotate and revoke portal links', () => {
  const customers = read('public/customers.html');
  const admin = read('public/admin.html');

  assert.match(customers, /rotatePortalLink/);
  assert.match(customers, /revokePortalLink/);
  assert.match(customers, /\/api\/customers\/' \+ id \+ '\/token\/rotate/);
  assert.match(customers, /method: 'DELETE'/);
  assert.doesNotMatch(admin, /customerLinksList/);
  assert.doesNotMatch(admin, /copyCustomerLink/);
});

test('customer portal enforces site-scoped users and order site binding', () => {
  const coreSchema = read('db/coreSchema.js');
  const startup = read('db/startup.js');
  const portalAccess = read('services/portalAccess.js');
  const portalRoute = read('routes/portal.js');
  const customerRoute = read('routes/customers.js');
  const customerPage = read('public/customer.html');

  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS customer_sites/);
  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS customer_site_users/);
  assert.match(coreSchema, /customer_portal_permission_audit/);
  assert.match(startup, /portal_can_manage_users/);
  assert.match(startup, /customer_sites/);
  assert.match(portalAccess, /function portalContext/);
  assert.match(portalAccess, /function resolveAuthorizedSite/);
  assert.match(portalAccess, /canChooseSite/);
  assert.match(portalRoute, /router\.get\('\/c\/sites'/);
  assert.match(portalRoute, /router\.post\('\/c\/sites'/);
  assert.match(portalRoute, /router\.get\('\/c\/sites\/:siteId\/summary'/);
  assert.match(portalRoute, /customer_created_site/);
  assert.match(portalRoute, /resolveAuthorizedSite\(c\.id, s\.user, siteId\)/);
  assert.match(portalRoute, /UPDATE orders SET site_id=\? WHERE id=\? AND customer_id=\?/);
  assert.match(customerRoute, /\/customers\/:id\/portal-sites/);
  assert.match(customerRoute, /\/customers\/:id\/portal-users/);
  assert.match(customerPage, /id="orderSiteWrap"/);
  assert.match(customerPage, /id="manageSitesBtn"/);
  assert.match(customerPage, /function createPortalSite/);
  assert.match(customerPage, /\/api\/c\/sites/);
  assert.match(customerPage, /function renderOrderSitePicker/);
  assert.match(customerPage, /siteId:\s+selectedPortalSiteId\(\)/);
});

test('customer portal lets customer admins manage field users and print safe order documents', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');

  assert.match(portalRoute, /router\.get\('\/c\/users'/);
  assert.match(portalRoute, /router\.post\('\/c\/users'/);
  assert.match(portalRoute, /canManageUsers/);
  assert.match(portalRoute, /canAssignSiteUsers/);
  assert.match(portalRoute, /field_manager/);
  assert.match(portalRoute, /customer_site_users/);
  assert.match(portalRoute, /portal_user_created_by_customer/);
  assert.match(portalRoute, /router\.get\('\/c\/orders\/:orderId\/print'/);
  assert.match(portalRoute, /orderPrintEsc/);
  assert.doesNotMatch(portalRoute.match(/router\.get\('\/c\/orders\/:orderId\/print'[\s\S]*?res\.type\('html'\)\.send/)?.[0] || '', /machine_id|worker_id|actual_waste|review_notes/);

  assert.match(customerPage, /function loadPortalUsers/);
  assert.match(customerPage, /function createPortalUser/);
  assert.match(customerPage, /id="portalUserSiteId"/);
  assert.match(customerPage, /מנהלי עבודה והרשאות/);
  assert.match(customerPage, /function openPortalOrderPdf/);
  assert.match(customerPage, /openPortalOrderPdf\(\$\{order\.id\}\).*PDF \/ הדפסת הזמנה/);
});

test('customer portal exposes finance dashboard with explicit money permissions', () => {
  const coreSchema = read('db/coreSchema.js');
  const startup = read('db/startup.js');
  const portalAccess = read('services/portalAccess.js');
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');

  assert.match(coreSchema, /can_view_payment_alerts/);
  assert.match(startup, /can_view_payment_alerts/);
  assert.match(portalAccess, /canViewPaymentAlerts/);
  assert.match(portalAccess, /role IN \('orderer','approver','both','finance','field_manager','customer_admin'\)/);
  assert.match(portalRoute, /router\.get\('\/c\/finance\/summary'/);
  assert.match(portalRoute, /router\.get\('\/c\/finance\/sites'/);
  assert.match(portalRoute, /router\.get\('\/c\/finance\/payments-due'/);
  assert.match(portalRoute, /router\.get\('\/c\/orders\/history'/);
  assert.match(portalRoute, /canViewCustomerFinance/);
  assert.match(portalRoute, /projectOrdersForPortal\(rows, s\)/);
  assert.match(portalRoute, /customerPortalProjection/);
  assert.doesNotMatch(portalRoute, /canCreateSites && !s\.caps\.canManageUsers && !s\.caps\.canApprove/);
  assert.match(customerPage, /id="customerFinanceDashboard"/);
  assert.match(customerPage, /function loadCustomerFinanceDashboard/);
  assert.match(customerPage, /\/api\/c\/finance\/summary/);
  assert.match(customerPage, /\/api\/c\/finance\/payments-due/);
  assert.match(customerPage, /\/api\/c\/orders\/history/);
  assert.match(customerPage, /function canViewCustomerFinance/);
  assert.match(customerPage, /formatMoney\(s\.dueNow/);
  assert.doesNotMatch(customerPage, /caps\.canCreateSites \|\| caps\.canManageUsers \|\| caps\.canApprove/);
});

test('customer portal price visibility remains compatible with configured visible price lists', () => {
  const portalAccess = read('services/portalAccess.js');

  assert.match(portalAccess, /priceExposureAllowed = customerCaps\.canExposePrices \|\| customer\.portal_price_list_visibility !== 'none'/);
});

test('customer portal confirmation cannot approve production', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');
  const linkApproveBlock = portalRoute.match(/router\.get\('\/c\/approve\/:token'[\s\S]*?router\.post\('\/c\/approve'/)?.[0] || '';
  const postApproveBlock = portalRoute.match(/router\.post\('\/c\/approve'[\s\S]*?function approvalPage/)?.[0] || '';

  assert.match(linkApproveBlock, /ORDER_STATUS\.PENDING_APPROVAL/);
  assert.match(postApproveBlock, /ORDER_STATUS\.PENDING_APPROVAL/);
  assert.match(postApproveBlock, /productionApproved:\s*false/);
  assert.doesNotMatch(linkApproveBlock, /APPROVED_WAITING_PRODUCTION|אושרה – ממתין לייצור|ניתן להתחיל ייצור|נתחיל בייצור/);
  assert.doesNotMatch(postApproveBlock, /APPROVED_WAITING_PRODUCTION|אושרה – ממתין לייצור|ניתן להתחיל ייצור/);
  assert.doesNotMatch(customerPage, /תחילת ייצור|להתחיל בייצור|נתחיל בייצור/);
  assert.match(customerPage, /שלח לבדיקה|נשלחו לבדיקה|בדיקה פנימית/);
});

test('customer portal order detail projection hides internal production fields', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');
  const detailBlock = portalRoute.match(/router\.get\('\/c\/orders\/:orderId'[\s\S]*?res\.json\(projected\);/)?.[0] || '';
  const internalFields = [
    'machine',
    'machine_id',
    'production_qty',
    'worker_id',
    'actual_waste',
    'actual_weight_kg',
    'weight_deviation_pct',
    'review_status',
    'review_notes',
    'reviewed_by',
  ];

  for (const field of internalFields) {
    assert.doesNotMatch(detailBlock, new RegExp('\\b' + field + '\\b'), field);
  }
  assert.match(detailBlock, /SELECT id,item_uid,shape_snapshot_json,shape_name,diameter,total_length_mm,quantity,weight_per_unit,total_weight/);
  assert.match(detailBlock, /portalPublicItem/);
  assert.match(detailBlock, /projectPortalOrderDetail/);
  assert.doesNotMatch(customerPage, /item\.production_qty|item\.produced_qty|item\.machine/);
  const client = require('./helpers/customer-portal-client').loadPortalClient();
  const payload = client.select({ family: 'bars', shapeType: 'straight_bar', diameter: 12, sides: [1000], angles: [] });
  assert.equal(payload.shapeSnapshot.contractVersion, 2);
  assert.deepEqual(payload.shapeSnapshot.data.sides, [1000]);
  assert.match(customerPage, /portalItemShapeMetrics/);
});

test('existing customer portal order submission still creates customer confirmation flow', () => {
  const portalRoute = read('routes/portal.js');
  const customerPage = read('public/customer.html');
  const orderCreateBlock = portalRoute.match(/router\.post\('\/c\/order'[\s\S]*?res\.json\(\{ success: true/)?.[0] || '';

  assert.match(orderCreateBlock, /ממתינה לאישור לקוח/);
  assert.match(orderCreateBlock, /awaitingApproval:\s*true/);
  assert.match(orderCreateBlock, /confirmToken/);
  assert.match(customerPage, /function submitOrder\(event\)/);
  assert.match(customerPage, /\/api\/c\/order/);
  assert.match(customerPage, /function approveOrder\(orderId, event\)/);
});

test('high-risk screens load shared safe DOM helper', () => {
  const files = [
    'public/admin.html',
    'public/customers.html',
    'public/dashboard.html',
    'public/reports.html',
    'public/finance.html',
    'public/machine.html',
    'public/orders.html',
  ];

  for (const file of files) {
    assert.match(read(file), /\/safe-dom\.js/, file);
  }

  assert.match(read('public/safe-dom.js'), /window\.IronBendSafe/);
});

test('high-risk admin and reporting surfaces load auth client before shared navigation', () => {
  for (const file of ['public/admin.html', 'public/finance.html', 'public/reports.html']) {
    const html = read(file);
    const authIndex = html.indexOf('src="/auth-client.js"');
    const navIndex = html.indexOf('src="/nav.js"');

    assert.notEqual(authIndex, -1, `${file} should load auth-client.js`);
    assert.notEqual(navIndex, -1, `${file} should load nav.js`);
    assert.ok(authIndex < navIndex, `${file} should load auth before nav`);
  }
});


test('shared temporary UI tuner is loaded globally and guarded', () => {
  const nav = read('public/nav.js');
  const tuner = read('public/ui-tuner.js');

  assert.match(nav, /\/ui-tuner\.js/);
  assert.match(tuner, /id = 'uiTunerRoot'|id = "uiTunerRoot"|root\.id = 'uiTunerRoot'/);
  assert.match(tuner, /top:64px;left:12px/);
  assert.match(tuner, /&#9998;/);
  assert.match(tuner, /data-ut-unlock/);
  assert.match(tuner, /if \(!unlocked\) return/);
  assert.match(tuner, /localStorage\.setItem\(STORE_KEY/);
  assert.doesNotMatch(tuner, /fetch\(/);
});

test('shared navigation preserves Tene logo aspect ratio', () => {
  const nav = read('public/nav.js');
  const theme = read('public/theme.css');

  assert.match(nav, /#ib-logo-icon \{[\s\S]*height:auto/);
  assert.match(nav, /#ib-drawer-logo \{[\s\S]*height:auto/);
  assert.doesNotMatch(nav, /#ib-logo-icon \{[\s\S]*height:\s*42px/);
  assert.match(theme, /#ib-logo img, #ib-drawer-logo \{[\s\S]*height: auto/);
});

test('shared desktop navigation is right aligned for RTL layout', () => {
  const nav = read('public/nav.js');
  const theme = read('public/theme.css');

  assert.match(nav, /padding-right:\s*156px/);
  assert.match(nav, /inset:\s*0 0 0 auto/);
  assert.match(nav, /border-left:\s*1px solid/);
  assert.match(nav, /#ib-drawer \{[\s\S]*right:0/);
  assert.match(nav, /transform:translateX\(100%\)/);
  assert.match(theme, /border-left:\s*1px solid/);
});

test('shared navigation module icons are clickable links', () => {
  const nav = read('public/nav.js');

  assert.match(nav, /escapeAttr\(l\.href\)/);
  assert.match(nav, /title=".*escapeAttr\(l\.label\)/);
  assert.match(nav, /aria-label=".*escapeAttr\(l\.label\)/);
  assert.match(nav, /ib-link-icon/);
  assert.match(nav, /ib-link-label/);
  assert.match(nav, /ib-bn-icon/);
  assert.match(nav, /ib-bn-label/);
  assert.match(nav, /<a href="\/dashboard\.html" title="דשבורד" aria-label="דשבורד"><img id="ib-drawer-logo"/);
});


test('shared window back control only closes the active app window', () => {
  const nav = read('public/nav.js');

  assert.match(nav, /#seOverlay\.show > #seModal/);
  assert.match(nav, /dialog\[open\]/);
  assert.match(nav, /function closeTopWindowPanel\(\)/);
  assert.match(nav, /IronBendWindowBack/);
  assert.match(nav, /e\.key === 'Escape' && closeTopWindowPanel\(\)/);
  assert.doesNotMatch(nav, /\.btn-outline, \[data-close\], button, a/);
});

test('order detail keeps its sticky identifier clear of the generic window-back control', () => {
  const nav = read('public/nav.js');
  const orders = read('public/orders.html');

  assert.match(nav, /if \(panel\.matches\('\.detail-panel'\)\) return/);
  assert.match(orders, /\.detail-heading\{min-width:0;flex:1;\}/);
  assert.match(orders, /\.detail-order-num\{[\s\S]*direction:ltr;text-align:right/);
  assert.match(orders, /<div class="detail-heading">[\s\S]*id="detailOrderNum"/);
  assert.match(orders, /class="detail-close"/);
});

test('shared navigation hides modules excluded by license entitlements', () => {
  const nav = read('public/nav.js');

  assert.match(nav, /const LINK_MODULES = \{/);
  assert.match(nav, /refreshLicensedModules/);
  assert.match(nav, /\/api\/license\/modules/);
  assert.match(nav, /applyLicensedModules/);
  assert.match(nav, /!data\.restricted/);
  assert.match(nav, /visibleLinks = LINKS\.filter/);
  assert.match(nav, /enabled\.has\(moduleKey\)/);
  assert.match(nav, /renderShellLinks/);
  assert.match(nav, /renderBottomLinks/);
});

test('dashboard production queue uses production queue API source', () => {
  const dashboard = read('public/dashboard.html') + read('public/dashboard.js');

  assert.match(dashboard, /\/api\/production-queue/);
  assert.doesNotMatch(dashboard, /renderProdQueue\(dashData\.recentOrders\)/);
  assert.match(dashboard, /renderProdQueue\(productionQueue\.items \|\| \[\]\)/);
});

test('dashboard metric drilldowns use the server source and permit card-level traceability', () => {
  const dashboard = read('public/dashboard.html') + read('public/dashboard.js');

  assert.match(dashboard, /\/api\/dashboard\/drilldown/);
  assert.match(dashboard, /data-dashboard-drilldown="produced_today"/);
  assert.match(dashboard, /data-dashboard-drilldown="in_production"/);
  assert.match(dashboard, /data-dashboard-drilldown="done_today"/);
  assert.match(dashboard, /data-dashboard-drilldown="waste_today"/);
  assert.match(dashboard, /data-dashboard-drill-entry/);
  assert.match(dashboard, /openDashboardDrilldown/);
  assert.match(dashboard, /metric === 'card'/);
});

test('dashboard production KPIs use completed production weight, not order-created weight', () => {
  const dashboard = read('public/dashboard.html') + read('public/dashboard.js');

  assert.match(dashboard, /producedWeightToday/);
  assert.match(dashboard, /producedTonsToday/);
  assert.match(dashboard, /kpiWeightToday'\)\.textContent = producedWeightToday\.toFixed\(0\)/);
  assert.match(dashboard, /qsWeight'\)\.textContent = producedWeightToday\.toFixed\(0\)/);
  assert.doesNotMatch(dashboard, /kpiWeightToday'\)\.textContent = \(d\.totalWeightToday\|\|0\)/);
  assert.doesNotMatch(dashboard, /qsWeight'\)\.textContent = \(d\.totalWeightToday\|\|0\)/);
});

test('dashboard business widgets have data identity contracts', () => {
  const dashboard = read('public/dashboard.html') + read('public/dashboard.js');
  const contracts = require(path.join(root, 'public', 'data-contracts-client.js')).WIDGET_CONTRACTS;
  const requiredElements = [
    'kpiOrdersToday',
    'kpiWeightToday',
    'kpiInProd',
    'kpiDone',
    'kpiUrgent',
    'kpiWaste',
    'kpiPending',
    'kpiTonsToday',
    'qsWeight',
  ];

  assert.match(dashboard, /\/data-contracts-client\.js/);
  assert.match(dashboard, /applyDataContractBadges\(\)/);

  for (const elementId of requiredElements) {
    assert.match(dashboard, new RegExp(`id="${elementId}"`), `${elementId} should exist in dashboard`);
    const ownerContract = Object.values(contracts).find(contract => contract.consumers.includes(elementId));
    assert.ok(ownerContract, `${elementId} should have a data contract`);
    assert.ok(ownerContract.source.api, `${elementId} contract should name source API`);
    assert.ok(ownerContract.source.fields.length, `${elementId} contract should name source fields`);
    assert.ok(ownerContract.meaning, `${elementId} contract should explain meaning`);
  }
});

test('kiosk distinguishes missing work from untrusted machine state', () => {
  const kiosk = read('public/kiosk.html');

  assert.match(kiosk, /let stateHealth\s*=/);
  assert.match(kiosk, /async function apiJson/);
  assert.match(kiosk, /אין אמון בנתוני התחנה/);
  assert.match(kiosk, /canTrustState\s*\?\s*'אין עבודה פעילה'\s*:\s*'אין אמון בנתוני התחנה'/);
  assert.match(kiosk, /btnComplete'\)\.disabled = !hasJob \|\| !canTrustState/);
  assert.match(kiosk, /btnStop'\)\.disabled\s+= !activeShift \|\| !canTrustState/);
});

test('kiosk uses the light operational design language', () => {
  const kiosk = read('public/kiosk.html');

  assert.match(kiosk, /--bg:#f4f7fb/);
  assert.match(kiosk, /--panel:#ffffff/);
  assert.match(kiosk, /--panel-soft:#f8fafc/);
  assert.match(kiosk, /apple-mobile-web-app-status-bar-style" content="default"/);
  assert.doesNotMatch(kiosk, /--bg:#0d1117/);
  assert.doesNotMatch(kiosk, /black-translucent/);
});

test('reports screen uses authenticated APIs and escapes API-sourced table fields', () => {
  const reports = read('public/reports.html');

  assert.match(reports, /src="\/auth-client\.js"/);
  assert.match(reports, /src="\/safe-dom\.js"/);
  assert.match(reports, /\/api\/reports\/summary/);
  assert.match(reports, /\/api\/reports\/production-timing/);
  assert.match(reports, /\/api\/machines\/oee/);
  assert.match(reports, /renderTimingCharts/);
  assert.match(reports, /timingPaceChart/);
  assert.match(reports, /timingOrderChart/);
  assert.match(reports, /timingRecipeChart/);
  assert.match(reports, /timingTransitionChart/);
  assert.match(reports, /timingCardChart/);
  assert.match(reports, /dailyDiameterChart/);
  assert.match(reports, /dailyDiameterTable/);
  assert.match(reports, /renderDailyDiameters/);
  assert.match(reports, /escH\(w\.shape_name/);
  assert.match(reports, /escH\(c\.name/);
  assert.match(reports, /escH\(m\.order_num/);
  assert.match(reports, /escH\(m\.name/);
  assert.doesNotMatch(reports, /\$\{w\.shape_name/);
  assert.doesNotMatch(reports, /\$\{c\.name/);
  assert.doesNotMatch(reports, /\$\{m\.order_num/);
});

test('orders screen uses shared status transition contract', () => {
  const orders = read('public/orders.html');
  const statusClient = read('public/status-contracts-client.js');

  assert.match(statusClient, /window\.IronBendStatus/);
  assert.match(orders, /src="\/auth-client\.js"/);
  assert.match(orders, /\/status-contracts-client\.js/);
  assert.match(orders, /allowedOrderTransitions\(o\.status\)/);
  assert.match(orders, /setStatusAndClose/);
  assert.match(orders, /נדרשת התחברות מחדש כדי לאשר הזמנה/);
  assert.match(orders, /אין למשתמש הנוכחי הרשאה לאשר הזמנה/);
  assert.doesNotMatch(orders, /ok=>\{if\(ok\)closeDetailPanel/);
  assert.doesNotMatch(orders, /const statuses = \['/);
});

test('portal orders have a dedicated customer-approval queue, separate from internal approvals', () => {
  const orders = read('public/orders.html');
  const dashboard = read('public/dashboard.js');
  const reports = read('routes/reports.js');

  assert.match(orders, /פורטל · לאישור לקוח/);
  assert.match(orders, /ממתינות משרד/);
  assert.match(orders, /PORTAL_AWAITING_CUSTOMER_APPROVAL/);
  assert.match(orders, /channelLabel\(o\)/);
  assert.match(dashboard, /הזמנות פורטל ממתינות לאישור לקוח/);
  assert.match(reports, /portalAwaitingCustomerApproval/);
  assert.match(reports, /CUSTOMER_PENDING_APPROVAL/);
});

test('orders screen escapes API-sourced detail fields before innerHTML rendering', () => {
  const orders = read('public/orders.html');

  assert.match(orders, /escHtml\(o\.customer_name/);
  assert.match(orders, /escHtml\(o\.delivery_address\)/);
  assert.match(orders, /const driverNotes = visibleOrderNote\(o\.driver_notes\)/);
  assert.match(orders, /escHtml\(driverNotes\)/);
  assert.match(orders, /const displayNote = visibleItemNote\(item\.note\)/);
  assert.match(orders, /escHtml\(displayNote\)/);
  assert.match(orders, /escHtml\(p\.package_code\)/);
  assert.match(orders, /jsAttr\(p\.package_code\)/);
  assert.doesNotMatch(orders, /\$\{o\.driver_notes\}/);
  assert.doesNotMatch(orders, /\$\{item\.note\}/);
});

test('orders screen status actions keep JavaScript arguments safe inside HTML attributes', () => {
  const orders = read('public/orders.html');

  assert.match(orders, /function jsAttr\(value\)/);
  assert.match(orders, /return escHtml\(jsArg\(value\)\)/);
  assert.match(orders, /setStatus\(\$\{o\.id\},\$\{jsAttr\(status\)\}\)/);
  assert.match(orders, /setStatusAndClose\(\$\{o\.id\},\$\{jsAttr\(s\)\}\)/);
  assert.match(orders, /printQR\(\$\{jsAttr\(p\.package_code\)\},\$\{jsAttr\(p\.order_num\)\}/);
  assert.doesNotMatch(orders, /setStatus\(\$\{o\.id\},\$\{jsArg\(status\)\}\)/);
  assert.doesNotMatch(orders, /setStatusAndClose\(\$\{o\.id\},\$\{jsArg\(s\)\}\)/);
});

test('orders detail does not present one straight segment as a spiral and shows weight checks', () => {
  const orders = read('public/orders.html');

  assert.match(orders, /function isSingleSegmentShape/);
  assert.match(orders, /function isSpiralOrRingName/);
  assert.match(orders, /function isRealSpiralItem/);
  assert.match(orders, /function shapeMismatchWarning/);
  assert.match(orders, /shapeLabel\(item\.shape_name, sides, item\)/);
  assert.match(orders, /data-spiral-shape/);
  assert.match(orders, /משקל רצוי/);
  assert.match(orders, /משקל מצוי/);
  assert.match(orders, /weightDeviationPct/);
});

test('orders review warnings have an approval path and source comparison', () => {
  const orders = read('public/orders.html');
  const intake = read('public/intake.html');
  const ordersRoute = read('routes/orders.js');
  const intakeRoute = read('routes/intakeReview.js');
  const startup = read('db/startup.js');

  assert.match(orders, /function needsItemReview/);
  assert.match(orders, /function visibleItemNote/);
  assert.match(orders, /function visibleOrderNote/);
  assert.match(orders, /isTechnicalRecognitionNote/);
  assert.match(orders, /דורש אימות מול מקור הקליטה/);
  assert.match(orders, /review_status/);
  assert.match(orders, /approveItemReview/);
  assert.match(orders, /openOrderIntakeSource/);
  assert.match(orders, /\/api\/orders\/\$\{orderId\}\/intake-source/);
  assert.match(orders, /\/api\/orders\/\$\{orderId\}\/items\/\$\{itemId\}\/review/);
  assert.match(orders, /openAddItem\(event, \$\{o\.id\}\)/);
  assert.match(orders, /openAddFromOcr/);
  assert.match(orders, /openAddManualItem/);
  assert.match(orders, /הוסף מ־OCR/);
  assert.match(orders, /הוסף צורה ידנית/);
  assert.match(orders, /addParsedItemToOrder/);
  assert.match(orders, /deleteOrderItem/);
  assert.match(orders, /method: 'DELETE'/);
  assert.match(orders, /new ShapeEditorModal\(shapeSelectedFromOrder\)/);
  assert.match(orders, /shapeSelectedFromOrder/);
  assert.match(orders, /const url = isNewItem \? `\/api\/orders\/\$\{ctx\.orderId\}\/items`/);
  assert.doesNotMatch(orders, /itemEditOverlay|openManualItemAdd|saveItemEdit/);
  assert.match(ordersRoute, /router\.post\('\/orders\/:orderId\/items'/);
  assert.match(ordersRoute, /router\.delete\('\/orders\/:orderId\/items\/:itemId'/);
  assert.match(ordersRoute, /order_item_added/);
  assert.match(ordersRoute, /order_item_deleted/);
  assert.match(ordersRoute, /\/orders\/:id\/intake-source/);
  assert.match(ordersRoute, /\/orders\/:orderId\/items\/:itemId\/review/);
  assert.match(ordersRoute, /wsBroadcast\('order_review'/);
  assert.match(intakeRoute, /\/intake\/order-review-tasks/);
  assert.match(intake, /\/api\/intake\/order-review-tasks/);
  assert.match(intake, /postOrderReviewHtml/);
  assert.match(intake, /reviewItemsHtml/);
  assert.match(intake, /מסלול אימות הערות אחרי פתיחת הזמנה/);
  assert.match(intake, /פתח הזמנה ואשר הערות/);
  assert.match(intake, /openLinkedOrder/);
  assert.match(startup, /addCol\('items',\s+'review_status'/);
});

test('image OCR metadata does not become driver instructions', () => {
  const index = read('public/index.html');
  assert.match(index, /function isTechnicalRecognitionNote/);
  assert.match(index, /data\.notes && !isTechnicalRecognitionNote\(data\.notes\)/);
});

test('technical OCR metadata does not print on customer-facing documents', () => {
  const deliveryCertificate = read('routes/orderDeliveryCertificate.js');
  const productionCards = read('services/productionCards.js');
  const printPage = read('services/productionCardPrintPage.js');

  for (const source of [deliveryCertificate, productionCards, printPage]) {
    assert.match(source, /isTechnicalRecognitionNote/);
    assert.match(source, /REVIEW_NOTE_LABEL/);
    assert.match(source, /printableItemNote/);
  }

  assert.doesNotMatch(deliveryCertificate, /\[item\.struct_element, item\.struct_floor, item\.sheet_num, item\.note\]/);
  assert.match(productionCards, /const note = printableItemNote\(item\.note\)/);
  assert.doesNotMatch(productionCards, /escapeHtml\(item\.note\)/);
  assert.match(printPage, /note:\s+printableItemNote\(it\.note\)/);
  assert.doesNotMatch(printPage, /note:\s+it\.note\s+\|\|/);
});

test('internal shape-editor provenance is not printed as an item note', () => {
  for (const file of [
    'routes/orderDeliveryCertificate.js',
    'services/productionCards.js',
    'services/productionCardPrintPage.js',
  ]) {
    const source = read(file);
    assert.match(source, /נוסף ידנית בעורך הצורות/);
    assert.match(source, /return '';/);
  }
});



test('delivery certificate summarizes work sections and reuses production card shapes', () => {
  const deliveryCertificate = read('routes/orderDeliveryCertificate.js');

  assert.match(deliveryCertificate, /buildOrderCommercialSummary/);
  assert.match(deliveryCertificate, /commercialSummary\.sections\.map/);
  assert.match(deliveryCertificate, /line\.unit === 'unit'/);
  assert.doesNotMatch(deliveryCertificate, /function buildDeliveryWorkSummary/);
  assert.ok(deliveryCertificate.includes('productionCards.itemShapeSvg(item)'));
  assert.match(deliveryCertificate, /data-summary-contract="steel-cutting-bending"/);
  assert.match(deliveryCertificate, /delivery-shape svg/);
  assert.doesNotMatch(deliveryCertificate, /const svgShape/);
  assert.doesNotMatch(deliveryCertificate, /wBent|wStraight/);
});

test('order creation success copy does not promise production before approval', () => {
  const index = read('public/index.html');

  assert.match(index, /ממתינה לאישור לפני ייצור/);
  assert.doesNotMatch(index, /נשלחה לתור הייצור/);
});

test('new order screen uses compact workspace layout with sticky summary', () => {
  const index = read('public/index.html');
  const rebarWeights = read('public/rebar-weights.js');
  const shapeEditor = read('public/shape-editor.js');
  const intakeStart = index.indexOf('class="section order-import-section"');
  const customerStart = index.indexOf('id="customer-section"');
  const deliveryStart = index.indexOf('id="delivery-section"');
  const channelStart = index.indexOf('class="channel-selector"');
  const customerBlock = index.slice(customerStart, deliveryStart);

  assert.match(index, /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(320px,\s*0\.72fr\) 290px/);
  assert.match(index, /order-import-section/);
  assert.match(index, /\.order-import-section \.section-subtitle \{ display: none; \}/);
  assert.match(index, /\.ocr-quick-action \{[\s\S]*gap: 8px;[\s\S]*flex-wrap: wrap;[\s\S]*\}/);
  assert.doesNotMatch(index, /class="ocr-file-hint"/);
  assert.doesNotMatch(index.match(/\.ocr-quick-action \{[\s\S]*?\}/)?.[0] || '', /border: 1px solid rgba\(201,98,26,\.16\)/);
  assert.doesNotMatch(index, /<nav class="topnav">/);
  assert.match(index, /summary-order-number" id="orderNumDisplay"/);
  assert.ok(channelStart > intakeStart && channelStart < customerStart);
  assert.doesNotMatch(customerBlock, /channel-selector/);
  assert.doesNotMatch(customerBlock, /orderChannel/);
  assert.match(customerBlock, /<details class="compact-toggle" id="customerDetails">/);
  assert.match(customerBlock, /id="customerSummaryText"/);
  assert.match(customerBlock, /customerStatePill/);
  assert.match(customerBlock, /href="\/customers\.html"/);
  assert.doesNotMatch(customerBlock, /label>.*source.*customer/i);
  assert.match(index, /#customer-section \{ grid-column: 1; \}/);
  assert.match(index, /#delivery-section \{ grid-column: 2; \}/);
  assert.match(index, /<details class="compact-toggle" id="intakeDetails">/);
  assert.match(index, /<details class="compact-toggle" id="customerDetails">/);
  assert.match(index, /<details class="delivery-toggle" id="deliveryDetails">/);
  assert.match(index, /<details class="compact-toggle" id="notesDetails">/);
  assert.match(index, /id="deliverySiteName"/);
  assert.match(index, /id="customerSiteChoice"/);
  assert.match(index, /id="orderSiteId"/);
  assert.match(index, /\/api\/customers\/.*\/portal-sites/);
  assert.match(index, /function hydrateSelectedCustomer\(customerId, seed = \{\}\)/);
  assert.match(index, /function clearSelectedCustomerBinding\(\)/);
  assert.match(index, /function onCustomerSearchInput\(value\)/);
  assert.match(index, /window\._selectedCustomerName = c\.name \|\| ''/);
  assert.match(index, /function saveOrderDraftForCustomerHandoff\(\)/);
  assert.match(index, /function restoreOrderDraft\(\)/);
  assert.match(index, /openCustomersWithDraft\(event\)/);
  assert.match(index, /const selectedCustomerId = Number\(window\._selectedCustomerId \|\| 0\) \|\| null/);
  assert.match(index, /const selectedSiteId = selectedCustomerId \? \(document\.getElementById\('orderSiteId'\)\?\.value \|\| null\) : null/);
  assert.match(index, /siteId: selectedSiteId/);
  assert.match(index, /alert\(result\.error \|\|/);
  assert.match(index, /function isSpiralOrderItem\(item = \{\}\)/);
  assert.match(index, /function itemShapeContract\(item = \{\}\)/);
  assert.match(index, /function approvedShapeContract\(data = \{\}\)/);
  assert.match(index, /function spiralFieldsFromShapeData\(data = \{\}\)/);
  assert.match(index, /item\.shapeSnapshot = approvedShapeContract\(data\)/);
  assert.match(index, /shapeSnapshot: item\.shapeSnapshot \|\| null/);
  assert.match(index, /openShapeEditor\(\$\{palletId\}, '\$\{item\.id\}'\)/);
  assert.match(index, /sides: isSpiralOrderItem\(item\) \? \[\] :/);
  assert.match(index, /function isSpiralImgItem\(it\)/);
  assert.match(index, /function updateDeliverySummary\(\)/);
  assert.match(index, /function openDeliveryDetails\(\)/);
  assert.match(index, /function openCustomerDetails\(\)/);
  assert.match(index, /function updateCustomerSummary\(\)/);
  assert.match(index, /function updateNotesSummary\(\)/);
  assert.match(index, /driverNotes: driverNotes/);
  assert.match(index, /#items-section \{ grid-column: 1 \/ 3; \}/);
  assert.match(index, /\.summary-bar \{[\s\S]*position: sticky;[\s\S]*top: 72px/);
  assert.match(index, /@media \(max-width: 768px\)[\s\S]*\.main \{ display: flex; flex-direction: column/);
  assert.match(index, /@media \(max-width: 768px\)[\s\S]*html, body \{ overflow-x: hidden; \}/);
  assert.match(index, /\.iron-items-table-wrap \{ width: 100%; max-width: 100%; overflow-x: auto/);
  assert.match(index, /function escapeHtml/);
  assert.match(index, /escapeHtml\(c\.name\)/);
  assert.match(index, /selectCustomer\(JSON\.parse\(decodeURIComponent/);
  assert.ok(index.indexOf('src="/rebar-weights.js"') > -1);
  assert.ok(index.indexOf('src="/rebar-weights.js"') < index.indexOf('src="/shape-editor.js'));
  assert.match(index, /IronBendRebar\.itemWeightKg/);
  assert.doesNotMatch(index, /REBAR_WEIGHTS\?\.\[/);
  assert.doesNotMatch(index, /0\.00617/);
  assert.match(rebarWeights, /IronBendRebar/);
  assert.match(rebarWeights, /kgPerMeter/);
  assert.match(shapeEditor, /sharedKgPerMeter/);
  assert.doesNotMatch(shapeEditor, /const REBAR_WEIGHTS = \{/);
});

test('shape side count picker uses clear canonical silhouettes', () => {
  const editor = read('public/shape-editor.js');

  assert.match(editor, /function countPickerShapeSVG/);
  assert.match(editor, /1:\s*'קו ישר'/);
  assert.match(editor, /2:\s*'צורת L'/);
  assert.match(editor, /3:\s*'צורת ח'/);
  assert.match(editor, /4:\s*'ריבוע \/ מלבן'/);
  assert.match(editor, /5:\s*'מחומש'/);
  assert.match(editor, /6:\s*'משושה'/);
  assert.match(editor, /if \(n === 3\)[\s\S]*aria-label="צורת ח"/);
  assert.match(editor, /if \(n === 4\)[\s\S]*<rect/);
  assert.doesNotMatch(editor, /const ex = SHAPE_PRESETS\.find\(s => s\.sides\.length == n\)/);
});

test('shape editor opens in clean 2D mode and keeps 3D uncluttered', () => {
  const editor = read('public/shape-editor.js');

  assert.match(editor, /window\._seViewMode = '2d'/);
  assert.match(editor, /showBends: false/);
  assert.match(editor, /compactLabels: true/);
  assert.match(editor, /seReal3DToggle/);
  assert.match(editor, /_setReal3D/);
  assert.match(editor, /setPointerCapture/);
  assert.match(editor, /releasePointerCapture/);
  assert.match(editor, /lostpointercapture/);
  assert.doesNotMatch(editor, /3D XYZ/);
});

test('order OCR upload refreshes auth and shows localized permission errors', () => {
  const index = read('public/index.html');

  assert.match(index, /ensureOcrSession/);
  assert.match(index, /IronBendAuth\.refreshAccessToken/);
  assert.match(index, /OCR_AUTH_REQUIRED/);
  assert.match(index, /OCR_FORBIDDEN/);
  assert.match(index, /נדרשת התחברות מחדש לפני ניתוח תמונה/);
  assert.match(index, /אין למשתמש הנוכחי הרשאה לניתוח תמונה/);
  assert.match(index, /img-review-workspace/);
  assert.match(index, /img-source-canvas/);
  assert.match(index, /זוהו \$\{items\.length\} פריטים/);
  assert.doesNotMatch(index, /showImgError\('שגיאת תקשורת: ' \+ err\.message\)/);
});

test('machine assignment queue uses production queue source of truth', () => {
  const machine = read('public/machine.html');

  assert.match(machine, /src="\/auth-client\.js"/);
  assert.match(machine, /src="\/safe-dom\.js"/);
  assert.match(machine, /\/status-contracts-client\.js/);
  assert.match(machine, /ITEM_STATUS\.WAITING/);
  assert.match(machine, /ITEM_STATUS\.IN_PRODUCTION/);
  assert.match(machine, /ITEM_STATUS\.DONE/);
  assert.match(machine, /\/api\/production-queue/);
  assert.doesNotMatch(machine, /\/api\/orders\?status=/);
  assert.doesNotMatch(machine, /fetch\(`\/api\/orders\/\$\{o\.id\}`/);
  assert.match(machine, /escHtml\(item\.customerName/);
  assert.match(machine, /jsArg\(item\.orderNum\)/);
});

test('production queue screen uses shared item status contract', () => {
  const productionQueue = read('public/production-queue.html');

  assert.match(productionQueue, /\/status-contracts-client\.js/);
  assert.match(productionQueue, /src="\/safe-dom\.js"/);
  assert.match(productionQueue, /ITEM_STATUS\.WAITING/);
  assert.match(productionQueue, /ITEM_STATUS\.IN_PRODUCTION/);
  assert.match(productionQueue, /ITEM_STATUS\.DONE/);
  assert.match(productionQueue, /shift-tons'\)\.textContent = 'שגיאה'/);
  assert.doesNotMatch(productionQueue, /status:\s*'בייצור'/);
  assert.doesNotMatch(productionQueue, /status:\s*'הושלם'/);
  assert.match(productionQueue, /escHtml\(item\.customer_name/);
  assert.match(productionQueue, /jsArg\(item\.order_num\)/);
});

test('shop floor screens use shared item status values', () => {
  const kiosk = read('public/kiosk.html');
  const workerVisual = read('public/worker-visual.html');
  const nav = read('public/nav.js');
  const productionQueue = read('public/production-queue.html');

  assert.match(kiosk, /\/status-contracts-client\.js/);
  assert.match(kiosk, /ITEM_STATUS\.DONE/);
  assert.match(kiosk, /\/api\/kiosk\/operators/);
  assert.match(kiosk, /\/api\/auth\/login/);
  assert.match(kiosk, /IronBendAuth\.storeSession/);
  assert.match(kiosk, /username:\s*op\.username/);
  assert.doesNotMatch(kiosk, /\/api\/users/);
  assert.doesNotMatch(kiosk, /op\.pin/);
  assert.doesNotMatch(kiosk, /status:'הושלם'/);

  assert.match(workerVisual, /\/status-contracts-client\.js/);
  assert.match(workerVisual, /ITEM_STATUS\.IN_PRODUCTION/);
  assert.match(workerVisual, /ITEM_STATUS\.DONE/);
  assert.match(workerVisual, /ITEM_STATUS\.DELIVERED/);
  assert.match(workerVisual, /worker-canonical-missing/);
  assert.doesNotMatch(workerVisual, /isOpenUShape/);
  assert.match(workerVisual, /worker-card-summary/);
  assert.match(workerVisual, /SCAN_ENTRY/);
  assert.match(workerVisual, /scan-entry/);
  assert.match(workerVisual, /queue-link/);
  assert.match(workerVisual, /selectedOrder=orders\.find/);
  assert.match(workerVisual, /SCAN_ENTRY\?\(state\.focusItemId/);
  assert.match(workerVisual, /shape-scale-note/);
  assert.match(workerVisual, /actual_weight_kg/);
  assert.match(workerVisual, /produced_qty/);
  assert.match(workerVisual, /isUnitProgressItem/);
  assert.match(workerVisual, /adjustProducedQty/);
  assert.match(workerVisual, /unit-progress/);
  assert.match(workerVisual, /pile\|cage\|/);
  assert.match(workerVisual, /worker-inline-panel/);
  assert.match(workerVisual, /worker-status-actions/);
  assert.match(workerVisual, /inlineProductionPanel/);
  assert.match(workerVisual, /saveProductionFields/);
  assert.doesNotMatch(workerVisual, /<details class="worker-more"/);
  assert.match(workerVisual, /weightDeviation/);
  assert.match(workerVisual, /משקל רצוי/);
  assert.match(workerVisual, /משקל מצוי/);
  assert.match(workerVisual, /דשבורד איסוף כרטיסים/);
  assert.match(workerVisual, /function parseCardToken/);
  assert.match(workerVisual, /openScannedCard/);
  assert.match(workerVisual, /data-item-id/);
  assert.match(workerVisual, /כרטיס נסרק/);
  assert.match(workerVisual, /הזמנות ממתינות/);
  assert.match(workerVisual, /כרטיסים/);
  assert.match(nav, /\/worker-visual\.html/);
  assert.match(nav, /דשבורד איסוף/);
  assert.match(productionQueue, /\/worker-visual\.html/);
});

test('price list management belongs to pricing screen', () => {
  const admin = read('public/admin.html');
  const finance = read('public/finance.html');
  const pricing = read('public/pricing.html');
  const nav = read('public/nav.js');

  assert.doesNotMatch(admin, /tab-pricelist/);
  assert.doesNotMatch(admin, /loadPriceList/);
  assert.doesNotMatch(admin, /savePriceList/);
  assert.match(finance, /src="\/auth-client\.js"/);
  assert.match(finance, /src="\/safe-dom\.js"/);
  assert.doesNotMatch(finance, /loadSalesPriceList/);
  assert.doesNotMatch(finance, /saveSalesPriceList/);
  assert.doesNotMatch(finance, /\/api\/price-list/);
  assert.match(pricing, /src="\/auth-client\.js"/);
  assert.match(pricing, /\/api\/pricing\/price-books/);
  assert.match(pricing, /id="importDialog"/);
  assert.match(pricing, /importOcrBtn/);
  assert.match(pricing, /\/api\/pricing\/price-books\/analyze-upload/);
  assert.match(pricing, /requested_by_module', 'pricing'/);
  assert.match(pricing, /requested_use_case', 'price_list_import'/);
  assert.match(pricing, /document_type_hint', 'price_list'/);
  assert.match(pricing, /saveImportDraft/);
  assert.match(pricing, /id="priceSheet"/);
  assert.match(pricing, /id="priceRows"/);
  assert.match(pricing, /brand\/tene-pdf-logo\.jpg/);
  assert.match(pricing, /המחירים אינם כוללים מע״מ/);
  assert.match(pricing, /id="notesInput"/);
  assert.match(pricing, /תנאים והערות:/);
  assert.match(pricing, /אישור המחירון ע״י הלקוח/);
  assert.match(pricing, /office@tene-ind\.com/);
  assert.match(pricing, /addRowBtn/);
  assert.match(pricing, /saveDocument/);
  assert.doesNotMatch(pricing, /id="itemDialog"/);
  assert.doesNotMatch(pricing, /payment_terms/);
  assert.match(nav, /\/pricing\.html/);
  assert.match(nav, /pricing: 'finance'/);
  assert.match(finance, /loadSteelPricesSafe/);
  assert.match(finance, /loadOrdersSafe/);
  assert.match(finance, /loadCustomersSafe/);
  assert.match(finance, /calcOrderCostSafe/);
  assert.match(finance, /escH\(c\.name/);
  assert.match(finance, /escH\(o\.order_num/);
});

test('driver management belongs to delivery admin screen', () => {
  const admin = read('public/admin.html');
  const deliveryAdmin = read('public/delivery-admin.html');
  const nav = read('public/nav.js');

  assert.doesNotMatch(admin, /tab-drivers/);
  assert.doesNotMatch(admin, /loadDriversAdmin/);
  assert.doesNotMatch(admin, /openDriverModal/);
  assert.doesNotMatch(admin, /driverModal/);
  assert.match(deliveryAdmin, /loadFleet/);
  assert.match(deliveryAdmin, /\/api\/vehicles\?all=1/);
  assert.match(deliveryAdmin, /\/api\/vehicles\/'\+id\+'\/documents/);
  assert.match(deliveryAdmin, /vehicleDocumentModal/);
  assert.match(deliveryAdmin, /driverVehicleId/);
  assert.match(deliveryAdmin, /\/api\/drivers\?all=1/);
  assert.match(deliveryAdmin, /\/api\/drivers/);
  assert.match(deliveryAdmin, /fleetKpis/);
  assert.match(deliveryAdmin, /vehicleSide/);
  assert.match(deliveryAdmin, /testExpiry/);
  assert.match(deliveryAdmin, /insuranceExpiry/);
  assert.match(deliveryAdmin, /nextServiceDate/);
  assert.match(deliveryAdmin, /\/events/);
  assert.match(deliveryAdmin, /expense_total/);
  assert.match(deliveryAdmin, /income_total/);
  assert.match(nav, /\/delivery-admin\.html/);
});

test('intake review belongs to intake screen and OCR training is a separate admin tool', () => {
  const admin = read('public/admin.html');
  const intake = read('public/intake.html');
  const training = read('public/ocr-training.html');
  const nav = read('public/nav.js');

  assert.doesNotMatch(admin, /tab-training/);
  assert.doesNotMatch(admin, /loadOcrTraining/);
  assert.doesNotMatch(admin, /saveOcrTraining/);
  assert.doesNotMatch(admin, /loadIntakeQueue/);
  assert.doesNotMatch(admin, /intakeApprove/);
  assert.doesNotMatch(admin, /intakeReject/);
  assert.match(admin, /\/ocr-training\.html/);
  assert.doesNotMatch(intake, /ocrTrainingList/);
  assert.doesNotMatch(intake, /loadOcrTraining/);
  assert.doesNotMatch(intake, /saveOcrTraining/);
  assert.doesNotMatch(intake, /deleteOcrTraining/);
  assert.match(intake, /loadIntakeQueue\(\);\s*<\/script>/);
  assert.match(intake, /loadIntakeQueue/);
  assert.match(intake, /מרכז קליטת הזמנות/);
  assert.doesNotMatch(intake, /saveManualIntake/);
  assert.doesNotMatch(intake, /manualIntakeText/);
  assert.match(intake, /תור לאישור לפי דחיפות/);
  assert.match(intake, /queue-panel/);
  assert.doesNotMatch(intake, /capture-panel/);
  assert.doesNotMatch(intake, /work-steps/);
  assert.doesNotMatch(intake, /source-box/);
  assert.match(intake, /data-box/);
  assert.match(intake, /queue-empty/);
  assert.match(intake, /urgencyInfo/);
  assert.match(intake, /sortIntakeRows/);
  assert.match(intake, /order-metrics/);
  assert.match(intake, /סינון לפי מקור/);
  assert.match(intake, /customer_match/);
  assert.match(intake, /searchCustomerForIntake/);
  assert.match(intake, /\/api\/customers\?q=/);
  assert.match(intake, /customer_id/);
  assert.match(training, /loadOcrTraining/);
  assert.match(training, /saveOcrTraining/);
  assert.match(training, /\/api\/intake\/training/);
  assert.match(intake, /\/api\/intake\/log\?status=pending_review/);
  assert.match(nav, /\/intake\.html/);
});

test('intake OCR review requires source-versus-parsed comparison', () => {
  const intake = read('public/intake.html');
  const route = read('routes/intake.js');
  const startup = read('db/startup.js');

  assert.match(intake, /intakeCompareModal/);
  assert.match(intake, /openIntakeCompare/);
  assert.match(intake, /intakeSourceHtml/);
  assert.match(intake, /intakeCompareSourceHtml/);
  assert.match(intake, /setIntakeCompareZoom/);
  assert.match(intake, /scrollToHashIntake/);
  assert.match(intake, /intakeEditableForm/);
  assert.match(intake, /data-ocr-field/);
  assert.match(intake, /data-editable-cell/);
  assert.match(intake, /total_length_m/);
  assert.match(intake, /target_weight_kg/);
  assert.match(intake, /low-confidence/);
  assert.match(intake, /shape-editor\.js/);
  assert.match(intake, /ocrShapePreviewHtml/);
  assert.match(intake, /openOcrShapeEditor/);
  assert.match(intake, /isStraightOcrItem/);
  assert.match(intake, /straight-ocr-no-angles/);
  assert.match(intake, /element_name/);
  assert.match(intake, /shape_description/);
  assert.match(intake, /review_status/);
  assert.match(intake, /ocrRowStatus_/);
  assert.match(intake, /intakeQueueSummaryHtml/);
  assert.match(intake, /data-intake-card-id/);
  assert.doesNotMatch(intake, /const items = intakeQueueItemsTable/);
  assert.match(intake, /intakeQueueItemsTable/);
  assert.match(intake, /ocr-queue-table/);
  assert.match(intake, /ocr-queue-edit/);
  assert.match(intake, /openQueueItemShapeEditor/);
  assert.match(intake, /applyShapeSelectionToItem/);
  assert.match(intake, /activeQueueShapeContext/);
  assert.match(intake, /ocr-queue-title/);
  assert.doesNotMatch(intake, /ocr-queue-edit-row/);
  assert.match(intake, /isDimensionPairMarker/);
  assert.match(intake, /isCardDimensionPair/);
  assert.match(intake, /cardDimensionPairSides/);
  assert.match(intake, /ocrCardShapeSvg/);
  assert.match(intake, /data-shape-kind="ocr-card-shape"/);
  assert.match(intake, /safeIntakeRender/);
  assert.match(intake, /expandSegmentPart/);
  assert.match(intake, /normalizeOcrSegments/);
  assert.match(intake, /angle_deg: 90/);
  assert.match(intake, /compactDimensionPairText/);
  assert.match(intake, /ocrHasBentGeometry/);
  assert.match(intake, /ocrReadablePreviewSides/);
  assert.match(intake, /cloneParsedForCompare/);
  assert.match(intake, /requireIntakeCompareElements/);
  assert.match(intake, /safeOpenIntakeCompare/);
  assert.match(intake, /data-intake-action="compare"/);
  assert.match(intake, /handleIntakeListClick/);
  assert.match(intake, /ocrUncertainShapeSvg/);
  assert.match(intake, /data-shape-kind="ocr-uncertain"/);
  assert.doesNotMatch(intake, /intake-compose-details/);
  assert.doesNotMatch(intake, /work-steps-details/);
  assert.match(intake, /spiral_diameter_mm/);
  assert.match(intake, /spiral_turns/);
  assert.match(intake, /ShapeEditorModal/);
  assert.match(intake, /parsed_data: parsed/);
  assert.match(intake, /tableFirst/);
  assert.doesNotMatch(intake, /השוואה במסך מלא/);
  assert.match(intake, /data-official-ocr-review/);
  assert.match(intake, /ocr-official-summary/);
  assert.match(intake, /ocr-context-grid/);
  assert.match(intake, /ocr-review-toolbar/);
  assert.match(intake, /ocr-official-footer/);
  assert.match(intake, /ensureOfficialOcrHeader/);
  assert.match(intake, /\/brand\/tene-pdf-logo\.jpg/);
  assert.match(intake, /ocrSourceTargetsHtml/);
  assert.match(intake, /highlightOcrTableTarget/);
  assert.match(intake, /toggleOcrCompareMode/);
  assert.match(intake, /setOcrCompareHover/);
  assert.match(intake, /class="ocr-compare-toggle"/);
  assert.match(intake, /filterOcrReviewRows/);
  assert.match(intake, /target_weight_kg/);
  assert.match(intake, /ocr-review-note/);
  assert.match(intake, /\u05d0\u05e9\u05e8 \u05d5\u05e4\u05ea\u05d7 \u05d4\u05d6\u05de\u05e0\u05d4/);
  assert.match(route, /original_data_url/);
  assert.match(route, /original_mime/);
  assert.match(route, /saveAnalysisToIntake/);
  assert.match(route, /element_name/);
  assert.match(route, /shape_description/);
  assert.match(route, /shape_name is the canonical shape/);
  assert.match(startup, /addCol\('intake_log', 'original_data_url'/);
});

test('new order OCR upload creates an intake review task before direct import', () => {
  const index = read('public/index.html');
  const route = read('routes/intake.js');

  assert.match(index, /save_to_intake/);
  assert.match(index, /intakeReviewUrl/);
  assert.match(index, /\/intake\.html\?source=order-upload/);
  assert.match(index, /window\.location\.href = intakeReviewUrl\(intakeId\)/);
  assert.match(route, /pending_review/);
  assert.match(route, /original_data_url/);
});

test('admin OCR settings describe OpenAI intake instead of Google Vision', () => {
  const admin = read('public/admin.html');
  const adminRoute = read('routes/admin.js');
  const server = read('server.js');
  const dbConnection = read('db/connection.js');

  assert.match(admin, /OpenAI \/ GPT OCR/);
  assert.match(admin, /OPENAI_API_KEY/);
  assert.match(admin, /OPENAI_API_KEY_LOCAL/);
  assert.match(admin, /OPENAI_MODEL/);
  assert.match(admin, /INTAKE_AI_ENABLED/);
  assert.doesNotMatch(admin, /Google Vision OCR/);
  assert.doesNotMatch(admin, /Google Vision API Key/);
  assert.match(adminRoute, /'OPENAI_API_KEY','OPENAI_MODEL','INTAKE_AI_ENABLED'/);
  assert.match(server, /function getOpenAiApiKey/);
  assert.match(server, /OPENAI_API_KEY_LOCAL/);
});

test('order numbers are allocated from a DB sequence instead of order count', () => {
  const server = read('server.js');
  const coreSchema = read('db/coreSchema.js');
  const orderNumbers = read('services/orderNumbers.js');
  const generateOrderNumStart = server.indexOf('const generateOrderNum');
  const generateOrderNumEnd = server.indexOf('function checkOrderComplete', generateOrderNumStart);
  const generateOrderNumSource = server.slice(generateOrderNumStart, generateOrderNumEnd);

  assert.match(coreSchema, /CREATE TABLE IF NOT EXISTS order_sequences/);
  assert.match(server, /createOrderNumberAllocator\(db\)/);
  assert.match(orderNumbers, /function ensureOrderSequence/);
  assert.match(orderNumbers, /const nextOrderNumTx = db\.transaction/);
  assert.match(orderNumbers, /UPDATE order_sequences\s+SET next_value=next_value\+1/);
  assert.doesNotMatch(generateOrderNumSource, /COUNT\(\*\).*FROM orders/s);
});

test('large operational list endpoints use server-side pagination', () => {
  const server = read('server.js');
  const orderRoutes = read('routes/orders.js');
  const ordersStart = orderRoutes.indexOf("router.get('/orders'");
  const ordersEnd = orderRoutes.indexOf("router.get('/orders/:id'", ordersStart);
  const ordersSource = orderRoutes.slice(ordersStart, ordersEnd);
  const inventoryRoutes = read('routes/inventory.js');
  const inventoryStart = inventoryRoutes.indexOf("router.get('/inventory'");
  const inventoryEnd = inventoryRoutes.indexOf("router.get('/inventory/summary'", inventoryStart);
  const inventorySource = inventoryRoutes.slice(inventoryStart, inventoryEnd);

  assert.match(server, /function listPage/);
  assert.match(ordersSource, /listPage\(req\.query/);
  assert.match(ordersSource, /LIMIT \? OFFSET \?/);
  assert.match(inventorySource, /listPage\(req\.query/);
  assert.match(inventorySource, /LIMIT \? OFFSET \?/);
});

test('machine and workstation setup belong to production setup screen', () => {
  const admin = read('public/admin.html');
  const setup = read('public/production-setup.html');
  const startup = read('db/startup.js');
  const nav = read('public/nav.js');

  assert.doesNotMatch(admin, /tab-machines/);
  assert.doesNotMatch(admin, /tab-workstations/);
  assert.doesNotMatch(admin, /loadMachinesAdmin/);
  assert.doesNotMatch(admin, /saveMachinesAdmin/);
  assert.doesNotMatch(admin, /openAddMachineModal/);
  assert.doesNotMatch(admin, /loadWorkstations/);
  assert.doesNotMatch(admin, /saveWorkstations/);
  assert.match(setup, /loadMachinesAdmin/);
  assert.match(setup, /saveMachinesAdmin/);
  assert.match(setup, /loadWorkstations/);
  assert.match(setup, /\/api\/machines/);
  assert.match(setup, /single_min_diameter/);
  assert.match(setup, /single_max_diameter/);
  assert.match(setup, /double_min_diameter/);
  assert.match(setup, /double_max_diameter/);
  assert.match(setup, /חוט בודד/);
  assert.match(setup, /חוט כפול/);
  assert.match(startup, /single_min_diameter/);
  assert.match(startup, /double_max_diameter/);
  assert.match(nav, /\/production-setup\.html/);
});

test('platform admin quick links target module admin surfaces', () => {
  const admin = read('public/admin.html');

  assert.match(admin, /\/intake\.html/);
  assert.match(admin, /\/customers\.html/);
  assert.match(admin, /\/finance\.html/);
  assert.match(admin, /\/delivery-admin\.html/);
  assert.match(admin, /\/production-setup\.html/);
  assert.doesNotMatch(admin, /href="\/machine\.html"/);
  assert.doesNotMatch(admin, /href="\/kiosk\.html"/);
  assert.doesNotMatch(admin, /href="\/driver\.html"/);
  assert.doesNotMatch(admin, /class="topnav"/);
  assert.doesNotMatch(admin, /\.machines-table/);
  assert.doesNotMatch(admin, /\.ws-card/);
});

test('platform admin exposes role permission management', () => {
  const admin = read('public/admin.html');

  assert.match(admin, /tab-permissions/);
  assert.match(admin, /ניהול הרשאות/);
  assert.match(admin, /PERMISSION_ROLES/);
  assert.match(admin, /openInitialTabFromUrl/);
  for (const role of ['admin', 'manager', 'office', 'warehouse', 'production', 'kiosk', 'sales', 'finance', 'quality', 'maintenance', 'driver']) {
    assert.match(admin, new RegExp(`value="${role}"|role:'${role}'`));
  }
});

test('platform admin exposes module maturity control board', () => {
  const admin = read('public/admin.html');

  assert.match(admin, /מודולים פעילים|בקרת מודולים/);
  assert.match(admin, /moduleStatusGrid/);
  assert.match(admin, /module-card/);
  assert.match(admin, /status:'partial'/);
  assert.match(admin, /status:'frozen'/);
  assert.match(admin, /risk:'high'/);
  assert.match(admin, /MODULE_PLATFORM_CORE/);
  assert.match(admin, /MODULE_VENDOR_CONTROL/);
  assert.match(admin, /Vendor Control \/ בקרה מרחוק/);
  assert.match(admin, /אין גישה חופשית לנתוני לקוח/);
  assert.match(admin, /MODULE_ORDERS/);
  assert.match(admin, /MODULE_PRODUCTION/);
  assert.match(admin, /MODULE_INVENTORY/);
  assert.match(admin, /MODULE_FLEET/);
  assert.match(admin, /MODULE_FINANCE/);
  assert.match(admin, /MODULE_QUALITY/);
  assert.match(admin, /MODULE_PORTALS/);
  assert.match(admin, /הפעלה טכנית לא אומרת שהמודול בשל למכירה|הפעלה.כיבוי מודולים מנוהלת/);
});

test('platform admin ERP connectors do not advertise unavailable demo actions', () => {
  const admin = read('public/admin.html');

  assert.doesNotMatch(admin, /placeholder="demo"/);
  assert.doesNotMatch(admin, /alert\('בפיתוח'\)/);
  assert.match(admin, /id="erp-sap" disabled/);
  assert.match(admin, /id="erp-maven" disabled/);
  assert.match(admin, /מחבר רשמי בתכנון/);
});

test('procurement screen is API-backed and no longer a demo stub', () => {
  const procurement = read('public/procurement.html');

  assert.match(procurement, /src="\/auth-client\.js"/);
  assert.match(procurement, /src="\/safe-dom\.js"/);
  assert.match(procurement, /loadProcurementData/);
  assert.match(procurement, /\/api\/purchase-orders/);
  assert.match(procurement, /\/api\/suppliers/);
  assert.match(procurement, /\/api\/steel-prices/);
  assert.match(procurement, /normalizePO/);
  assert.match(procurement, /normalizeSupplier/);
  assert.doesNotMatch(procurement, /BUG-47/);
  assert.doesNotMatch(procurement, /coming soon banner/);
  assert.doesNotMatch(procurement, /demo data/);
  assert.doesNotMatch(procurement, /fallback to demo/i);
});

test('warehouse screen is API-backed and owns outbound warehouse work only', () => {
  const warehouse = read('public/warehouse.html');

  assert.match(warehouse, /src="\/auth-client\.js"/);
  assert.match(warehouse, /src="\/safe-dom\.js"/);
  assert.match(warehouse, /\/api\/packages/);
  assert.match(warehouse, /\/api\/deliveries/);
  assert.doesNotMatch(warehouse, /\/api\/suppliers/);
  assert.doesNotMatch(warehouse, /\/api\/inventory/);
  assert.doesNotMatch(warehouse, /tab-receipt/);
  assert.doesNotMatch(warehouse, /submitReceipt/);
  assert.doesNotMatch(warehouse, /loadReceipts/);
  assert.doesNotMatch(warehouse, /loadSuppliers/);
  assert.doesNotMatch(warehouse, /rSupplier/);
  assert.doesNotMatch(warehouse, /getMockPackages/);
  assert.doesNotMatch(warehouse, /getMockDeliveries/);
  assert.doesNotMatch(warehouse, /getMockSuppliers/);
  assert.doesNotMatch(warehouse, /getMockReceipts/);
  assert.doesNotMatch(warehouse, /Mock success/i);
  assert.doesNotMatch(warehouse, /Use mock data/i);
});

test('inventory screen is authenticated and covered by safe API loading', () => {
  const inventory = read('public/inventory.html');
  const training = read('public/ocr-training.html');
  const inventoryVisionRoutes = read('routes/inventoryVision.js');

  assert.match(inventory, /src="\/auth-client\.js"/);
  assert.match(inventory, /src="\/safe-dom\.js"/);
  assert.match(inventory, /\/api\/inventory\/summary/);
  assert.match(inventory, /\/api\/inventory/);
  assert.match(inventory, /\/api\/suppliers/);
  assert.match(inventory, /\/api\/waste\/summary/);
  assert.match(inventory, /value="bent"/);
  assert.match(inventory, /bending_shape_segments/);
  assert.match(inventory, /\/api\/inventory\/analyze-bending-shape/);
  assert.match(inventory, /\/api\/inventory\/receipt-reviews/);
  assert.match(inventory, /receiptSourcePreview/);
  assert.match(inventory, /receiptCompareModal/);
  assert.match(inventory, /openReceiptCompare/);
  assert.match(inventory, /receipt-fullscreen/);
  assert.match(inventory, /השוואה במסך מלא/);
  assert.match(inventory, /approveReceiptReview/);
  assert.match(inventory, /parseBendingShapeSegments/);
  assert.match(inventory, /renderShapePreview/);
  assert.match(inventory, /ocrSetupMessage/);
  assert.match(inventory, /insufficient_quota/);
  assert.match(inventory, /Billing ב-OpenAI/);
  assert.match(training, /value="bending_shape"/);
  assert.match(inventoryVisionRoutes, /getIntakeTrainingGuidance\(12, \['bending_shape', 'bar_schedule', 'general'\]\)/);
  assert.match(inventory, /חסר OpenAI API Key/);
  assert.match(inventory, /OCR כבוי/);
  assert.match(inventory, /IronBendSafe\.escapeHtml/);
  assert.match(inventory, /שגיאה בטעינת ספקים/);
  assert.doesNotMatch(inventory, /mock[A-Z]/);
  assert.doesNotMatch(inventory, /demo data/i);
});

test('order OCR routes non-order documents to their owning modules before upload', () => {
  const intake = read('public/index.html');
  const inventory = read('public/inventory.html');
  const finance = read('public/finance.html');
  const intakeRoute = read('routes/intake.js');
  const catalogRoute = read('routes/catalog.js');

  assert.match(intake, /function routeNonOrderOcrDocument\(documentType\)/);
  assert.match(intake, /documentType === 'supplier_delivery'/);
  assert.match(intake, /\/inventory\.html#receipts/);
  assert.match(intake, /documentType === 'price_list'/);
  assert.match(intake, /\/pricing\.html/);
  assert.match(intake, /if \(routeNonOrderOcrDocument\(documentType\)\) return/);
  assert.match(intake, /function handleOcrPickerClick\(event\)/);
  assert.match(intake, /function updateOcrDocumentRouteUi\(\)/);
  assert.match(intake, /data-ocr-upload-label/);
  assert.match(intake, /פתח מלאי - קבלת חומר OCR/);
  assert.match(intake, /פתח פיננסים - מחירון/);
  assert.match(intakeRoute, /requested_by_module/);
  assert.match(intakeRoute, /requested_use_case/);
  assert.match(intakeRoute, /\/api\/pricing\/price-books\/analyze-upload/);
  assert.match(catalogRoute, /function pricingOcrContext\(req\)/);
  assert.match(catalogRoute, /requested_by_module=\$\{context\.requested_by_module\}/);
  assert.match(inventory, /function openInitialInventoryTab\(\)/);
  assert.match(inventory, /window\.location\.hash/);
  assert.doesNotMatch(finance, /id="price-list"/);
});

test('local server command skips startup snapshot outside production', () => {
  const server = read('server.js');
  const dbConnection = read('db/connection.js');
  const authMiddleware = read('middleware/auth.js');
  const pkg = JSON.parse(read('package.json'));
  const localStart = read('scripts/start-local.js');

  assert.match(dbConnection, /SKIP_STARTUP_DB_SNAPSHOT/);
  assert.match(dbConnection, /env\.NODE_ENV !== 'production'/);
  assert.match(authMiddleware, /AUTH_BYPASS.*NODE_ENV === 'development'/);
  assert.equal(pkg.scripts['start:local'], 'node scripts/start-local.js');
  assert.match(localStart, /PORT.*3100/);
  assert.match(localStart, /SKIP_STARTUP_DB_SNAPSHOT/);
  assert.match(localStart, /AUTH_BYPASS/);
  assert.match(localStart, /AUTH_BYPASS_ROLE/);
});

test('render blueprint keeps env var values as explicit strings', () => {
  const renderYaml = read('render.yaml');
  const unquotedValues = renderYaml
    .split(/\r?\n/)
    .filter(line => /^\s+value:\s+/.test(line))
    .filter(line => !/^\s+value:\s+["'].*["']\s*$/.test(line));

  assert.deepEqual(unquotedValues, []);
});

test('supplier portal is frozen instead of serving demo supplier data', () => {
  const supplier = read('public/supplier.html');

  assert.match(supplier, /פורטל הספקים מוקפא/);
  assert.match(supplier, /מסך הרכש הפנימי/);
  assert.doesNotMatch(supplier, /DEMO_SUPPLIERS/);
  assert.doesNotMatch(supplier, /SUP-042/);
  assert.doesNotMatch(supplier, /supplier_code/);
  assert.doesNotMatch(supplier, /\/api\/purchase-orders\/' \+ activePO \+ '\/eta/);
  assert.doesNotMatch(supplier, /method: 'POST',\s*body: fd/);
});

test('driver portal uses authenticated API calls and server delivery statuses', () => {
  const driver = read('public/driver.html');

  const authIndex = driver.indexOf('src="/auth-client.js"');
  const safeIndex = driver.indexOf('src="/safe-dom.js"');
  const navIndex = driver.indexOf('src="/nav.js"');

  assert.notEqual(authIndex, -1, 'driver should load auth-client.js');
  assert.notEqual(safeIndex, -1, 'driver should load safe-dom.js');
  assert.notEqual(navIndex, -1, 'driver should load nav.js');
  assert.ok(authIndex < navIndex, 'driver should load auth before nav');
  assert.match(driver, /DELIVERY_STATUS/);
  assert.match(driver, /PLANNED: 'מתוכנן'/);
  assert.match(driver, /\[DELIVERY_STATUS\.WAITING, DELIVERY_STATUS\.PLANNED\]\.includes/);
  assert.match(driver, /escHtml\(d\.order_num\)/);
  assert.match(driver, /escHtml\(d\.delivery_address \|\| 'לא הוזנה'\)/);
  assert.doesNotMatch(driver, /selectDriver\(\$\{JSON\.stringify/);
});

test('maintenance screen is API-backed and no longer falls back to mock maintenance data', () => {
  const maintenance = read('public/maintenance.html');

  assert.match(maintenance, /src="\/auth-client\.js"/);
  assert.match(maintenance, /src="\/safe-dom\.js"/);
  assert.match(maintenance, /\/api\/maintenance/);
  assert.match(maintenance, /\/api\/loto/);
  assert.match(maintenance, /\/api\/pm-schedule/);
  assert.doesNotMatch(maintenance, /BUG-47/);
  assert.doesNotMatch(maintenance, /coming soon banner/);
  assert.doesNotMatch(maintenance, /mockMachines/);
  assert.doesNotMatch(maintenance, /mockStats/);
  assert.doesNotMatch(maintenance, /mockLogs/);
  assert.doesNotMatch(maintenance, /mockLoto/);
  assert.doesNotMatch(maintenance, /mockPm/);
});

test('projects screen is API-backed and no longer owns finance credit workflows', () => {
  const projects = read('public/projects.html');

  assert.match(projects, /src="\/auth-client\.js"/);
  assert.match(projects, /src="\/safe-dom\.js"/);
  assert.match(projects, /\/api\/projects/);
  assert.match(projects, /\/api\/sites/);
  assert.doesNotMatch(projects, /BUG-47/);
  assert.doesNotMatch(projects, /coming soon banner/);
  assert.doesNotMatch(projects, /\/api\/credit/);
  assert.doesNotMatch(projects, /creditTable/);
  assert.doesNotMatch(projects, /openCreditModal/);
  assert.doesNotMatch(projects, /מסגרות אשראי/);
});

test('war room is API-backed and does not fall back to local mock incidents', () => {
  const warroom = read('public/warroom.html');

  assert.match(warroom, /src="\/auth-client\.js"/);
  assert.match(warroom, /src="\/safe-dom\.js"/);
  assert.match(warroom, /\/api\/incidents/);
  assert.match(warroom, /\/api\/machines/);
  assert.match(warroom, /normalizeIncident/);
  assert.match(warroom, /update_text/);
  assert.doesNotMatch(warroom, /BUG-47/);
  assert.doesNotMatch(warroom, /coming soon banner/);
  assert.doesNotMatch(warroom, /MOCK_/);
  assert.doesNotMatch(warroom, /local-\'+Date\.now/);
  assert.doesNotMatch(warroom, /API not available/);
  assert.doesNotMatch(warroom, /timelineEntry/);
});

test('quality screen is API-backed and does not fall back to local NCR or CAPA demo data', () => {
  const quality = read('public/quality.html');
  const qualityRoute = read('routes/quality.js');

  assert.match(quality, /src="\/auth-client\.js"/);
  assert.match(quality, /src="\/safe-dom\.js"/);
  assert.match(quality, /\/api\/quality/);
  assert.match(quality, /\/api\/ncr/);
  assert.match(quality, /\/api\/capa/);
  assert.match(quality, /normalizeNCR/);
  assert.match(quality, /normalizeCAPA/);
  assert.match(quality, /return false/);
  assert.doesNotMatch(quality, /Generate local IDs for demo/);
  assert.doesNotMatch(quality, /seedNCR/);
  assert.doesNotMatch(quality, /seedCAPA/);
  assert.doesNotMatch(quality, /_ncrSeq/);
  assert.doesNotMatch(quality, /_capaSeq/);
  assert.doesNotMatch(quality, /NCR-101/);
  assert.doesNotMatch(quality, /CAPA-201/);
  assert.doesNotMatch(quality, /ncrList\.unshift/);
  assert.doesNotMatch(quality, /capaList\.unshift/);
  assert.match(qualityRoute, /verification_method = COALESCE/);
});

test('shared navigation exposes modules converted from stubs', () => {
  const nav = read('public/nav.js');

  assert.match(nav, /\/projects\.html/);
  assert.match(nav, /\/warroom\.html/);
  assert.match(nav, /\/maintenance\.html/);
  assert.match(nav, /\/quality\.html/);
  assert.doesNotMatch(nav, /warroom removed \(stub\)/);
  assert.doesNotMatch(nav, /stub pages hidden/);
});


test('server hardens production auth and websocket upgrades', () => {
  const server = read('server.js');
  const realtime = read('realtime/ws.js');
  const authClient = read('public/auth-client.js');
  const wsClients = [
    'public/dashboard.html',
    'public/kiosk.html',
    'public/machine.html',
    'public/orders.html',
    'public/worker-visual.html',
  ];

  assert.match(server, /const helmet\s+=\s+require\('helmet'\)/);
  assert.match(server, /app\.use\(helmet\(\{ contentSecurityPolicy: false \}\)\)/);
  assert.match(server, /STRICT_SECRET_ENVS = new Set\(\['production', 'staging'\]\)/);
  assert.match(server, /JWT_SECRET is required in production\/staging/);
  assert.match(server, /createRealtimeServer\(\{ server, db, modbus, authService, applyAuthBypass \}\)/);
  assert.match(realtime, /new WebSocketServer\(\{ noServer: true \}\)/);
  assert.match(realtime, /server\.on\('upgrade', onUpgrade\)/);
  assert.match(realtime, /authService\.verifyAccessToken\(token\)/);
  assert.match(realtime, /HTTP\/1\.1 401 Unauthorized/);
  assert.match(authClient, /function webSocketUrl/);
  assert.match(authClient, /searchParams\.set\('token', token\)/);

  for (const file of wsClients) {
    const source = file === 'public/dashboard.html'
      ? read(file) + read('public/dashboard.js')
      : read(file);
    assert.match(source, /IronBendAuth\?\.webSocketUrl/, file);
  }
});


test('OCR review shape refresh keeps compact cell without edit pencil', () => {
  const intake = read('public/intake.html');
  const shapeCell = intake.slice(
    intake.indexOf('function ocrShapeCellHtml(item, index) {'),
    intake.indexOf('function removeOcrItem(index)')
  );

  assert.match(shapeCell, /class="ocr-review-shape"/);
  assert.match(shapeCell, /handleOfficialOcrShapeClick/);
  assert.doesNotMatch(shapeCell, /ocr-queue-edit/);

  const refreshVisual = intake.slice(
    intake.indexOf('function refreshOcrShapeVisual(index) {'),
    intake.indexOf('function shapeSelectedFromIntake(data)')
  );
  assert.match(refreshVisual, /shapeTd.innerHTML = ocrShapeCellHtml/);
});


test('OCR review straight detection is explicit and does not treat any bar text as straight', () => {
  const intake = read('public/intake.html');
  assert.match(intake, /function ocrHasStraightHint\(item\)/);
  assert.match(intake, /straight\|straight bar/);
  assert.match(intake, /ocrHasStraightHint\(item\) && !ocrHasBentHint\(item\)/);
  assert.doesNotMatch(intake, /straight\|bar\/i\.test\(raw\)/);
});

test('OCR review editable cell lookup prefers visible inputs over hidden fields', () => {
  const intake = read('public/intake.html');
  const inputLookup = intake.slice(
    intake.indexOf('function ocrItemInput(index, field) {'),
    intake.indexOf('function itemSegmentsOf(item)')
  );

  assert.match(inputLookup, /querySelectorAll/);
  assert.match(inputLookup, /input.type !== 'hidden'/);
});

test('OCR prompt separates TASSA bar mark from quantity', () => {
  const intakeRoute = read('routes/intake.js');

  assert.match(intakeRoute, /bar-mark column is never quantity/);
  assert.match(intakeRoute, /quantity-column value is the item quantity/);
  assert.match(intakeRoute, /quantity=51/);
  assert.match(intakeRoute, /segments \[20,670\] cm/);
  assert.match(intakeRoute, /table total length 6\.90 m/);
  assert.match(intakeRoute, /two different length sources that must not be merged/);
  assert.match(intakeRoute, /total_length_cm must come from the table total-length column/);
  assert.match(intakeRoute, /When the difference is a plausible missing leg\/tail/);
  assert.match(intakeRoute, /shape_type as one of: straight, bent, stirrup, spiral, unknown/);
  assert.match(intakeRoute, /segments=\[\]/);
  assert.match(intakeRoute, /straight label must never erase visible shape parameters/);
  assert.match(intakeRoute, /Every visible number has a role based on its visual context/);
  assert.match(intakeRoute, /Do not blacklist values such as 20 or 180/);
  assert.match(intakeRoute, /total cut length \/ overall row length/);
  assert.match(intakeRoute, /shape side dimensions belong only to the sketch/);
  assert.match(intakeRoute, /foundation rebar lists/);
  assert.match(intakeRoute, /Extract every visible numbered row, including rows 1 and 2/);
  assert.match(intakeRoute, /segments \[20,100,20\] cm/);
  assert.match(intakeRoute, /segments \[20,80,20\] cm/);
  assert.match(intakeRoute, /coil \/ spiral row/);
  assert.match(intakeRoute, /do not silently change the visible shape/);
});


test('analyze-image PDF route uses steel document parser before saving an empty OCR draft', () => {
  const intakeRoute = read('routes/intake.js');

  assert.match(intakeRoute, /extractPdfWordsFromBuffer/);
  assert.match(intakeRoute, /steelPdfParsed\.metrics\?\.\s*rows_detected > 0/);
  assert.match(intakeRoute, /steelPdfParsed\.metrics\?\.\s*usable_rows > 0/);
  assert.match(intakeRoute, /return res\.json\(payload\)/);
});


test('post-order OCR review saves row statuses without mutating approved intake drafts', () => {
  const intake = read('public/intake.html');
  const intakeReviewRoute = read('routes/intakeReview.js');

  assert.match(intakeReviewRoute, /\/intake\/:id\/order-review/);
  assert.match(intakeReviewRoute, /UPDATE items SET review_status=\?,review_notes=\?,reviewed_by=\?,reviewed_at=\?/);
  assert.match(intakeReviewRoute, /draft save cannot mutate/);
  assert.match(intakeReviewRoute, /applyOrderItemReviewState/);
  assert.match(intakeReviewRoute, /function orderItemToParsedItem/);
  assert.match(intakeReviewRoute, /function saveReviewedItemCorrectionExample/);
  assert.match(intakeReviewRoute, /Intake row approval/);
  assert.match(intakeReviewRoute, /Training example save skipped/);
  assert.match(intakeReviewRoute, /Row approval training example save skipped/);
  assert.match(intakeReviewRoute, /const parsedItems = next\.items\.length \? next\.items : orderItems\.map\(orderItemToParsedItem\)/);
  assert.match(intakeReviewRoute, /shape_snapshot_json,shape_id,shape_name,diameter/);
  assert.match(intakeReviewRoute, /COALESCE\(review_notes,note\) AS review_note_text/);
  assert.match(intakeReviewRoute, /item\.review_note_text \|\| item\.review_notes \|\| item\.note/);
  assert.match(intake, /function ocrSourceRefForPath/);
  assert.match(intake, /function ocrSourceRectPercent/);
  assert.match(intake, /const centeredHeight = rawHeight > 5 \? 3\.8/);
  assert.match(intake, /height: 3\.8/);
  assert.match(intake, /item\.fields\?\.\[field\]/);
  assert.match(intake, /row\?\.post_order_review \? .*order-review/);
  assert.match(intake, /function refreshOcrStatusSummary/);
  assert.match(intake, /refreshOcrStatusSummary\(\);/);
});

test('order detail prefers canonical server-rendered production shape SVG', () => {
  const ordersHtml = read('public/orders.html');
  const ordersRoute = read('routes/orders.js');

  assert.match(ordersHtml, /.item-visual svg{width:100%!important;height:100%!important/);
  assert.match(ordersHtml, /data-shape-svg/);
  assert.match(ordersHtml, /el.dataset.shapeSvg/);
  assert.match(ordersHtml, /decodeURIComponent\(el\.dataset\.shapeSvg\)/);
  assert.match(ordersRoute, /item\.shape_svg = productionCards\.itemShapeSvg\(item\)/);
});


test('display-only production views prefer server-rendered production shape SVG', () => {
  const worker = read('public/worker-visual.html');
  const productionRoute = read('routes/production.js');
  const orderPrintA4 = read('routes/orderPrintA4.js');

  assert.match(worker, /if\(item\.shape_svg\)return item\.shape_svg/);
  assert.match(worker, /worker-canonical-missing/);
  assert.match(worker, /\/api\/worker-card\?card=/);
  assert.match(worker, /workerCardApi\(id,'\/status'\)/);
  assert.match(read('public/reports.html'), /\/api\/reports\/worker-card-activity/);
  assert.match(worker, /if\(!SCAN_ENTRY\)ws\(\)/);
  assert.match(productionRoute, /router\.get\('\/worker-card'/);
  assert.match(productionRoute, /router\.patch\('\/worker-card\/:id'/);
  assert.match(productionRoute, /router\.patch\('\/worker-card\/:id\/status'/);
  assert.doesNotMatch(worker, /worker-open-u/);
  assert.doesNotMatch(worker, /worker-closed-stirrup/);
  assert.doesNotMatch(worker, /function openU\(/);
  assert.doesNotMatch(worker, /function generic\(/);
  assert.match(productionRoute, /i\.shape_snapshot_json/);
  assert.match(productionRoute, /i\.spiral_diameter_mm/);
  assert.match(productionRoute, /i\.spiral_turns/);
  assert.match(productionRoute, /productionCards\.itemShapeSvg\(item\)/);
  assert.match(orderPrintA4, /shape_svg:\s+productionCards\.itemShapeSvg\(it\)/);
  assert.doesNotMatch(orderPrintA4, /function drawShape2D/);
});

