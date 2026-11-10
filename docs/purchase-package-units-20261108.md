# Purchase drafts in supplier units — 2026-11-08

Owner: Procurement. Inventory supplies read-only exact shortage kg; the draft owns
supplier quantity. Scope: draft UI, pure unit helper, CSV export. D0: no database
schema, stock, reservation, receipt or purchase-order writes.

The owner clarified that orders are discussed with suppliers in rolls for coils
and bundles for straight bars. Preserve exact kg shortages on the daily screen;
suggest ceil(shortage kg / estimated kg per supplier unit), initially 1586 kg per coil and 2050 kg per straight bundle as
corrected by the owner. The draft permits editing quantity and kg/unit, displays
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

Owner correction 2026-11-09: specification and length are separate fields.
The draft preview has distinct specification and length (meters) columns; CSV exports
length_m separately. Length applies to straight/bent bars, not coils or mesh sheets.
Unit export tests pass, including independent B500B / 12-meter values.

Corrections 2026-11-10: average coil weight is 1586 kg; bundles remain 2050 kg.
Display and CSV mass columns use whole kilograms, while exact kg values remain
internally available for calculation. Half-bundle quantities and meter lengths
retain their independent precision. Updated visual approval is still pending.


## Integration authorized by operational correction — 2026-11-10

The owner reports the active purchase dialog still has fractional kg and no bar
length and requests completing that behavior. The reviewed supplier-unit screen
is now integrated in the existing style. Roll and bundle drafts are separate;
length_m is mandatory for final straight-package exports. Kg summaries use whole
kg, while half bundles and internal shortage precision are retained.

Procurement policy starts at 10000 kg min stock, 30000 kg target, 30000 kg min order
per supply form, with available stock default and physical stock selectable. A
true diameter shortage also requires procurement even if another diameter has
surplus. Confirmed incoming is credited. The minimum is completed by a clearly
marked editable row; its diameter/spec/length are not invented. The user can split
or edit that row into other diameters of the same supply form. Export validates the
minimum and form on the server. CSV only; no supplier message or PO is sent.

The separate demand/consumption cutoff correction is NOT implemented by this UI
release. Inspection confirms current calls occur on item production completion,
and legacy reservations do not debit stock. The owner requires whole-order closure
after physical count with an order-creation eligibility window. Two facts are
pending: production-finished vs shipment closure; rolling seven days vs calendar
week. Do not silently activate or backfill either interpretation. The physical
count basis is 2026-11-08; its average-weight correction on 2026-11-10 must never
reset that cutoff. Preserve receipts, usage and previous count/correction history.

Verification: isolated browser fixture checks separate supplier form, whole counts,
bar length 12 in its own field, and CSV export for 15 bundles at 2050 kg (30750 kg).
Full suite before final small changes: 1167 passed. Rerun relevant checks for the
final diff. Reverting this UI release does not revert the owner's stock correction.
