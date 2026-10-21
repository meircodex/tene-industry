# Module Inventory

This inventory assigns the current screens and API route families to product
modules. It is intentionally practical: every future agent task should name one
module and one bounded file set from this document.

## Platform Core

Purpose:

- Identity, roles, permissions, shared shell, settings, audit, search, and
  deployment safety.

Screens:

- `public/login.html`
- `public/admin.html` for users/settings/audit only
- `public/help.html`

Shared frontend:

- `public/auth-client.js`
- `public/nav.js`
- `public/theme.css`
- `public/help.js`
- `public/sw.js`
- `public/offline.html`
- `public/offline-db.js`

Shared backend:

- `auth-core.js`
- `middleware/auth.js` for request auth decoding, development bypass, and signed webhook verification
- `permissions.js`
- `routes/auth.js` for identity session endpoints only
- `routes/admin.js` for settings, users, audit, and database maintenance
- `constants.js`
- `services/moduleLoader.js` for selecting the active industry module through `ACTIVE_INDUSTRY_MODULE`
- `modules/steel-rebar/index.js` as the current industry contract implementation
- `status-contracts.js`
- `public/status-contracts-client.js`
- `db/connection.js` for database path, startup snapshots, and production safety checks
- `db/coreSchema.js` for core table creation
- `db/startup.js` for startup orchestration and compatibility migrations
- `db/seed.js` for deterministic startup seed data
- `db/vehicleMigrations.js` for historical driver/vehicle compatibility migration
- `db/financeSchema.js` for finance tables loaded by startup
- `realtime/ws.js` for authenticated WebSocket transport and machine broadcasts
- `jobs/scheduler.js` for cron-based alerts, email intake polling, and backups

API route families:

- `/api/auth/*`
- `/api/users*`
- `/api/settings*`
- `/api/settings/test/:service`
- `/api/audit-log`
- `/api/search`
- `/api/admin/database/*`
- `/api/health`

Current risks:

- JWT auth is active for guarded routes. `AUTH_BYPASS` must stay disabled in
  production and staging environments.
- Local startup may use `AUTH_BYPASS=true` only for development setup; never use
  that mode to validate production security.
- User management routes are protected by JWT-derived admin roles; keep
  `test/route-auth-coverage.test.js` green so this cannot regress.
- Auth routes are platform identity infrastructure, not an admin feature. Keep
  `/api/auth/*` out of `routes/admin.js`.
- Many screens do not load `auth-client.js` directly and rely on `nav.js`.

## Orders

Purpose:

- Internal order creation, import, approval, status, item/pallet structure,
  documents, and customer order history as an internal domain.

Screens:

- `public/orders.html`
- `public/index.html`
- order panels inside `public/dashboard.html`

Module services:

- `services/orderNumbers.js`
- `services/orders.js`
- `services/intakeWorkflow.js` for external order intake parsing and
  approve-to-order payload building
- `services/productionCards.js` for individual production card rendering
- `services/productionCardPrintPage.js` for the print-cards HTML workspace

Extracted routes:

- `routes/orders.js` for core order CRUD, import approval, status, and lock APIs
- `routes/productionCards.js` for production card print output
- `routes/orderDocuments.js` as the order document router aggregator
- `routes/orderDeliveryCertificate.js` for delivery certificate documents
- `routes/orderPrintA4.js` for A4 production/order documents
- `routes/intake.js` for image/OCR document recognition
- `routes/intakeChannels.js` for WhatsApp and email intake channels
- `routes/intakeReview.js` for review queue, manual parse, approve, and reject
  flows
- `routes/intakeTraining.js` for OCR/AI correction examples and training
  guidance management

API route families:

- `/api/orders*`
- `/api/order-imports/*`
- `/api/items/*`
- `/api/bvbs/*`
- `/api/intake/*`
- `/api/analyze-image`
- `/api/priority/*`

Current risks:

- Order statuses are Hebrew strings scattered across server and screens.
- Some order detail rendering uses unescaped database values.
- Intake/OCR review renders external content in admin.
- Priority and AI flows are partially feature-flagged and should stay frozen
  until the core flow is stable.

## Production

Purpose:

- Approved work queue, machine assignment, execution, worker/kiosk operation,
  production events, OEE, shifts, stops.

Screens:

- `public/production-queue.html`
- `public/machine.html`
- `public/kiosk.html`
- `public/worker.html`
- `public/worker-visual.html`
- production sections inside `public/dashboard.html`

