# API Route Permission Map

Working baseline for turning the current API surface into a role-governed product.

Source files:

- `routes/*.js`
- `server.js` for `/api/health` only
- `docs/api-registry.md`
- `docs/permission-registry.md`
- `IronBend_API_Registry.docx`
- `IronBend_Permission_Matrix.docx`

## Current Code Snapshot

Automated scan of active API sources found:

- `server.js` intentionally keeps only `GET /api/health`.
- Product API route families live in module-owned `routes/*.js` files.
- Public/scoped boundaries remain explicit by design: auth, customer portal, WhatsApp webhook, OCR custom authorization, and health.
- `test/route-auth-coverage.test.js` fails if a new active `/api/*` route is added without an explicit role guard, custom authorization middleware, scoped public boundary, or allowlist entry.

Directly protected route groups today:

| Group | Routes | Current middleware |
| --- | --- | --- |
| Settings | `/api/settings`, `/api/settings/test/:service` | `requireRole('admin')` |
| Users | `/api/users`, `/api/users/:id` | `requireRole('admin')` |
| Audit | `/api/audit-log` | `requireRole('manager')` |
| Admin database | `/api/admin/database/download`, `/api/admin/database/upload` | `requireRole('admin')` |
| Customer CRM | `/api/customers`, `/api/customers/:id` | read: `office/sales/manager/admin`; write: `office/manager/admin` |
| Finance / credit / costs | `/api/finance/*`, `/api/credit*`, `/api/invoices*`, cost/margin/ledger/credit routes | `requireAnyRole(['finance', 'manager', 'admin'])` |
| Customer pricing/token | `/api/customers/:id/token`, `/api/customers/:id/pricing` | `requireAnyRole(['office', 'manager', 'admin'])` |
| Price/steel writes | `/api/pricing/price-books*`, `/api/steel-prices` POST | `requireAnyRole(['finance', 'manager', 'admin'])` |
| Cost lock | `/api/orders/:id/costs/lock` | `requireRole('manager')` |
| Order commitments | `/api/orders/manual`, `/api/orders`, `/api/order-imports/preview`, `/api/order-imports/:id/approve`, `/api/intake/:id/approve`, `/api/intake/:id/reject` | `requireAnyRole(['office', 'manager', 'admin'])` |
| Order reads/documents | `/api/orders`, `/api/orders/:id`, `/api/orders/:id/print-cards`, `/api/orders/:id/print-a4`, `/api/orders/:id/delivery-certificate` | read: `office/production/sales/manager/admin`; documents by operational role |
| Intake and BVBS | `/api/analyze-image`, `/api/intake/image`, `/api/intake/email/poll`, `/api/intake/log`, `/api/intake/parse-text`, `/api/intake/training*`, `/api/bvbs/*` | office/manager/admin for parse/log/file flows; manager/admin for training writes |
| Order lifecycle | `/api/orders/:id/status` | `requireAnyRole(['office', 'production', 'manager', 'admin'])` |
| Order lock/ERP | `/api/orders/:id/lock`, `/api/orders/:id/unlock`, `/api/priority/sync/:orderId` | `requireRole('manager')` |
| Production setup/read | `/api/workers`, `/api/workers/:id`, `/api/machines`, `/api/machines/:id`, `/api/machines/:id/config`, `/api/machines/:id/state-log`, `/api/machines/oee` | reads use production/maintenance/office/manager/admin by data surface; setup writes use manager/admin |
| Production station actions | `/api/machines/:id/send-params`, `/api/machines/:id/complete`, `/api/scan`, `/api/machines/:id/end-of-day`, `/api/items/:id/status` | `requireAnyRole(['production', 'kiosk', 'manager', 'admin'])` |
| Production assignment/state | `/api/machines/:id/assign`, `/api/machines/:id/state` | assignment: `production/manager/admin`; state: `production/maintenance/manager/admin` |
| Shifts and stops | `/api/shifts`, `/api/shifts/:id/end`, `/api/machine-stops`, `/api/machine-stops/:id/end` | `production/manager/admin` or `production/maintenance/manager/admin` |
| Dashboard/KPI/reports | `/api/dashboard`, `/api/kpi/*`, `/api/reports/*`, `/api/waste/*` | read dashboards require internal roles; finance/business reports require office/finance/manager/admin |
| Alerts/search/export | `/api/alerts`, `/api/alerts/:id/resolve`, `/api/search`, `/api/export/*` | alerts/search require authenticated internal roles; exports are scoped by office/warehouse/manager/admin |
| Logistics/delivery | `/api/deliveries*`, `/api/packages*`, `/api/delivery-notes*` | delivery routes are scoped to driver/warehouse/office/manager/admin by action |
| Fleet/inventory | `/api/drivers*`, `/api/vehicles*`, `/api/suppliers*`, `/api/inventory*` | fleet and inventory routes are scoped by operational role and action |
| Quality/maintenance | `/api/quality*`, `/api/maintenance*`, `/api/incidents*`, `/api/ncr*`, `/api/capa*`, `/api/loto*`, `/api/pm-schedule*` | quality/maintenance module routes are scoped to quality/maintenance/production/office/manager/admin by action |
| Catalog/project/procurement/AI | `/api/shapes*`, `/api/companies*`, `/api/holdings`, `/api/projects*`, `/api/sites*`, `/api/priority/status`, `/api/pricing/price-books*`, `/api/steel-prices`, `/api/purchase-orders*`, `/api/ai/*` | protected by catalog, office, finance, procurement, and manager/admin policies by action |

