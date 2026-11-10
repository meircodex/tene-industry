# Shape editing, names, delivery policy and reversible removal

Owner: Orders. Dependencies: Catalog persistence / permissions, shared steel
commercial policy. Impact D1: user-triggered updates to existing shape columns
and audit rows. No schema migration, order rewrites, inventory or machine writes.

Reproduced: changing product family during catalogue editing called
`_loadPreset`, cleared `_catalogueEditTarget`, and switched back to template
mode. Saving could therefore create a different shape instead of updating the
selected one. The editor now retains the original target ID and expected
revision across geometry changes. Explicit new-shape mode remains separate.

The floating picker now has manager/admin edit and remove buttons beside each
drawing. Edit opens the current catalogue revision, its editable name, and
expanded `סעיפים בתעודת משלוח / בסיסי חיוב הצורה` controls. The confirmation
button says `עדכן צורה בקטלוג` and opens the catalogue save form rather than
approving an order item. Normal item dimensions still use `אשר צורה` and never
update catalogue defaults implicitly. Existing saved order snapshots retain
their original geometry, names, catalogue versions and billing policies.

Removal sets `shapes.active=0` and increments `definition_version`; restore sets
it to 1 and increments the revision again. Both require manager/admin plus the
expected version. Existing IDs, reserved numeric SKUs, definitions and references
remain. A previously unchanged builtin is retained as a complete inactive
definition so restoration preserves the actual geometry and policy. GET includes
`hiddenBuiltinIds` for staff to suppress the static fallback. Only management
roles receive `archived` metadata and restore controls. A restored builtin is
shown once as its saved override. Failed mutations do not remove picker cards.

Legacy device-local shapes can be removed/restored locally. Editing one into
the shared catalogue requires a unique numeric SKU; the local original is
archived only after a successful shared save. Archive content is preserved when
additional local shapes are written. Local changes do not claim cross-device
synchronization.

Delivery policy controls select material/processing kg bases and per-unit
additions. Material mass is counted once; units remain item quantities. These
are the existing order/document summary lines, not a new price list or a new
monetary calculation. Delivery certificates remain price-free.

Scope: editor and four cache references, savedShapeCatalog, catalog routes and
server audit dependency, existing widget contract and tests. Validation:
fixture-only browser checks for shared/default/overridden entries, rename,
geometry changes, delivery policy, permissions, remove/restore, keyboard/overlap;
isolated HTTP checks for authorization, versions, audit and immutable documents;
full serial Node suite. No production sample shape/order is created or removed.

Rollback: revert the release code and redeploy; no schema rollback. Archived
rows and all order snapshots remain recoverable. An old client does not
understand hiddenBuiltinIds and can show a static builtin fallback again; reload
clients after deploying the fix. Restore through the supported UI for normal
undo. Do not delete retained rows to roll back.
