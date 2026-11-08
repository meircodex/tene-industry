# Purchase drafts in supplier units — 2026-11-08

Owner: Procurement. Inventory supplies read-only exact shortage kg; the draft owns
supplier quantity. Scope: draft UI, pure unit helper, CSV export. D0: no database
schema, stock, reservation, receipt or purchase-order writes.

The owner clarified that orders are discussed with suppliers in rolls for coils
and bundles for straight bars. Preserve exact kg shortages on the daily screen;
suggest ceil(shortage kg / estimated kg per supplier unit), initially 2050 kg as
reported by the owner. The draft permits editing quantity and kg/unit, displays
the approximate resulting weight and retains the exact shortage separately.
Mesh remains whole sheets; bent material retains kg because no package form was
specified. Roll quantities must be whole; straight bundles permit half bundles.

`public/purchase-units.js` is a pure browser/CommonJS helper with no DOM access or
external dependencies. Export accepts explicit `purchase_unit` coil/bundle/sheet/kg,
`unit_weight_kg` and optional `shortage_kg`. The server validates form/unit matching
and recomputes estimated weight from final quantity and unit weight; a submitted
estimated weight is never trusted. Legacy callers omitting purchase_unit retain
kg/sheet interpretation and are never silently reinterpreted as packages.

CSV includes final supplier quantity/unit, estimated kg per unit, estimated order
kg and exact shortage kg in separate columns. Existing formula escaping, supplier
validation and role authorization remain. CSV generation does not place orders.

Before actual UI integration, BUILD_RULES_HE.md section 12 requires visual approval.
Standalone review: docs/mockups/purchase-package-units-20261108.html and PNG.
Backend normalization and unit/CSV tests are ready; integration is pending that
approval. No production deployment has been performed for this change.

Verification: rounding (including exact multiples), alternate kg/unit, manual edited
supplier quantities, half-bundle validation, type/unit mismatches, invalid/overflowing
weights, server recomputation, mixed sheet/kg/package CSV and no business writes.
Rollback: revert the draft UI and export helper together; no data migration needed.

Full verification: npm test — 1152 tests passed, zero failures. Only the standalone
mockup and backend support have changed; the live purchase dialog remains unchanged
until visual approval.
