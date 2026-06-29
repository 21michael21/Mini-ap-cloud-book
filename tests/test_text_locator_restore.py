from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.formats import detect_format, extract_metadata
from backend.app.models import Book, ReadingPosition, User


SAMPLES = {
    "fb2": Path("dev/fixtures/sample.fb2"),
    "txt": Path("dev/fixtures/sample.txt"),
}


@pytest.mark.parametrize("fmt,locator", [("fb2", "epubcfi(/2/1:12)"), ("txt", "epubcfi(/2/1:7)")])
def test_text_reader_locator_restores_exact_value_after_reload(fmt: str, locator: str) -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    sample = SAMPLES[fmt]
    metadata = extract_metadata(sample, sample.name, fmt)

    with Session(engine) as db:
        user = User(tg_user_id=9000)
        db.add(user)
        db.flush()
        book = Book(
            user_id=user.id,
            tg_file_id=f"sample-{fmt}",
            tg_file_unique_id=f"sample-{fmt}",
            file_name=sample.name,
            mime_type="text/plain" if fmt == "txt" else "application/x-fictionbook+xml",
            title=metadata.title,
            author=metadata.author,
            format=detect_format(sample.name),
            cover_ref=None,
            size_bytes=sample.stat().st_size,
            too_large=False,
            folder_id=None,
        )
        db.add(book)
        db.flush()
        db.add(ReadingPosition(book_id=book.id, user_id=user.id, locator=locator, percent=42.0))
        db.commit()
        book_id = book.id
        user_id = user.id

    with Session(engine) as reloaded:
        restored = reloaded.scalar(
            select(ReadingPosition).where(
                ReadingPosition.book_id == book_id,
                ReadingPosition.user_id == user_id,
            )
        )

    assert restored is not None
    assert restored.locator == locator
