#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
BASE_URL="${BASE_URL:-https://telegram-library.89.124.84.4.sslip.io}"
MIN_FREE_KB="${MIN_FREE_KB:-2621440}" # 2.5 GiB
REF="${1:-main}"
MODE="deploy"

usage() {
  cat <<'USAGE'
Usage:
  deploy/vps/deploy.sh [git-ref]
  deploy/vps/deploy.sh --rollback <previous-ref>

Environment:
  APP_DIR=/opt/telegram-library
  BASE_URL=https://telegram-library.89.124.84.4.sslip.io
  MIN_FREE_KB=2621440
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--rollback" ]]; then
  MODE="rollback"
  REF="${2:-}"
  if [[ -z "$REF" ]]; then
    echo "Missing rollback ref." >&2
    usage >&2
    exit 2
  fi
fi

cd "$APP_DIR"

compose() {
  if [[ -f "$APP_DIR/docker-compose.yml" ]]; then
    docker compose -f "$APP_DIR/docker-compose.yml" "$@"
  else
    docker compose --project-directory "$APP_DIR" -f "$APP_DIR/deploy/vps/docker-compose.yml" "$@"
  fi
}

free_kb() {
  df -Pk "$APP_DIR" | awk 'NR == 2 {print $4}'
}

diagnostics() {
  local exit_code="$1"
  echo
  echo "Deploy failed with exit code ${exit_code}." >&2
  echo "== current commit ==" >&2
  git rev-parse --short HEAD >&2 || true
  echo "== docker compose ps ==" >&2
  compose ps >&2 || true
  echo "== recent backend logs ==" >&2
  compose logs --tail=80 backend >&2 || true
  echo "== recent bot logs ==" >&2
  compose logs --tail=80 bot >&2 || true
}

trap 'diagnostics $?' ERR

require_disk() {
  local available
  available="$(free_kb)"
  if (( available < MIN_FREE_KB )); then
    echo "Only ${available} KiB free in ${APP_DIR}; need at least ${MIN_FREE_KB} KiB before build." >&2
    echo "Run scripts/vds_disk_report.sh, then safe cleanup if needed. Never run docker system prune --volumes." >&2
    exit 1
  fi
  echo "Free disk OK: ${available} KiB"
}

checkout_ref() {
  local ref="$1"
  git fetch origin --tags --prune
  if git show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
    git checkout -B "$ref" "origin/${ref}"
    git pull --ff-only origin "$ref"
  elif git show-ref --verify --quiet "refs/heads/${ref}"; then
    git checkout "$ref"
    git pull --ff-only origin "$ref"
  else
    git checkout --detach "$ref"
  fi
}

wait_for_health() {
  local deadline=$((SECONDS + 90))
  local body
  while (( SECONDS < deadline )); do
    if body="$(curl -fsS "${BASE_URL}/health" 2>/dev/null)" && grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body"; then
      echo "$body"
      return 0
    fi
    sleep 3
  done
  echo "Health check did not return ok within timeout." >&2
  return 1
}

smoke_checks() {
  local status headers body
  status="$(curl -sS -o /dev/null -w "%{http_code}" "${BASE_URL}/api/books")"
  if [[ "$status" != "401" ]]; then
    echo "Expected unauthenticated /api/books to return 401, got ${status}." >&2
    return 1
  fi
  echo "Auth smoke OK: /api/books -> 401"

  headers="$(mktemp)"
  body="$(mktemp)"
  curl -fsS -D "$headers" -o "$body" "${BASE_URL}/"
  if ! grep -qi '^content-security-policy:' "$headers"; then
    echo "GET / did not include Content-Security-Policy header." >&2
    cat "$headers" >&2
    return 1
  fi
  if grep -qiE "unsafe-inline|unsafe-eval" "$headers"; then
    echo "CSP contains unsafe-inline or unsafe-eval." >&2
    cat "$headers" >&2
    return 1
  fi
  if ! grep -q '<div id="app"' "$body"; then
    echo "GET / did not look like the Mini App shell." >&2
    head -40 "$body" >&2
    return 1
  fi
  rm -f "$headers" "$body"
  echo "App shell/CSP smoke OK"
}

echo "== ${MODE}: ${REF} =="
echo "App dir: ${APP_DIR}"
echo "Base URL: ${BASE_URL}"

echo
echo "== disk guard =="
require_disk

echo
echo "== git checkout =="
checkout_ref "$REF"
DEPLOY_COMMIT="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Commit to deploy: ${DEPLOY_COMMIT}"

echo
echo "== docker compose build =="
compose build \
  --build-arg "GIT_COMMIT=${DEPLOY_COMMIT}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  --build-arg "APP_ENV=production"

echo
echo "== docker compose up =="
compose up -d

echo
echo "== docker compose ps =="
compose ps

echo
echo "== wait for health =="
wait_for_health

echo
echo "== smoke checks =="
smoke_checks

echo
echo "== deployed commit =="
git rev-parse HEAD
