# פורטל עובד אישי — 15.11.2026

## Approved scope

Personal username/password login; phone-first home, QR/barcode/manual card entry, canonical card view and forward status actions. Default permissions: start production, complete production, mark loaded. Manager can restrict each action. Latest user instruction explicitly removes machine selection and limits this phase to scanning/status; no machine choice or mutation, storage, weighing, partial production or order editing on this screen. Language he/en/th is selected only inside the gear menu and persists per account. Same menu signs out/switches employee. No general application navigation.

## Ownership and contracts

- Auth owns bcrypt password hashes (never plaintext), portal-only JWT claim, auth version, language and session revocation in existing users/refresh_tokens. Existing PIN users unchanged. Password length at least 8 characters, maximum 72 UTF-8 bytes. Username 3–40 letters/numbers/dot/dash/underscore. Provisioning cannot convert or take over a privileged existing account.
- Admin/worker access owns worker_portal_accounts: unique worker profile ↔ user mapping and permissions JSON. Existing worker QR profiles are reused. QR activation mode remains unchanged and is independent of personal portal login. Disabling the profile or account takes effect at the next request; password reset and sign-out revoke portal access/refresh sessions.
- Production owns card reads, statuses, machine assignment, timing and inventory effects. routes/workerPortal.js is mounted inside existing Production license gate and delegates card/status to the same handlers as worker-card; no parallel manufacturing or stock logic. Every action uses the authenticated user/profile, ignoring shared phone enrollment identity.
- Status writes require request_id and expected_status and accept only card/status/expected_status/request_id. No machine fields, quantities, prices or arbitrary client identity. Forward steps only. Repeated request returns original receipt; a new request for the same status is a no-op preserving completion time and stock. Receipt fingerprints include portal actor so another worker cannot replay it.
- Read-only recent work is paginated and restricted to that user. Reports map authenticated and activated-device identities back to the same worker profile, retaining historical name snapshots and leaving anonymous past scans anonymous.

## API and UI

- POST /api/auth/worker-login: rate-limited username/password, portal accounts only; normal login compatibility redirects portal accounts to the portal.
- Admin only GET/PUT /api/worker-profiles/:id/portal-account: provision/update username/password, active state, language and start/complete/load permissions. Atomic access audit excludes secrets. UI: Admin > Workers & QR > Portal next to a saved employee, with shareable generic portal URL.
- Authenticated linked worker only GET /api/worker-portal/me, GET /api/worker-portal/history?page=1&limit=10 (max 50), PATCH /api/worker-portal/preferences (language only), GET /api/worker-portal/card?card=...&original=1, PATCH /api/worker-portal/card/:id/status.
- Portal-only credentials are rejected from general application APIs and general WebSocket broadcasts. Authentication checks live user active/version; portal guard checks profile active/current permissions. Existing anonymous/open QR flow stays available as requested.
- public/worker-portal.html has its own shell. No nav.js, machine control or general module links. Gear menu contains one language selector and sign-out. Hebrew is RTL; English/Thai are LTR. Business customer names and original printed card remain source data.
- Full-quantity completion/loading use an in-page translated confirmation, not OS/browser dialogs. Save success requires the server receipt. Unknown network outcome retains the exact idempotency request for retry; it never declares success offline. Camera tracks stop on leaving/hiding the scan view; late camera permission/decoded frame cannot reopen a departed screen.

## Validation

HTTP tests cover personal identity with shared-device header, auth isolation, no privileged-account takeover, default and updated permissions, password hashing/reset/logout revocation, profile suspension, pagination, language persistence, shared start/finish/load, stale/backward transitions, same-status no-op and actor-bound retries. Camera adapter tests cover QR detection and both asynchronous cancellation races. Dictionary coverage verifies all three languages. Full suite plus auth/governance regression required; local QA uses a copied database and synthetic order only. No worker production passwords are chosen automatically and no production scan is fabricated.

## Observed release verification

- Integrated on top of 73d7cf7 (existing worker-machine feedback retained). Full suite: 1,338 passed. Final account-entry explanation: 14 focused tests passed.
- Local copied database: personal login, canonical manual QR-code entry, start/full completion/loading, own history, logout, Hebrew/English/Thai and translated in-page confirmations observed. Camera adapter tests cover detection and cancellation; no claim of a physical phone-camera scan.
- Live commit 150aad3, Render deploy dep-dbt2g76i0phs73egmj1g is live, health 200. Worker login page and Thai/RTL-LTR switching observed; admin account dialog for a real saved employee showed all three status permissions selected, required initial password, and language setting. Five existing profiles retained. No production worker passwords or fake production scans created. Existing QR access mode observed open.
- Generic persistent employee link: https://ironbend-hmd.onrender.com/worker-portal.html. Manager sets credentials/language per employee from Admin > Workers & QR > Portal. Existing admin accounts receive a clear request for personal worker sign-in, rather than a disabled-portal error.
- Proof: task-local tmp/portal-account-live.png. Temporary database copies and screenshots stay outside Git.
