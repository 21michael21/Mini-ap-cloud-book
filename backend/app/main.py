import mimetypes
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.app.auth import current_user
from backend.app.config import Settings, get_settings
from backend.app.db import get_db
from backend.app.models import Book, Folder, ReadingPosition, User
from backend.app.schemas import (
    BookOut,
    BookUpdate,
    EventIn,
    FolderCreate,
    FolderOut,
    FolderUpdate,
    HomeOut,
    MoveBookIn,
    ReadingPositionIn,
    ReadingPositionOut,
)
from backend.app.services import cache_path, ensure_cached_file, log_event, owned_book_or_404, owned_folder_or_404


mimetypes.add_type("font/woff2", ".woff2")
logger = logging.getLogger(__name__)

app = FastAPI(title="Telegram Library API", version="0.1.0")
settings = get_settings()
cors_allowed_origins = list(
    dict.fromkeys(
        origin.rstrip("/")
        for origin in [settings.webapp_url, settings.backend_public_url]
        if origin
    )
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def content_security_policy(settings: Settings) -> str:
    connect_src = " ".join(
        origin
        for origin in [
            "'self'",
            settings.backend_public_url.rstrip("/") if settings.backend_public_url else "",
            "https://telegram.org",
            "https://web.telegram.org",
        ]
        if origin
    )
    return (
        "default-src 'self'; "
        "script-src 'self' https://telegram.org; "
        "style-src 'self'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        f"connect-src {connect_src}; "
        "worker-src 'self' blob:; "
        "frame-src blob: data:; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "frame-ancestors 'self' https://web.telegram.org;"
    )


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    settings = get_settings()
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = content_security_policy(settings)
    return response


def serialize_book(book: Book) -> BookOut:
    progress = book.reading_pos.percent if book.reading_pos else 0.0
    return BookOut(
        id=book.id,
        file_name=book.file_name,
        title=book.title,
        author=book.author,
        format=book.format,
        cover_ref=book.cover_ref,
        size_bytes=book.size_bytes,
        too_large=book.too_large,
        folder_id=book.folder_id,
        added_at=book.added_at,
        last_opened_at=book.last_opened_at,
        progress_percent=progress,
    )


def books_query(user: User) -> Select[tuple[Book]]:
    return select(Book).where(Book.user_id == user.id)


def version_payload(settings: Settings, service: str = "backend") -> dict[str, str]:
    return {
        "status": "ok",
        "app": "telegram-library",
        "commit": settings.git_commit or "unknown",
        "built_at": settings.build_time or "unknown",
        "environment": settings.app_env or "unknown",
        "service": service,
    }


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, str]:
    return version_payload(settings)


@app.get("/api/version")
def version(settings: Settings = Depends(get_settings)) -> dict[str, str]:
    return version_payload(settings)


