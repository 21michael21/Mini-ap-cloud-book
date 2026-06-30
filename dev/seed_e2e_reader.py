from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
sys.path.insert(0, str(REPO))

from backend.app.config import Settings
from backend.app.covers import extract_and_store_cover
from backend.app.db import Base
from backend.app.formats import detect_format, extract_metadata, sniff_format
from backend.app.models import Book, Folder, User
from dev.make_init_data import make_init_data


PUBLIC_FIXTURES = ROOT / "reader_fixtures" / "public"
ENV_PATH = ROOT / "reader_e2e_env.json"
TG_USER_ID = 51515151
BOT_TOKEN = "123456789:AAabcdefghijklmnopqrstuvwxyz1234567"

FIXTURE_ORDER = [
    "simple.epub",
    "bad_markup.epub",
    "multi_section.epub",
    "long_text.fb2",
    "cp1251.fb2",
    "long.txt",
    "small.pdf",
    "scanned_like.pdf",
    "blank.pdf",
    "long_pdf.pdf",
]


def default_paths() -> tuple[Path, Path]:
    db_path = Path(os.environ.get("READER_E2E_DB", ROOT / "reader_e2e.sqlite3"))
    cache_dir = Path(os.environ.get("READER_E2E_FILE_CACHE", ROOT / "reader_e2e_file_cache"))
    return db_path, cache_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="Print machine-readable env payload only.")
    args = parser.parse_args()
    db_path, cache_dir = default_paths()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cover_dir = cache_dir / "covers"
    if db_path.exists():
        db_path.unlink()
    shutil.rmtree(cache_dir, ignore_errors=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
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
    with SessionLocal() as db:
        user = User(tg_user_id=TG_USER_ID)
        db.add(user)
        db.flush()
        folder = Folder(user_id=user.id, name="E2E Folder", sort_order=10)
        db.add(folder)
        db.flush()

        for index, file_name in enumerate(FIXTURE_ORDER, start=1):
            path = PUBLIC_FIXTURES / file_name
            if not path.exists():
                raise FileNotFoundError(f"Missing fixture: {path}. Run dev/generate_reader_fixtures.py first.")
            fmt = detect_format(path.name, None, path) or sniff_format(path)
            if fmt is None:
                raise RuntimeError(f"Could not detect format for {path}")
            metadata = extract_metadata(path, path.name, fmt)
            title = fixture_title(path)
            cover_ref = extract_and_store_cover(settings, path, path.name, fmt, title=title, author=metadata.author)
            book = Book(
                user_id=user.id,
                tg_file_id=f"e2e-{path.stem}",
                tg_file_unique_id=f"e2e-{path.stem}",
                file_name=path.name,
                mime_type=mime_type_for(fmt),
                title=title,
                author=metadata.author or "Reader Fixture",
                normalized_title=title.lower(),
                format=fmt,
                cover_ref=cover_ref,
                size_bytes=path.stat().st_size,
                too_large=False,
                possible_duplicate=path.name == "long.txt",
                sort_order=index * 10,
                folder_id=None,
            )
            db.add(book)
            db.flush()
            shutil.copyfile(path, cache_dir / f"{book.id}.{fmt}")
            books_by_name[path.name] = book.id

        db.commit()

    init_data = make_init_data(BOT_TOKEN, TG_USER_ID, username="reader_e2e")
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
    }
    ENV_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(payload))
        return

    print(f"Seeded reader e2e database: {db_path}")
    print(f"Seeded file cache: {cache_dir}")
    print(f"Wrote env: {ENV_PATH}")
    print()
    print("Backend:")
    print(
        "DATABASE_URL='{databaseUrl}' BOT_TOKEN='{botToken}' FILE_CACHE_DIR='{fileCacheDir}' "
        "WEBAPP_URL='{webappUrl}' BACKEND_PUBLIC_URL='{apiBase}' "
        ".venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 18080".format(
            **payload
        )
    )
    print()
    print("Mini App:")
    print(
        "cd miniapp && VITE_API_BASE='{apiBase}' VITE_DEV_INIT_DATA='{initData}' "
        "npm run dev -- --host 127.0.0.1 --port 15173".format(**payload)
    )


def fixture_title(path: Path) -> str:
    return {
        "simple.epub": "Reader E2E Simple EPUB",
        "bad_markup.epub": "Reader E2E Bad Markup EPUB",
        "multi_section.epub": "Reader E2E Multi Section EPUB",
        "long_text.fb2": "Reader E2E Long FB2",
        "cp1251.fb2": "Reader E2E CP1251 FB2",
        "long.txt": "Reader E2E Long TXT",
        "small.pdf": "Reader E2E Small PDF",
        "scanned_like.pdf": "Reader E2E Scanned Like PDF",
        "blank.pdf": "Reader E2E Blank PDF",
        "long_pdf.pdf": "Reader E2E Long PDF",
    }[path.name]


def mime_type_for(fmt: str) -> str:
    return {
        "epub": "application/epub+zip",
        "fb2": "application/x-fictionbook+xml",
        "txt": "text/plain",
        "pdf": "application/pdf",
    }[fmt]


if __name__ == "__main__":
    main()
