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
.venv/bin/python dev/seed_e2e_reader.py
cd miniapp
npm run e2e:reader
npm run e2e:reader:mobile
npm run e2e:reader:screenshots
```

The e2e suite seeds only public synthetic fixtures by default. Use private files manually while reproducing issues, then add a safe synthetic fixture if the bug should become permanent coverage.
