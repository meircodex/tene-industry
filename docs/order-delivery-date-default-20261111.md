# Delivery date fallback — 2026-11-11

Owner: Orders. Data level D1 for future order creation only; no schema/migration,
existing-row rewrite, API route or permission change. User explicitly requested
that an empty date must not block creation and must become two days ahead.

The factory local date uses Asia/Jerusalem. Add two calendar days (weekends
included), using UTC only to normalize calendar fields across month/year and
daylight-saving boundaries. Browser initial form and save share the pure UMD
`public/order-delivery-date.js` with CommonJS `services/orders.js`. Explicit
dates are retained. A cleared field is re-resolved at save time. A date explicitly
chosen and restored from a draft is retained; no assumed user schedule replaces it.

Scope: customer order creation through the canonical creation service. Existing
order edits, historic dates, intake recognition evidence and immediate machine-job
creation are unchanged. Quote payload building uses the same new-order form.
Existing customer/address/item validation remains. No data submitted on load.

Validation: `test/order-delivery-date.test.js` covers local-midnight rollover,
leap/month/year boundaries, DST, missing/null/blank dates, explicit date retention
and real in-memory canonical creation without rewriting an old null date.
`scripts/verify-order-delivery-date-ui.js` operates actual HTML/editor/assets and
saves isolated fixture orders through UI with empty and explicit dates. Full
serial suite before deployment; live verification must not create test orders.

Rollback: revert release and redeploy, no DB rollback required. Handoff: seven
real orders were prepared through UI in a separate task, not by this code change;
their saved draft data must be preserved. The user separately authorized 7.5 cm
additional ends on pins and date default +2; order entry remains UI only.
