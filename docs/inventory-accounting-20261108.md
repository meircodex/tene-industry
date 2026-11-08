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
branch. Production deployment authorized by the owner on 2026-11-08.
Release verification is recorded below; operational test writes use isolated copies only.
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

## Implemented API contracts (local implementation; not deployed)

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
- `POST /api/procurement/purchase-draft/export`: warehouse/office/manager/admin, no writes.

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
and the focused test also fails on those unchanged files. The existing inventory screen now uses its normal theme and components with sortable headings, a purchase-draft modal, separate count and receiving tabs. No deployment was performed, and no real inventory database was opened.

The user directed that the normal application styling be preserved, with clickable headings and an editable purchase-order window; this is implemented.

Before deployment, inspect existing reservation
ambiguities using reconciliation reports, back up and stage a representative full
cycle. Do not treat this branch as a production release while those gates remain.


## Browser verification of integrated screen

Isolated review server: `http://127.0.0.1:4601/inventory.html`, backed exclusively by
`tmp/inventory-review-20261108/review.db`. Verified in the browser:
- ascending/descending sorting and existing application theme;
- purchase draft populated with shortages, quantity edited 5000 → 5250, downloaded
  CSV contains 5250 and preserves sheets as units;
- count 5000 → 4900 posts -100 without changing the received-weight history;
- receipt of 10 sheets remains pending until approval, then stock 80 → 90 and
  shortage 30 → 20;
- desktop and phone layout; no browser console errors.

Screenshots: `docs/mockups/inventory-regular-style.png`,
`inventory-regular-purchase.png`, `inventory-regular-mobile.png`. The old standalone
mockup remains research history; `public/inventory.html` is the implementation.


## Production release preparation — 2026-11-08

- Rebased both inventory commits onto the verified live `a48c43f` main revision;
  retained all intervening production/customer/order changes.
- Downloaded the live database through the existing administrator session. SHA-256:
  `15641e467eba732502514b5891d97a7f30226a178169842919fc277a3202fb64`.
  Backup and staging copy remain outside version control in `tmp/deployment-20261108/`.
- Verified live Render `DB_PATH=/data/ironbend.db`, persistent disk mounted at `/data`.
  Set `ALLOW_EMPTY_DB_INIT=false` to refuse accidental empty database initialization.
- Applied the additive schema twice to the downloaded copy: integrity `ok`, zero
  foreign-key violations, original counts unchanged (110 orders, 1658 items,
  110 pallets, 3 raw-material lots, 152 usage rows, 1524 reservations, 272 purchases).
  Receipt/use/scrap counters unchanged; all 1524 old reservations retain legacy mode.
- Staged a new reservation → actual completion → replay, count → replay, mesh
  receipt → approval → replay and edited CSV export against that migrated copy.
  All passed; synthetic business operations were rolled back.
- Historical reconciliation remains advisory: 152 ambiguous historical consumption
  diagnostics, 1098 consumed reservations without a usage link, and other existing
  allocation/counter mismatches. No historical deduction/rewrite was performed.
- Integrated full suite: 1142 tests, 1141 pass. One pre-existing print-layout literal
  assertion fails in `test/order-document-send-ui.test.js:61`; both that test and
  `services/productionCardPrintPage.js` match live main byte-for-byte. All inventory,
  route authorization, accounting, client and governance tests pass.
- Rollback before real count use can retain the additive columns. After real count
  adjustments, any emergency code rollback must preserve materialBalance support;
  returning blindly to a version that ignores count adjustments is unsafe.
