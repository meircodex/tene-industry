# Order save / automatic material source fix — 2026-11-10

Owner: Orders. Dependency: Inventory reservation boundary. Data level D1, existing order-creation writes only; no schema, migration, stocktake or historic data rewrites.

The first new-order attempt after the inventory release returned `FOREIGN KEY constraint failed`. The new-order serializer sends `raw_material_id: 'auto'` for normal automatic source selection. `orders.js` passed this through as `preferred_raw_material_id`, and the reservation writer inserted it into an INTEGER foreign key referencing raw_material. Existing tests omitted the browser's actual sentinel.

Reproduced on an isolated database with foreign keys enabled, count-adjusted opening stock and the real order transaction. Before the fix, the exact browser-shaped payload raised SQLITE_CONSTRAINT_FOREIGNKEY. Automatic/empty selection now persists null, allowing completion-time FIFO selection; an explicit valid numeric lot is retained. Invalid/missing explicit IDs return a clear input error rather than a SQL exception. Validation is shared by all reservation callers, so existing saved drafts containing 'auto' work without editing the draft.

Validation: real order transaction succeeds, creates an on_completion reservation, leaves stock untouched on save, and completion consumes exactly once even on replay. Explicit lot selection persists. Invalid explicit sources roll back all customers/orders/pallets/items/reservations created by the request. No production sample orders are submitted. Full-suite results and deploy evidence are saved outside Git under outputs/order-save-fk-20261110/.

Rollback: revert this reservation-boundary change; no database restoration needed. Prefer retaining the sentinel normalization even if surrounding UI is rolled back. Existing snapshots, count balances and order drafts are retained.
