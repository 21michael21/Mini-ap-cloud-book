from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
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
from backend.app.duplicates import (
    file_sha256,
    find_content_duplicate,
    find_possible_duplicate,
    find_tg_unique_duplicate,
    normalize_title,
)
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


@dp.message(Command("version"))
async def version(message: Message) -> None:
    await message.answer(
        "\n".join(
            [
                "Telegram Library",
                f"service: bot",
                f"commit: {settings.git_commit or 'unknown'}",
                f"built_at: {settings.build_time or 'unknown'}",
                f"environment: {settings.app_env or 'unknown'}",
                f"webapp: {settings.webapp_url}",
                f"backend: {settings.backend_public_url}",
            ]
        )
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

    user = get_or_create_user(message.from_user.id)
    with SessionLocal() as db:
        existing = find_tg_unique_duplicate(db, user.id, document.file_unique_id)
        if existing:
            if existing.tg_file_id != document.file_id:
                existing.tg_file_id = document.file_id
                db.commit()
            await message.answer(
                f"Already in your library: {existing.title}",
                reply_markup=open_library_keyboard(),
            )
            return

    too_large = size_bytes > settings.max_telegram_download_bytes
    fmt = detect_format(file_name, document.mime_type)
    downloaded_path: Path | None = None
    download_temp_dir: tempfile.TemporaryDirectory[str] | None = None
    content_sha256: str | None = None
    if not too_large:
        try:
            downloaded_path, download_temp_dir = await download_for_sniffing(message, file_name)
            content_sha256 = file_sha256(downloaded_path)
            if fmt not in SUPPORTED_FORMATS:
                fmt = sniff_format(downloaded_path)
        except Exception:
            if download_temp_dir is not None:
                download_temp_dir.cleanup()
            logger.exception("Could not download uploaded document %s", file_name)
            await message.answer("I could not read this file from Telegram. Please try sending it again.")
            return

    if fmt not in SUPPORTED_FORMATS:
        if download_temp_dir is not None:
            download_temp_dir.cleanup()
        await message.answer("This MVP supports EPUB, FB2, TXT, and PDF files.")
        return

    if content_sha256:
        with SessionLocal() as db:
            existing = find_content_duplicate(db, user.id, content_sha256)
            if existing:
                if existing.tg_file_id != document.file_id:
                    existing.tg_file_id = document.file_id
                    db.commit()
                if download_temp_dir is not None:
                    download_temp_dir.cleanup()
                await message.answer(
                    f"Already in your library: {existing.title}",
                    reply_markup=open_library_keyboard(),
                )
                return

    title, author, cover_ref = await metadata_for_document(
        message,
        fmt,
        file_name,
        too_large,
        downloaded_path=downloaded_path,
    )
    normalized_title = normalize_title(title)

    with SessionLocal() as db:
        possible_duplicate = find_possible_duplicate(
            db,
            user.id,
            normalized_title=normalized_title,
            author=author,
            fmt=fmt,
            size_bytes=size_bytes,
            content_sha256=content_sha256,
        )
        book = Book(
            user_id=user.id,
            tg_file_id=document.file_id,
            tg_file_unique_id=document.file_unique_id,
            file_name=file_name,
            mime_type=document.mime_type,
            title=title,
            author=author,
            normalized_title=normalized_title,
            format=fmt,
            cover_ref=cover_ref,
            content_sha256=content_sha256,
            size_bytes=size_bytes,
            too_large=too_large,
            possible_duplicate=possible_duplicate is not None,
            folder_id=None,
            original_message_date=message.date,
        )
        db.add(book)
        db.flush()
        event_meta = {"format": fmt}
        if possible_duplicate is not None:
            event_meta["possible_duplicate_of"] = possible_duplicate.id
        db.add(Event(user_id=user.id, type="file_uploaded", book_id=book.id, meta=event_meta))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if download_temp_dir is not None:
                download_temp_dir.cleanup()
            await message.answer("This file is already in your library.", reply_markup=open_library_keyboard())
            return

    if download_temp_dir is not None:
        download_temp_dir.cleanup()

    note = " It is over 20 MB, so it is saved but cannot open in-app in the MVP." if too_large else ""
    duplicate_note = (
        f"\n\nThis looks similar to an existing item: {possible_duplicate.title}."
        if possible_duplicate is not None
        else ""
    )
    await message.answer(
        f"Added to Inbox: {title}.{note}{duplicate_note}\n\nOpen Library to rename or organize it.",
        reply_markup=open_library_keyboard(),
    )


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
