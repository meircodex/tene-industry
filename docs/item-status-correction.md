# Item status correction — 2026-10-21

- Primary owner: Production. Dependencies: Orders status, existing delivery certificate cancellation service.
- User authorization: fix the investigated rollback problem without repeated approval steps; reuse the existing correction dialog.
- Scope: item status route, read-only correction preview, reconciliation service, existing orders dialog, contracts, tests.
- Data impact: D1, writes existing status/audit/cancellation rows on explicit operator actions only. No migration, backfill, deletion or automatic cancellation. No changes to production quantities or inventory movements.
- Preview: GET /api/items/:id/status-correction-preview?status=...; same operational roles as item status. Returns target, linked documents, whole-document affected items, cancellation blockers and a stale-state fingerprint. No-store.
- PATCH /api/items/:id/status accepts expected_status, correction_fingerprint and correction_mode. Default keep_documents preserves all shipment evidence. cancel_unshipped_certificate requires office/manager/admin, a backward target, reason, and matching preview. Existing document safeguards remain in force.
- One transaction cancels eligible complete source certificates, restores their other items through the existing service, changes the selected item, and reconciles the order work queue. Failure rolls everything back. Audit and broadcasts cover changed items and order.
- Shipped orders with reopened work become partial-delivery operational orders; historical delivered quantities do not decrease. Old audited corrections stuck at waiting can resume production. Pending approval/cancelled orders cannot use that recovery path. Hold can resume within a released production order.
- Active warehouse sessions retain ownership of loading status. No automatic reversal of truck, stock, signed delivery or invoice records. Their documents can remain valid while the item returns to work.
- UI contract: public/data-contracts-client.js itemStatusCorrection. Cancellation text explains that the entire certificate, including other lines, is affected. Default is keep_documents. No second confirmation dialog.
- Validation: isolated HTTP fixtures for preserve/cancel/reissue, sibling restoration, stale state, signed/invoiced documents, permissions, transaction rollback, old stuck records, hold, active loading, FK integrity; existing delivery/status/client/security/governance suites and full npm test.
- Rollback: revert the code commit and deploy; existing cancellation history remains valid and no schema rollback is needed.
- Handoff: based on origin/main f2fdb5d in the existing clean worktree. Do not modify the older dirty ironbend-app checkout. Real orders are not used as test fixtures.

Verified: full npm test 1099/1099; subsequent client/governance/auth checks 147/147. Real browser against an isolated local database: cancel source from the item selector, verify archived void document, return waiting -> in production, refresh and verify persistence. No production order mutations during QA.


## 17.11.2026 — queue placement and safe return

- Production → Production Queue is scheduling only when there is no active loading session. It preserves every item row, including completed items, quantities, start/completion times, stock and certificates. Recorded production facts trigger acknowledgment even when there is no opening scan. A new accepted production scan still resumes the order automatically.
- Explicit backward corrections remain reviewed; Production stores the full before-image in an append-only `production_state_snapshot` audit record before mutating status facts, in the same transaction.
- Orders owns `GET /api/orders/:id/status-undo` and `POST /api/orders/:id/status-undo`, manager/admin only. POST requires `restore_point_id`, `fingerprint`, and a 3–2000 character `reason`. The point is captured atomically with each real manual order status change. Same-status requests are no-ops.
- Undo compares the entire current order/item state, current delivery/loading projection, and all worker receipts/scans to the saved after-state. New work, editing, lock, deletion or cancellation prevents blind restoration. The operator can still use the ordinary reviewed correction flow against current facts.
- Orders restores its prior status/approval metadata; the owned Production helper restores only item status, started_at and completed_at. No geometry, quantity, stock, actual weighing, delivery document or scan event is overwritten. Each return appends `status_restored` and a new return point, allowing a correction of the return itself.
- A correction that cancels a certificate or loading session is not blindly undone; use the owning document/loading correction flow. No cancelled document is resurrected.
- Existing historical records without saved before-images are not fabricated. HZ-2026-131 was inspected read-only: the live audit records 11 completed and 1 in-production item changed to waiting at 10:39 on 17 November. No live order/item/history/stock was edited for this investigation.

The Orders list now expands the existing single detail panel beneath one row. Parking before list replacement preserves handlers/IDs, filters and selection; request generations reject late responses. Secondary status/edit/print/commercial sections are collapsed. Dashboard and New Order density changes share a scoped stylesheet and keep canonical API calculations.


Verification: 1,395 tests passed in the final suite, including route authorization/governance, mixed-status requeue preservation, explicit completion-date restoration, stale/replayed return rejection, document cancellation protection, and the correction dialog-to-API contract. An isolated browser requeue/undo round trip retained 3 completed of 8 and 38% progress. Live release `1219b48`, deployment `dep-dbu7l3942hec73bq8tsg`: source/health/auth checks passed and authenticated inline expansion observed without changing production data.


## Visible order table — 17.11.2026

The approved follow-up replaces accordion navigation with one visible item table in both inline and modal order details. Order identity, delivery/priority/note and existing actions share a compact header. Every table heading has a multi-value checkbox filter; alternatives within one heading are ORed and headings intersect. Filters preserve whole-order totals and do not alter print scope or any API data.

`public/orders-detail-table.js` owns client filtering and expansion only. The existing Orders builder supplies canonical metrics and server shape SVGs, with unchanged detailed editors/status/cancellation/history/printing handlers inside the one selected expanded row. Filter popovers are outside the scrolling table to avoid clipping, and close on outside click, Escape and resize. Rebinding removes listeners; close resets the view and same-order refresh retains the selected filters/row. Printing/documents/edit dialogs use the existing actions. No route, permission, inventory or production write changed.

Verified live release `80e874d` / `dep-dbu896om7kps73b9nosg`: full suite 1,398 passed. Frontend asset parity and health/auth checks passed. Read-only live order 131 rendered all 23 items with nine filter headings; selecting Ø14 showed 9 and clearing restored all 23. The compact header measured 42.8px and item rows 46px. Existing correction/undo APIs and production data were not changed.


## Unified order styling and explicit actions — 17.11.2026

User clarified that the order window is welcome; the correction preserves both existing modal and inline entry paths. The detail window is bounded to 1140px, the name column no longer absorbs empty space, and 66px item rows show 16px text and larger canonical drawings. Existing cards, A4, shipment/cutting, documents/summary and editing actions remain available with visible text labels.

Column names toggle ascending/descending order while their independent arrow opens the existing checkbox filter. Numeric sorting uses raw canonical metrics supplied by the existing item builder; it does not parse displayed rounded weights or unit strings. Sorting moves each main/expanded row pair together, preserves selected filters and editor nodes, retains stable ties and puts missing values last. No production, stock, scan or document data was changed.

Pre-release verification: 1,400 tests passed; local sort/filter composition, A4 language dialog, documents/summary and desktop visual review passed using demo data.

Live verification: `ef9f26a` / `dep-dbu8piifngtc73e3c010` is live. Three frontend assets matched source after newline normalization; health returned 200, anonymous orders and undo returned 401. Authenticated read-only order 133 rendered all 17 items at 66px height and 16px text. Weight sorting returned 14 through 352 in numeric order; the direct A4 button opened the existing language dialog. Desktop screenshot `order-unified-style-live.png` confirms bounded columns, readable drawings and all named actions beside metadata in one compact header. No live production record was changed.
