# Machine station bridge 1.1

The central application stores requested manufacturing intent independently of source shape geometry and receives immutable reports from registered machine stations. The station owns acquisition and local execution evidence. This web release contains generic contracts and integration code; it does not contain machine programs, factory captures or vendor parameter backups.

`routes/machineStation.js` mounts under the production module. Its `StationInbox` service owns only `mi_station_bindings`, `mi_station_messages` and `mi_manufacturing_intents`. It reads the existing machine directory and never updates source shapes, orders, production counts, PLC parameters or authoritative Quality records.

| API | Permission | Behavior |
| --- | --- | --- |
| POST `/api/machine-integration/stations/register` | manager/admin | Registers a source against one logical and one central machine. Credential is returned once and stored as a hash. Silent retargeting is rejected. |
| POST `/api/machine-integration/station-events` | production/maintenance/manager/admin plus station credential | Validates source scope, whole-content hashes, timestamps, owner/message types and byte/count limits. Exact duplicates are acknowledged; conflicts roll back the batch. |
| GET `/api/machine-integration/station-events` | authorized production/office/maintenance/management | Returns paged station reports, retaining station-report authority. |
| GET `/api/machine-integration/manufacturing-intent` | authorized production/office/maintenance/management | Looks up the latest intent by shape identity/version, complete geometry hash and central machine. |
| POST `/api/machine-integration/manufacturing-intents` | office/manager/admin | Saves an immutable optimistic revision after shared shape/intent validation. Emits audit and module-map events. |

The shape editor opens an isolated compact manufacturing-intent dialog. Each bend retains approach, plate requirement, radius/reference and tool. Dimension reference, starting segment and reverse order are explicit. The same canonical geometry hash is used by browser and server. A geometry or machine change cannot inherit another intent accidentally. Original dimensions are unchanged.

Saved intent has status `requested_not_machine_qualified`. AUTO requires verified station rules; manual choice does not override capabilities or physical interlocks. Saving intent never starts a machine or writes a recipe. Job/transfer/measurement messages are reported evidence, not permission to mutate another module's records.

Validation: shared contract/service tests, route authorization/governance, full main-application tests and an actual browser save/reopen test against the central router with synthetic data. Local station distribution and physical qualification are tracked separately from this web release.

## Verified release — 14 November 2026

PR #16 merged as `3c76ed4`; live deploy `dep-dbs90qec6qcc738h9pg0` serves descendant `a8a9a5a`. All 1,277 tests in the web-only checkout passed. Nine browser save/reopen checks passed with synthetic data. Live checks passed for health, the editor cache version, button availability, exact tested module contents and anonymous-access rejection. No production manufacturing-intent or machine-control writes were performed for verification.
