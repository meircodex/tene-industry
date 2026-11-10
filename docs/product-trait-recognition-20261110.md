# Product recognition from manually entered geometry

Owner: Orders. Dependencies: saved catalogue and pure steel-rebar geometry /
commercial modules. D1: explicit catalogue revisions can store recognition rules
in existing `definition_json`; approved future items receive recognition evidence
inside their existing shape snapshot. No migration, historic rewrites, price
changes, machine commands or inventory changes.

Scope: `modules/steel-rebar/shape-recognition.js`, shape editor, saved catalogue
service, static JS route and four editor consumers/cache references; API/widget
contracts and focused tests. The three recognition rules are enabled, allow
reversed entry, and allow reflection. Defaults: true, true, false. Managers/admins
edit these in the existing versioned catalogue flow. Existing definitions use
these defaults at read time; they are not rewritten by deployment.

The engine derives authoritative traits from numeric geometry, not product
names, icons, a bent-bar category, or a requested unit fee. Bar recognition uses
segment count and ordered directions, actual endpoint closure, indexed collinear
overlap pairs, planar/nonplanar rank, rounded-end mode, and real XYZ mode.
Three-dimensional pairwise direction products and signed volume retain bend
order and handedness independently of global rotation. Reversing the path and
reflecting it are separate product rules. The redundant terminal angle of a
closed template does not invent another segment. Lengths, quantity and diameter
can vary, provided geometric relationships such as closure and overlap remain.

Nonbar families require their explicit structured fields: a ring is distinct
from a spiral. The engine does not infer a curve from a flat bar silhouette or
infer stock source from the shape. Same-family products can still be ambiguous.

Preview recognition is provisional and never replaces entered dimensions.
Approval applies the sole matching active product's numeric SKU, catalogue
revision, name and **existing** billing policy. Multiple candidates block approval
until the operator selects one. No match blocks approval until a product is
explicitly assigned or saved to the catalogue. An explicit manual assignment
retains geometry and is recorded as `manual_assignment`, never as an automatic
match. A choice is invalidated by changes to the entered path or catalogue
revision. Disabled/removed/shared-device-local records are not automatic
candidates. Catalogue loading/failure cannot create an apparent verified match.
Explicitly selected products and historic order snapshots are not reclassified.

The order snapshot includes `productRecognition.version`, `method` (unique
geometry, candidate choice or manual assignment), `catalogIdentity` and a Hebrew
trait summary plus the numeric path fingerprint. Reapproval after an explicit
product's path changes records explicit catalogue reuse instead of claiming a
fresh automatic match. Definitions strip caller-supplied trait/evidence labels; GET
returns newly derived `recognitionTraits`. Existing role checks and catalogue
audit/version rules cover rule edits. Order creation follows its existing audit.

This release binds recognition to the existing billing policy. It does not add
a new price-list item editor or implement pending custom unit-price products.
Those remain a separate commercial-catalogue change; no invented rates or fees
are introduced here. A U product uses material/cutting/bending kilograms and
keeps its production piece count without creating a per-piece surcharge.

Validation: pure geometry cases for U/closure/overlap, rounded ends, mirror and
reverse rules, invalid data, nonplanar bench geometry and rings/spirals;
catalogue validation/version tests; fixture-only browser approval of unique U,
ambiguous rectangle and unmatched manual assignment with unchanged dimensions,
policies, quantity and evidence; existing editor/layout/permission regressions.
Full serial suite is required because the shared server/catalogue reader changes.
No test product, order or machine activity is created in production.

Rollback: revert this release and redeploy, leaving saved definitions and order
snapshots intact. Older clients ignore recognition rules/evidence but can read
the unchanged geometry and billing policy. No schema or data rollback.
