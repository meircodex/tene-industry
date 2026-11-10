# Inventory whole-kg presentation — 2026-11-10

Owner: Inventory. D0, presentation only. The user explicitly requested removing
fractional kilograms/grams. Preserve existing layout, stock basis, source values,
reservations and demand calculations. Daily weights, count previews and pending
receipt weight summaries display nearest whole kg. Manual mass controls step in
whole kg; meter lengths, diameters, percent allowances and half-bundle quantities
retain their independent precision. Remove unused fmt1 and version the changed
client assets. Supplier-unit purchasing remains a separate pending UI review.

No database migration or operational data writes are included in this code change.
The separately authorized coil-average correction is stocktake 2: delta -20416 kg,
44 coils at reported average 1586 kg, physical coils 69784 kg. Straight stock remains
45100 kg. Correction was staged, backed up, replay-tested, and preserves every
receipt/use/scrap counter and all non-coil lots, orders and reservations.

Verification: JavaScript syntax checks and existing client/governance checks.
Rollback: revert these presentation files only; do not reverse the owner's stock
correction or restore an old database to roll back display formatting.
