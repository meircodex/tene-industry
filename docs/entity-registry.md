# Entity Registry

`direct_order_drafts` (Orders, 2026-11-11) also stores complete shape-editor UI
snapshots under source `new-order-editor-v2`. `external_id` is the client draft
ID, `version` guards concurrent writes, and `submitted`/`deleted` retain payload
as cross-browser closure tombstones. These rows never represent production orders.

## Shared shape catalogue extension — 2026-11-08

Owner: Orders / Catalog. Additive D2 columns on `shapes`: `item_code` (unique, case-insensitive text; leading zeros retained), `definition_json` (complete editor family payload), `billing_json` (policy version 1), `definition_version` (optimistic update counter). Null definition marks legacy rows; no automatic conversion or deletion occurs. Quantity, order identity and element name are excluded from a reusable definition.

Order `shape_snapshot_json` optionally carries `catalogIdentity:{source,id,itemCode,name,version}` and `billingPolicy:{version:1,lines,cuttingMode}`. The snapshot owns the policy used by that order, independently of later catalogue revisions. Unchanged historical records without policy retain legacy classification. The pure rules live in `modules/steel-rebar/shape-commercial.js`.

There is exactly one material/finished-product kg basis per policy. Cutting/bending kg and unit additions overlap commercially without adding their kg again to material/shipment weight. Smooth steel resolves to a separate material row. The existing monetary pricer still calculates material prices; policy exposes charge quantities and does not invent processing rates.

Source-of-truth registry required by Volume 10. Current entities are inferred
from SQLite table creation in `server.js` and `auth-core.js`. This registry is
the first planning-level ownership map; it is not yet a full schema dictionary.

The original `IronBend_Entity_Registry.docx` defines 46 business entities. This
markdown registry includes those entities plus implementation extensions found
in the current codebase, such as auth/session and import-staging tables.

## Platform Core

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `users` | Platform Core | Contains legacy `pin` plus `pin_hash`; migration/enforcement incomplete. |
| `refresh_tokens` | Platform Core | Implementation extension. Created by `auth-core.js`; rotating refresh token storage. |
| `settings` | Platform Core | Stores service configuration/secrets; admin-only. |
| `audit_log` | Platform Core | Partial audit trail; should become universal important-action ledger. |
| `alerts` | Platform Core / Dashboard | Global alerts and contextual alerts. |
| `companies` | Platform Core / Multi-tenant | Current company/holding basis; future tenant boundary. |

## Orders

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `customers` | Orders / CRM | Internal customer record; portal token currently stored here. |
| `orders` | Orders | Core order lifecycle. |
| `pallets` | Orders | Order grouping/package planning structure. |
| `items` | Orders / Production | Shared: order item and production unit. Needs clear contract. |
| `shapes` | Orders | Rebar shape library. |
| `order_imports` | Orders | Implementation extension. Staging import previews. |
| `intake_log` | Orders | WhatsApp/email/OCR intake queue. |
| `intake_training_examples` | Orders / AI | Implementation extension. OCR/parser training examples. |
| `projects` | Orders / Finance | Project/site domain. Stub/partial. |
| `sites` | Orders / Delivery | Delivery sites under projects/customers. |

## Production

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `machines` | Production | Machine config and live-ish state. |
| `workers` | Production | Internal worker/operator list. |
| `scan_log` | Production | Scan events. |
| `shifts` | Production | Shift lifecycle. |
| `downtime_reasons` | Production | Reason catalog. |
| `machine_stops` | Production | Stop events. |
| `production_events` | Production | Production event history. |
| `machine_state_log` | Production | Machine state transitions. |

## Inventory And Procurement

Inventory also owns `inventory_stocktakes`, `inventory_stocktake_lines`,
`inventory_item_completion_policy`, `inventory_count_completed_items`,
`inventory_item_completion_state`, `inventory_item_completion_events`,
`inventory_item_consumption_overrides`,
`inventory_completion_consumptions`, `inventory_mesh_stock`, `inventory_mesh_receipts`,
`inventory_mesh_demands`, and `inventory_mesh_movements`. Kg adjustments are additive
to historical receipts/use/scrap. Mesh stock and its movements are whole sheets.

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `suppliers` | Procurement | Supplier master data. Inventory may reference suppliers for receiving, but does not own supplier management. |
| `raw_material` | Inventory | Material batches/stock. |
| `raw_material_usage` | Inventory / Production | Material consumption. |
| `steel_price_history` | Procurement / Finance | Purchase price tracking. |
| `steel_prices` | Finance / Inventory | Financial steel price table. |
| `purchase_orders` | Procurement | Procurement module partial/stub. |

## Delivery

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `drivers` | Delivery | Driver master data and location. |
| `deliveries` | Delivery | Delivery lifecycle. |
| `packages` | Delivery | Package/shipment grouping. |
| `delivery_notes` | Delivery | Delivery note documents. |

## Finance

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `pricing_price_books` | Finance / Pricing | Price book header, customer binding, status, and terms. |
| `pricing_price_items` | Finance / Pricing | Price book SKU/diameter rows. |
| `credit_accounts` | Finance | Credit control model. |
| `credit_transactions` | Finance | Credit transaction ledger. |
| `invoices` | Finance | Invoice state. |
| `order_costs` | Finance | Calculated order costs. |
| `cost_snapshots` | Finance | Cost history snapshots. |
| `customer_credit` | Finance | Customer ledger/analytics; overlaps with credit accounts. |
| `financial_events` | Finance | Financial event stream. |

## Quality, Maintenance, Safety

| Entity/Table | Owner Module | Notes |
| --- | --- | --- |
| `quality_checks` | Quality | Item/order quality checks. |
| `maintenance_logs` | Maintenance | Maintenance activity. |
| `incidents` | War Room | Incident management. |
| `ncr` | Quality | Non-conformance records. |
| `capa` | Quality | Corrective/preventive actions. |
| `loto` | Maintenance / Safety | Lockout-tagout safety records. |
| `pm_schedule` | Maintenance | Preventive maintenance schedule. |

## Entity Cleanup Decisions Needed

1. Decide whether `credit_accounts` or `customer_credit` is authoritative for
   credit limit/payment terms.
2. Define whether `items` belongs primarily to Orders or Production and what
   fields each module may mutate.
3. Move portal access out of `customers.portal_token` or harden its lifecycle.
4. Define tenant/company boundary before selling to multiple customers.
5. Replace schema-on-startup changes with a migration framework before serious
   commercial deployments.
