# Production label printing — 2026-10-19

Owner: Orders. Risk: D0 (presentation only).

Production labels now have a white header with black text and no outer frames or internal separator lines. Eight labels still fit on one A4 sheet, with a 5 mm inset on all sides. Screen, browser printing and PDF export share these dimensions. The inset and white header were checked with a physical one-page test; border removal was subsequently requested explicitly.

The physical card stock also has a 7.5 mm non-printable marked strip at the top and bottom of every card. The complete card face (text, drawing, quantities and QR) is inset by 7.5 mm at both edges, so all content remains in the white center without changing the card or A4 dimensions.

This changes CSS in `services/productionCardPrintPage.js` and updates the existing layout assertions. Label content, QR payloads, order status, permissions and printer configuration are unchanged. No database, API or registry contract changes are required.

Validation: 103 targeted production-print and client-auth contract tests passed. Chromium checked the actual card renderer in screen and print media with nine fixture labels: eight on page one and one on page two, all within the sheet inset, zero frame widths, white headers, nine QR images and contained quantity/length footers. The resulting PDF has two A4 pages; the first-page screenshot was visually inspected. The full backend suite was not run for this CSS-only change.

The photograph from the other computer does not establish the cause of clipping there. This update must not be described as proof of a driver or printer diagnosis.

Rollback: revert the label-layout commit and deploy the reverted main branch. No data rollback is needed.
