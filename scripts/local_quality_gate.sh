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
