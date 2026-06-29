from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
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
)
from backend.app.models import Book, Event, User


settings = get_settings()
if not settings.bot_token:
    raise RuntimeError("BOT_TOKEN is required to run the bot")
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


async def metadata_for_document(message: Message, fmt: str, file_name: str, too_large: bool):
    if too_large:
        return clean_title_from_filename(file_name), None, None

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir) / file_name
        await message.bot.download(message.document, destination=temp_path)
        metadata = extract_metadata(temp_path, file_name, fmt)
        return metadata.title, metadata.author, metadata.cover_ref


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
    fmt = detect_format(file_name, document.mime_type)
    if fmt not in SUPPORTED_FORMATS:
        await message.answer("This MVP supports EPUB, FB2, TXT, and PDF files.")
        return

    size_bytes = document.file_size or 0
    too_large = size_bytes > settings.max_telegram_download_bytes
    title, author, cover_ref = await metadata_for_document(message, fmt, file_name, too_large)
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
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