Current guard behavior: `requireRole()` and `requireAnyRole()` require real JWT-derived `req.auth` and do not trust `x-user-role`/`x-user-id` browser headers. Route coverage is guarded by `test/route-auth-coverage.test.js`; request-level tests still need to keep expanding for every critical workflow.

## Target Role Baseline

Use the original permission matrix roles as the product baseline until the role reconciliation decision is complete:

| Role | Level | Intended scope |
| --- | ---: | --- |
| `admin` | 100 | System ownership, users, database, all modules |
| `manager` | 90 | Operational management, approvals, financial oversight |
| `office` | 70 | Orders, customers, pricing, documents, day-to-day administration |
| `production` | 50 | Production queue, machine execution, scan, shift work |
| `quality` | 50 | Incidents, NCR, CAPA, inspections |
| `maintenance` | 50 | Maintenance, LOTO, PM schedule, machine stops |
| `driver` | 30 | Deliveries, route status, delivery confirmations |
| `warehouse` | 30 | Inventory, receiving, packages, delivery notes |
| `sales` | 20 | Customer/order visibility, quotes, pricing read access |
| `viewer` | 10 | Read-only dashboards and reports |
| `kiosk` | 15 | Narrow production station actions |

Current code-only roles that need reconciliation:

- `operator`
- `finance`
- `customer`
- `supplier`

## Permission Rules

| Rule | Decision |
| --- | --- |
| Health endpoints | Public only when they reveal no sensitive data. |
| Customer portal `/api/c/*` | Customer-scoped auth, not internal role auth. |
| Auth endpoints | Public for login/refresh only; logout should require a valid refresh/access context. |
| Internal API reads | Require at least authenticated role unless explicitly public. |
| Internal API writes | Require module owner role or higher. |
| Approval, lock, cancel, pay, credit, pricing | Require manager/office/finance/admin according to final role reconciliation. |
| Database upload/download, user management, settings | Admin-only. |
| Audit log | Admin/manager read-only; no public access. |
| Exports and reports | Authenticated; finance/business exports require manager/office/finance/admin. |

## Route Family Map

