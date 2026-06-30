# Private Reader Fixtures

Put problematic real EPUB, FB2, TXT, or PDF files here when debugging reader quality locally.

Rules:

- Never commit copyrighted, private, or user-supplied books.
- This directory is gitignored except for this README.
- Keep filenames descriptive enough to remember the issue.
- When a private file reveals a reproducible markup/rendering pattern, create a tiny synthetic public fixture in `dev/generate_reader_fixtures.py` instead of copying book content into the repo.

Local workflow:

```bash
.venv/bin/python dev/generate_reader_fixtures.py
scripts/local_quality_gate.sh
```

When this folder contains files, `scripts/local_quality_gate.sh` automatically
runs the private fixture gate and fails if a private book cannot open, render
enough visible text, show progress, or restore position.

To run the private check directly:

```bash
cd miniapp
npm run e2e:reader:private
```

The summary report is written to:

```text
reports/reader-experiments/private-fixtures-summary.json
```

Screenshot review remains manual:

```bash
cd miniapp
npm run e2e:reader:screenshots
```

Do not deploy reader changes if public fixtures, private fixtures, or screenshot
review fail. If a bug should become permanent coverage, add a safe synthetic
fixture instead of committing real book content.
