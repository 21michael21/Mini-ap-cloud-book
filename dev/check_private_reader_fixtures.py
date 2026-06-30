from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent
PRIVATE_FIXTURES = ROOT / "private_reader_fixtures"
SUPPORTED_SUFFIXES = {".epub", ".fb2", ".txt"}


def main() -> None:
    PRIVATE_FIXTURES.mkdir(parents=True, exist_ok=True)
    files = sorted(
        path
        for path in PRIVATE_FIXTURES.iterdir()
        if path.is_file() and path.name != "README.md"
    )
    supported = [path for path in files if path.suffix.lower() in SUPPORTED_SUFFIXES]
    unsupported = [path for path in files if path not in supported]

    print(f"Private reader fixtures: {PRIVATE_FIXTURES}")
    if not files:
        print("No private EPUB/FB2/TXT files found.")
    else:
        for path in supported:
            print(f"OK   {path.name} ({path.stat().st_size} bytes)")
        for path in unsupported:
            print(f"SKIP {path.name} (unsupported suffix)")

    print("\nLocal workflow:")
    print("1. Put problematic EPUB/FB2/TXT files in dev/private_reader_fixtures/.")
    print("2. Reproduce locally by sending the file to the dev bot or by creating a tiny synthetic case in dev/generate_reader_samples.py.")
    print("3. Run:")
    print("   .venv/bin/python dev/generate_reader_samples.py")
    print("   .venv/bin/python dev/seed_reader_harness.py")
    print("   cd miniapp && npm run build:harness")
    print("\nDo not commit private or copyrighted books.")


if __name__ == "__main__":
    main()
