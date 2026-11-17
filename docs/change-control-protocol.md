# IronBend Change Control Protocol

This is the fixed "iron rule" for every new module, feature, fix, UI change, or
deployment. The goal is simple: no data loss, no duplicated ownership, and no
need to retest the whole system after every small change.

## Iron Rule

No change is ready unless it has:

1. One module owner.
2. One bounded file scope.
3. A data-impact decision.
4. A targeted test set.
5. A rollback note.
6. A handoff note for the next thread or agent.
7. A widget/data contract update when any visible KPI, badge, chart, icon, or
   document value reads business data.

If any item is unknown, the change is not ready to deploy.

## Module Ownership

Every task must name exactly one primary owner from `docs/module-inventory.md`.
Shared modules are allowed only as dependencies, not as vague ownership.

Examples:

| Change | Owner | Allowed dependency |
| --- | --- | --- |
| New order intake OCR | Intake / AI | Orders |
| Order detail window | Orders | Design System |
| Production queue card | Production | Orders |
| Customer credit | Finance | CRM |
| Database backup | Platform Core | DevOps |

## Data Impact Decision

Before editing code, classify the change:

| Level | Meaning | Required safety |
| --- | --- | --- |
| D0 | UI/read-only only | Syntax check + targeted UI/API test |
| D1 | Writes existing rows | Targeted route test + audit log/behavior check |
| D2 | Adds columns/tables/indexes | Backup note + migration test + rollback note |
| D3 | Changes existing data semantics | Backup required + staging verification + owner approval |
| D4 | Drops/renames/deletes data | Forbidden until explicit migration plan and verified backup |

Default to the higher level when unsure.

## Widget Data Identity

Any visual element that displays business data needs a contract. This includes
KPIs, icons, badges, charts, order cards, print cards, and warning chips.

Contracts live in `public/data-contracts-client.js` and are documented in
`docs/widget-data-contracts.md`. When a source API, field name, meaning, or
consumer changes, update the contract in the same commit.

## Database Rules

- Never use `DROP TABLE`, destructive `DELETE`, or column rename in production
  without a written migration plan.
- Existing production data is the source of truth. Code must adapt to it, not
  erase it.
- SQLite startup migrations must be additive and idempotent.
- Any import/OCR/order creation path must run inside a transaction.
- After any D1+ change, run or expose a read-only integrity check. Current tool:
  `GET /api/admin/data-audit`.
- Before production deployment of D2+, download a DB backup and verify
  `DB_PATH=/data/ironbend.db`.

See also `docs/data-safety.md`.

## Targeted Test Matrix

Use the smallest test set that covers the touched surface. Full `npm test` is
still required before pushing shared server/security changes.

| Change type | Minimum command |
| --- | --- |
| Server route/auth/status | `npm run test:security` |
| Browser/client contracts/nav/screens | `npm run test:client` |
| Order status or item status | `npm run test:status` |
| OCR/intake parser only | `npm run test:intake` |
| App smoke / critical pages | `npm run test:smoke` |
| Auth core only | `npm run test:auth` |
| Shared server, DB, permissions, or deploy risk | `npm test` |

## Change Checklist

Copy this into the commit or handoff when the change is more than a tiny UI
cleanup:

```text
Module owner:
Files touched:
Data level: D0/D1/D2/D3/D4
DB changes: none/additive/migration/destructive
Routes touched:
Screens touched:
Feature flags/env touched:
Targeted tests:
Full tests required: yes/no
Rollback:
Handoff:
```

## New Module Gate

A new module cannot be added to navigation or production deployment until it has:

- screen entry in `docs/screen-registry.md`,
- API ownership in `docs/api-registry.md` when it exposes routes,
- entity ownership in `docs/entity-registry.md` when it stores data,
- permission mapping in `docs/permission-registry.md`,
- at least one smoke or contract test,
- a feature flag if it is partial, experimental, or customer-specific.

## No Duplicate Agent Work

Parallel threads or agents may work at the same time only when each has:

- different primary module owner,
- different write scope,
- no overlapping DB migration,
- one handoff note in the repo before the next person starts.

If two agents touch the same module, one is explorer-only and one is worker-only.

## Deployment Gate

Before deploy:

1. `git status --short` is understood.
2. Relevant targeted tests pass.
3. `npm test` passes for server/security/data changes.
4. D1+ changes have a data audit or equivalent verification.
5. D2+ changes have a verified backup.
6. Render env is not changed casually; DB env must remain persistent:
   `DB_PATH=/data/ironbend.db`, `ALLOW_EMPTY_DB_INIT=false`.

## Emergency Stop

Stop deployment immediately if any of these appear:

- order created with 0 items,
- items exist without pallet,
- pallet exists without order,
- production queue item count differs from order detail count,
- Render starts with empty database,
- a migration silently resets data,
- an import path partially succeeds outside a transaction.

First action in an emergency: run `/api/admin/data-audit`, then back up the
current DB before attempting any repair.
