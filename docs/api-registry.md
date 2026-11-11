# API Registry

Shared editor drafts (2026-11-11): Orders owns GET
`/api/operations/editor-drafts?before=<id>`, PUT
`/api/operations/editor-drafts/:id`, POST
`/api/operations/editor-drafts/:id/close`. Existing JWT office/manager/admin only;
versioned full editor snapshots, 200-record pagination, 2 MB/1000-item bound,
soft closure, audit and `editor_draft_updated`. No order or inventory creation.
Details: `docs/editor-drafts-recovery-20261111.md`.

Orders creation default (2026-11-11): the canonical `services/orders.js` creation
service resolves missing/null/blank `order.deliveryDate` (or `delivery_date`) to
today + two calendar days in Asia/Jerusalem. An explicit date remains explicit.
This affects new customer orders through existing creation callers only, not
historical rows or date edits. No new route/permission/schema; existing order
transaction, audit and new_order event remain unchanged. The immediate manual
machine-job route retains its deliberate current-day operational semantics.

2026-11-11 — Inventory: `GET /api/inventory/cutting-stock?order_ids=1,2` is a
read-only approved straight-lot projection for cutting. Access: warehouse,
office, manager, admin. Optional comma-separated positive safe integer order IDs
(max 500); malformed IDs return 400. Returns current physical kg, other orders'
remaining confirmed lot allocations, available kg, recorded nominal length,
canonical kg/m and calculated whole bars using Inventory `barEstimate`. Missing
length produces null count, never a guessed length. No prices or writes; no
audit/event is emitted for this read. All eligible lots form one planning snapshot.

Orders: mixed-customer `POST /api/operations/delivery-notes` retains the existing
block and now returns 409 with `לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים`.
Existing customer/company/destination, quantity and approval checks remain.

Order creation material-source contract (2026-11-10): `POST /api/orders` accepts the existing client `items[].raw_material_id: 'auto'` sentinel. Inventory reservation persists null for automatic source selection, retaining FIFO choice at completion. A valid explicit lot ID is preserved; an invalid/missing explicit lot returns HTTP 400 with a readable message, and the entire order transaction rolls back. Saving reserves demand without consuming physical stock.

`GET /api/inventory/metrics` (Inventory, 2026-11-09): warehouse/office/manager/admin; read-only stocktake-period journal/control report. Returns stocked_lots, stocked_diameters, baseline{id,counted_at,created_at}, recorded_net_kg (null without baseline), verified_consumption_kg (null; actual use is not inferred), status (no_baseline/needs_reconciliation/recorded_only), issues, historical counters and legacy coverage diagnostics. Uses approval time as the explicit period boundary. Existing inventory/summary response remains unchanged.

## Shared shape definitions — 2026-11-08

Owner: Orders / Catalog. `routes/catalog.js` delegates persistence to `services/savedShapeCatalog.js`.

| Route | Access | Contract |
| --- | --- | --- |
| `GET /api/shape-definitions` | office, sales, production, manager, admin | `{entries:[{id,itemCode,name,version,definition,billingPolicy}],permissions:{canManage}}`; active definitions. Trusted definition.builtinPresetId replaces the corresponding built-in template. Local legacy templates are labelled separately. |
| `POST /api/shape-definitions` | manager, admin | Name, unique itemCode (1–40 ASCII digits), family definition and explicit billingPolicy. Built-in SKUs 1–20 reserved; leading zeros retained. 201 saved, 400 invalid, 409 duplicate. |
| `PUT /api/shape-definitions/builtin/:id` | manager, admin | Revise a whitelisted built-in ID with expectedVersion=1 on first edit (creates version 2). Later edits enforce stored version. Server assigns builtinPresetId; client cannot forge it. Legacy rows and existing order snapshots are retained. |
| `PUT /api/shape-definitions/:id` | manager, admin | Same fields plus expectedVersion. Optimistic version check, 409 on stale write, increments version. Existing order snapshots remain unchanged. |

`GET /shapeCommercial.js` serves the same pure rules used by commercial summaries. It contains no prices or private data. Legacy `POST /api/shapes` cannot overwrite a shared definition.

Source-of-truth registry required by Volume 10. Active API routes are implemented
in `routes/*.js`, with only `/api/health` intentionally remaining in `server.js`;
this file assigns each route family to a module and records security posture.

