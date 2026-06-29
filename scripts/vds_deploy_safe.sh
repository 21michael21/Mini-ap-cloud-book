#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/telegram-library}"
BASE_URL="${BASE_URL:-https://telegram-library.89.124.84.4.sslip.io}"
MIN_FREE_KB="${MIN_FREE_KB:-2621440}" # 2.5 GiB

cd "$APP_DIR"

free_kb() {
  df -Pk "$APP_DIR" | awk 'NR == 2 {print $4}'
}

print_commit() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git rev-parse HEAD
  else
    echo "no git checkout in $APP_DIR"
  fi
}

build_commit() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git rev-parse HEAD
  else
    echo "unknown"
  fi
}

print_state() {
  echo "== commit =="
  print_commit
  echo
  echo "== df -h =="
  df -h
  echo
  echo "== docker system df =="
  docker system df
}

ensure_free_disk() {
  local available
  available="$(free_kb)"
  if (( available >= MIN_FREE_KB )); then
    echo "Free disk is OK: ${available} KiB available."
    return
  fi

  echo "Free disk is low: ${available} KiB available. Running safe Docker prune."
  echo "This does not remove named volumes, Postgres data, or ./file_cache."
  docker image prune -f
  docker builder prune -f --filter "until=24h"

  available="$(free_kb)"
  if (( available < MIN_FREE_KB )); then
    echo "Still not enough free disk after safe prune: ${available} KiB available." >&2
    echo "Need at least ${MIN_FREE_KB} KiB before Docker build. Aborting." >&2
    exit 1
  fi
  echo "Free disk after safe prune is OK: ${available} KiB available."
}

print_state
echo
echo "== pre-build disk guard =="
ensure_free_disk

echo
echo "== git pull =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
else
  echo "Skipping git pull because $APP_DIR is not a git checkout."
fi

DEPLOY_COMMIT="$(build_commit)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "== docker compose build =="
docker compose build \
  --build-arg "GIT_COMMIT=${DEPLOY_COMMIT}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  --build-arg "APP_ENV=production"

echo
echo "== docker compose up =="
docker compose up -d

echo
echo "== docker compose ps =="
docker compose ps

echo
echo "== health =="
curl -fsS "${BASE_URL}/health"
echo

echo
echo "== api version =="
curl -fsS "${BASE_URL}/api/version"
echo

echo
echo "== deployed commit =="
print_commit