Module services:

- `status-contracts.js`
- `public/status-contracts-client.js`
- `services/productionCards.js` for card output shared with Orders

Extracted routes:

- `routes/productionMetrics.js` for production KPI read models: tons today,
  machine OEE, and current shift summary.
- `routes/production.js` for workers, scan execution, item progress, and
  production queue/events.
- `routes/productionMachines.js` for machine setup, machine assignment, Modbus
  parameter writes, machine state transitions, completion, and state logs.
- `routes/productionShifts.js` for shifts, downtime reasons, and machine stops.

API route families:

- `/api/production-queue`
- `/api/production-events`
- `/api/machines*`
- `/api/workers*`
- `/api/scan`
- `/api/shifts*`
- `/api/downtime-reasons`
- `/api/machine-stops*`
- `/api/kpi/tons-today`
- `/api/kpi/shift-summary`
- `/api/machines/oee`

Current risks:

- Dashboard production queue uses recent orders instead of the production queue
  service.
- Machine and queue screens need one status contract.
- Kiosk/worker flows are guarded by production/kiosk roles, but sold deployments
  still need a deliberate device/station auth policy.

## Inventory

Purpose:

- Raw material stock, receiving, receipt review, and stock forecasts.

Screens:

- `public/inventory.html`
- `public/inventory.html` is the home for raw material receiving. Warehouse is outbound only.

Module services:

- `services/inventory.js`

Extracted routes:

- `routes/inventory.js` for raw material, receipt review, and inventory forecast
- `routes/inventoryVision.js` for inventory OCR/AI recognition: bending shape
  analysis, label scanning, and supplier receipt parsing.

API route families:

- `/api/inventory*`
- `/api/inventory/summary`
- `/api/inventory/forecast`
- `/api/inventory/analyze-bending-shape`
- `/api/inventory/scan-label`
- `/api/inventory/receipt-reviews/analyze`

Current risks:

- Inventory must not own supplier management; supplier master data belongs to Procurement.
- Warehouse must stay outbound only and not reintroduce raw-material receiving.
- Inventory reservation rules are not clearly separated from production demand.

## Procurement

Purpose:

- Supplier master data, purchase orders, steel price history, supplier purchase workflow, and receiving handoff into inventory.

Screens:

- `public/procurement.html`

Extracted routes:

- `routes/procurement.js` for suppliers, steel prices, and purchase orders

API route families:

- `/api/suppliers*`
- `/api/steel-prices*`
- `/api/purchase-orders*`

Current risks:

- Procurement is API-backed, but workflow policy, approvals, and supplier portal separation still need product hardening.

## Logistics

Purpose:

- Dispatch execution, delivery lifecycle, shipment status, proof of delivery,
  delivery failures, and handoff between Warehouse and customers.

Screens:

- `public/driver.html`
- delivery/package areas inside `public/warehouse.html`

Extracted routes:

- `routes/warehouse.js` for packages and delivery-note issuance.
- `routes/logistics.js` for delivery lifecycle actions.

API route families:

- `/api/deliveries*`
- `/api/packages*`
- `/api/delivery-notes*`
- `/api/export/packages`

Current risks:

- Logistics may read assigned driver/vehicle context from Fleet, but it must not
  own vehicle documents, service history, or driver master data.
- Driver portal and internal dispatch need different auth models.
- Package shipping can easily diverge from order status if not centralized.
## Fleet Management

Purpose:

- Sellable fleet module for vehicles as company assets: vehicle file, assigned
  driver, documents, test/insurance/service expiry, service history, expenses,
  income attribution, and operational readiness.

Screens:

- `public/delivery-admin.html`

Module services:

- `services/fleet.js`

Extracted routes:

- `routes/fleet.js` for vehicles, vehicle documents/events, driver identity,
  vehicle assignment, and driver locations. Delivery execution lives in
  `routes/logistics.js` so Fleet can be sold independently from dispatch.

API route families:

- `/api/vehicles*`
- `/api/vehicles/:id/events`
- `/api/vehicles/:id/documents`
- `/api/drivers*` only for driver identity and vehicle assignment

Current risks:

- This module must not collapse back into "driver = vehicle".
- Delivery can depend on the assigned driver, but vehicle documents and service
  history belong to Fleet Management.
- Future customer packaging must allow Fleet Management to be enabled or hidden
  independently from Inventory, Production, Finance, and Quality.

## Catalog And Pricing

Purpose:

