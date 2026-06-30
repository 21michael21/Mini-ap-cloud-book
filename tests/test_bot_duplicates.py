from __future__ import annotations

import asyncio
import importlib
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backend.app.config import Settings, get_settings
from backend.app.db import Base
from backend.app.models import Book


BOT_TOKEN = "123456789:AAabcdefghijklmnopqrstuvwxyz1234567"


class FakeBot:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.download_count = 0

    async def download(self, document, destination: Path) -> None:
        self.download_count += 1
        destination.write_bytes(self.payload)


class FakeMessage:
    def __init__(
        self,
        *,
        payload: bytes,
        file_name: str = "book.txt",
        file_size: int | None = None,
        file_unique_id: str = "unique-1",
        file_id: str = "file-1",
        user_id: int = 777,
    ) -> None:
        self.document = SimpleNamespace(
            file_name=file_name,
            file_size=len(payload) if file_size is None else file_size,
            mime_type="text/plain" if file_name.endswith(".txt") else "application/pdf",
            file_unique_id=file_unique_id,
            file_id=file_id,
        )
        self.from_user = SimpleNamespace(id=user_id)
        self.bot = FakeBot(payload)
        self.date = datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)
        self.answers: list[str] = []

    async def answer(self, text: str, reply_markup=None) -> None:
        self.answers.append(text)


@pytest.fixture(autouse=True)
def clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def load_bot_main(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", BOT_TOKEN)
    get_settings.cache_clear()
    import bot.main as bot_main

    return importlib.reload(bot_main)


def configure_bot_db(bot_main, tmp_path: Path) -> sessionmaker:
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'bot-duplicates.sqlite3'}")
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    bot_main.SessionLocal = SessionLocal
    bot_main.settings = Settings(
        bot_token=BOT_TOKEN,
        database_url="sqlite+pysqlite:///:memory:",
        webapp_url="https://telegram-library.example.test",
        backend_public_url="https://telegram-library.example.test",
        file_cache_dir=tmp_path / "file_cache",
        cover_cache_dir=tmp_path / "covers",
        max_telegram_download_bytes=20,
    )
    return SessionLocal


def books(SessionLocal: sessionmaker) -> list[Book]:
    with SessionLocal() as db:
        return list(db.scalars(select(Book).order_by(Book.id)).all())


def test_tg_file_unique_duplicate_does_not_create_second_book_and_refreshes_file_id(monkeypatch, tmp_path: Path) -> None:
    bot_main = load_bot_main(monkeypatch)
    SessionLocal = configure_bot_db(bot_main, tmp_path)

    first = FakeMessage(payload=b"same text", file_unique_id="same-unique", file_id="old-file")
    second = FakeMessage(payload=b"different text", file_unique_id="same-unique", file_id="new-file")
    asyncio.run(bot_main.handle_document(first))
    asyncio.run(bot_main.handle_document(second))

    stored = books(SessionLocal)
    assert len(stored) == 1
    assert stored[0].tg_file_id == "new-file"
    assert second.bot.download_count == 0
    assert second.answers[-1].startswith("Already in your library:")


def test_same_content_sha256_duplicate_does_not_create_second_book_and_refreshes_file_id(monkeypatch, tmp_path: Path) -> None:
    bot_main = load_bot_main(monkeypatch)
    SessionLocal = configure_bot_db(bot_main, tmp_path)

    first = FakeMessage(payload=b"same content", file_unique_id="unique-1", file_id="old-file")
    second = FakeMessage(payload=b"same content", file_unique_id="unique-2", file_id="new-file")
    asyncio.run(bot_main.handle_document(first))
    asyncio.run(bot_main.handle_document(second))

    stored = books(SessionLocal)
    assert len(stored) == 1
    assert stored[0].content_sha256 is not None
    assert stored[0].tg_file_id == "new-file"
    assert second.bot.download_count == 1
    assert second.answers[-1].startswith("Already in your library:")


def test_too_large_upload_does_not_download(monkeypatch, tmp_path: Path) -> None:
    bot_main = load_bot_main(monkeypatch)
    SessionLocal = configure_bot_db(bot_main, tmp_path)

    message = FakeMessage(payload=b"", file_name="large.pdf", file_size=25, file_unique_id="large-1", file_id="large-file")
    asyncio.run(bot_main.handle_document(message))

    stored = books(SessionLocal)
    assert len(stored) == 1
    assert stored[0].too_large is True
    assert stored[0].content_sha256 is None
    assert message.bot.download_count == 0


def test_possible_duplicate_heuristic_does_not_block_upload(monkeypatch, tmp_path: Path) -> None:
    bot_main = load_bot_main(monkeypatch)
    SessionLocal = configure_bot_db(bot_main, tmp_path)

    first = FakeMessage(payload=b"", file_name="same-title.pdf", file_size=25, file_unique_id="large-1", file_id="file-1")
    second = FakeMessage(payload=b"", file_name="same title.pdf", file_size=25, file_unique_id="large-2", file_id="file-2")
    asyncio.run(bot_main.handle_document(first))
    asyncio.run(bot_main.handle_document(second))

    stored = books(SessionLocal)
    assert len(stored) == 2
    assert stored[0].possible_duplicate is False
    assert stored[1].possible_duplicate is True
    assert first.bot.download_count == 0
    assert second.bot.download_count == 0
    assert "This looks similar to an existing item" in second.answers[-1]


def test_upload_attempts_epub_cover_extraction(monkeypatch, tmp_path: Path) -> None:
    bot_main = load_bot_main(monkeypatch)
    SessionLocal = configure_bot_db(bot_main, tmp_path)
    payload = make_epub_with_cover()
    bot_main.settings.max_telegram_download_bytes = len(payload) + 10

    message = FakeMessage(
        payload=payload,
        file_name="covered.epub",
        file_size=len(payload),
        file_unique_id="covered-epub",
        file_id="covered-file",
    )
    asyncio.run(bot_main.handle_document(message))

    stored = books(SessionLocal)
    assert len(stored) == 1
    assert stored[0].cover_ref is not None
    assert (bot_main.settings.cover_cache_dir / stored[0].cover_ref).exists()


def make_epub_with_cover() -> bytes:
    epub_path = Path(tempfile.gettempdir()) / "telegram-library-test-cover.epub"
    png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    with ZipFile(epub_path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
            </container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<package xmlns:dc="http://purl.org/dc/elements/1.1/">
              <metadata><dc:title>Covered</dc:title></metadata>
              <manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>
            </package>""",
        )
        archive.writestr("OEBPS/cover.png", png)
    data = epub_path.read_bytes()
    epub_path.unlink(missing_ok=True)
    return data
