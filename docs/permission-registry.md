# Permission Registry

Shared shape catalogue (2026-11-08): read through `GET /api/shape-definitions` for office/sales/production/manager/admin; create/update shared definitions and billing defaults for manager/admin, matching existing catalogue management access. Version conflicts cannot silently overwrite another editor's changes. Public/customer sessions do not gain catalogue-management access. Saving errors remain visible in the editor; local storage is not used as a success fallback for a failed shared save.

Built-in revision endpoint `PUT /api/shape-definitions/builtin/:id` uses the same manager/admin restriction. The GET response reports `permissions.canManage` for the edit/save/configuration controls; UI controls default to hidden when permission is unknown or loading fails. Normal order dimension entry remains available to authorized order operators.

Working role decision: see `docs/role-model-decision.md`.

Source-of-truth registry required by Volume 10. Current roles are defined in
`permissions.js`; guarded routes now require JWT-derived roles. There is no
global auth enforcement switch: each active `/api/*` route must declare a role
guard, custom authorization middleware, scoped public boundary, or explicit
allowlist entry, and `test/route-auth-coverage.test.js` enforces that contract.

## Source Permission Matrix

The original `IronBend_Permission_Matrix.docx` defines 11 target roles, 48
operations, and 20 screens. It also explicitly warns that the current
implementation checks `x-user-role` only and does not yet enforce JWT.

| Role | Source Level | Intended Use |
| --- | ---: | --- |
| `admin` | 100 | Full system administration, users, DB, settings. |
| `manager` | 90 | Operations management, orders, customers, machines, reports, credit. |
| `office` | 70 | Orders, customers, invoices, deliveries; no financial reports/costs. |
| `production` | 50 | Production queue, item status, shifts, stops. |
| `quality` | 50 | QC, NCR, CAPA, LOTO, incidents; order read access. |
| `maintenance` | 50 | Maintenance log, PM, LOTO creation, incidents, machine read. |
| `driver` | 30 | Own deliveries, GPS, delivery status, signature. |
| `warehouse` | 30 | Packages and inventory; no orders/customers. |
| `sales` | 20 | Read-only customers, orders, price list. |
| `viewer` | 10 | Read-only dashboard and orders. |
| `kiosk` | 15 | Workstation only: barcode scan and item status; no business data. |

## Current Code Roles

`server.js` currently defines a different role model:

- `admin`
- `manager`
- `production`
- `operator`
- `quality`
- `warehouse`
- `driver`
- `finance`
- `maintenance`
- `customer`
- `supplier`

Current roles are therefore not yet aligned with the source permission matrix.
Do not build new permissions on the current role list until Sprint 1 reconciles
the target role model.

## Current Permission Flags

The code currently models role capability mostly through:

- `level`
- `canApprove`
- `canDelete`
- `finance`
- `config`

This is too coarse for the specification. It cannot express context such as
"manager may override production block with reason code" or "warehouse can
receive material but cannot see margin".

## Required Permission Domains

| Domain | Example Permissions |
| --- | --- |
| Platform | manage users, manage settings, view audit, database backup/restore. |
| Orders | create order, approve order, edit locked order, change status, import orders. |
| Production | assign machine, start job, pause job, complete job, override block. |
| Inventory | receive material, adjust stock, reserve material, view supplier costs. |
| Delivery | create package, ship package, confirm delivery, update driver route. |
| Finance | view price, edit price, view margin, lock cost, approve credit, issue invoice. |
| Quality | create NCR, close NCR, create CAPA, approve quality release. |
| Maintenance | create LOTO, release LOTO, schedule PM, close maintenance task. |
| Portals | customer order create, customer approve, supplier confirm, driver confirm. |

## P0 Security Rules

1. No privileged endpoint may trust `x-user-role`.
2. `/api/users*` must be `admin` only.
3. `/api/settings*` must be `admin` only.
4. `/api/admin/database/*` must be `admin` only and disabled unless maintenance
   flags permit dangerous operations.
5. Finance endpoints must require `finance` or `manager`.
6. Order status changes must require an authenticated role allowed by the state
   transition.
7. Shop-floor screens need a deliberate auth mode for sold deployments.

## Sprint 1 Permission Deliverables

1. Decide whether `finance` remains a separate internal role or maps to
   `manager`/`office` with finance-specific permissions.
2. Decide whether current `operator` maps to `kiosk`, `production`, or both by
   screen context.
3. Treat `customer` and `supplier` as external portal identities, not internal
   staff roles, unless the product owner explicitly decides otherwise.
4. Replace coarse fallback role logic with verified JWT identity.
5. Add route-level tests for anonymous, wrong-role, and allowed-role cases.
6. Produce a route permission table from `api-registry.md`.
7. Decide kiosk/worker/driver/customer external auth modes.
8. Keep `AUTH_BYPASS` disabled in staging/production and verify anonymous
   protected-route requests return 401 before every release.
