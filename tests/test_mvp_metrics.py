from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.db import Base
from backend.app.models import Book, Event, Folder, User
from scripts.mvp_metrics import collect_metrics, render_report


def add_book(db: Session, user: User, unique_id: str, fmt: str, *, too_large: bool = False) -> Book:
    book = Book(
        user_id=user.id,
        tg_file_id=f"{unique_id}-file",
        tg_file_unique_id=unique_id,
        file_name=f"{unique_id}.{fmt}",
        mime_type=None,
        title=f"{fmt.upper()} book",
        author=None,
        format=fmt,
        cover_ref=None,
        size_bytes=1024,
        too_large=too_large,
        folder_id=None,
    )
    db.add(book)
    db.flush()
    return book


def add_event(db: Session, user: User, event_type: str, created_at: datetime, book: Book | None = None) -> None:
    meta = {"format": book.format} if event_type == "file_uploaded" and book else None
    db.add(Event(user_id=user.id, type=event_type, book_id=book.id if book else None, meta=meta, created_at=created_at))


def test_collect_mvp_metrics_aggregates_without_private_user_data() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    now = datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc)

    with Session(engine) as db:
        user_a = User(tg_user_id=100100)
        user_b = User(tg_user_id=200200)
        user_c = User(tg_user_id=300300)
        db.add_all([user_a, user_b, user_c])
        db.flush()

        db.add(Folder(user_id=user_a.id, name="Research", sort_order=1))
        book_a = add_book(db, user_a, "a", "epub")
        book_b = add_book(db, user_a, "b", "pdf", too_large=True)
        book_c = add_book(db, user_c, "c", "txt")

        add_event(db, user_a, "file_uploaded", now - timedelta(hours=2), book_a)
        db.add(
            Event(
                user_id=user_a.id,
                type="file_uploaded",
                book_id=book_b.id,
                meta={"format": "pdf"},
                created_at=now - timedelta(minutes=55),
            )
        )
        add_event(db, user_a, "miniapp_opened", now - timedelta(hours=1))
        add_event(db, user_a, "book_opened", now - timedelta(minutes=50), book_a)
        add_event(db, user_a, "reading_position_saved", now - timedelta(minutes=45), book_a)
        add_event(db, user_a, "continue_clicked", now - timedelta(minutes=40), book_a)
        add_event(db, user_a, "folder_created", now - timedelta(minutes=35))
        add_event(db, user_a, "book_moved_to_folder", now - timedelta(minutes=30), book_a)
        add_event(db, user_b, "search_used", now - timedelta(days=3))
        db.add(
            Event(
                user_id=user_c.id,
                type="file_uploaded",
                book_id=book_c.id,
                meta={"format": "txt"},
                created_at=now - timedelta(days=8),
            )
        )
        add_event(db, user_c, "miniapp_opened", now - timedelta(days=8))
        db.commit()

        metrics = collect_metrics(db, now=now)

    assert metrics["totals"] == {"users": 3, "books": 3, "folders": 1, "too_large": 1}
    assert metrics["uploaded_files_by_format"] == {"epub": 1, "pdf": 1, "txt": 1}
    assert metrics["upload_depth"]["users_with_1_or_more_uploaded_files"] == 2
    assert metrics["upload_depth"]["users_with_2_or_more_uploaded_files"] == 1
    assert metrics["events"]["book_opened"] == 1
    assert metrics["events"]["reading_position_saved"] == 1
    assert metrics["events"]["continue_clicked"] == 1
    assert metrics["events"]["search_used"] == 1
    assert metrics["events"]["folder_created"] == 1
    assert metrics["events"]["book_moved_to_folder"] == 1
    assert metrics["active_users"] == {"last_24h": 1, "last_7d": 2}
    assert metrics["signals"] == {
        "activation_count": 2,
        "first_read_count": 1,
        "continue_users": 1,
        "organization_users": 1,
    }
    assert metrics["top_event_types"][0] == {"type": "file_uploaded", "count": 3}

    report = render_report(metrics)
    assert "Telegram Library MVP Metrics" in report
    assert "activation_count: 2" in report
    assert "100100" not in report
    assert "200200" not in report
    assert "300300" not in report
