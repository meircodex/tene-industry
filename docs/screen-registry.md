# Screen Registry

Worker portal (2026-11-15): `/worker-portal.html`, personal credentials, he/en/th via gear only, home/scan/card/status with no machine controls. Provisioning under Admin > Workers & QR. Ownership and tests: `docs/worker-portal-20261115.md`.

Source-of-truth registry required by Volume 10. Every screen must have one
module owner, one purpose, one auth mode, and one status. Screens not listed here
must not be expanded until they are registered.

Status values:

- `active`: used by the current product.
- `partial`: exists but needs module cleanup or consistency work.
- `stub`: visible/implemented as placeholder or coming soon.
- `external`: user outside the internal staff context.
- `shared`: platform-level screen or asset.

## Internal Platform

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `login.html` | Platform Core | active | public login | Uses `/api/auth/login`; comment still says demo but calls real endpoint. |
| `admin.html` | Platform Core | partial | internal admin | Mixed responsibilities: settings, users, DB, intake, machines, drivers, prices. Needs splitting by module. |
| `help.html` | Platform Core | shared | internal | Does not currently load shared nav/auth in inventory check. |
| `offline.html` | Platform Core | shared | public/offline | PWA fallback. |

## Dashboard And Reporting

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `dashboard.html` | Dashboard | partial | internal | Cross-module operational overview; must read module APIs and not own module business logic. |
| `reports.html` | Reports | partial | internal | API-backed reporting screen with auth/safe helpers and smoke coverage; read-only ownership, still needs role-specific report visibility policy. |
| `holdings.html` | Companies | partial | internal | Company/holding overview. |
| `docs.html` | Platform Core | partial | internal | Project documentation surface. |

## Orders

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `orders.html` | Orders | partial | internal | Core order list/detail; unsafe rendering risk; needs shared status model. |
| `index.html` | Orders | partial | internal | Order creation/intake screen. Confirm role and future placement. |
| `customers.html` | Customers | partial | internal | Internal customer CRM only; portal token admin remains a separate portal/admin flow. |

## Production

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `production-queue.html` | Production | active | internal production | Should be production queue source of truth. |
| `machine.html` | Production | partial | internal production | Machine assignment/state. Needs state contract. |
| `kiosk.html` | Production | partial | shop-floor auth TBD | Does not load shared nav in inventory check; needs auth decision. |
| `worker.html` | Production | partial | shop-floor auth TBD | Very small wrapper/entry point. |
| `worker-visual.html` | Production | active | existing production QR/card scope | Original scan and completion; optional Machine Integration parameter mirror and same-action recipe confirmation. No new worker screen. |

## Inventory, Procurement, Delivery

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `inventory.html` | Inventory | partial | internal warehouse | API-backed raw material inventory and receiving/OCR. Supplier management moved to Procurement; inventory only references suppliers during receiving. |
| `warehouse.html` | Warehouse | partial | internal warehouse | API-backed packages/loading; must stay outbound only and not own raw-material receiving. |
| `procurement.html` | Procurement | partial | internal procurement | API-backed MVP for suppliers, purchase orders, and steel purchase prices; still needs full workflow policy and supplier portal separation. |
| `delivery-admin.html` | Fleet Management | partial | internal logistics/manager | Internal fleet asset module: vehicles, assigned drivers, service/test/insurance tracking, events, expenses/income, and vehicle documents. Must remain separate from the external driver portal. |
| `driver.html` | Driver Portal | partial | internal driver/auth TBD | Loads shared auth/nav and aligns with delivery statuses; still needs dedicated external driver auth model before commercial portal use. |

## Finance, Quality, Maintenance

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `finance.html` | Finance | partial | finance/manager | Sensitive finance workspace with auth/safe helpers; price list and cost tools API-backed, still needs role-specific finance visibility policy. |
| `projects.html` | Projects | partial | internal office/sales | API-backed projects/sites MVP; finance credit workflow removed back to Finance ownership. |
| `quality.html` | Quality | partial | internal quality | API-backed quality checks and NCR/CAPA MVP; local demo fallbacks removed, still needs workflow state policy before commercial release. |
| `maintenance.html` | Maintenance | partial | internal maintenance | API-backed maintenance/LOTO/PM screen; mock fallbacks removed, still needs workflow policy and navigation/role polish before commercial release. |
| `warroom.html` | War Room | partial | internal quality/maintenance | Cross-module incident/machine monitor; reads Quality and Maintenance APIs, but does not own either workflow. |

## External Portals

| Screen | Module Owner | Status | Auth Mode | Notes |
| --- | --- | --- | --- | --- |
| `customer.html` | Portals | external partial | portal token / phone currently | Active customer portal; ownership tests cover order detail/approval. Phone bootstrap still needs OTP/token lifecycle hardening. |
| `portal.html` | Portals | deprecated | no internal API lookup | Deprecated until rebuilt on a scoped public endpoint or removed. |
| `supplier.html` | Portals | frozen | supplier portal TBD | Demo supplier data removed; frozen until supplier auth and external purchase-order contract are defined. |

## Screen Rebuild Order

1. `login.html`, `admin.html` auth/user/settings surfaces.
2. `dashboard.html` queue and KPI consistency.
3. `orders.html` status/source-of-truth and safe rendering.
4. `production-queue.html`, `machine.html`, `kiosk.html`, `worker-visual.html`.
5. `inventory.html`, `warehouse.html`.
6. `customer.html`, `portal.html`, `supplier.html`, `driver.html`.
7. `finance.html`.
8. `quality.html`, `maintenance.html`, `warroom.html`.
