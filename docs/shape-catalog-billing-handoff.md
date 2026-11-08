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

Status: implemented locally on `codex/shape-catalog-billing-20261108`; not deployed. Production DB and existing order data were not opened or changed during development.

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
