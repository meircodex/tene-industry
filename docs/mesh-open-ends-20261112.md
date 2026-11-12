# קצות רשת פתוחים — 12.11.2026

מאיר אישר תצוגה מקדימה של רשת המסתיימת בקוצים מכל הצדדים, במקום מסגרת סוגרת.

Owner: Steel/Rebar drawing; Orders/Production consume the shared preview and canonical item drawing. No schema, API, weights, bar-count rules, stored snapshots or stock changes.

MeshEngine keeps the existing counts and pitch, centering the drawn bars in the available spans so full-length bars extend beyond their outermost intersections. The visual bounding rectangle has no stroke. Existing explicit edges and all saved geometry remain untouched; this drawing adjustment is not a new fabrication margin or a stock calculation. The canonical schematic SVG used by item detail, production cards and delivery documents likewise draws inset crossbars with exposed ends. Print-card page sizing and safe zones are unchanged.

Asset references are refreshed for factory and customer editors. Verification: existing shape geometry and mesh stock tests, production print tests, syntax checks, npm test, and visual read-only inspection of the deployed editor. No production test order or inventory writes. Rollback is a code-only change.

Before-release evidence: 134 focused checks passed; npm test passed all 1,244 tests. A canonical 6000×2000 mm, Ø8, 200×200 mm case retains 10/30 bars and 47.41 kg. Canonical SVG line endpoints were checked: both sets of bars extend beyond their outermost intersections, with no enclosing perimeter.
