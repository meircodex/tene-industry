# File intake reliability — 2026-10-19

Owner: Intake / AI. Orders remains responsible for order creation and shape snapshots.

Goal: the office uploads a document, reviews the extracted order alongside the original,
and confirms once. Preserve geometry, every row and source linkage. Never silently drop
incomplete rows, fabricate recognition confidence, or create an order with missing core values.

Scope: existing quick upload, intake review, intake workflow and steel PDF parser; focused
regression tests. No redesign, database migration, production-data repair, or model change.
UI preview: `docs/mockups/intake-upload-review.html` (approved by Meir in chat on 2026-10-19).

Architecture: reuse intake_log and /intake/:id/approve, normalizeIntakeItem and existing
shape snapshot mapping. The upload remains a draft until the operator confirms.
Data level: D1 (existing intake/order writes). No changes to existing stored records.

Validation: upload routing and shape preservation; missing quantity/diameter/length;
parser review notes; known versus unknown PDF layouts; confidence absent versus measured;
approval atomicity/idempotency; full npm test and read-only live checks.

Local results: 1,083 tests passed, zero failures. Includes the 37-row TASSA fixture,
HTTP tests with an in-memory database and stubbed recognition responses, duplicate
uploads, incomplete approvals, canonical edits and browser-function flow tests.
Live verification is read-only: existing intake 31 and order 86. Recognition accuracy
on new customer scans still depends on source legibility; uncertain values remain for review.

Rollback: revert this task's commit and manually deploy the prior commit. No schema rollback.
Handoff: use the new ironbend-hmd Render service only. Existing production order 86 is read-only.