The original `IronBend_API_Registry.docx` defines 149 endpoints across 34 API
groups. This markdown registry is grouped by product module for agent ownership;
the original 34 group names should be preserved as aliases during the route by
route reconciliation.

Original API groups:

Customers, Orders, Shapes, Machines, Scan, Dashboard & KPIs, Alerts, Settings,
Companies, Drivers & Deliveries, Priority ERP, Intake AI, Suppliers, Inventory,
Audit Log, Users, Quality, Maintenance, Projects & Sites, Credit & Finance,
Shifts, Steel Prices, Packages, Delivery Notes, Production Queue, Invoices, CSV
Export, BVBS Parser, Search, Reports, Admin, Health, Customer Portal, Price List.

Security posture values:

- `public`: intentionally public.
- `auth-required`: must have authenticated user.
- `role-required`: must require a named role.
- `portal`: external user/session/token model.
- `unsafe-current`: currently not safe enough for production.

## Platform Core

Orders owns `/api/operations/*` in `routes/orders.js`: authenticated proposal, versioned approval, selected-order delivery preview, immutable consolidated issuance/reprint and guarded cancellation. `scripts/order-operations-client.js` uses an existing user Bearer JWT; it creates no agent credential. Preview never issues a document; only an explicit POST approval mutates business records.

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/auth/login` | Platform Core | public with rate limit | Present. |
| `/api/auth/refresh` | Platform Core | refresh cookie | Present. |
| `/api/auth/logout` | Platform Core | refresh cookie | Present. |
| `/api/users*` | Platform Core | role-required: admin | Protected by JWT-derived `req.auth`; covered by security tests. |
| `/api/settings*` | Platform Core | role-required: admin | Protected by JWT-derived `req.auth`; external service tests remain admin-only. |
| `/api/settings/test/:service` | Platform Core | role-required: admin | Can touch external services/secrets. |
| `/api/audit-log` | Platform Core | role-required: manager/admin | Audit visibility should be permissioned. |
| `/api/search` | Platform Core | auth-required | Cross-module data exposure risk. |
| `/api/admin/database/download` | Platform Core | role-required: admin | Protected by real JWT roles; remains critical because it exposes the active DB. |
| `/api/admin/database/upload` | Platform Core | role-required: admin + maintenance flag | Protected by real JWT roles plus upload-specific safety gates. |
| `/api/health` | Platform Core | public | Keep minimal. |

## Vendor Control And Remote Support

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/vendor/sites*` | Vendor Control | vendor-admin only | Future route. Must expose technical/site metadata, not customer business data by default. |
| `/api/vendor/sites/:id/health` | Vendor Control | vendor-admin only | Future route. Shows online/offline, installed version, backup age, integration health, and module status. |
| `/api/vendor/sites/:id/modules` | Vendor Control | vendor-admin only | Future route. License and enablement status per sellable module. |
| `/api/vendor/sites/:id/support-session` | Vendor Control | customer-approved + vendor-admin | Future route. Time-limited support access, read-only by default, full audit trail. |
| `/api/vendor/sites/:id/version` | Vendor Control | vendor-admin + customer approval for writes | Future route. Update visibility and controlled rollout. |
| `/api/vendor/sites/:id/backups` | Vendor Control | vendor-admin + customer approval for restore | Future route. Backup status can be visible; restore must require approval. |

## Orders

