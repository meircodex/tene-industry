# API Registry

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

| Route Family | Module | Expected Security | Current Concern |
| --- | --- | --- | --- |
| `/api/customers*` | Orders / CRM | auth-required; writes office/manager/admin | Protected; still needs CRM vs portal-token ownership cleanup. |
| `/api/orders*` | Orders | auth-required; writes role-gated | Protected; keep expanding workflow-specific tests. |
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
