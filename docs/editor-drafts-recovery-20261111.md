# Shared editor drafts and recovery — 2026-11-11

Owner: Orders. Data level: D1. Existing `direct_order_drafts` storage is reused
under source `new-order-editor-v2`; no table/column migration, no order/stock
mutation from draft persistence. Local cache and existing snapshot formats remain.

The old UI treated its untouched starter row as meaningful, generated blank
drafts on page render, retained only 20 local records, and had no server sync.
Pending autosave could recreate a draft after successful submission. Customer
hydration also applied the customer's sole portal site over restored manual
delivery fields. These are independently addressed.

Existing meaningful local records upload on opening the new-order screen. A
different authorized browser loads the shared list without creating an order.
Empty rows are excluded from draft identity/count/weight. Existing empty cache
records are hidden, not destroyed. Incomplete but meaningful records (customer,
notes, a partial shape, etc.) remain available. No claim is made to recover a
record previously evicted by the old 20-record cap. Old duplicates of already
saved orders are preserved; historical orders are never matched by a heuristic.

API: GET `/api/operations/editor-drafts?before=<id>` (200/page + nextCursor),
PUT `/api/operations/editor-drafts/:draftId` (`record`, optimistic `version`),
POST `/api/operations/editor-drafts/:draftId/close` (`version`, optional existing
`orderId`). All require office/manager/admin JWT. PUT and close share the existing
40/minute Orders operation limiter. Writes audit `editor_draft_saved`,
`editor_draft_submitted` or `editor_draft_deleted` and broadcast only a draft ID.
Snapshots are retained on close; closed states act as cross-browser tombstones.
The ordinary order-save path remains responsible for creation/stock policy.

Version conflicts leave the local edits intact. Opening the list forks them to
a new draft ID, then loads the authoritative shared record; an open editing form
continues on the fork. Disconnects show that the snapshot is only local, rather
than falsely claiming a successful shared save. Existing local 14-day visibility
and offline queue policies remain; shared data is not automatically deleted.

Validation: HTTP auth/permissions, incomplete snapshots, replay, stale versions,
nonexistent order linkage, soft close and no order/stock changes in
`test/order-operations.test.js`; actual-page isolated two-browser acceptance in
`scripts/verify-order-drafts-ui.js`; customer identity and full suite.

Rollback: redeploy b56a887. Draft rows stay in the existing table and are not
discarded. Old clients only see their local cache. No env changes required.
Handoff: do not bypass the shared shape editor or create customer orders through
draft synchronization. Browser testing must distinguish fixture orders from
actual customer orders. Seven official customer orders 124–130 already exist.