- Product shape catalog and internal product price list used by orders, customer
  portal quoting, and pricing screens.

Screens:

- `public/index.html`
- `public/intake.html`
- `public/customer.html`
- `public/pricing.html` for price book and SKU maintenance

Extracted routes:

- `routes/catalog.js` for shape catalog and internal pricing APIs

API route families:

- `/api/shapes*`
- `/api/pricing/price-books*`

Pricing architecture:

- There are three separate steel price layers and they must never be collapsed:
  purchase price, base selling price, and customer-specific price.
- Purchase price source of truth: `steel_price_history`, owned by Procurement/Finance.
  It changes frequently and is used for material cost and margin only.
- Base selling price source of truth: active `pricing_price_books` with
  `price_type='general'` and `pricing_price_items` rows.
- Customer price source of truth: active `pricing_price_books` with
  `price_type='customer'`, `customer_id`, and `pricing_price_items` rows.
- Future import layer: `services/pricing-importer.js` should parse Excel, CSV,
  ERP/API, supplier files, customer price-list files, and images into a preview
  structure that requires approval before saving.
- Future pricing engine: `services/pricer.js` should answer "what does this
  product cost this customer?" using customer pricing source, tier, discount,
  and industry-specific modules.

Current risks:

- Price-list writes are commercially sensitive and remain limited to
  finance/manager/admin.
- Customer-facing price list stays scoped under `/api/c/price-list` in the
  portal module; catalog owns only the internal source of truth.
- Do not make routes parse every vendor format directly; add importer adapters
  that normalize into the canonical price-list format.

## Finance

Purpose:

- Order costs, margin, credit, ledger, invoices, finance KPIs.

Screens:

- `public/finance.html`
- finance sections inside `public/reports.html`
- credit/project sections inside `public/projects.html`

Extracted routes:

- `routes/financeInvoices.js` for invoice listing, creation, payment, and cancellation
- `routes/financeCosts.js` for order cost calculation, recalculation, locking,
  and cost snapshots
- `routes/financeLedger.js` for customer ledger and customer_credit exposure
- `routes/finance.js` for order margin, finance KPIs, and financial events
- `routes/financeCredit.js` for active credit accounts, blocking status, and
  credit transactions

API route families:

- `/api/orders/:id/margin`
- `/api/orders/:id/costs*`
- `/api/customers/:id/ledger`
- `/api/customers/:id/credit`
- `/api/credit*`
- `/api/invoices*`
- `/api/finance/*`
- `/api/export/orders`
- `/api/export/inventory`

Current risks:

- There are two separate credit mechanisms: `customer_credit` for finance
  ledger/exposure and `credit_accounts`/`credit_transactions` for active
  blocking and credit operations. Keep them distinct; `financeCredit.js`
  owns the latter without merging table semantics.
- Finance endpoints contain sensitive data and must be protected before use.

## Quality

Purpose:

- Quality checks, NCR/CAPA, non-conformance handling, and incident reporting.

Screens:

- `public/quality.html`
- `public/warroom.html`

Extracted routes:

- `routes/quality.js` for quality checks, incidents, NCR, and CAPA.

API route families:

- `/api/quality*`
- `/api/incidents*`
- `/api/ncr*`
- `/api/capa*`

Current risks:

- Several pages are marked as coming soon/stub.
- State machines for NCR/CAPA need a specification before expanding
  functionality.
- Quality may read machine context for incidents, but must not own maintenance,
  LOTO, PM, or machine repair workflows.

## Maintenance

Purpose:

- Maintenance logs, breakdown handling, LOTO, preventive maintenance schedule,
  and machine repair state transitions.

Screens:

- `public/maintenance.html`
- maintenance sections inside `public/warroom.html`

Extracted routes:

- `routes/maintenance.js` for maintenance logs, LOTO, and preventive
  maintenance schedules.

API route families:

- `/api/maintenance*`
- `/api/loto*`
- `/api/pm-schedule*`

Current risks:

- State machines for maintenance need a specification before expanding
  functionality.
- LOTO and maintenance currently update machine status directly; preserve that
  behavior until a shared machine-state service owns those transitions.
- Maintenance may publish machine update events, but must not own quality checks,
  NCR, or CAPA.

## Customers And Projects

Purpose:

- Internal customer CRM, project records, delivery sites, and operational
  customer/project context used by Orders and Finance.

Screens:

- customer sections inside `public/admin.html`
- `public/projects.html`

