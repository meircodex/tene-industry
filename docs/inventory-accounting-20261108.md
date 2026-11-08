# Inventory accounting: count, receipt and purchase planning

Owner: Inventory. Dependencies: Orders records demand, Production reports completion,
Procurement owns purchase orders. No supplier management moves into Inventory.

## Agreed behavior

- A receipt adds stock only after approval; its recorded received weight is historical.
- A count records an absolute observed balance per lot at a cutoff and posts an audited
  adjustment. It never overwrites receipts, usage or scrap. Preview must be refreshed
  if a lot changes before approval. Receipts created after the count are not included.
- New order creation records demand/reservations only. Remove the old early-usage
  allocator and automatic shortage purchase-order creation; recommendations are read-only.
- New reservations consume stock once on reported production completion. Existing
  reservations retain legacy behavior to avoid deducting historical usage a second time.
  A shortage leaves consumption pending with a persistent alert, rather than negative
  stock or a silently successful consumption. V2 orders retain their explicit approved
  consumption-report workflow; these two workflows cannot own the same order.
- Count adjustment participates in every operational stock calculation.
- Purchase planning combines unconsumed demand, existing stock, confirmed incoming
  purchases, waste allowance and safety stock. Drafts/automatic shortage requests are
  not incoming stock. Date cutoff applies to both demand and incoming purchases.
- Historical ambiguous early usage is visible for reconciliation; no silent migration
  or deletion of historical movements.

## Data and release

D3 semantics for new order reservations, additive D2 schema. Implement in an isolated
branch; no production data writes or deployment in this task. Before release: verified
backup, full test suite, staged count/receipt/order/completion cycle and data audit.
Rollback code together with its callers; retain the additive schema and ledger.
Do not roll back to code that ignores count adjustments after any real count is posted.

UI requires visual approval under BUILD_RULES_HE.md §12. Build a standalone mockup
first; backend work and tests can continue while approval is pending.

## Updated user direction

The landing view is daily inventory, shortages and recommended purchases. Receiving
comes second; counting comes third. Show coils and lifts/straight bars separately by
diameter; mesh is a distinct stock product counted in whole sheets with exact length,
width, both wire diameters, both spacings, grade and standard. Never total sheets as kg.
Every table heading sorts, with the next click reversing direction. Type and diameter
also filter. The draft is created from currently displayed shortages, is editable
(supplier, delivery date, quantities, added/removed lines, notes), and exports UTF-8
CSV for Excel. Export does not place an order or change inventory. Strings are escaped
against spreadsheet formula execution.

## Implemented API contracts (pending UI approval and release)

- `POST /api/inventory/stocktakes/preview`: warehouse/manager/admin; read-only token.
- `POST /api/inventory/stocktakes`: manager/admin; idempotent audited adjustment.
- `GET /api/inventory/stocktakes` and `/:id`: paginated history / approved record.
- `POST /api/inventory/consumption/retry`: manager/admin; completed items only.
- `GET /api/inventory/mesh`: quantities and exact specifications, paginated.
- `GET/POST /api/inventory/mesh/receipts`: list / create a pending sheet receipt.
- `POST /api/inventory/mesh/receipts/:id/approve`: manager/admin adds sheets once.
- `POST /api/inventory/mesh/stocktakes/preview` and `/stocktakes`: revision-protected
  sheet count; warehouse can preview and managers can approve.
- `GET /api/procurement/plan`: combined kg demand and separate `mesh_groups` in units.
- `POST /api/procurement/purchase-draft/export`: office/manager/admin, no writes.

Earlier kg counts require `post_count_net_kg`, `post_count_reconciled: true` and a
reconciliation note per line. Positive net means stock added after observation;
negative net means stock removed. Target current balance = observed count + later net.
Never backdate a count over an unreviewed later movement or include a newer lot.

The kg plan groups diameter/supply form and is deliberately marked as requiring
specification review: grade, standard and straight length are not inferred from kg
alone. A lift's physical source is `straight`; "lift" is the user-facing bundle name.
Mesh demand requires an explicit `mesh_specification` and `quantity_units`; it is
never inferred to be interchangeable with coil production material.

Existing V2 allocation/consumption remains relevant for V2 orders. The removed code
is the early order-time usage allocator and automatic shortage purchase creation,
including its unused settings definition and the obsolete completion-status-based forecast endpoint. Historical counters and usage rows remain.

## Validation and handoff

18 new accounting/export/API checks cover count deltas, stale previews, replay,
historical reconciliation, completion retries/alerts, split kg/sheets, incompatible
mesh specs, confirmed incoming, editable CSV and permissions. Full suite: 753/754
passed at the last full run. The remaining existing `shape-geometry` preview test
expects `pad = 16`; both that test and `public/index.html` are unchanged from HEAD
and the focused test also fails on those unchanged files. No UI source has been
replaced, no deployment was performed, and no real inventory database was opened.

Before deployment, approve and connect the final UI, inspect existing reservation
ambiguities using reconciliation reports, back up and stage a representative full
cycle. Do not treat this branch as a production release while those gates remain.
