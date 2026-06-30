# Private Reader Fixtures

Put problematic real EPUB, FB2, TXT, or PDF files here when debugging reader quality locally.

Rules:

- Never commit copyrighted, private, or user-supplied books.
- This directory is gitignored except for this README.
- Keep filenames descriptive enough to remember the issue.
- When a private file reveals a reproducible markup/rendering pattern, create a tiny synthetic public fixture in `dev/generate_reader_fixtures.py` instead of copying book content into the repo.

Local workflow:

```bash
# Example: copy a problematic local book here, but do not commit it.
# cp ~/Downloads/"Жила-была девочка.epub" dev/reader_fixtures/private/

.venv/bin/python dev/generate_reader_fixtures.py
scripts/local_quality_gate.sh
```

When this folder contains files, `scripts/local_quality_gate.sh` automatically
runs the private fixture gate and fails if a private book cannot open, render
enough visible text, show progress, avoid horizontal overflow, expose Aa,
change font size for text formats, or restore position.

To run the private check directly:

```bash
cd miniapp
npm run e2e:reader:private
```

To compare the same private file across reader modes:

```bash
cd miniapp
VITE_READER_UI=v2 npm run e2e:reader:all-engines
```

The summary report is written to:

```text
reports/reader-experiments/private-fixtures-summary.json
```

Per-mode private reports are written as:

```text
reports/reader-experiments/private-fixtures-summary-custom-clean-v2.json
reports/reader-experiments/private-fixtures-summary-custom-original-v2.json
reports/reader-experiments/private-fixtures-summary-foliate-view-clean-v2.json
```

The reports include detected format, title source, cover image/fallback state,
visible text length, overflow width, progress, Aa/font-size checks, restore
status, selected engine/mode, and screenshot path. They must not include raw
book content.

Private screenshots are saved under:

```text
reports/reader-experiments/screenshots/private-fixtures/
```

Screenshot review remains manual:

```bash
cd miniapp
npm run e2e:reader:screenshots
```

Do not deploy reader changes if public fixtures, private fixtures, or screenshot
review fail. If a bug should become permanent coverage, add a safe synthetic
fixture instead of committing real book content.