| Family | Routes / module ownership | Current protection | Target access | Priority |
| --- | --- | --- | --- | --- |
| Customers | `/api/customers`, `/api/customers/:id`, `/api/customers/:id/token`, `/api/customers/:id/pricing`, `/api/customers/:id/ledger`, `/api/customers/:id/credit` | Base read/write, token/pricing, ledger/credit protected by action | Read: office/sales/manager/admin. Write/pricing/token/credit: office/manager/admin. Ledger: office/manager/admin and finance role if retained. | P0 |
| Orders | `/api/orders`, `/api/orders/:id`, `/api/orders/manual`, `/api/orders/:id/status`, `/api/orders/:id/lock`, `/api/orders/:id/unlock`, print/document routes | Read/create/manual/status/lock/unlock and main print/document routes protected | Read: office/production/sales/manager/admin. Create/update: office/manager/admin. Production status: production/manager/admin. Lock/unlock: manager/admin. | P0 |
| Order imports | `/api/order-imports/preview`, `/api/order-imports/:id/approve` | Preview and approve protected by office/manager/admin | Preview: office/manager/admin. Approve: manager/admin. | P0 |
| Image/intake AI | `/api/analyze-image`, `/api/intake/*`, `/api/bvbs/*` | Main intake parse/log/file/BVBS routes protected; WhatsApp webhook remains public for Meta verification/ingest, rate-limited, and signature-verified when `WHATSAPP_APP_SECRET` is configured | Internal auth. Approve/reject/create-order: office/manager/admin. Parse/preview: office/manager/admin. Webhooks require provider verification/signature. | P0 |
| Shapes | `/api/shapes`, `/api/shapes/seed` | Protected. Read: office/sales/production/manager/admin. Write/seed: manager/admin. | Read: authenticated internal + customer portal scoped copies. Write/seed: manager/admin. | P1 |
| Workers | `/api/workers` | Protected. Read: production/office/manager/admin. Write: manager/admin. | Production/manager/admin; writes manager/admin. | P1 |
| Machines | `/api/machines`, `/api/machines/:id/*`, `/api/scan`, `/api/machines/oee` | Protected by action. Reads: production/maintenance/office/manager/admin as appropriate. Config/delete: manager/admin. Complete/state/scan: production/kiosk/maintenance/manager/admin by action. | Production/kiosk/maintenance/manager/admin by action. Config/delete: manager/admin. Complete/state/scan: production/kiosk/manager/admin. | P0 |
| Dashboard/KPI | `/api/dashboard`, `/api/kpi/*`, `/api/reports/*`, `/api/waste/*` | Protected by route role middleware. Broad dashboard/tons KPI use `viewer` hierarchy; monthly/summary reports use office/finance/manager/admin; shift KPI uses production/office/manager/admin. | Authenticated internal. Finance/margin/business reports: manager/office/admin and finance if retained. | P1 |
| Alerts | `/api/alerts`, `/api/alerts/:id/resolve` | Protected. Read uses `viewer` hierarchy; create/resolve use office/production/maintenance/quality/manager/admin. | Authenticated internal; resolve: module owner/manager/admin. | P1 |
| Settings | `/api/settings`, `/api/settings/test/:service` | Admin-only route middleware | Admin-only. Consider manager read-only only if secrets are redacted. | P0 |
| Companies/holdings | `/api/companies`, `/api/holdings` | Protected. Companies read: office/finance/manager/admin. Company writes: manager/admin. Holdings: finance/manager/admin. | Manager/admin, with office read access if needed. | P1 |
| Drivers/fleet | `/api/drivers`, `/api/drivers/:id/*`, `/api/vehicles*` | Protected. Reads/actions are scoped to driver/warehouse/office/manager/admin; driver and vehicle management is office/manager/admin. | Driver scoped access to own operational data. Office/manager/admin manage. | P1 |
| Delivery execution | `/api/deliveries`, `/api/deliveries/:id/*` | Protected. Reads/actions are scoped to driver/warehouse/office/manager/admin by delivery state. | Driver/warehouse/office can execute; manager/admin supervise. | P1 |
| Priority ERP | `/api/priority/sync/:orderId`, `/api/priority/status` | Protected. Sync requires manager/admin. Status requires office/manager/admin. | Manager/admin for sync. Office/manager/admin for status. | P0 |
| Price books | `/api/pricing/price-books*` | Protected. Read: office/sales/finance/manager/admin. Writes: finance/manager/admin. Customer-facing price list remains customer-scoped under `/api/c/*`. | Read: office/sales/manager/admin. Writes: manager/admin. Customer-facing price list must be customer-scoped. | P0 |
| Customer portal | `/api/c/auth`, `/api/c/auth/verify`, `/api/c/me`, `/api/c/shapes`, `/api/c/price-list`, `/api/c/quote`, `/api/c/order`, `/api/c/approve/*`, `/api/c/orders/:orderId` | Customer-scoped token logic with ownership checks, dedicated rate limits, OTP verification before phone bootstrap token issue, and token expiry/revocation checks. | Customer-scoped session/token, OTP phone bootstrap, order ownership checks, rate limits. Do not use internal role fallback. | P0 |
| AI predictions | `/api/ai/*` | Protected by manager/admin pending data review. | Manager/admin by default; expose read-only predictions to office/production only after data review. | P2 |
| Suppliers | `/api/suppliers` | Protected by warehouse/office/manager/admin. | Warehouse/procurement/office/manager/admin. Supplier role only for future supplier portal, scoped to own data. | P1 |
| Inventory | `/api/inventory`, `/api/inventory/summary`, `/api/inventory/forecast` | Protected by warehouse/office/manager/admin. | Warehouse/office/manager/admin. Forecast may include business data: manager/office/admin. | P1 |
| Purchase orders | `/api/purchase-orders`, `/api/purchase-orders/:id`, `/api/purchase-orders/:id/receive` | Protected. Read: warehouse/office/finance/manager/admin. Create/receive: warehouse/office/manager/admin. Approve/status patch: finance/manager/admin. | Warehouse/procurement/office/manager/admin with finance approval where retained. | P1 |
| Audit log | `/api/audit-log` | Manager/admin route middleware | Admin/manager read-only. | P0 |
| Auth | `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/users/login` | Login is rate-limited; refresh requires a valid refresh cookie; logout now requires a refresh cookie or valid JWT; legacy `/api/users/login` returns 410. | Login/refresh public with rate limits. Logout authenticated. Deprecate or reconcile `/api/users/login`. | P0 |
| Users | `/api/users`, `/api/users/:id` | Admin-only route middleware | Admin-only. Optional manager read-only after final decision. | P0 |
| Quality | `/api/quality`, `/api/incidents`, `/api/ncr`, `/api/capa` | Protected by action. Quality checks read: quality/production/office/manager/admin; quality writes: quality/manager/admin. Incidents allow production/maintenance reporting; NCR/CAPA are quality/manager/admin with limited production read for NCR. | Quality/manager/admin. Read access to production/office only where operationally required. | P1 |
| Maintenance | `/api/maintenance`, `/api/loto`, `/api/pm-schedule`, `/api/machine-stops`, `/api/downtime-reasons` | Protected by action. Maintenance reads/stats allow maintenance/production/office/manager/admin; maintenance writes allow maintenance/production/manager/admin; LOTO/PM writes require maintenance/manager/admin. | Maintenance/production/manager/admin by action. LOTO release: maintenance/manager/admin. | P1 |
| Projects/sites | `/api/projects`, `/api/sites` | Protected. Read: office/sales/manager/admin. Write: office/manager/admin. | Office/sales/manager/admin. | P2 |
| Credit/finance | `/api/credit/*`, `/api/orders/:id/margin`, `/api/orders/:id/costs/*`, `/api/finance/*`, `/api/invoices/*`, `/api/customers/:id/ledger` | Finance/manager/admin route middleware on sensitive routes; cost lock remains manager/admin | Manager/admin plus finance. Office read access only if approved. | P0 |
| Cost snapshots | `/api/orders/:id/costs/snapshots` | Protected by finance/manager/admin. | Finance/manager/admin. | P1 |
| Shifts | `/api/shifts`, `/api/shifts/:id/end` | Protected. Read: production/office/manager/admin. Write/end: production/manager/admin. | Production/manager/admin. | P1 |
| Steel prices | `/api/steel-prices` | Protected. Read: office/sales/finance/manager/admin. Write: finance/manager/admin. | Read: office/sales/manager/admin. Write: manager/admin. | P1 |
| Packages/delivery notes/items | `/api/packages`, `/api/packages/:id/ship`, `/api/delivery-notes`, `/api/items/:id/*` | Protected by action. Packages/delivery notes use warehouse/driver/office/manager/admin; item mutations use production/warehouse/manager/admin by action. | Warehouse/driver/production/office/manager/admin by action. | P1 |
| Production queue/events | `/api/production-queue`, `/api/production-events` | Protected. Queue: production/office/manager/admin. Events: production/maintenance/manager/admin. | Production/manager/admin read; event mutation endpoints should be production/manager/admin. | P0 |
| Search | `/api/search` | Protected by `requireRole('viewer')`; result-level filtering still remains future work. | Authenticated internal with result filtering by role. | P1 |
| Export | `/api/export/orders`, `/api/export/packages`, `/api/export/inventory` | Protected. Orders export: office/manager/admin. Packages/inventory: warehouse/office/manager/admin. | Authenticated. Orders export: office/manager/admin. Packages/inventory: warehouse/office/manager/admin. | P1 |
| Admin database | `/api/admin/database/download`, `/api/admin/database/upload` | Admin-only route middleware with real JWT guard; upload also requires maintenance flag | Admin-only with real JWT enforcement, no header fallback. | P0 |
| Health | `/api/health` | Public, but no longer returns order counts or other business metrics. | Public or authenticated monitor-only, depending on deployment exposure. | P2 |

## Sprint 1 Implementation Order

1. Freeze the target role list and map current code roles to the permission matrix.
2. Keep `JWT_SECRET` configured in every deployed environment.
3. Keep `test/route-auth-coverage.test.js` green so no active `/api/*` route can be added without a guard or explicit public/scoped boundary.
4. Protect P0 families first: users, settings, admin database, finance/credit, order approvals, production queue mutations, customer portal ownership.
5. Add route-level tests for every P0 family before broad refactors.
6. Keep route families inside module-owned `routes/*.js` files; new routes require explicit permission contracts and `test/module-governance.test.js` updates.

## Acceptance Checks

- Every non-public route declares auth and role policy in code.
- Tests prove anonymous access fails for all internal P0/P1 families.
- Tests prove low-level roles cannot perform manager/admin actions.
- Customer portal tests prove OTP is required before phone bootstrap token issue, token rotate/revoke invalidates old links, unauthenticated order creation is rejected, and a customer cannot read or mutate another customer's orders.
- Settings and database routes cannot be accessed through spoofed headers.

Item correction preview uses the item-status operational role guard (production/kiosk/warehouse/office/manager/admin). Cancelling an unshipped source certificate through the status endpoint additionally requires office/manager/admin and an unchanged preview.
