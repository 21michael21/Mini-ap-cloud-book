from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
sys.path.insert(0, str(REPO))

from backend.app.config import Settings
from backend.app.covers import extract_and_store_cover
from backend.app.db import Base
from backend.app.formats import clean_title_from_filename, detect_format, extract_metadata, sniff_format
from backend.app.models import Book, User
from dev.make_init_data import make_init_data


PRIVATE_FIXTURES = ROOT / "reader_fixtures" / "private"
ENV_PATH = ROOT / "private_reader_e2e_env.json"
TG_USER_ID = 61616161
BOT_TOKEN = "123456789:AAabcdefghijklmnopqrstuvwxyz1234567"
SUPPORTED_GATE_FORMATS = {"epub", "fb2", "txt", "pdf"}


def default_paths() -> tuple[Path, Path]:
    db_path = Path(os.environ.get("PRIVATE_READER_E2E_DB", ROOT / "private_reader_e2e.sqlite3"))
    cache_dir = Path(os.environ.get("PRIVATE_READER_E2E_FILE_CACHE", ROOT / "private_reader_e2e_file_cache"))
    return db_path, cache_dir


def private_files() -> list[Path]:
    if not PRIVATE_FIXTURES.exists():
        return []
    return sorted(
        path
        for path in PRIVATE_FIXTURES.iterdir()
        if path.is_file() and path.name != "README.md" and not path.name.startswith(".")
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="Print machine-readable env payload only.")
    args = parser.parse_args()

    files = private_files()
    if not files:
        payload = {"fixtures": [], "books": {}}
        ENV_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps(payload) if args.json else "No private reader fixtures found.")
        return

    db_path, cache_dir = default_paths()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    shutil.rmtree(cache_dir, ignore_errors=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cover_dir = cache_dir / "covers"
    cover_dir.mkdir(parents=True, exist_ok=True)

    database_url = f"sqlite+pysqlite:///{db_path}"
    engine = create_engine(database_url)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    settings = Settings(
        bot_token=BOT_TOKEN,
        database_url=database_url,
        webapp_url="http://127.0.0.1:15173",
        backend_public_url="http://127.0.0.1:18080",
        file_cache_dir=cache_dir,
        cover_cache_dir=cover_dir,
        file_cache_max_bytes=256 * 1024 * 1024,
        cover_cache_max_bytes=32 * 1024 * 1024,
        initdata_max_age_seconds=86400,
    )
    books_by_name: dict[str, int] = {}
    fixture_payload: list[dict[str, object]] = []
    with SessionLocal() as db:
        user = User(tg_user_id=TG_USER_ID)
        db.add(user)
        db.flush()

        for index, path in enumerate(files, start=1):
            fmt = detect_format(path.name, None, path) or sniff_format(path)
            if fmt not in SUPPORTED_GATE_FORMATS:
                raise RuntimeError(
                    f"Private fixture {path.name} detected as {fmt or 'unknown'}; "
                    "the mandatory gate covers EPUB, FB2, TXT, and PDF only."
                )
            metadata = extract_metadata(path, path.name, fmt)
            fallback_title = clean_title_from_filename(path.name)
            title = metadata.title or fallback_title
            title_source = "metadata" if metadata.title and metadata.title != fallback_title else "fallback"
            cover_ref = extract_and_store_cover(settings, path, path.name, fmt, title=title, author=metadata.author)
            book = Book(
                user_id=user.id,
                tg_file_id=f"private-e2e-{index}",
                tg_file_unique_id=f"private-e2e-{index}",
                file_name=path.name,
                mime_type=mime_type_for(fmt),
                title=title,
                author=metadata.author,
                normalized_title=title.lower(),
                format=fmt,
                cover_ref=cover_ref,
                content_sha256=None,
                size_bytes=path.stat().st_size,
                too_large=False,
                possible_duplicate=False,
                sort_order=index * 10,
                folder_id=None,
            )
            db.add(book)
            db.flush()
            shutil.copyfile(path, cache_dir / f"{book.id}.{fmt}")
            books_by_name[path.name] = book.id
            fixture_payload.append(
                {
                    "fileName": path.name,
                    "title": title,
                    "author": metadata.author,
                    "format": fmt,
                    "detectedFormat": fmt,
                    "bookId": book.id,
                    "titleSource": title_source,
                    "hasExtractedCover": cover_ref is not None,
                    "coverUrl": f"/api/books/{book.id}/cover" if cover_ref else None,
                }
            )

        db.commit()

    init_data = make_init_data(BOT_TOKEN, TG_USER_ID, username="private_reader_e2e")
    payload = {
        "databaseUrl": database_url,
        "fileCacheDir": str(cache_dir),
        "coverCacheDir": str(cover_dir),
        "botToken": BOT_TOKEN,
        "tgUserId": TG_USER_ID,
        "initData": init_data,
        "apiBase": "http://127.0.0.1:18080",
        "webappUrl": "http://127.0.0.1:15173",
        "books": books_by_name,
        "fixtures": fixture_payload,
    }
    ENV_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(payload))
        return
    print(f"Seeded {len(files)} private reader fixture(s).")
    print(f"Wrote env: {ENV_PATH}")


def mime_type_for(fmt: str) -> str:
    return {
        "epub": "application/epub+zip",
        "fb2": "application/x-fictionbook+xml",
        "txt": "text/plain",
        "pdf": "application/pdf",
    }[fmt]


if __name__ == "__main__":
    main()
