# Historical supplied orders and inline priority

Orders owns the maintenance service and the priority edit. D3 historical data
change authorized by the owner: orders through 8 October 2026 inclusive were
supplied but their statuses were not maintained. Two later old orders remain
outside this operation (103 and 108); two current production orders (121 and
122) retain the count-based completion consumption workflow.

Scope is explicit reviewed IDs, selected by creation time before
2026-10-08T21:00:00Z (9 October midnight in the factory timezone), excluding
deleted, cancelled and already supplied orders. They become `סופק – אושר`
and their uncancelled items become `סופק`. Existing completion timestamps,
produced quantities, weights, output events and delivery certificates are
preserved; this does not invent historical production or claim a new delivery.
Active reservations are released so old work leaves the purchasing backlog.
The count-aware planning projection also excludes completed-before-count items,
orders before the configured creation window, and already supplied/cancelled
orders, even if an old active reservation remains in their history. Current
production demand remains in the plan.
Inventory records a historical exemption to prevent later rescans consuming
counted stock. No physical balance or consumption journal is changed.

Preview fingerprints guard the complete selected order/item/reservation data.
An immediate transaction applies only the reviewed IDs, audits per-order before
snapshots and the batch result, then asserts exact fingerprints of raw lots,
usage, mesh movements, V2 consumption and item-consumption states/events.
Replays return the previous result. V2 orders and already debited tracked items
require separate reconciliation rather than an inferred historical refund.

Verified backup downloaded 10 November: `tmp/historical-closure-20261110/production-before.db`.
SHA256 `487e817024198a33a10208c689775c1a95f8d8d07af1933f4ed5c56ecae50866`;
integrity_check=ok. Staging found 48 orders and updated 632 item status labels.
Physical inventory delta was exactly zero, total 114884 kg. Remaining open
orders: 103 (waiting pickup), 108 (partial delivery), 121/122 (production).
Order 108's recorded partial delivery is preserved pending any separate
production/delivery correction; it is not declared fully supplied by this batch.

Run the reviewed plan using `tools/close-historical-orders.cjs DB PLAN REPORT`.
Never restore a historical DB over current work as a rollback. A correction to
the operation must use the saved audit snapshots and reviewed IDs, account for
intervening changes and preserve all new business records.

Inline priority is a narrow change to scheduling metadata. It can change during
production without falsely treating it as a geometry correction. Locked,
deleted, cancelled and departed orders remain guarded. Existing server role
gates apply. A concurrent priority change is rejected and each real change is
audited. Priority alone does not move material between orders.

Applied maintenance evidence: 48 old orders and 632 item status labels were
updated, physical fingerprint unchanged, integrity_check=ok. Server pre-close
backup SHA256 `11e228b7694d68b35d3b2d9a01276c4eeacdb2bcc31eddde9a0f79f7bcb17aa6`.
Persistent result: `/data/backups/historical-orders-closed-20261110.json`.

Subsequent owner correction: orders 105–107 were incorrectly marked fully
supplied. The owner clarified partial delivery, excluding diameter 12. The
reviewed maintenance script `tools/reconcile-partial-orders-20261110.cjs` changes
their headers to partial delivery and preserves child delivery states and
documents because exact supplied item quantities were not provided. All 37
uncancelled diameter-12 items receive count-bound consumption overrides; only
post-count completed items are debited. No other diameter or supply form moves.
Chronological replay debited 17 items, 4652.506 kg. Sixteen items await production;
four completed items totaling 2026.896 kg remain pending due to insufficient coil
stock. Remaining coil Ø12 is 105.494 kg; the net discrepancy for the already
completed pending items is 1921.402 kg. These are theoretical item weights, not
invented measured weights. The pending debt stays in procurement demand.
No unreported receipt or negative physical stock was created. Total physical
stock after the scoped debit: 110231.494 kg. Idempotency and item states prevent
repeated deductions. The original 103/108 and current 121/122 remain unchanged.
Server pre-partial backup SHA256
`d641e65623cbf37c753a63bf99ef4ed325f2fae33d37af1d40caba95c8a350c2`;
persistent result `/data/backups/partial-orders105-107-diameter12-20261110.json`.
Partial delivery is also shown explicitly in the order row notes, independently
of the primary production status and without fabricating shipment counts.
