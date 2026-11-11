# Multi-order cutting and order list actions — 2026-11-11

Primary owner: **Orders**. Dependencies: Inventory (read-only projection), Steel/Rebar
(canonical weights, pure cutting calculation). Data impact **D0**, no schema,
startup migration, persistent settings or production-data repair. Selection may
open existing delivery workflow, which retains its explicit confirmation and
original write permissions. Server mixed-customer rejection only gains the exact
user-approved wording; it already rejected this operation.

## Approved interaction

- Checkbox on each desktop row/mobile card, select-visible header. Actions appear
  only after selection; filtering/sorting keeps selected IDs, switching list
  buckets clears selection, removed/deleted orders cannot remain selected.
- Cutting accepts multiple customers; pieces retain source order and item IDs.
  Mixing compatible orders on a bar is default; operator may separate orders,
  choose source lots, choose per-diameter lengths, and reduce quantities to plan.
- Document icon opens existing consolidated/partial delivery preview with selected
  orders. Different customer IDs: thin red diagonal slash; explanation only after
  click: **לא ניתן לעשות תעודת משלוח אחת ללקוחות שונים**. No automatic issuance.
  Existing company/destination validation and fingerprint approval remain.
- Click data headers to alternate ascending/descending with direction marker.
  Natural numbers, numeric weights, ISO dates, Hebrew text, regular/urgent rank.
  Missing values last; ties stable. No data writes. Default outstanding partial
  delivery priority remains until an explicit sort. Sorting reflects displayed
  primary status/combined notes. Actions and selection headers are not sortable.

## Inventory contract

`GET /api/inventory/cutting-stock?order_ids=...`, warehouse/office/manager/admin.
Only active approved straight-stock lots; coils never become 6/12m bars. Physical
stock follows `materialBalance`, minus other orders' confirmed remaining V2 lot
allocations (net of consumption/reversals). Selected orders may use their own
allocations. Legacy demand reservations are not lot allocations and are not
silently counted as physical consumption.

Length comes **only** from existing `raw_material.nominal_length_mm`. This change
does not split lots, change 6/12m fields or add an alternate inventory owner.
`inventoryPlanningLength.barEstimate` supplies whole-bar count:
`floor(available_kg / (kg_per_m * nominal_length_mm / 1000))` with its shared
floating-point tolerance. Count is an estimate from recorded kg, not a physical
bar count. Unknown length => null count, excluded by default; selecting it gives
a precise instruction to finish the length definition in Inventory and refresh.

No steel finish column currently exists on lots: local planning defaults to
ribbed and allows explicit smooth choice. This is not a verified lot property and
is not saved into Inventory. Explicit grade/standard demands require matching
recorded source specifications; missing source specifications do not match them.

Every calculation refreshes stock. Finite quantities may be used once per plan;
plans preserve lot identity, list every unplaced item and show capture time.
Requests above 100,000 parts are rejected; calculation uses a cancellable worker.
Two greedy alternatives (short-first/long-first) are compared for coverage and
tail waste; there is **no global optimality guarantee**. One-length preferences
compare available uniform lengths. Operator choices remain authoritative.
Kerf includes cuts separating usable tails and is printed separately from tails.

## Explicit limits

This is a read-only cutting proposal, not a reservation or execution journal.
Concurrent users may plan the same stock; refresh is not a lock. Quantity defaults
to full order item quantity, editable by operator; it is not claimed to be the
verified uncut remainder. Printing creates no production completion, stock use,
reusable-offcut entry, waste charge or delivery document. Billing and machine
geometry contracts are unchanged. Import work on origin/main was integrated;
this change neither creates/imports nor edits customer orders.

## Validation and handoff

- `test/multi-order-cutting.test.js`: finite stock, mixed orders, material/spec,
  policies, kerf conservation, shortages, kg estimates and read-only DB projection.
- `test/order-list-sorting.test.js`: data types, nulls, stability, direction and
  preserved default outstanding-partial order priority.
- `test/order-operations.test.js`: real endpoint authentication, role denial,
  invalid input, readonly stock values, mixed-customer rejection with zero notes.
- `scripts/verify-multi-order-cutting-ui.js`: isolated actual HTML/assets/worker,
  desktop/mobile, all header toggles, selection survives sorting, exact click-only
  alert/slash, finite inventory, refresh/missing length/error, same-client preview
  navigation, zero fixture business writes. Fixture data never reaches production.
- Full serial test suite before release; live verification is read-only.

Rollback: revert this release commit and redeploy. No DB rollback/migration.
Next chat: length management stays in Inventory's existing service/UI. Extend
allocation/execution only with a separate approved ownership/persistence contract.
