from __future__ import annotations

import hashlib
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.models import Book


_SPACES_RE = re.compile(r"\s+")
_TITLE_DROP_RE = re.compile(r"[^\w\s]+", re.UNICODE)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_title(value: str | None) -> str | None:
    if not value:
        return None
    normalized = _TITLE_DROP_RE.sub(" ", value.casefold())
    normalized = _SPACES_RE.sub(" ", normalized).strip()
    return normalized or None


def normalize_author(value: str | None) -> str | None:
    if not value:
        return None
    normalized = _SPACES_RE.sub(" ", value.casefold()).strip()
    return normalized or None


def find_tg_unique_duplicate(db: Session, user_id: int, tg_file_unique_id: str) -> Book | None:
    return db.scalar(
        select(Book).where(
            Book.user_id == user_id,
            Book.tg_file_unique_id == tg_file_unique_id,
        )
    )


def find_content_duplicate(db: Session, user_id: int, content_sha256: str | None) -> Book | None:
    if not content_sha256:
        return None
    return db.scalar(
        select(Book).where(
            Book.user_id == user_id,
            Book.content_sha256 == content_sha256,
        )
    )


def find_possible_duplicate(
    db: Session,
    user_id: int,
    *,
    normalized_title: str | None,
    author: str | None,
    fmt: str,
    size_bytes: int,
    content_sha256: str | None,
) -> Book | None:
    if not normalized_title:
        return None
    candidates = db.scalars(
        select(Book).where(
            Book.user_id == user_id,
            Book.normalized_title == normalized_title,
            Book.format == fmt,
        )
    ).all()
    author_norm = normalize_author(author)
    for candidate in candidates:
        if content_sha256 and candidate.content_sha256 == content_sha256:
            continue
        if candidate.content_sha256 and content_sha256 and candidate.content_sha256 != content_sha256:
            if normalize_author(candidate.author) == author_norm:
                return candidate
            continue
        if candidate.too_large and size_bytes > 0 and candidate.size_bytes == size_bytes:
            return candidate
        if normalize_author(candidate.author) == author_norm:
            return candidate
    return None
