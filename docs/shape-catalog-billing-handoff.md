# Shape selection and commercial basis — 2026-11-08

Module owner: Orders.
Dependencies: steel-rebar domain rules, Catalog persistence, commercial summary and delivery documents.
Data level: D2 (additive catalog columns); existing order snapshots without an explicit billing policy keep their legacy classification.
Allowed scope: shape editor and its script consumers; shared commercial rules; shape catalog service/routes/schema; snapshot preservation; commercial summary/pricer basis metadata; relevant tests and data contracts.
No machine, PLC, inventory, deployment or existing order data changes.

## User requirements

- Preserve the existing editor design and proportional renderer.
- Replace the marked 3D notice with item code, an arrow and New shape. Catalogue opens only by activating that arrow, in a floating panel without layout movement.
- Existing shape: exact configured sides, no add/delete side; Enter/Tab traverse lengths, diameter, quantity.
- New shape: retain add-side editing, name and unique code, save to the shared catalogue. Keep real 3D data and editing available in authoring.
- Each shape exposes its explicit material/processing/unit billing bases. A hoop includes material by steel type, cutting kg, bending kg, hoop units. Chair/bench shares one unit charge. A material kg is counted once even when it supports several processing charges.
- Copy the policy and catalogue identity/version into the order snapshot. Never recalculate historic identity from a subsequently renamed catalogue entry.

## Data/rollback

Add nullable catalogue code/definition/billing columns and version to the existing shapes table, with an idempotent unique-code index. Existing rows are retained. Writes validate and run transactionally; duplicates do not overwrite. No production database is opened by development checks. Before any later production deployment, use the project's verified DB backup process.

Rollback: revert application code; leave additive columns and saved definitions in place. Do not delete new catalogue records or order snapshots. A pre-change runtime cannot interpret new explicit policies, so retain the new summary reader when rolling back UI alone.

Validation: isolated temporary SQLite migration/catalog/API/summary tests, browser keyboard and popup checks, existing commercial/document/shape tests, client/security/smoke and full suite for shared server/schema changes. Results are recorded below when complete.

Status: production deployment authorized on 2026-11-08. Prepared on `codex/shape-catalog-billing-20261108`; live deployment evidence is saved in the release report described below. Development did not modify the production DB or existing orders.

## שימוש

בעורך הצורות מזינים קוד פריט ומאשרים ב־Enter, או לוחצים על החץ כדי לפתוח את הקטלוג בחלון צף. בצורת מוט קבועה מקלידים אורכי צלעות, קוטר וכמות; הציור נשאר פרופורציונלי. ״צורה חדשה״ מאפשרת הוספת צלעות וכיפופים, ובשמירה מזינים שם ומספר צורה ייחודי. שמירה משותפת דורשת הרשאת מנהל, לפי הרשאות הקטלוג הקיימות.

פותחים ״בסיסי חיוב הצורה״ כדי לראות את חומר הגלם לפי סוג הברזל, העיבודים לפי ק״ג והתוספות לפי יחידות. חישוק מקבל חומר, חיתוך, כיפוף וחישוקים ביחידות. ספסל/כיסא מקבל סעיף כסאות ביחידות. בתוך ״הגדרת סעיפי חיוב״ אפשר להתאים את הסעיפים ואת תנאי החיתוך. ״שמור צורה״ מעדכן קוד משותף קיים בגרסה חדשה או יוצר קוד חדש. גרסאות שכבר הוכנסו להזמנות שומרות את הגדרת החיובים שלהן.

## Implemented connections

- The shared rule module is used by the editor, order commercial summary and pricer basis metadata; includes a separate smooth-material row.
- Server-side catalogue validates geometry, one material basis matching the family, unique case-insensitive codes, and stale-version updates. Built-in IDs are reserved. Legacy rows remain intact.
- New order serialization, order-detail editing, customer shape snapshots and intake corrections retain explicit policy and catalogue identity. Existing external OCR shape mapping cannot override an operator-selected product's commercial policy.
- Order API, A4 and delivery certificate read the order snapshot. A catalogue rename/change does not retroactively alter it. Historical items without a policy continue through the existing classifier.
- No processing rates were invented: `calcOrderPrice` retains material-only monetary calculation and explicitly reports that scope. This change connects billing bases/quantities, not a full processing tariff engine. Delivery documents remain price-free.
- Device-local legacy templates are shown as local. Failed shared loading/saving is visible; it never silently becomes a successful local-only shared save. Customer portal sessions do not gain staff catalogue access.

## Verification evidence

- Browser harness: `scripts/verify-shape-catalog-ui.js`, isolated in-memory catalogue. Checks popup remains closed on typing/ArrowDown, arrow-only opening without layout movement, Enter/Tab order, fixed topology, smooth hoop basis and snapshot, save/reload from a second page, saved custom templates remaining fixed, and true-3D bench preservation. Three consecutive final runs passed without browser errors.
- The fast keyboard check exposed legacy delayed focus callbacks that could pull the cursor back to an earlier side; these callbacks were replaced with immediate guarded focus.
- New catalogue service/HTTP tests cover idempotent migration, preserved legacy rows, duplicate codes, malformed geometry/policy rejection, authorization, stale updates, immutable order policy, hoop+chair coexistence and price-free A4/delivery output. SQLite integrity checks pass.
- Targeted regression run after serialization/intake fixes: 339 tests passed, including client auth, security, smoke and module governance.
- An earlier complete run passed 1,120 tests. A later parallel run passed 1,121/1,122 with one delivery-progress test process exiting without a diagnostic assertion; that test passed immediately in isolation. Final serialized-suite result is recorded below.

