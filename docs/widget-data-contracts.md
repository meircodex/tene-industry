# Widget Data Contracts

Every KPI, icon, badge, chart, and operational widget that displays business
data must have a data contract.

The contract answers:

- where the data comes from,
- which API fields are consumed,
- what the number actually means,
- which screen elements read it,
- who owns it,
- how risky the value is if it becomes wrong.

## Current Registry

`orderStatusCorrection` describes the Orders rollback dialog: the affected-item count comes from the server preview, excludes cancelled/stopped items, and accompanies explicit document choices. `itemStatusCorrection` continues to describe individual item rollback. Both preserve production quantities and history.

The first registry lives in:

- `public/data-contracts-client.js`

It is intentionally browser-readable and test-readable. The dashboard uses it
to stamp DOM elements with:

- `data-contract-id`
- `data-source-api`
- `data-source-fields`
- tooltip text with owner, source, fields, and meaning.

## Rule

No dashboard KPI or production-critical widget may be added without a contract.

If an API response field is renamed, moved, or split, update the contract in the
same change. Tests should fail when a widget reads business data without a
registered contract.

## Required Fields

```js
{
  screen: 'dashboard.html',
  owner: 'Dashboard / Production',
  source: { api: '/api/dashboard', fields: ['producedWeightToday'] },
  meaning: 'Total weight of items completed today, in kg.',
  consumers: ['kpiWeightToday', 'qsWeight'],
  risk: 'D1'
}
```

## Risk Levels

Use the same D0-D4 language from `docs/change-control-protocol.md`.

- `D0`: informational display only.
- `D1`: operational value that can affect daily decisions.
- `D2`: financial/customer-facing value or route-dependent value.
- `D3`: value that can trigger production, billing, delivery, or stock actions.
- `D4`: destructive/data-repair value; must not be exposed without explicit
  owner approval.

## Next Expansion

After dashboard KPIs, extend contracts to:

1. order detail drawer,
2. production queue cards,
3. print cards/A4 production documents,
4. inventory stock badges,
5. finance KPIs,
6. OCR/intake confidence badges (implemented as `intakeRecognitionConfidence`):
   source numeric scores only, absent scores shown as unknown; row score uses the
   minimum of the four core fields when all are provided. Operator approval is
   independent of recognition confidence.

## Item correction preview

`itemStatusCorrection` in `public/data-contracts-client.js` owns the orders dialog shipment explanation. The preview is authoritative for linked certificates, documented quantities and every affected line; only explicit cancellation releases document quantities. Work status never erases production or physical shipment history.
