# Private reader fixtures

Put problematic EPUB, FB2, or TXT files here when debugging reader rendering locally.

Do not commit user books or copyrighted files. This directory is gitignored except for this README.

Suggested local workflow:

1. Place a private file in this folder.
2. Reproduce the issue in the Mini App reader locally.
3. If you need durable test coverage, create a tiny synthetic fixture in `dev/generate_reader_samples.py` that mimics the markup problem without copying book content.
4. Run the reader harness:

```bash
.venv/bin/python dev/check_private_reader_fixtures.py
.venv/bin/python dev/generate_reader_samples.py
.venv/bin/python dev/seed_reader_harness.py
cd miniapp
npm run build:harness
```

To test the experimental `foliate-view` reader spike without changing the
production reader:

```bash
cd miniapp
VITE_READER_ENGINE=foliate-view npm run build:harness:foliate-view
```

Private files are for local reproduction only. When you identify a rendering pattern,
add a tiny synthetic fixture to `dev/generate_reader_samples.py` instead of copying
book text into the repo.