Extracted routes:

- `routes/customers.js` for internal customer CRUD, projects, and sites.

API route families:

- `/api/customers`
- `/api/customers/:id`
- `/api/projects*`
- `/api/sites*`

Current risks:

- Portal token, portal pricing, and public customer portal routes are separate
  external-access flows and must not be merged into internal CRM routes.
- Customer/project data is sellable module data; vendor support access must stay
  off unless a support session is approved.

## Customer And External Portals

Purpose:

- External customer, supplier, driver, and worker experiences.

Screens:

- `public/customer.html`
- `public/portal.html`
- `public/supplier.html`
- `public/driver.html`
- `public/worker.html`
- `public/worker-visual.html`

Module services:

- `services/intakeWorkflow.js` for external order intake before approval
- `services/portalAccess.js` for customer portal OTP, scoped customer
  resolution, token lifecycle, and staff-generated portal links

Extracted routes:

- `routes/portalAdmin.js` for internal staff management of customer portal
  access links, token rotation/revocation, and customer portal pricing.
- `routes/portal.js` for customer-facing `/api/c/*` OTP, quote/order
  submission, customer approval, and portal-scoped order reads.

API route families:

- `/api/c/*`
- `/api/customers/:id/token`
- `/api/customers/:id/token/rotate`
- `/api/customers/:id/pricing`
- supplier routes used by `supplier.html`
- driver routes used by `driver.html`
- worker routes used by `worker*.html`

Current risks:

- Customer access can be granted from phone alone.
- Portal token policy is not strong enough for a sellable product.
- External portals need a separate session/OTP decision.
- Internal portal administration and external customer portal traffic are now
  separate route files; do not merge them back into CRM or the public portal.

## Dashboard And Reports

Purpose:

- Cross-module overview and reporting. This module must read from module-owned
  services, not reimplement business logic.

Screens:

- `public/dashboard.html`
- `public/reports.html`
- `public/holdings.html`
- `public/docs.html`

Extracted routes:

- `routes/reports.js` for dashboard summary, report summary, waste reports,
  monthly KPI, and CSV exports.

API route families:

- `/api/dashboard`
- `/api/reports/*`
- `/api/export/*`
- `/api/waste/summary`
- `/api/kpi/monthly`
- `/api/reports/summary`
- `/api/holdings`
- `/api/companies*`

Current risks:

- Dashboard currently duplicates production queue logic.
- Reporting is broad and should not own write behavior.

## Vendor Control And Remote Support

Purpose:

- Vendor/partner control plane for sold customer installations. This module lets
  the software owner see technical health, licensed modules, installed version,
  backup status, integration status, error telemetry, and support access state
  across customer sites without automatically exposing customer business data.

Screens:

- Future: `public/vendor-control.html`
- Current placeholder/control entry: `public/admin.html` module control board

API route families:

- Future: `/api/vendor/sites*`
- Future: `/api/vendor/sites/:id/health`
- Future: `/api/vendor/sites/:id/modules`
- Future: `/api/vendor/sites/:id/support-session`
- Future: `/api/vendor/sites/:id/version`
- Future: `/api/vendor/sites/:id/backups`

Current risks:

- This is not implemented yet and must not be confused with local admin access.
- Remote vendor access to customer data must be off by default.
- Support access must be customer-approved, time-limited, read-only by default,
  and fully audit logged.
- Any remote update, restore, permission change, or destructive action must need
  explicit customer approval and a separate audit event.
- The sellable product should expose module/license status to the vendor while
  keeping orders, prices, workers, customers, and financial data private unless a
  support session is open.

## Next Agent Assignments

Use these as the next concrete work packages after the Sprint 1 security and
module-governance foundation:

1. Production Agent: make dashboard production queue read only from
   `/api/production-queue` and remove duplicated queue logic.
2. Quality/Maintenance Agent: extract NCR/CAPA/LOTO/PM state rules into a module
   service before adding more UI.
3. Intake/OCR Agent: build compare-and-approve review surfaces for image/email/
   WhatsApp intake, preserving the original document beside parsed output.
4. Design System Agent: normalize modal/table layouts for shape review, intake,
   inventory receiving, and order approval.
5. Portal Agent: separate internal driver/worker screens from external portal
   sessions and document the final auth mode.


Production owns `services/itemStatusCorrection.js` and `/api/items/:id/status-correction-preview`, orchestrating the existing Orders certificate cancellation service without modifying document snapshots.
