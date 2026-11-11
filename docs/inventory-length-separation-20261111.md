# Straight-bar length separation and estimated bar counts

Owner: Inventory. Dependencies: Orders item shape snapshots and Steel/Rebar's
canonical `rebarKgPerMeter` table; Procurement consumes the planning projection.
Data impact: D0, SELECT-only projection and editable local purchase draft.
No schema, stock adjustment, consumption, allocation, status or environment changes.

## Contract

`GET /api/procurement/plan` retains its role guards and existing quantities.
Groups now include `nominal_length_mm`, `requires_length_review`,
`available_stock_kg`, `unit_weight_kg` and `estimated_bar_count`.
Identity is diameter + supply form + nominal length for straight bars.
Coils remain continuous material and have no bar count or nominal length.
Mesh units and exact-spec planning are unchanged.

- Physical stock uses approved active lot `nominal_length_mm`.
- V1 reservation and V2 requirement demand resolve length from the item's lift
  shape metrics, consistent with the existing item-completion length guard.
  Developed bent-bar lengths are never treated as raw straight-bar lengths.
- Confirmed legacy incoming uses `purchase_orders.specification_json`'s explicit
  `nominal_length_mm`. Missing length remains unassigned; it does not offset a
  known-length shortage. Existing date cutoffs remain in force.
- Unknown straight lengths have a review row when nonzero. They do not imply
  coverage, even by other stock of unknown length. Empty legacy unknown rows
  are omitted. Standard 6m and 12m rows remain visible, including zero stock.
- Already consumed mass is credited only to the same length identity.
- Estimated physical bars = floor(physical kg / (canonical kg/m × length m)).
  Count is an estimate, never a verified piece count; unknown length or negative
  stock has a null count. Calculations keep full precision; kg and bar counts
  display as whole numbers. Length is a separate column, not specification text.
- Each length shortage creates its own editable purchase-draft line with
  `length_m` prefilled. Existing same-form 30t minimum and bundle units remain.
- Safety allowance is per displayed identity. The 10t trigger and 30t supplier
  order policy remain per supply form, allowing other diameters/lengths to fill
  the same order without allowing their stock to hide individual shortages.

Scope: services/inventoryPlanning*.js, public/inventory*.{html,js},
public/data-contracts-client.js, focused tests and documentation. No changes to
the separate V2 coverage/recommendation APIs, which continue advertising their
partial identity contract, or to material consumption writes.

## Approval, verification and rollback

Owner approved the standalone visual preview in this chat on 2026-11-11, including
separate length and estimated-count columns and deployment.
Verified pre-deploy backup: `tmp/before-length-separation.db`, downloaded through
the admin backup flow. SHA256
`aad537ad9e22218b14a4d9f322ac89050bceddacbe127f3da5f414889db0d2a6`,
SQLite integrity `ok`; 111 orders, 1661 items, physical raw stock 110130.795kg.
Stage uses an isolated copy plus explicitly local test demand, never production
writes. Tests cover cross-length stock/incoming, unknown identity, date cutoff,
V1/V2 separation, prepaid use, count formula and read-only database equality.

Rollback: revert this commit and deploy previous source. No database restore or
inventory re-entry is required. Handoff: unknown lengths require an explicit
business correction; never guess length from diameter, lot notes or developed
bent-bar geometry. Counts are estimates based on the supplied approximate mass.
