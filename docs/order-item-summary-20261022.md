# Order item summary — 2026-10-22

- Owner: Orders; dependency: shared status choices and read-only delivery progress.
- User request: partial delivery is not a selectable order status; order notes should count item rows without piece quantities.
- Scope: order list/mobile/detail status selectors, notes and delivery badge; matching browser/server manual-transition contracts.
- Data: D0 presentation and rejection of a manual derived-status target. No migration or data writes. Existing partial-delivery records and Warehouse/Delivery automatic bookkeeping remain compatible. Shipment history, quantities, documents and permissions remain unchanged.
- Architecture: use the existing delivery projection for the displayed work stage; one shared presentation helper counts complete and partial rows separately. A previously released legacy partial order never appears to need approval again.
- Validation: matching browser/server manual choices, rejection of partial as a manual target, legacy partial display, item summary and partial-row cases; full npm test; isolated browser QA and live static-file verification.
- Rollback: revert commit and deploy, no data rollback.
- Handoff: branch codex/order-item-summary-20261022 based on 7108c08; no unrelated checkout edits.
