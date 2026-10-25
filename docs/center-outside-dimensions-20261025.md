# Centered external dimensions — 2026-10-25

- Owner: Production Cards; shared display-units geometry consumed by canonical server drawings and the shape editor.
- User requested every length at its own side's midpoint, outside the shape. User explicitly paused compact order-card changes; no card layout or compacting changes are included.
- D0 display-only. Remove the return-bend exception that moved the upright label above its corner and a horizontal arm label beside its end. Preserve midpoint-normal placement, outward direction and collision avoidance.
- No stored shapes, dimensions, quantities, document snapshots, order status, routes or permissions change. Existing saved certificate drawings stay immutable.
- Validation: short and tall return bends, reversed and mirrored paths, perpendicular midpoint placement, outward direction, canonical SVG regression, full npm test, local visual proof.
- Rollback: revert and deploy; no database rollback. Based on fc6dfa9.
