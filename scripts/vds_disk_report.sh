#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/telegram-library}"

cd "$APP_DIR"

echo "== df -h =="
df -h

echo
echo "== /opt/telegram-library usage =="
du -h -d 1 "$APP_DIR" 2>/dev/null | sort -h

echo
echo "== docker system df =="
docker system df

echo
echo "== docker compose ps =="
docker compose ps

echo
echo "== ./file_cache size =="
du -sh ./file_cache 2>/dev/null || echo "file_cache directory not found"

echo
echo "== Postgres volume size =="
POSTGRES_VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E 'telegram.*pgdata|postgres.*data' | head -1 || true)"
if [[ -n "$POSTGRES_VOLUME" ]]; then
  POSTGRES_MOUNTPOINT="$(docker volume inspect "$POSTGRES_VOLUME" --format '{{.Mountpoint}}')"
  du -sh "$POSTGRES_MOUNTPOINT" 2>/dev/null || echo "Could not read $POSTGRES_MOUNTPOINT"
else
  echo "Postgres volume not found"
fi