@app.get("/api/home", response_model=HomeOut)
def home(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> HomeOut:
    continue_book = db.scalar(
        select(Book)
        .join(ReadingPosition)
        .where(Book.user_id == user.id)
        .order_by(ReadingPosition.updated_at.desc())
        .limit(1)
    )
    recent = db.scalars(
        books_query(user).order_by(Book.last_opened_at.desc().nullslast(), Book.added_at.desc()).limit(12)
    ).all()
    folders = db.scalars(select(Folder).where(Folder.user_id == user.id).order_by(Folder.sort_order)).all()
    log_event(db, user.id, "miniapp_opened")
    db.commit()
    return HomeOut(
        continue_book=serialize_book(continue_book) if continue_book else None,
        recent=[serialize_book(book) for book in recent],
        folders=folders,
    )


@app.get("/api/books", response_model=list[BookOut])
def list_books(
    folder_id: int | None = None,
    inbox: bool = False,
    q: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[BookOut]:
    query = books_query(user)
    if inbox:
        query = query.where(Book.folder_id.is_(None))
    elif folder_id is not None:
        owned_folder_or_404(db, user, folder_id)
        query = query.where(Book.folder_id == folder_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Book.title.ilike(like), Book.author.ilike(like)))
        log_event(db, user.id, "search_used", meta={"q": q.strip()})
    books = db.scalars(query.order_by(Book.added_at.desc())).all()
    db.commit()
    return [serialize_book(book) for book in books]


@app.get("/api/books/{book_id}", response_model=BookOut)
def get_book(book_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> BookOut:
    book = owned_book_or_404(db, user, book_id)
    return serialize_book(book)


@app.patch("/api/books/{book_id}", response_model=BookOut)
def update_book(
    book_id: int,
    payload: BookUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> BookOut:
    book = owned_book_or_404(db, user, book_id)
    if "title" in payload.model_fields_set:
        title = (payload.title or "").strip()
        if not title:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Title must not be empty")
        book.title = title
    if "author" in payload.model_fields_set:
        author = (payload.author or "").strip()
        book.author = author or None
    log_event(
        db,
        user.id,
        "book_metadata_updated",
        book.id,
        {"title": book.title, "author": book.author},
    )
    db.commit()
    db.refresh(book)
    return serialize_book(book)


@app.delete("/api/books/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_book(
    book_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    book = owned_book_or_404(db, user, book_id)
    cached_path = cache_path(settings, book)
    log_event(db, user.id, "book_removed", book.id, {"title": book.title})
    db.flush()
    db.delete(book)
    db.commit()
    try:
        cached_path.unlink(missing_ok=True)
    except OSError:
        logger.exception("Could not delete cached file for removed book_id=%s", book_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.patch("/api/books/{book_id}/move", response_model=BookOut)
def move_book(
    book_id: int,
    payload: MoveBookIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> BookOut:
    book = owned_book_or_404(db, user, book_id)
    if payload.folder_id is not None:
        owned_folder_or_404(db, user, payload.folder_id)
    book.folder_id = payload.folder_id
    log_event(db, user.id, "book_moved_to_folder", book.id, {"folder_id": payload.folder_id})
    db.commit()
    db.refresh(book)
    return serialize_book(book)


@app.get("/api/books/{book_id}/file")
async def get_book_file(
    book_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
):
    book = owned_book_or_404(db, user, book_id)
    if book.too_large:
        log_event(db, user.id, "too_large_file_opened", book.id)
        db.commit()
    path = await ensure_cached_file(settings, book)
    book.last_opened_at = datetime.now(timezone.utc)
    log_event(db, user.id, "book_opened", book.id)
    db.commit()
    return FileResponse(path, media_type=book.mime_type or "application/octet-stream", filename=book.file_name)


@app.get("/api/folders", response_model=list[FolderOut])
def list_folders(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[Folder]:
    return db.scalars(select(Folder).where(Folder.user_id == user.id).order_by(Folder.sort_order)).all()


@app.post("/api/folders", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
def create_folder(
    payload: FolderCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Folder:
    next_order = db.scalar(select(func.coalesce(func.max(Folder.sort_order), 0)).where(Folder.user_id == user.id))
    folder = Folder(user_id=user.id, name=payload.name.strip(), sort_order=(next_order or 0) + 1)
    db.add(folder)
    try:
        db.flush()
        log_event(db, user.id, "folder_created", meta={"folder_id": folder.id})
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Folder already exists") from exc
    db.refresh(folder)
    return folder


@app.patch("/api/folders/{folder_id}", response_model=FolderOut)
def rename_folder(
    folder_id: int,
    payload: FolderUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Folder:
    folder = owned_folder_or_404(db, user, folder_id)
    folder.name = payload.name.strip()
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Folder already exists") from exc
    db.refresh(folder)
    return folder


@app.delete("/api/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(folder_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> Response:
    folder = owned_folder_or_404(db, user, folder_id)
    for book in folder.books:
        book.folder_id = None
    db.delete(folder)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/books/{book_id}/position", response_model=ReadingPositionOut | None)
def get_position(
    book_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    owned_book_or_404(db, user, book_id)
    return db.scalar(
        select(ReadingPosition).where(
            ReadingPosition.book_id == book_id,
            ReadingPosition.user_id == user.id,
        )
    )


@app.put("/api/books/{book_id}/position", response_model=ReadingPositionOut)
def upsert_position(
    book_id: int,
    payload: ReadingPositionIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ReadingPosition:
    book = owned_book_or_404(db, user, book_id)
    pos = db.scalar(
        select(ReadingPosition).where(
            ReadingPosition.book_id == book_id,
            ReadingPosition.user_id == user.id,
        )
    )
    if pos is None:
        pos = ReadingPosition(book_id=book_id, user_id=user.id, locator=payload.locator, percent=payload.percent)
        db.add(pos)
    else:
        pos.locator = payload.locator
        pos.percent = payload.percent
        pos.updated_at = datetime.now(timezone.utc)
    book.last_opened_at = datetime.now(timezone.utc)
    log_event(db, user.id, "reading_position_saved", book.id, {"percent": payload.percent})
    db.commit()
    db.refresh(pos)
    return pos


@app.post("/api/events", status_code=status.HTTP_204_NO_CONTENT)
def create_event(
    payload: EventIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Response:
    if payload.book_id is not None:
        owned_book_or_404(db, user, payload.book_id)
    log_event(db, user.id, payload.type, payload.book_id, payload.meta)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


miniapp_dist = Path(__file__).resolve().parents[2] / "miniapp" / "dist"
if miniapp_dist.exists():
    app.mount("/", StaticFiles(directory=miniapp_dist, html=True), name="miniapp")
