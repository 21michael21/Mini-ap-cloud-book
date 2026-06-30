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

They are gitignored. Curated baselines can be added later under
`tests/screenshots/baseline/`.

## Private Problem Books

Put problematic real books in:

```text
dev/reader_fixtures/private/
```

Never commit copyrighted, private, or user-supplied books. When a private file
reveals a durable bug, create a tiny synthetic public fixture in
`dev/generate_reader_fixtures.py` instead.

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
