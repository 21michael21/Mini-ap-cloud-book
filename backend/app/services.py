from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.config import Settings
from backend.app.models import Book, Event, Folder, Note, User


logger = logging.getLogger(__name__)


def log_event(
    db: Session,
    user_id: int,
    event_type: str,
    book_id: int | None = None,
    meta: dict | None = None,
) -> None:
    db.add(Event(user_id=user_id, type=event_type, book_id=book_id, meta=meta))


def owned_book_or_404(db: Session, user: User, book_id: int) -> Book:
    book = db.scalar(select(Book).where(Book.id == book_id, Book.user_id == user.id))
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return book


def owned_folder_or_404(db: Session, user: User, folder_id: int) -> Folder:
    folder = db.scalar(select(Folder).where(Folder.id == folder_id, Folder.user_id == user.id))
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return folder


def owned_note_or_404(db: Session, user: User, note_id: int) -> Note:
    note = db.scalar(select(Note).where(Note.id == note_id, Note.user_id == user.id))
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return note


def cache_path(settings: Settings, book: Book) -> Path:
    suffix = f".{book.format}" if book.format else ""
    return settings.file_cache_dir / f"{book.id}{suffix}"


async def ensure_cached_file(settings: Settings, book: Book) -> Path:
    if book.too_large or book.size_bytes > settings.max_telegram_download_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="This file is larger than the Telegram Bot API download limit.",
        )

    cleanup_file_cache(settings)
    path = cache_path(settings, book)
    if path.exists():
        path.touch()
        return path

    settings.file_cache_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            file_resp = await client.get(
                f"https://api.telegram.org/bot{settings.bot_token}/getFile",
                params={"file_id": book.tg_file_id},
            )
            file_resp.raise_for_status()
            payload = file_resp.json()
            if not payload.get("ok"):
                raise HTTPException(status_code=502, detail="Telegram getFile failed")
            file_path = payload["result"]["file_path"]
            download_url = f"https://api.telegram.org/file/bot{settings.bot_token}/{file_path}"
            download_resp = await client.get(download_url)
            download_resp.raise_for_status()
            tmp_path.write_bytes(download_resp.content)
            tmp_path.replace(path)
    except HTTPException:
        raise
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        logger.exception("Telegram file download failed for book_id=%s", book.id)
        raise HTTPException(status_code=502, detail="Could not download this file from Telegram.") from exc
    cleanup_file_cache(settings)
    return path


def cleanup_file_cache(settings: Settings) -> None:
    cache_dir = settings.file_cache_dir
    if not cache_dir.exists():
        return

    now = time.time()
    files: list[tuple[float, int, Path]] = []
    for path in cache_dir.iterdir():
        if not path.is_file() or path.name.endswith(".tmp"):
            continue
        try:
            stat = path.stat()
        except OSError:
            logger.exception("Could not stat cache file %s", path)
            continue
        if settings.file_cache_max_age_seconds > 0 and now - stat.st_mtime > settings.file_cache_max_age_seconds:
            try:
                path.unlink()
            except OSError:
                logger.exception("Could not remove expired cache file %s", path)
            continue
        files.append((stat.st_mtime, stat.st_size, path))

    max_bytes = settings.file_cache_max_bytes
    if max_bytes <= 0:
        return
    total = sum(size for _, size, _ in files)
    for _, size, path in sorted(files):
        if total <= max_bytes:
            break
        try:
            path.unlink()
            total -= size
        except OSError:
            logger.exception("Could not remove cache file %s during LRU cleanup", path)
