from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.app.config import get_settings


def is_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Railway runtime environment.")
    parser.add_argument("service", choices=["backend", "bot"])
    args = parser.parse_args()

    settings = get_settings()
    is_railway = bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"))
    problems: list[str] = []

    if not settings.bot_token or settings.bot_token == "replace-me":
        problems.append("BOT_TOKEN is missing")
    if not settings.database_url:
        problems.append("DATABASE_URL is missing")
    elif is_railway and ("localhost" in settings.database_url or "127.0.0.1" in settings.database_url):
        problems.append("DATABASE_URL still points to localhost")
    if not settings.webapp_url:
        problems.append("WEBAPP_URL is missing")
    elif is_railway and not is_https_url(settings.webapp_url):
        problems.append("WEBAPP_URL must be an HTTPS public URL")
    if not settings.backend_public_url:
        problems.append("BACKEND_PUBLIC_URL is missing")
    elif is_railway and not is_https_url(settings.backend_public_url):
        problems.append("BACKEND_PUBLIC_URL must be an HTTPS public URL")

    if problems:
        joined = "; ".join(problems)
        raise SystemExit(f"Invalid Railway environment for {args.service}: {joined}")

    print(f"Railway environment looks valid for {args.service}.")


if __name__ == "__main__":
    main()
