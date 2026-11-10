# Hebrew messages and actionable diagnostics

Owner: Platform Core. Impact: D0 (presentation and error metadata only). No
schema, balance, stocktake, billing, permissions or machine-control changes.

`public/user-messages.js` is the shared browser/Node message catalog. All app
pages load it before other executable scripts. Dialogs and notification helpers
use the same wording. Long toast explanations wrap and stay visible longer.
Manual user content and business identifiers are not translated as data.

Each known failure names the actual condition and the correction. Examples:
missing diameter, reused SKU, stale stocktake preview, quantity above production,
missing source lot, different customers in a combined shipment. Missing manual
order/scan fields are enumerated from the same predicate that rejected them.
For an invalid preferred source in a new order, the service returns its visible
item sequence and selected source. Cancellation responses can identify the
affected item and recorded production quantity from existing error details.
No row, amount or causal diagnosis is invented when that information is absent.

HTTP JSON errors retain their original `error`, `code`, status and existing data.
The server adds `user_message`; consumers display it and keep raw codes for
branches such as duplicate confirmation and worker permissions. Request IDs are
included for internal failures and correlated with bounded diagnostic logging.
No bodies, tokens, query strings or upstream HTML are logged by this layer.
Malformed/oversize API bodies now also produce Hebrew JSON explanations.

The auth client's existing single refresh/retry behavior is retained. The new
presentation layer does not retry network failures or mutations. A lost response
explicitly says to check whether the operation was received before trying again.
`responseError` reads a cloned response so download/legacy helpers can preserve
the actual server explanation rather than replacing it with a generic local one.

Validation: `test/user-messages.test.js`, existing auth/client/order source tests,
full serial Node suite, and fixture-only browser verification. Production tests
must be read-only; no synthetic order, stock movement or machine command.

Rollback: revert this release commit and redeploy. No data rollback is needed.
Handoff: new routes must supply a specific domain error and diagnostic details
where the caller needs a row/field/value. Add its explanation to the catalog and
display `user_message`. Unexpected errors use an honest internal-failure message
with a reference; this is not a substitute for diagnosing the new failure.
