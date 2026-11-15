# Existing worker card: optional machine feedback

Owner: Machine Integration Edge; dependencies: Production and Production Cards.
Data level: D2, additive tables only. This integration adds to `worker-visual.html`.
Original scan, printed card, status, quantity, inventory and DONE writes retain
their existing owners. No new worker page or scanner flow is introduced.

| Stage | Existing owner | Additive behavior |
| --- | --- | --- |
| Open card | Production | Background observation request to a registered station. |
| Work and adjust | HMI / PLC | Local recorder mirrors actual recipe values. |
| DONE | Production | Optional parameter question in the same action. |
| Successful receipt | Production | Optional local operator-attested recipe memory. |

The channel exposes no hardware writes, outputs, START, STOP or automatic recipe
application. Operator approval does not qualify controller mappings or establish
physical accuracy. Readback is not controller acceptance. Drawing dimensions and
angle conventions remain distinct from controller commands until qualified.

## Interfaces and ownership

- `/api/machine-feedback/stations`: paged registered source directory.
- `/api/machine-feedback/requests`: strict whitelist, actor/card scope, hashes.
- `/api/machine-feedback/requests/:id`: same actor and authorized card only.
- `/api/machine-feedback/snapshot`: station credential plus Production card
  authorization; does not create an extra scan activity.
- `/api/machine-integration/station-requests`, `/station-requests/result`,
  `/station-current`: existing role and registered-source credentials.

Machine Integration owns `mi_worker_requests`, `mi_station_presence`,
`mi_station_current`. The last table holds one latest mirror per source, so UI
refreshes do not append raw recordings to the central database. Full recordings
and approved parameter snapshots remain in identity-bound local databases.
Only the original successful DONE receipt for the exact card can trigger optional
confirmation. Changed or stale snapshots cannot be approved. Business completion
still succeeds when monitoring, learning or addon APIs are unavailable.

## Activation and recovery

Use the native monitor's existing central-connection form to authenticate and
select the actual machine entry. A physical machine number is not a database ID.
Source/card/run identities are checked at every boundary. Login does not enable
hardware writes. Back up the database and verify its persistent path before
deployment. Rollback restores prior code and retains additive tables, recordings
and memories; do not restore a database solely to roll back this UI feature.

Validation covers scope, authorization, idempotency, the original worker browser
with synthetic reads, business failure, controller disconnect, missing addon API,
card preservation and activity-free source reads. Actual device transfer and
physical accuracy require separate machine qualification.