- Final serialized suite: **1,122 passed; 0 failed; 0 skipped** (45.4 seconds). Subsequent template sanitation of lift weighing was checked with the catalogue service/HTTP tests. Production stock measurements are never retained as a reusable shape default.

QA screenshots (isolated fixture): [hoop billing](<C:/Users/meir-tene/Documents/ChatGPT/מפעל ברזל/outputs/shape-catalog-implementation-20261108/hoop-billing.png>), [floating catalogue](<C:/Users/meir-tene/Documents/ChatGPT/מפעל ברזל/outputs/shape-catalog-implementation-20261108/floating-catalogue.png>).

## Integrated release verification — 2026-11-08

- Merged the current inventory release `637424e` and all prior main changes. Both catalogue and inventory schema initializers remain enabled. Only stale test literals were aligned with the already deployed enlarged production-card layout; that layout was not changed.
- Full integrated serial suite: **1,149 passed, 0 failed, 0 skipped**.
- Render target confirmed against the status, print and inventory chats: My Workspace (`tea-d8e6iv4p3tds73899nf0`), service `ironbend-hmd` (`srv-dafhkev40ujc73baups0`). Persistent disk `/data`, live `DB_PATH=/data/ironbend.db` and `ALLOW_EMPTY_DB_INIT=false` were verified during the inventory release immediately before this one.
- Verified downloaded DB backup SHA-256 `15641e467eba732502514b5891d97a7f30226a178169842919fc277a3202fb64`. SQLite integrity `ok`; zero foreign-key violations.
- Ran actual application startup and repeated schema initialization against an isolated copy with background jobs disabled. Every original column value is unchanged in 110 orders, 1,658 items, 110 pallets, 3 material lots, 152 usage rows, 1,524 reservations, 272 purchases and 12 shapes. Tested catalogue creation and revision in a rolled-back transaction. Auth migration dry run found zero pending PIN hashes.
- Backup, staging proof and final deployment evidence are outside Git under `C:/Users/meir-tene/Documents/ChatGPT/מפעל ברזל/outputs/shape-catalog-release-20261108/`. Do not commit database copies.
- Deployment changes application code and adds catalogue columns/index only; no sample orders or catalogue entries are written to production. Preserve the inventory release's accounting reader and the new billing-policy reader in any UI rollback.

## Shape fidelity correction — 2026-11-08

Owner: Orders, with shared renderer / Catalog dependencies. Data level D1; no new schema or automatic rewrite of existing data. Scope: template previews, editor geometry and dimensions, matching document renderers, numeric SKU validation, and explicit versioned built-in/shared catalogue editing.

- Fixed root causes: catalogue icons were unrelated to the selected side sequence; a fuzzy six/five-side detector invented rectangular closure tails; overlap separation shifted vertices (or shortened a neighboring print side). These transformations are removed. Only an exact four-side rectangular loop uses the rectangle renderer, without a fictitious closure hook. Overlap labels identify their side letters, stay separate and fit the editor viewport in both 2D and projected 3D. Stored lengths/angles and theoretical weight remain unchanged.
- Displayed SKUs are ASCII digits, 1–40 characters. Built-ins use 1–20 independently of their stable internal IDs. Leading zeros are retained. Existing snapshots keep their original identifiers; alphabetic legacy entries are not bulk-renamed. Reserved codes cannot be claimed through new-shape creation.
- Thumbnails use template geometry, including true 3D templates. Explicit SKU selection loads the stored default dimensions instead of blanking them. Managers/admins can choose **ערוך צורה בקטלוג** to load the latest template, change topology/name/SKU/billing, then **שמור צורה**. Editing starts from the catalogue, not the current order's unsaved dimensions. Other roles can enter order dimensions but do not receive catalogue editing/configuration controls. Server authorization and stale-version checks apply independently of UI visibility.
- Built-in editing creates `catalog-builtin-<internal-id>` at version 2, with a server-owned `builtinPresetId`. It replaces the matching catalogue choice rather than duplicating it. Further revisions keep the same ID. Existing order snapshots and their commercial bases are unchanged.
- Browser checks use an isolated in-memory database: exact six-by-50 cm reproduction, all six labels visible and separate in 2D/3D, arrow-only floating panel, numeric validation, built-in edit/reload, manager and ordinary-user UI, preserved keyboard flow and billing snapshots. No production sample orders/templates are created.
- Rollback: revert this correction's code; leave any saved catalogue revisions and order snapshots intact. Retain prior catalogue/policy readers and inventory release. Earlier UI lacks built-in override support, so a UI rollback temporarily hides those overrides rather than deleting them.
- Evidence is saved outside Git in `C:/Users/meir-tene/Documents/ChatGPT/מפעל ברזל/outputs/shape-fidelity-20261108/`.
- Final serial suite: **1,152 passed, 0 failed, 0 skipped**. Browser check passed after final geometry/permission changes, including all six 2D and 3D dimension boxes being separate and inside the viewport. Startup/repeated initialization on the verified backup copy preserved every original value in all eight audited tables (110 orders, 1,658 items); integrity `ok`, zero foreign-key violations. Numeric catalogue writes/revisions were rolled back after staging verification.
