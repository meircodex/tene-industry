# Order item filters — 2026-10-25

- Owner: Orders. Scope: order detail item section, client filter module, widget contract and scoped styles.
- User intent: choose diameter 12 and see completed versus remaining item counts; show either group or an exact item status. Combine diameter and status, clear both, and show an empty-result message.
- D0: read-only local projection of existing item rows. No API, permission, database, production or document changes. Original item numbers remain stable and empty pallet groups are hidden. Same-order refresh retains selection; closing or changing order resets it.
- Completed means current status done/loaded/sent/delivered. A partial/in-progress row remains to produce. Cancelled rows are separate and excluded from active production totals. Count rows, not piece quantities.
- UI uses existing styling and controls under the standing user request to implement without repeated approval bureaucracy.
- Validation: combined filters, count semantics with unequal quantities, cancelled/held rows, rollback status, empty results, UI reset and refresh; full test suite and isolated browser QA.
- Rollback: revert and deploy; no data rollback.
