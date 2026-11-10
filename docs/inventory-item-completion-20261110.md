# Count-based item consumption and corrections

Owner: Inventory. D3 change; owner specified on 10 November 2026 that consumption
may happen per completed item, real cancelled production belongs to finished
goods, and only erroneous production reporting may return raw material.

The explicitly activated physical baseline is stocktake 1, 8 November 2026 at
20:56:41.574 UTC. Its seven-day creation window starts 1 November at the same
time. The 10 November coil-weight correction is not a new physical baseline.
Items already completed in the verified pre-count backup remain excluded even
if rescanned later. Eligible items require completed production after the count.
Shipment or whole-order status alone does not debit material.

`inventoryItemCompletion` owns the policy, current item allocation and append-only
revision events. Completion and measured-weight corrections reconcile the full
item debit, return the previous allocation to its original lots and allocate the
corrected amount atomically. Repeated identical reports do nothing. Shortage
rolls back both the return and the new debit and retains the reported weight for
retry. Straight material is matched by diameter, supply form and length.

Orders calls Inventory from its existing authorized, reasoned item-edit
transaction; it never writes material balances. A consumed reservation can be
superseded without deleting its history. Real cancellation keeps raw consumption
and uses the existing finished-goods/scrap disposition. The manager-authorized
`ERRONEOUS_PRODUCTION_RECORD` flow returns the corrected proportion of tracked
V1 consumption to its original lots, keyed by the immutable production correction
event. An ordinary status rollback is not proof that physical steel was unused.
V2 retains approved reports/reversals and its existing explicit reversal
requirement before erroneous-production correction; the item/count eligibility
gate also applies to approval. Mesh retains its separate sheet movement ledger.

No automatic historical refund is inferred from pre-count usage. Unknown
post-count usage requires reconciliation. No Orders/Production history is erased.
The old per-reservation completion implementation remains compatibility behavior
for installations without the explicitly activated policy.

Release evidence: `tmp/order-completion-20261110/production-before.db`, downloaded
10 November, integrity_check=ok, 111 orders and two stocktakes. SHA256
`d563fa321168ebdd45e48e0779075ea1adcce922053765a236ba042304d4aee4`.
Staging activation on a verified copy using the original pre-count backup found
1220 completed items to exclude, no newly eligible completed items to backfill,
and unchanged physical balances: coils 69784 kg, straight 45100 kg.

Maintenance tool: `tools/inventory-item-policy.cjs COPY_DB PRE_COUNT_BACKUP REPORT`.
It is never run by startup. Inspect its report on a copy before applying against
the live database under a fresh verified backup. Schema changes are additive.
Future full stocktakes require an explicit reviewed policy transition, rather
than silently treating every partial count or weight correction as a reset.

Rollback: retain all ledgers and backups; deploy the previous code only after
accounting for any new tracked movements. Restoring an old database over current
orders is not an acceptable code rollback. Tests cover cutoff boundaries,
duplicate/reopened reports, corrected weights, source-lot returns, shortages,
diameter/length changes, real cancellation and erroneous-production cancellation.
