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
