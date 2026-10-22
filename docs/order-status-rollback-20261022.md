# Unified order rollback — 2026-10-22

- Owner: Orders. Dependencies: Production item correction, Warehouse session cancellation, Delivery certificate cancellation.
- User scope: remove the redundant approved/waiting status and make returning an order also return its advanced items, including after issuing a delivery note. Existing correction dialog and styles are reused; the user explicitly requested implementation without repeated approval bureaucracy.
- Canonical approval destination is production queue. The old approved label is accepted as a read/input alias; existing rows are not bulk rewritten. Internal approval permission remains required when leaving either pending approval state.
- D1: explicit audited operator actions write existing order/item/session/cancellation records, transactionally. No schema or automatic data migration; quantities, stock movements, payment and document snapshots are preserved.
- Earlier work stages cap advanced active item statuses at the selected stage. Cancelled/stopped items are excluded. Pending loading is cancelled with history retained; completed departures remain historical evidence.
- One correction dialog previews affected item count, active loading and document choices. Keep documents is the default. Explicit cancellation uses existing source-certificate safeguards. Stale fingerprints reject the whole operation.
- Validation: isolated HTTP fixtures for legacy aliases, approval, every backward work target, document preserve/cancel, stale state, atomic rollback, active loading, real worker start, and read-only FK integrity. Full npm test before release. Browser QA uses isolated data only.
- Rollback: revert commit and deploy; audited corrections remain, with no schema rollback.
- Handoff: clean worktree ironbend-order-status based on origin/main 6ec0eea; unrelated checkouts untouched.

User follow-up: phone scan actions end at loaded (הועמס), not delivered (סופק). The worker endpoint no longer accepts new sent/delivered commands, but replays existing receipts. Historical sent/delivered states remain truthful in the display. A phone correction uses the shared item/order reconciliation and preserves quantities/documents; loading no longer hides the card from the visual queue. Saving quantities/notes on a loaded card does not downgrade it to completed. Receipt, stale-status and approval/cancellation protections remain.

Verified: full npm test 1111/1111. Isolated HTTP coverage includes source certificate issue after a phone-loaded state, correction of a historical accidental delivered status, and returning one order from a shared loading session while another can still depart. Read-only PRAGMA foreign_key_check passes. Browser QA verified legacy approval is displayed as queue, whole-order return after a certificate, item restart and refresh persistence, and phone loaded -> waiting. Screenshots are in the chat outputs directory. Production data was not used for mutation tests.