`PATCH /api/orders/:id` accepts `{priority,expected_priority}` as a guarded
scheduling-only change for office/manager/admin. This records a priority audit
and emits `order_updated`; it does not edit production, allocations or inventory.
The existing full header-edit contract and production correction permissions
remain unchanged for other payloads. A stale expected priority returns 409.

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/customers*` | Orders / CRM | auth-required; writes office/manager/admin | Protected; still needs CRM vs portal-token ownership cleanup. |
| `/api/orders*` | Orders | auth-required; writes role-gated | Protected; keep expanding workflow-specific tests. |
| `/api/orders/:id/status-correction-preview` | Orders | office/production/manager/admin | Read-only, no-store preview of item rollback, active loading and certificate choices; fingerprint guards the existing status PATCH. |
| `/api/order-imports/*` | Orders | role-required: office/manager/admin | Protected; approval changes production data and must remain audited. |
| `/api/items*` | Orders / Production | auth-required; writes role-gated | Protected; shared ownership with Production still needs clean module boundary. |
| `/api/shapes*` | Catalog | auth-required; writes manager/admin | Protected; shape library is product catalog data, not order workflow ownership. |
| `/api/intake/*` | Orders | role-required by action | Protected except public WhatsApp provider boundary; OCR/approval still needs compare-and-approve UX. |
| `/api/bvbs/*` | Orders | role-required: office/manager/admin | Protected import parser/order creation. |
| `/api/priority/*` | Orders / Integrations | role-required: office/manager/admin by action | Protected; integration still feature/ops-policy sensitive. |

## Production

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/production-queue` | Production | auth-required | Should be the only production queue source. |
| `/api/production-events` | Production | auth-required | Event reader contract needed. |
| `/api/machines*` | Production | auth-required; config admin/manager | Config/assignment/state writes are critical. |
| `/api/workers*` | Production | auth-required | Protected; worker identity model still needs final product policy. |
| `/api/scan` | Production | role-required: production/kiosk/manager/admin | Protected; kiosk/device auth policy still needs hardening for sold deployments. |
| `/api/shifts*` | Production | auth-required | Needs state machine/audit. |
| `/api/downtime-reasons` | Production | auth-required | Read low risk; writes absent currently. |
| `/api/machine-stops*` | Production | auth-required | Operational event; needs audit. |
| `/api/kpi/tons-today`, `/api/kpi/shift-summary` | Production | auth-required | Dashboard data. |
| `/api/machines/oee` | Production | auth-required | Dashboard/reporting. |

## Inventory, Procurement, Delivery

Inventory count and daily purchase planning contracts (2026-11-08):
`/api/inventory/stocktakes*` is preview/read for warehouse and manager/admin approval;
`/api/inventory/mesh*` owns exact-spec sheet stock, pending receipts and sheet counts;
`/api/inventory/consumption/retry` is manager/admin-only for completed items.
`/api/procurement/plan` is read-only planning; `/api/procurement/purchase-draft/export`
is warehouse/office/manager/admin CSV export and does not create a purchase order or stock.
See `inventory-accounting-20261108.md` for quantities, cutoff and replay contracts.
  Straight-bar planning now includes nominal length and estimated physical bar
  counts, with no cross-length coverage; see `inventory-length-separation-20261111.md`.

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/suppliers*` | Procurement | auth-required; writes manager | Supplier master data; inventory may read it only as a dependency for receiving. |
| `/api/inventory*` | Inventory | auth-required; writes warehouse/manager | Stock changes must be audited. |
| `/api/steel-prices*` | Procurement / Finance | role-required: finance/manager | Purchase price history; impacts pricing/costing. |
| `/api/purchase-orders*` | Procurement | role-required: procurement/manager | Supplier purchase workflow. |
| `/api/vehicles*` | Fleet Management | auth-required; writes office/manager/admin | Vehicle asset records, service events, expenses/income, and vehicle documents. Must stay separate from driver identity. |
| `/api/drivers*` | Delivery / Fleet Management | auth-required; writes dispatch/manager | Driver identity and assignment; driver portal split needed. Vehicle documents/history belong to `/api/vehicles*`. |
| `/api/deliveries*` | Delivery | auth-required or driver portal | Delivery state changes need auth/audit. |
| `/api/packages*` | Delivery | auth-required | Package/order status coupling risk. |
| `/api/delivery-notes*` | Delivery | auth-required | Document issuance. |

## Catalog

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/shapes*` | Catalog | auth-required; writes manager/admin | Product shape catalog source of truth. |
| `/api/pricing/price-books*` | Catalog / Pricing | role-required: finance/manager/admin for writes | Sensitive commercial pricing; portal reads only scoped copy under `/api/c/price-list`. |

## Finance

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/orders/:id/margin` | Finance | role-required: finance/manager | Sensitive profitability. |
| `/api/orders/:id/costs*` | Finance | role-required: finance/manager | Some role checks exist. |
| `/api/customers/:id/ledger` | Finance | role-required: finance/manager | Sensitive account data. |
| `/api/customers/:id/credit` | Finance | role-required: manager | Some role check exists. |
| `/api/credit*` | Finance | role-required: finance/manager | Credit changes sensitive. |
| `/api/invoices*` | Finance | role-required: finance | Financial state changes. |
| `/api/finance/*` | Finance | role-required: finance/manager | Sensitive KPIs/events. |
| `/api/export/orders`, `/api/export/inventory`, `/api/export/packages` | Reporting | role-required by data type | Exports can leak data. |

## Quality, Maintenance, War Room

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/quality*` | Quality | auth-required | Quality writes need audit. |
| `/api/maintenance*` | Maintenance | auth-required | Stub/partial screen. |
| `/api/incidents*` | War Room | auth-required | Incident workflow needs state model. |
| `/api/ncr*` | Quality | auth-required | NCR state machine needed. |
| `/api/capa*` | Quality | auth-required | CAPA state machine needed. |
| `/api/loto*` | Maintenance / Safety | role-required: maintenance/manager | Safety-critical. |
| `/api/pm-schedule*` | Maintenance | auth-required | Prevent unauthorized maintenance scheduling. |

## External Portals And AI

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/c/*` | Portals | customer-scoped token + OTP bootstrap | Customer ownership, OTP bootstrap, rate limits, and token expiry/revocation are implemented; browser smoke tests remain. |
| `/api/customers/:id/token` | Portals / Admin | role-required: office/manager/admin | Generates customer access link with expiry metadata. |
| `/api/customers/:id/token/rotate` | Portals / Admin | role-required: office/manager/admin | Rotates customer access link and invalidates the previous token. |
| `/api/customers/:id/token` DELETE | Portals / Admin | role-required: office/manager/admin | Revokes customer portal access link. |
| `/api/ai/*` | AI | role-required + feature flag | Keep frozen until governance/data confidence exists. |
| `/api/analyze-image` | Orders / AI | custom image authorization + rate limit | Protected by JWT-derived roles; still depends on configured AI billing/API key. |

## Sprint 1 Security Targets

1. Keep `test/route-auth-coverage.test.js` green so new `/api/*` routes cannot be added without a guard or explicit public/scoped boundary.
2. Keep request-level security tests expanding for high-risk workflows, not just route families.
3. Keep local/prod server startup paths aligned so old copies cannot run on `localhost:3100`.
4. Add stable `JWT_SECRET` deployment requirement for every production/staging environment.
5. Keep route families in module-owned `routes/*.js` files, and require an explicit permission contract before adding any new route.

## Item status correction (2026-10-21)

`GET /api/items/:id/status-correction-preview` belongs to Production; production/kiosk/warehouse/office/manager/admin can inspect. `PATCH /api/items/:id/status` accepts a stale-state preview and an explicit unshipped-certificate cancellation mode, restricted to office/manager/admin. See [contract](item-status-correction.md).
<!-- Procurement draft supplier units, 2026-11-08: POST /api/procurement/purchase-draft/export
accepts explicit per-line purchase_unit (coil/bundle/sheet/kg), unit_weight_kg and optional
shortage_kg. Edited quantity/unit are exported directly; estimated_weight_kg is computed
on the server. Omitting purchase_unit retains legacy kg/sheet semantics. No DB writes. -->

Procurement plan: `stock_basis=available|physical` defaults to available and adds
read-only `purchase_policy` with 10000/30000/30000 kg thresholds per supply form.
Supplier-unit draft export with `enforce_supplier_policy:true` rejects mixed forms,
coil/straight orders below 30000 estimated kg and straight-package rows without
`length_m`. Other diameters may complete the minimum without mixing supply forms.


## Shared Hebrew error presentation (2026-11-10)

Platform Core adds `user_message` to JSON error objects without changing raw
`error`, `code` or status. Request IDs identify internal failures. Parser errors
also use JSON. Diagnostic details can identify affected item sequences and lots.
See [contract and handoff](hebrew-system-messages-20261110.md).

## Reversible shape catalogue management (2026-11-10)

Orders owns POST `/api/shape-definitions/builtin/:id/archive`, POST
`/api/shape-definitions/:id/archive` and POST `/api/shape-definitions/:id/restore`.
All require manager/admin and `expectedVersion`. GET returns `hiddenBuiltinIds`
and manager-only `archived` metadata. Existing create/update and lifecycle changes
record catalogue audit events. No rows or historical snapshots are deleted.
See [handoff](shape-catalog-management-20261110.md).
<!-- Product trait recognition, 2026-11-10: GET /api/shape-definitions now also
returns entries[].recognitionTraits derived from the saved numeric geometry.
Existing manager/admin create/update calls accept definition.recognitionRules
(version=1; boolean enabled/allowReverse/allowMirror). Existing role/version/audit
checks remain. /shapeRecognition.js exposes the same pure, non-mutating matcher.
See product-trait-recognition-20261110.md. -->
