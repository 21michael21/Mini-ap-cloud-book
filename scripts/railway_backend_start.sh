#!/usr/bin/env bash
set -euo pipefail

python scripts/check_railway_env.py backend
alembic upgrade head
uvicorn backend.app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
