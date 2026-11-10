# Widget Data Contracts

Order material-source selector (2026-11-10): automatic selection remains the existing string `auto` in new-order drafts/payloads; the server normalizes it to a null preferred lot reference. Explicit lot selection retains its numeric identity. Order save reserves demand; it does not deduct physical inventory. Failed transaction leaves the draft available for retry and commits no partial order. See `docs/order-auto-material-fk-20261110.md`.

## Inventory consumption evidence — 2026-11-09

Owner: Inventory; `inventoryConsumptionEvidence` contract. `/api/inventory/metrics` replaces the unbounded historic usage counter on the main screen. `kpiUsed` shows recorded net kg since the stated stocktake approval only when reporting checks pass; otherwise „לא מאומת”. Journal zero is never described as proof of zero actual production. Missing baseline or failed request cannot fall back to history or zero. Source events: production_completion usage plus signed V2 consumption/reversals. Reservations and stocktake adjustments are excluded. Detail text exposes legacy coverage gaps. `kpiBatches` and `kpiDiam` count only positive-balance, active, approved lot records, not packages or coils.

**Superseded by the user's final clarification on 2026-11-09:** the count supplied by the user is the authoritative opening stock. Main screen now shows only current stock and diameters with positive stock, plus an explicit stocktake basis date and balance definition (`inventoryStockBasis`). Consumption, lot-record counts and „לא מאומת” explanations are removed from the main screen. The diagnostic /inventory/metrics API and research evidence remain internal/read-only and are not called by that screen. A failed basis-date lookup does not invalidate a successful balance read; a failed balance read shows unavailable rather than zero.

## Shape catalogue and billing bases — 2026-11-08

Owner: Orders. Definition: `shapeCatalogueBilling` in `public/data-contracts-client.js`.

- The code field selects on Enter. Focus, typing and ArrowDown do not open the catalogue. Only the adjacent arrow button opens a fixed-position floating panel. Escape, outside click and selection close it without moving the editor layout.
- SKUs contain digits only, independently of legacy internal IDs. Preview thumbnails are generated from the actual template geometry. Explicit selection loads the template dimensions; editing order lengths keeps its topology. Overlap handling never changes vertices or invents hooks; labels identify coincident sides and fit inside the viewport.
- Overlapping sides use a darker stroke, matching labelled dimension borders and input outlines. Leader annotations connect side midpoints to their value windows. Selecting a window focuses its side input and darkens the matching link; the drawing coordinates are preserved.
- Clarification: body coloring applies only to the exact shared interval, shown as orange over a wider dark base so two layers remain visible. The nonshared remainder stays blue; participating sides are not darkened over their full lengths. This applies in both 2D and projected 3D.
- `permissions.canManage` controls catalogue-edit/save controls and billing configuration. Manager/admin may explicitly edit built-in or shared definitions, including topology, name, numeric SKU and charge bases. The server enforces the same roles and expected revision. An override replaces its built-in choice without duplicating it; existing orders retain their original snapshots.
- Built-in and saved bar templates expose exactly their configured side count; Enter/Tab go through lengths, diameter and quantity. Geometry stays proportional. New shape mode retains add-side/angle and real 3D authoring.
- `seBillingBasis` resolves material by ribbed/smooth steel, processing by total item kg and additions by item quantity. Lifts use whole-line weighed kg without multiplying by package quantity. Expanded settings allow explicit cutting conditions and processing/unit choices. Saving a shared definition requires its name and unique code.
- Approved snapshot stores the exact policy and catalogue revision. Orders, the order summary, A4 and delivery certificate read the saved policy. Renaming a hoop does not turn it into a chair. Changing catalogue defaults affects future selections, not prior order snapshots.
- Charge bases contain no monetary amounts. Delivery certificate remains price-free. Existing pricer reports `pricingScope: material_only`; mapping all processing lines to monetary tariffs is separate work.
- The internal catalogue API requires staff authentication. In the customer portal or during a connection failure the editor reports shared-catalogue unavailability; built-in and explicitly labelled device-local legacy choices remain usable. Failed server save is never reported as shared success.

