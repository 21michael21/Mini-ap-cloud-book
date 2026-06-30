# A/B Reader Experiments

This workflow compares reader approaches locally on the committed fixture set before any production reader swap.

Experiments are local only. Do not set these flags on VDS until a reader decision is made:

- `VITE_TEXT_READER_ENGINE=custom|foliate-view`
- `VITE_TEXT_RENDER_MODE=clean|original`
- `VITE_PDF_READER_MODE=canvas|viewer-shell`
- `VITE_READER_UI=v1|v2`

Production defaults remain:

- `custom`
- `clean`
- `canvas`
- `v1`

## Run

Install dependencies and Playwright Chromium once:

```bash
cd miniapp
npm install
npx playwright install chromium
```

Run the stable custom reader:

```bash
cd miniapp
npm run e2e:reader:custom
```

Run the foliate-view experiment:

```bash
cd miniapp
npm run e2e:reader:foliate
```

Run the local comparison matrix:

```bash
cd miniapp
npm run e2e:reader:all-engines
```

The matrix currently covers:

- `custom + clean + canvas + v1`
- `custom + original + canvas + v1`
- `foliate-view + clean + canvas + v1`

`viewer-shell` is a reserved PDF experiment flag. It is not implemented yet; the app logs a warning and uses the stable canvas PDF reader.

## Reports

Each e2e run writes a JSON report under:

```text
reports/reader-experiments/<timestamp>-<mode>.json
```

Each record includes:

- fixture and format
- text engine
- text render mode
- PDF mode
- UI mode
- whether the book opened
- visible text length
- progress visibility
- position restore result
- font-size control result
- PDF canvas quality result
- screenshot path
- errors

Screenshots are saved under `reports/reader-experiments/screenshots/`. Reports and screenshots are intentionally gitignored.

## Decision Rule

Prefer the engine/mode that:

1. Opens the most public and private fixtures.
2. Shows enough visible text for real reading.
3. Keeps progress visible.
4. Restores position consistently.
5. Keeps font controls working.
6. Avoids CSP violations and sandbox regressions.
7. Has the smallest long-term maintenance burden.

Do not choose a reader mode only because it works on clean fixtures. Run the same command after adding private problematic books to `dev/reader_fixtures/private/`, and keep those files uncommitted.

## Known Blockers to Track

- `foliate-view` may expose different relocation/position semantics than the custom JSON locator path.
- `foliate-view` text access can differ from iframe access, so visible text and font-size assertions are intentionally reported rather than treated as a production gate.
- `viewer-shell` for PDF is not implemented in this local matrix yet.
