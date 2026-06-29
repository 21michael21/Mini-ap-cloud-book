from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.config import Settings
from backend.app.models import Book, Event, Folder, User


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


def cache_path(settings: Settings, book: Book) -> Path:
    suffix = f".{book.format}" if book.format else ""
    return settings.file_cache_dir / f"{book.id}{suffix}"


async def ensure_cached_file(settings: Settings, book: Book) -> Path:
    if book.too_large or book.size_bytes > settings.max_telegram_download_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="This file is larger than the Telegram Bot API download limit.",
        )

    path = cache_path(settings, book)
    if path.exists():
        return path

    settings.file_cache_dir.mkdir(parents=True, exist_ok=True)
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
        path.write_bytes(download_resp.content)
    return path
