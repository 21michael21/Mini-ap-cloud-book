#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

.venv/bin/python -m pytest -q
.venv/bin/python -m compileall backend bot

cd "$ROOT/miniapp"
npm install --cache ../.npm-cache
npm run build
npm run build:harness
npm run e2e:reader

PRIVATE_FIXTURE_COUNT="$(find "$ROOT/dev/reader_fixtures/private" -type f ! -name README.md ! -name '.*' | wc -l | tr -d ' ')"
if [[ "$PRIVATE_FIXTURE_COUNT" -gt 0 ]]; then
  echo "Found $PRIVATE_FIXTURE_COUNT private reader fixture(s); running mandatory private gate."
  npm run e2e:reader:private
else
  echo "No private reader fixtures found; skipping private reader gate."
fi

if [[ "${READER_SCREENSHOTS:-}" == "1" || "${1:-}" == "--screenshots" ]]; then
  npm run e2e:reader:screenshots
fi
