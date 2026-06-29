#!/usr/bin/env bash
set -euo pipefail

python scripts/check_railway_env.py bot
python -m bot.main
