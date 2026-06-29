from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.config import get_settings
from backend.app.db import SessionLocal
from backend.app.formats import (
    SUPPORTED_FORMATS,
    clean_title_from_filename,
    detect_format,
    extract_metadata,
    sniff_format,
)
from backend.app.models import Book, Event, User


settings = get_settings()
if not settings.bot_token:
    raise RuntimeError("BOT_TOKEN is required to run the bot")
logger = logging.getLogger(__name__)
bot = Bot(token=settings.bot_token)
dp = Dispatcher()


def open_library_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Open Library",
                    web_app=WebAppInfo(url=settings.webapp_url),
                )
            ]
        ]
    )


def get_or_create_user(tg_user_id: int) -> User:
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.tg_user_id == tg_user_id))
        if user:
            return user
        user = User(tg_user_id=tg_user_id)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user


async def metadata_for_document(
    message: Message,
    fmt: str,
    file_name: str,
    too_large: bool,
    downloaded_path: Path | None = None,
):
    if too_large:
        return clean_title_from_filename(file_name), None, None

    try:
        if downloaded_path is not None:
            metadata = extract_metadata(downloaded_path, file_name, fmt)
            return metadata.title, metadata.author, metadata.cover_ref

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir) / file_name
            await message.bot.download(message.document, destination=temp_path)
            metadata = extract_metadata(temp_path, file_name, fmt)
            return metadata.title, metadata.author, metadata.cover_ref
    except Exception:
        logger.exception("Could not extract metadata for uploaded document %s", file_name)
        return clean_title_from_filename(file_name), None, None


async def download_for_sniffing(message: Message, file_name: str) -> tuple[Path, tempfile.TemporaryDirectory[str]]:
    temp_dir = tempfile.TemporaryDirectory()
    temp_path = Path(temp_dir.name) / file_name
    try:
        await message.bot.download(message.document, destination=temp_path)
    except Exception:
        temp_dir.cleanup()
        raise
    return temp_path, temp_dir


@dp.message(CommandStart())
async def start(message: Message) -> None:
    await message.answer(
        "Send me an EPUB, FB2, TXT, or PDF file and I will add it to your Telegram Library.",
        reply_markup=open_library_keyboard(),
    )


@dp.message(F.document)
async def handle_document(message: Message) -> None:
    assert message.document is not None
    assert message.from_user is not None

    document = message.document
    file_name = document.file_name or "document"
    size_bytes = document.file_size or 0
    if size_bytes <= 0:
        await message.answer("This file is empty, so I cannot add it to your library.")
        return

    too_large = size_bytes > settings.max_telegram_download_bytes
    fmt = detect_format(file_name, document.mime_type)
    sniffed_path: Path | None = None
    sniff_temp_dir: tempfile.TemporaryDirectory[str] | None = None
    if fmt not in SUPPORTED_FORMATS and not too_large:
        try:
            sniffed_path, sniff_temp_dir = await download_for_sniffing(message, file_name)
            fmt = sniff_format(sniffed_path)
        except Exception:
            logger.exception("Could not sniff uploaded document %s", file_name)

    if fmt not in SUPPORTED_FORMATS:
        if sniff_temp_dir is not None:
            sniff_temp_dir.cleanup()
        await message.answer("This MVP supports EPUB, FB2, TXT, and PDF files.")
        return

    title, author, cover_ref = await metadata_for_document(
        message,
        fmt,
        file_name,
        too_large,
        downloaded_path=sniffed_path,
    )
    if sniff_temp_dir is not None:
        sniff_temp_dir.cleanup()
    user = get_or_create_user(message.from_user.id)

    with SessionLocal() as db:
        existing = db.scalar(
            select(Book).where(
                Book.user_id == user.id,
                Book.tg_file_unique_id == document.file_unique_id,
            )
        )
        if existing:
            await message.answer(
                f"Already in your library: {existing.title}",
                reply_markup=open_library_keyboard(),
            )
            return

        book = Book(
            user_id=user.id,
            tg_file_id=document.file_id,
            tg_file_unique_id=document.file_unique_id,
            file_name=file_name,
            mime_type=document.mime_type,
            title=title,
            author=author,
            format=fmt,
            cover_ref=cover_ref,
            size_bytes=size_bytes,
            too_large=too_large,
            folder_id=None,
        )
        db.add(book)
        db.flush()
        db.add(Event(user_id=user.id, type="file_uploaded", book_id=book.id, meta={"format": fmt}))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            await message.answer("This file is already in your library.", reply_markup=open_library_keyboard())
            return

    note = " It is over 20 MB, so it is saved but cannot open in-app in the MVP." if too_large else ""
    await message.answer(f"Added to Inbox: {title}.{note}", reply_markup=open_library_keyboard())


async def main() -> None:
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(
            text="Library",
            web_app=WebAppInfo(url=settings.webapp_url),
        )
    )
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