Every KPI, icon, badge, chart, and operational widget that displays business
data must have a data contract.

The contract answers:

- where the data comes from,
- which API fields are consumed,
- what the number actually means,
- which screen elements read it,
- who owns it,
- how risky the value is if it becomes wrong.

## Current Registry

`shapeSideDimensions` keeps each generic bar length on the outward perpendicular through its own side midpoint, including return bends. It uses existing geometry and centimeter display conversion; no stored dimension is changed. Canonical server SVGs and editor previews share the positioning helper.

`orderItemFilters` filters the order's existing item rows by diameter and exact status or completed/remaining production group. The diameter summary counts active item rows, not units: done, loaded, sent and delivered are completed; cancelled rows are counted separately. It retains the diameter totals when narrowing the status, so completed versus remaining stays visible. Filtering does not change documents, printing scope, stored status, row numbering or order totals.

`orderItemSummary` counts order item rows, not quantities within rows. Notes and the detail badge use the same summary, distinguish fully shipped from partially shipped rows, and preserve operator notes. Partial delivery is shipment information and is excluded from manual status choices; existing partial orders display their projected work stage.

`orderStatusCorrection` describes the Orders rollback dialog: the affected-item count comes from the server preview, excludes cancelled/stopped items, and accompanies explicit document choices. `itemStatusCorrection` continues to describe individual item rollback. Both preserve production quantities and history.

The first registry lives in:

- `public/data-contracts-client.js`

It is intentionally browser-readable and test-readable. The dashboard uses it
to stamp DOM elements with:

- `data-contract-id`
- `data-source-api`
- `data-source-fields`
- tooltip text with owner, source, fields, and meaning.

## Rule

No dashboard KPI or production-critical widget may be added without a contract.

If an API response field is renamed, moved, or split, update the contract in the
same change. Tests should fail when a widget reads business data without a
registered contract.

## Required Fields

```js
{
  screen: 'dashboard.html',
  owner: 'Dashboard / Production',
  source: { api: '/api/dashboard', fields: ['producedWeightToday'] },
  meaning: 'Total weight of items completed today, in kg.',
  consumers: ['kpiWeightToday', 'qsWeight'],
  risk: 'D1'
}
```

## Risk Levels

Use the same D0-D4 language from `docs/change-control-protocol.md`.

- `D0`: informational display only.
- `D1`: operational value that can affect daily decisions.
- `D2`: financial/customer-facing value or route-dependent value.
- `D3`: value that can trigger production, billing, delivery, or stock actions.
- `D4`: destructive/data-repair value; must not be exposed without explicit
  owner approval.

## Next Expansion

After dashboard KPIs, extend contracts to:

1. order detail drawer,
2. production queue cards,
3. print cards/A4 production documents,
4. inventory stock badges,
5. finance KPIs,
6. OCR/intake confidence badges (implemented as `intakeRecognitionConfidence`):
   source numeric scores only, absent scores shown as unknown; row score uses the
   minimum of the four core fields when all are provided. Operator approval is
   independent of recognition confidence.

## Item correction preview

`itemStatusCorrection` in `public/data-contracts-client.js` owns the orders dialog shipment explanation. The preview is authoritative for linked certificates, documented quantities and every affected line; only explicit cancellation releases document quantities. Work status never erases production or physical shipment history.

## Inventory daily view (2026-11-08)

Inventory owns the display. `/api/procurement/plan` supplies kg groups with
`physical_stock_kg`, `backlog_kg`, `incoming_kg`, `recommended_purchase_kg`,
`legacy_preallocated_kg` and `requires_specification_review`. A kg group is a
diameter/supply-form planning estimate; it must not claim interchangeability of
length, grade or standard. Physical stock includes audited count adjustments.
`mesh_groups` uses exact mesh specifications and `physical_units`, `required_units`,
`incoming_units`, `available_units`, `recommended_purchase_units`. Whole sheets
are never added to kg totals. Sorting/filtering changes presentation only.
The editable export uses the operator's final rows, not stale recommendation
quantities, and does not write to purchase or inventory tables.
