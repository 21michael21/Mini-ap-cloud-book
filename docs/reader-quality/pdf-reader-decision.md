# PDF Reader Decision Spike

Date: 2026-06-30

## Decision

Keep `VITE_PDF_READER_MODE=canvas` as the default PDF reader for alpha.

The current canvas reader is good enough for alpha after the high-DPI, zoom,
fit-width, render queue, and restore checks. Do not switch to a PDF.js
viewer-shell yet. The viewer-shell flag remains experimental-only; there is no
production-ready viewer-shell implementation in this spike.

## Canvas Results

Verified with `VITE_READER_UI=v2` against committed PDF fixtures:

| Fixture | Opens | DPR backing pixels | Zoom | Fit width | Rapid nav stable | Restore | Nonblank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `small.pdf` | pass | pass | pass | pass | pass | pass | pass |
| `scanned_like.pdf` | pass | pass | n/a | pass | n/a | n/a | pass |

Additional mobile viewport run passed the same PDF checks. Fit-width verifies
that the PDF canvas stays inside the reader stage without horizontal overflow in
the mobile viewport.

## Screenshot Artifacts

Generated artifacts for human review:

- `tests/screenshots/artifacts/desktop-pdf-fit-width.png`
- `tests/screenshots/artifacts/desktop-pdf-zoomed.png`
- `tests/screenshots/artifacts/desktop-pdf-scanned-like.png`
- `tests/screenshots/artifacts/desktop-pdf-reader.png`
- `tests/screenshots/artifacts/desktop-reader-v2-pdf.png`

No `pdf-error-state` screenshot was generated because the committed fixture set
does not currently include a deliberately broken PDF path.

## Viewer-Shell Feasibility

PDF.js ships same-origin viewer assets in `pdfjs-dist`, so a viewer-shell is
technically feasible without CDN access or raw Telegram URLs. It would still
need a separate implementation to load authenticated Blob/File bytes, fit the
Telegram WebView, preserve strict CSP, and integrate with Reader UI v2.

The main concerns are:

- More bundle and CSS surface: `pdf_viewer.mjs` and `pdf_viewer.css` add a
  sizeable viewer layer on top of the existing local PDF.js worker.
- UI duplication: PDF.js viewer chrome would need to be stripped or reconciled
  with Telegram Library's top bar, Aa sheet, bottom progress, and restore model.
- Mobile behavior risk: the full viewer has its own scroll, scale, history, and
  event model that must be proven in Telegram WebView before becoming default.
- Maintenance cost: viewer-shell would be a second PDF integration path until it
  fully replaces canvas.

Because the canvas reader now passes the alpha quality checks, viewer-shell is
not worth enabling by default yet.

## Memory And Disk

The canvas path renders client-side from authenticated file bytes. It does not
pre-render pages on the server and does not store permanent PDF page images.
The reader keeps a small page cache only around the current page, avoiding many
live canvases in memory.

## Recommendation

Use canvas mode for alpha. It is acceptable for current alpha testing because:

- High-DPI backing pixels are verified.
- Zoom and fit-width are verified.
- Rapid navigation resolves to the latest requested page.
- Page restore is verified.
- Both vector-text and scanned-like PDF fixtures render visibly.

Only prototype viewer-shell later if real private PDFs still fail after this
canvas quality pass. That future spike should import the local PDF.js viewer
assets, disable unneeded viewer chrome/download controls, load from the existing
authenticated Blob, and run the same public/private fixture gates before any
default change.
