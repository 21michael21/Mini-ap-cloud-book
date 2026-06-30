#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.config import Settings, normalize_database_url  # noqa: E402
from backend.app.covers import cleanup_cover_cache, extract_and_store_cover  # noqa: E402
from backend.app.models import Book  # noqa: E402
from backend.app.services import cache_path, ensure_cached_file  # noqa: E402


def database_url_from_env() -> str:
    return normalize_database_url(Settings().database_url)


async def maybe_cached_path(settings: Settings, book: Book, *, download: bool, dry_run: bool) -> tuple[Path | None, str]:
    path = cache_path(settings, book)
    if path.exists():
        return path, "cached"
    if dry_run:
        return None, "would_download" if download else "missing_cached"
    if not download:
        return None, "missing_cached"
    return await ensure_cached_file(settings, book), "downloaded"


async def run_backfill(args: argparse.Namespace) -> dict[str, int]:
    settings = Settings()
    engine = create_engine(database_url_from_env(), pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    summary = {
        "checked": 0,
        "updated": 0,
        "no_cover": 0,
        "skipped_too_large": 0,
        "missing_cached": 0,
        "would_download": 0,
        "would_extract": 0,
        "errors": 0,
    }

    with SessionLocal() as db:
        statement = select(Book).where(Book.cover_ref.is_(None)).order_by(Book.id)
        if args.limit:
            statement = statement.limit(args.limit)
        books = list(db.scalars(statement))

        for book in books:
            summary["checked"] += 1
            if book.too_large or book.size_bytes > settings.max_telegram_download_bytes:
                summary["skipped_too_large"] += 1
                continue

            try:
                path, source = await maybe_cached_path(settings, book, download=args.download, dry_run=args.dry_run)
                if source == "missing_cached":
                    summary["missing_cached"] += 1
                    continue
                if source == "would_download":
                    summary["would_download"] += 1
                    continue
                if path is None:
                    summary["missing_cached"] += 1
                    continue
                if args.dry_run:
                    summary["would_extract"] += 1
                    continue

                cover_ref = extract_and_store_cover(
                    settings,
                    path,
                    book.file_name,
                    book.format,
                    title=book.title,
                    author=book.author,
                )
                if cover_ref:
                    book.cover_ref = cover_ref
                    db.commit()
                    summary["updated"] += 1
                else:
                    summary["no_cover"] += 1
            except Exception:
                db.rollback()
                summary["errors"] += 1

    if not args.dry_run:
        cleanup_cover_cache(settings)
    return summary


def print_summary(summary: dict[str, int], *, dry_run: bool, download: bool) -> None:
    mode = "dry-run" if dry_run else "write"
    download_mode = "download enabled" if download else "cached files only"
    print(f"Cover backfill summary ({mode}, {download_mode})")
    for key in sorted(summary):
        print(f"  {key}: {summary[key]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill missing Telegram Library cover_ref values safely.")
    parser.add_argument("--dry-run", action="store_true", help="show what would be attempted without writing covers")
    parser.add_argument("--download", action="store_true", help="download missing <=20MB files from Telegram before extraction")
    parser.add_argument("--limit", type=int, default=0, help="maximum number of coverless books to inspect")
    args = parser.parse_args()

    summary = asyncio.run(run_backfill(args))
    print_summary(summary, dry_run=args.dry_run, download=args.download)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
