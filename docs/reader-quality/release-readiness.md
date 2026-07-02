# Reader Release Readiness

Date: 2026-07-02

## Current Defaults

The stable local reader defaults are:

- Text reader engine: `foliate-view`
- Text reading mode: `Pages` by default, with `Scroll` available as the
  per-user custom-reader fallback in the Aa sheet
- Text render mode: `clean`
- PDF reader mode: `canvas`
- Reader UI: `v2`

`original` text render mode and `viewer-shell` remain local experiments only.
They must not be deployed to VDS unless a later decision document explicitly
promotes them.

## Public Fixture Result

The stable default path is expected to pass all committed public reader
fixtures:

- `simple.epub`
- `bad_markup.epub`
- `multi_section.epub`
- `long_text.fb2`
- `cp1251.fb2`
- `long.txt`
- `small.pdf`
- `scanned_like.pdf`

The latest default-engine e2e produced
`reports/reader-experiments/2026-07-02T13-12-58-967Z-foliate-view-clean-canvas-v2.json`
with 9/9 public fixture records opened, 9/9 position restores, and 0 report
errors.

## Private Fixture Result

Private fixtures are gitignored and optional. At the time of this readiness
check, no private fixtures were present, so the private fixture count is `0/0`.

Before deploying reader changes that are meant to fix real problematic books,
place those files in `dev/reader_fixtures/private/` and require the private
fixture gate to pass. Do not commit private or copyrighted books.

## PDF Result

The PDF decision remains `canvas`.

Canvas mode is considered acceptable for alpha because the PDF decision spike
verified:

- high-DPI backing pixels
- fit-width layout without horizontal overflow
- zoom in/out and fit-width reset
- rapid navigation stability
- page restore
- visible rendering for vector and scanned-like fixtures

`viewer-shell` remains experimental because it adds bundle/UI surface and has
not been proven in Telegram WebView.

## Screenshot Review Checklist

Review these screenshot artifacts before deploying reader-facing changes:

- text reader controls visible
- text reader controls hidden
- Aa/settings sheet
- PDF fit width
- PDF zoomed
- scanned-like PDF
- library card with cover or fallback
- book actions sheet
- rename sheet
- remove confirmation
- manage folders sheet
- possible duplicate row

Screenshots are human-review gates for now. Do not deploy if they look broken,
even when automated tests pass.

## Known Limitations

- Private fixture result is empty until real problematic books are placed
  locally.
- `foliate-view` is now default for text reading, but the custom scroll reader
  remains available as a fallback for books that fail to open in paginated mode.
- PDF text layer is still a TODO; scanned PDFs are rendered visually but are not
  OCR/searchable.
- The "Open similar item" duplicate action needs an API shape that exposes the
  similar book id; the current API exposes only `possible_duplicate`.

## VDS Deploy Verdict

Reader UI v2 and paginated text reading are ready as the stable local/default
paths after the quality gate and screenshot e2e pass. This is not a deploy
approval by itself: VDS was not touched in this task, and production environment
variables must not be edited unless a separate deploy task explicitly requests
it.
