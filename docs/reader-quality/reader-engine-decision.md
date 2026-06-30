# Reader Engine Decision Spike

Date: 2026-06-30

## Decision

Keep `custom + clean + v2` as the default reader path. Do not switch the production default to `foliate-view` yet.

The custom reader passed the public fixture matrix with reliable visible text, progress, font-size changes, and position restore. The strengthened `bad_markup.epub` fixture now covers weird nested markup, stripped scripts/styles, long Russian headings, and horizontal-overflow risk.

`foliate-view` is promising visually, but it is not ready for default use because the automated checks cannot reliably inspect rendered text through its internals, font-size changes are not observable, TXT restore fails, and teardown can throw inside `foliate-js`.

## Modes Tested

| Mode | Text engine | Render mode | UI | Public fixtures passed | Private fixtures passed | Recommendation |
| --- | --- | --- | --- | ---: | ---: | --- |
| custom-clean-v2 | `custom` | `clean` | `v2` | 8/8 | 0/0 | Keep as default |
| custom-original-v2 | `custom` | `original` | `v2` | 8/8 | 0/0 | Keep available for comparison only |
| foliate-view-clean-v2 | `foliate-view` | `clean` | `v2` | 2/8 | 0/0 | Not ready |

No private fixtures were present in `dev/reader_fixtures/private/` during this run, and the reported problematic book similar to "Жила-была девочка" was not found on this machine. Private results are therefore `0/0`; the workflow is ready, but the exact real book has not been reproduced locally. Private reports never include raw book content.

## Public Fixture Matrix

| Fixture | Format | custom-clean-v2 | custom-original-v2 | foliate-view-clean-v2 |
| --- | --- | --- | --- | --- |
| simple.epub | EPUB | Pass | Pass | Fail |
| bad_markup.epub | EPUB | Pass | Pass | Fail |
| multi_section.epub | EPUB | Pass | Pass | Fail |
| long_text.fb2 | FB2 | Pass | Pass | Fail |
| cp1251.fb2 | FB2 | Pass | Pass | Fail |
| long.txt | TXT | Pass | Pass | Fail |
| small.pdf | PDF | Pass | Pass | Pass |
| scanned_like.pdf | PDF | Pass | Pass | Pass |

The `bad_markup.epub` clean-mode regression specifically verifies that unknown nested tags are unwrapped instead of losing text, scripts/styles are removed, long Russian text wraps, and frame overflow stays within tolerance.

Source reports:

- `reports/reader-experiments/2026-06-30T19-28-11-654Z-custom-clean-v2.json`
- `reports/reader-experiments/2026-06-30T19-28-11-654Z-custom-original-v2.json`
- `reports/reader-experiments/2026-06-30T19-28-11-654Z-foliate-view-clean-v2.json`

## Screenshot Summary

Screenshots were written under:

- `reports/reader-experiments/screenshots/custom-clean-v2/`
- `reports/reader-experiments/screenshots/custom-original-v2/`
- `reports/reader-experiments/screenshots/foliate-view-clean-v2/`
- `tests/screenshots/artifacts/desktop-reader-bad-markup-clean.png`

The custom reader screenshots show readable text and stable v2 chrome. The foliate-view screenshots show visible text for text fixtures, but the automated DOM checks still report `visibleTextLength=0`; that is an e2e observability blocker for using foliate-view as a controlled engine in this app.

## Foliate-View Blockers

1. Text introspection is not reliable enough for the local quality gate. The screenshots are visibly readable, but e2e cannot prove visible text length through foliate-view's shadow/iframe internals.
2. Font size changes did not apply observably in all text fixtures: `before=16 after=16`.
3. TXT position restore failed: exercised `40%`, restored `0%`.
4. Cleanup can throw in `foliate-js`:
   `TypeError: Cannot read properties of undefined (reading 'destroy')` from `Paginator.destroy`.
5. Foliate-view strict EPUB/FB2/TXT tests are still skipped; only smoke reporting is active for that engine.

## Private Fixture Workflow

Place private/problem books under `dev/reader_fixtures/private/` and run:

```bash
cd miniapp && VITE_READER_UI=v2 npm run e2e:reader:all-engines
```

For each private fixture, the local report records detected format, metadata-or-fallback title source, cover image-or-fallback state, visible text length, horizontal overflow, progress visibility, Aa visibility, font-size behavior, restore behavior, screenshot path, and errors. It intentionally does not log raw book content.

## Bundle And CSP Risk

No CSP relaxation was added, no CDN was used, and the book iframe sandbox policy was not changed. The foliate-view spike remains behind `VITE_TEXT_READER_ENGINE=foliate-view`.

The current build already code-splits the experimental foliate engine into a small separate chunk, so VDS disk size is not the primary blocker. The real risks are lifecycle stability, controllable font/theme settings, restore semantics, and testability inside Telegram WebView.

## Recommendation

Recommendation A: keep `custom-clean` as the default text reader internals for now.

Do not change the production default. Use `foliate-view` only locally behind the feature flag until the blockers above are fixed and the same public plus private fixture gate passes.

Implementation TODOs before reconsidering foliate-view:

1. Make foliate-view destruction idempotent and non-throwing.
2. Expose or derive a reliable visible text signal for e2e without weakening sandbox/CSP.
3. Make font-size settings apply observably to foliate-rendered content.
4. Implement stable TXT restore or exclude TXT from foliate-view.
5. Run the two problematic private books through the private fixture gate.
6. Re-run `VITE_READER_UI=v2 npm run e2e:reader:all-engines` and require text fixtures to pass, not only screenshot review.

## Default Change

The engine default should not change after this spike.
