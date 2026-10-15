# Manual order status choices — 2026-10-15

- Owner: Orders; shared status contract is a dependency.
- Scope: existing order status selector, detail actions, status contract and PATCH /api/orders/:id/status.
- Behavior: manual order updates offer every canonical status and permit skips/corrections. Automatic lifecycle transitions retain their existing sequential contract.
- Approval: skipping from either pending approval stage into an advanced stage requires manager/admin and records approved_by, approved_at and manager_approval audit, as the normal approval path does. Loading retains manager/admin permission. Restricted options remain visible but disabled.
- Cancellation: uses the existing cancellation review/disposition flow; cancelled orders cannot be reopened through this endpoint.
- Payment: remains a separate field; paid orders also expose lifecycle choices without changing their payment state.
- Design: existing selector, styles, labels and layout retained per the user's screenshot and explicit instruction. Only the requested option set changes.
- Data impact: D1 endpoint behavior only, no schema/migration/backfill or production data writes performed for verification. Changes are audited using the existing status_change event and order_status broadcast. Item quantities, production records, weights and delivery documents are untouched.
- Validation: exhaustive server/browser manual-transition parity; dropdown choices for pending, partially delivered, delivered and paid orders; HTTP skip/return, manager approval, stale-state rejection and unchanged item-row checks; full npm test.
- Baseline limitation: full suite has one existing failing subtest (and its parent): security-routes production mutation expects office item-status rejection 403 but current main returns 400. Reproduced in clean 07e95a5 baseline. No unrelated permissions behavior changed.
- Rollback: revert this commit and redeploy; no data rollback needed.
- Handoff: work based on origin/main 07e95a5 in an isolated worktree; original user checkout and its uncommitted changes preserved. Verify live order 86 read-only after deployment.
