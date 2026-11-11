# Production queue follows open orders — 2026-11-11

Owner: Production, consuming Orders workspace/status contracts. Data level D1:
existing forward production writes gain lifecycle guards; no migration or
historical data rewrite. No customer, order number, date or machine is exempted.

Root cause: the queue filtered only production status. An order could still have
`בייצור` after trashing or marking paid, with unfinished child items. This let
non-active orders leak into all consumers of `/api/production-queue`.

`services/productionEligibility.js` consumes the existing Orders
`bucketCondition('active')` for SQL and `order-workspace.bucket` for start/write
guards. Both use the same status contracts and known aliases. NULL legacy
payment flags are treated as unpaid consistently with the workspace UI. Normal
mode additionally requires a released production order and waiting/in-production
item. Visual mode can include finished/loading items of still-open orders.
Cancelled/stopped item flags override the legacy status text. Queue reads are
no-store; closing/trashing an order never modifies its historical child records.

The same policy guards scans, machine assignment/completion and worker/item
production writes. Assignment uses the saved order number. Stale cards cannot
start work on inactive orders. The existing explicit backward correction of an
unpaid delivered order remains possible and reopens its lifecycle; paid/trashed
orders require an Orders workspace action first. No commands are sent to a live
machine during verification, and this change does not automatically stop a
running machine or rewrite its history.

The production queue, machine page and visual worker page refetch on order
workspace lifecycle events as well as existing production updates. The queue
retains its 30-second fallback refresh and refreshes on return to visibility.
It discards stale async responses and hides actionable old cards when a read
fails. Empty queue count becomes zero. Header `shift-pieces` is labelled
`פריטים בתור`: it counts item rows, not produced pieces. Closing a shift no
longer writes queue size into produced-piece totals; omitted totals preserve
existing shift values. This does not introduce a new shift-actuals calculation.

Evidence: fresh pre-change backup showed 237 pending cards; 42 belonged to two
trashed orders. This is diagnosis only; no one-off cleanup is applied. General
HTTP tests cover all closed buckets, machine filter, visual mode, restored and
reopened orders, aliases, partial delivery and stopped items. Rejected writes
must leave items, machines and stock unchanged. Isolated UI acceptance verifies
WebSocket removal, machine-filter preservation, failed reads, zero counts and
slow-response races. Full suite and read-only before/after integrity checks are
required before reporting deployment complete.

Rollback: redeploy the previous commit; there are no schema or data migrations
to undo. Handoff: Orders owns opening/closing/restoring, Production only consumes
that decision. Do not restore a specific customer record just to hide this bug.
