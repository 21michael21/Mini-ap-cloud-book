import mimetypes
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from backend.app.auth import current_user
from backend.app.config import Settings, get_settings
from backend.app.db import get_db
from backend.app.models import Book, Folder, ReadingPosition, User
from backend.app.schemas import (
    BookOut,
    EventIn,
    FolderCreate,
    FolderOut,
    FolderUpdate,
    HomeOut,
    MoveBookIn,
    ReadingPositionIn,
    ReadingPositionOut,
)
from backend.app.services import ensure_cached_file, log_event, owned_book_or_404, owned_folder_or_404


mimetypes.add_type("font/woff2", ".woff2")

app = FastAPI(title="Telegram Library API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    settings = get_settings()
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
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://telegram.org https://cdn.jsdelivr.net; "
        "style-src 'self'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        f"connect-src {connect_src}; "
        "worker-src 'self' blob: https://cdn.jsdelivr.net; "
        "frame-src blob: data:; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "frame-ancestors 'self' https://web.telegram.org;"
    )
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    db.flush()
    log_event(db, user.id, "folder_created", meta={"folder_id": folder.id})
    db.commit()
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
    db.commit()
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
