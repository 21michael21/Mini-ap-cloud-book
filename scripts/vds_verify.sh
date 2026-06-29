#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/telegram-library}"
BASE_URL="${BASE_URL:-https://telegram-library.89.124.84.4.sslip.io}"

cd "$APP_DIR"

echo "== git =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git log --oneline -1
else
  echo "no git checkout in $APP_DIR"
fi

echo
echo "== docker compose ps =="
docker compose ps

echo
echo "== health =="
curl -fsS "$BASE_URL/health"
echo

echo
echo "== api version =="
curl -fsS "$BASE_URL/api/version"
echo
