# דוח ייצור: טבלה קבועה וזהות עובד — 15.11.2026

Reports owns a read-only projection, not source scans, geometry, weights or access grants.

- Existing GET /api/reports/production-timing with unified=1&flat=1 returns exactly one row per card with start/end activity in the requested Israel-local period. Existing role gate (office/finance/manager/admin), date validation and pagination remain. Worker identities retain their existing office/manager/admin gate; finance receives timing without the worker activity projection. No new route or tables.
- Every data-column header toggles ascending/descending server sorting before pagination. Numeric values sort numerically, missing values stay last, item ID provides deterministic ties. CSV uses the same sort. The detail action has no sort.
- Checkbox menus: every categorical filter supports multiple values using validated JSON-string *_in parameters (maximum 50 values). OR within one field, AND between fields. Empty selection means all. Menus stay open while selecting; outside click/Escape closes them. Column selection is also in a compact dropdown.
- Filters: machine, diameter, material, customer, order, status, worker, activity kind, reliability and search. Filter before summary/page. CSV uses the same query across pages. Column selection changes presentation only. Each data header has an accessible hide button; the column picker restores hidden fields, with preferences remembered on that browser.
- Start-only and historical end-only rows remain visible. Completion quantities/weights are attributed only if canonical completion is inside the period. Multiple activity dates never multiply totals. Calendar, geometry, weight and reliability remain canonical services.
- Optional graphs beside the same table use the complete filtered deduplicated dataset before paging: daily weight, diameter weight, machine pace (trusted length / trusted exact minutes), reliability counts. Each chart has its own remembered display type: bars/line/pie for output; bars/line for pace; bars/pie for reliability. Pie charts combine categories beyond 11 into a remainder without losing totals. No chart derives raw weights or changes source data.
- Worker activity is read from Production event snapshots, with stable profile/device/user keys. Anonymous historic scans are not assigned to new workers. No writes or audit/event for this read-only endpoint.
- Removed report-topic/group UI and unrelated report API fetching. Existing API consumers remain compatible. The displayed dataset always consists of cards.
- Worker profiles remain in Admin > Workers & QR, with a shortcut from Users. Profile name/permissions/active status are checked for activated phones in both open and secure modes. Anonymous open scanning remains available as explicitly requested; QR_ACCESS_MODE is not changed by this release.
- Profile updates retain existing audit, now including active state. Activation uses current profile information and refuses inactive profiles. No historic scan identity rewritten.
- Validation: cross-day deduplication/totals, server-side filters, anonymous/start-only data, activated open identity, live permission/name changes and inactive denial, existing auth/governance suites, browser filter/columns/detail/CSV QA.

## Observed release verification

- Full suite: 1,323 passed; final focused suite: 98 passed.
- Deployed commit 02c4d22 / Render dep-dbssdol6e07s73aojbig is live; health endpoint returned 200.
- Live UI: one table, nine checkbox filter menus; A+B simultaneous selection; column hide/restore; numeric weight ascending/descending and matching CSV order. Local backup copy export: 131 rows, exclusively A/B and diameters 8/12.
- Four live charts rendered; daily line and diameter pie selected independently, retained after refresh. Date labels visibly separated. Screenshots kept in task-local tmp/graphs-live-final.png and tmp/live-checkbox-menus.png.
- Five worker profiles remain saved and not yet activated by workers. QR mode observed open. No historical anonymous identity rewritten and no test production weighing/scan/stock movement inserted.
