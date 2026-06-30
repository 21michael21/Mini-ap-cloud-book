# Local Reader E2E

This is the local gate for reader quality changes. It runs against a seeded
SQLite backend and synthetic committed fixtures; it does not deploy anything.

## Generate Fixtures

```bash
.venv/bin/python dev/generate_reader_fixtures.py
```

Committed public fixtures live in:

```text
dev/reader_fixtures/public/
```

They cover:

- `simple.epub`
- `bad_markup.epub`
- `multi_section.epub`
- `long_text.fb2`
- `cp1251.fb2`
- `long.txt`
- `small.pdf`
- `scanned_like.pdf`

## Seed Local Backend

```bash
.venv/bin/python dev/seed_e2e_reader.py
```

The seed script:

- creates `dev/reader_e2e.sqlite3`
- creates a test Telegram user
- creates books/folders from public fixtures
- copies fixture files into `dev/reader_e2e_file_cache/`
- writes `dev/reader_e2e_env.json`
- prints backend and Mini App commands with valid `VITE_DEV_INIT_DATA`

## Run E2E

Install dependencies first:

```bash
cd miniapp
npm install
```

If Playwright reports a missing browser, install Chromium once:

```bash
cd miniapp
npx playwright install chromium
```

Run desktop reader e2e:

```bash
cd miniapp
npm run e2e:reader
```

Run mobile reader e2e:

```bash
cd miniapp
npm run e2e:reader:mobile
```

Save local screenshot artifacts:

```bash
cd miniapp
npm run e2e:reader:screenshots
```

Screenshots are written to:

```text
tests/screenshots/artifacts/
```

They are gitignored and are for human review today. Do not deploy reader changes
if these screenshots look broken, even when automated tests pass. Curated
baselines and visual-diff thresholds can be added later under
`tests/screenshots/baseline/`.

The screenshot pass captures:

- text reader controls visible
- text reader controls hidden
- Aa/settings sheet
- PDF fit width
- PDF zoomed
- library card with cover or fallback
- book actions sheet
- notes/bookmark sheet when available

## Private Problem Books

Put problematic real books in:

```text
dev/reader_fixtures/private/
```

Never commit copyrighted, private, or user-supplied books. When a private file
reveals a durable bug, create a tiny synthetic public fixture in
`dev/generate_reader_fixtures.py` instead.

When private files are present, the local quality gate automatically seeds them
into an isolated SQLite database and runs a mandatory reader check. The report
is written to:

```text
reports/reader-experiments/private-fixtures-summary.json
```

The report records only file names, detected format, booleans, visible text
length, overflow width, screenshot paths, errors, and selected engine/mode. It
also records whether the seeded book used extracted metadata or a fallback title
and whether the library card displayed an extracted cover image or a generated
fallback. It must not include raw book content.

The private gate fails when a private book:

- is not detected as EPUB, FB2, TXT, or PDF
- does not open the reader
- renders too little visible text, or a blank PDF stage
- creates horizontal overflow in the reader
- hides progress or Aa controls
- cannot change font size for text formats
- cannot restore position after close and reopen
- cannot show either an authenticated cover image or a fallback cover

To run only the private gate:

```bash
cd miniapp
npm run e2e:reader:private
```

To compare a problematic private book such as "Жила-была девочка" across the
current engine matrix:

```bash
cd miniapp
VITE_READER_UI=v2 npm run e2e:reader:all-engines
```

This writes per-mode private summaries named like:

```text
reports/reader-experiments/private-fixtures-summary-custom-clean-v2.json
reports/reader-experiments/private-fixtures-summary-custom-original-v2.json
reports/reader-experiments/private-fixtures-summary-foliate-view-clean-v2.json
```

## Full Local Quality Gate

```bash
scripts/local_quality_gate.sh
```

This runs:

- `.venv/bin/python -m pytest -q`
- `.venv/bin/python -m compileall backend bot`
- `cd miniapp && npm install`
- `cd miniapp && npm run build`
- `cd miniapp && npm run build:harness`
- `cd miniapp && npm run e2e:reader`
- private fixture checks if `dev/reader_fixtures/private/` contains files

To include screenshot capture in the same gate:

```bash
READER_SCREENSHOTS=1 scripts/local_quality_gate.sh
# or
scripts/local_quality_gate.sh --screenshots
```

## Deploy Rule

Reader changes must not go to VDS until all applicable local checks pass:

- public reader fixtures
- private problematic fixtures, when present
- screenshot review by a human

After any deploy, verify the running commit before phone testing:

```bash
curl -fsS https://telegram-library.89.124.84.4.sslip.io/api/version
```

## Interpreting Failures

- Fixture generation failure: the public fixture set is not reproducible. Fix
  `dev/generate_reader_fixtures.py` before touching reader code.
- Seed failure: database/cache assumptions drifted. Check model fields and
  `cache_path` naming.
- Browser launch failure: install Playwright Chromium locally.
- Reader text failure: check EPUB/FB2/TXT rendering, sanitizer, iframe load, or
  position restore.
- PDF DPR failure: check canvas backing dimensions, fit-width scale, and DPR
  clamp.
- Screenshot differences: artifacts are for human inspection until visual
  thresholds are introduced.

Current skipped e2e:

- Duplicate upload path. Local browser e2e seeds backend/cache directly and does
  not emulate Telegram document transport. Bot duplicate behavior remains covered
  by backend/bot tests.
