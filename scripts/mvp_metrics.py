#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.config import Settings, normalize_database_url  # noqa: E402
from backend.app.models import Book, Event, Folder, User  # noqa: E402


WATCHED_EVENTS = [
    "book_opened",
    "reading_position_saved",
    "continue_clicked",
    "search_used",
    "folder_created",
    "book_moved_to_folder",
]


def scalar_count(db: Session, statement) -> int:
    return int(db.scalar(statement) or 0)


def grouped_counts(db: Session, statement) -> dict[str, int]:
    return {str(key): int(count) for key, count in db.execute(statement).all()}


def users_with_at_least_books(db: Session, minimum: int) -> int:
    rows = db.execute(select(Book.user_id).group_by(Book.user_id).having(func.count(Book.id) >= minimum)).all()
    return len(rows)


def event_user_ids(db: Session, event_types: list[str]) -> set[int]:
    if not event_types:
        return set()
    return set(
        db.scalars(select(Event.user_id).where(Event.type.in_(event_types)).distinct()).all()
    )


def uploaded_files_by_format(db: Session) -> dict[str, int]:
    counts: dict[str, int] = {}
    rows = db.execute(select(Event.meta).where(Event.type == "file_uploaded")).all()
    for (meta,) in rows:
        fmt = "unknown"
        if isinstance(meta, dict) and isinstance(meta.get("format"), str) and meta["format"].strip():
            fmt = meta["format"].strip().lower()
        counts[fmt] = counts.get(fmt, 0) + 1
    return dict(sorted(counts.items()))


def collect_metrics(db: Session, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    event_counts = grouped_counts(
        db,
        select(Event.type, func.count(Event.id)).group_by(Event.type),
    )
    top_events = [
        {"type": event_type, "count": int(count)}
        for event_type, count in db.execute(
            select(Event.type, func.count(Event.id).label("count"))
            .group_by(Event.type)
            .order_by(func.count(Event.id).desc(), Event.type.asc())
            .limit(10)
        ).all()
    ]

    file_uploaded_users = event_user_ids(db, ["file_uploaded"])
    miniapp_opened_users = event_user_ids(db, ["miniapp_opened"])
    organization_users = event_user_ids(db, ["folder_created", "book_moved_to_folder"])

    return {
        "generated_at": now.isoformat(),
        "totals": {
            "users": scalar_count(db, select(func.count(User.id))),
            "books": scalar_count(db, select(func.count(Book.id))),
            "folders": scalar_count(db, select(func.count(Folder.id))),
            "too_large": scalar_count(db, select(func.count(Book.id)).where(Book.too_large.is_(True))),
        },
        "uploaded_files_by_format": uploaded_files_by_format(db),
        "upload_depth": {
            "users_with_1_or_more_uploaded_files": users_with_at_least_books(db, 1),
            "users_with_2_or_more_uploaded_files": users_with_at_least_books(db, 2),
        },
        "events": {event_type: event_counts.get(event_type, 0) for event_type in WATCHED_EVENTS},
        "active_users": {
            "last_24h": scalar_count(
                db,
                select(func.count(func.distinct(Event.user_id))).where(Event.created_at >= now - timedelta(hours=24)),
            ),
            "last_7d": scalar_count(
                db,
                select(func.count(func.distinct(Event.user_id))).where(Event.created_at >= now - timedelta(days=7)),
            ),
        },
        "top_event_types": top_events,
        "signals": {
            "activation_count": len(file_uploaded_users & miniapp_opened_users),
            "first_read_count": len(event_user_ids(db, ["book_opened"])),
            "continue_users": len(event_user_ids(db, ["continue_clicked"])),
            "organization_users": len(organization_users),
        },
    }


def render_report(metrics: dict[str, Any]) -> str:
    totals = metrics["totals"]
    upload_depth = metrics["upload_depth"]
    events = metrics["events"]
    active = metrics["active_users"]
    signals = metrics["signals"]
    formats = metrics["uploaded_files_by_format"]

    lines = [
        "Telegram Library MVP Metrics",
        f"Generated at: {metrics['generated_at']}",
        "",
        "Totals",
        f"  users: {totals['users']}",
        f"  books: {totals['books']}",
        f"  folders: {totals['folders']}",
        f"  too_large: {totals['too_large']}",
        "",
        "Uploaded files by format",
    ]
    if formats:
        lines.extend(f"  {fmt}: {count}" for fmt, count in sorted(formats.items()))
    else:
        lines.append("  none: 0")

    lines.extend(
        [
            "",
            "Upload depth",
            f"  users with >=1 uploaded file: {upload_depth['users_with_1_or_more_uploaded_files']}",
            f"  users with >=2 uploaded files: {upload_depth['users_with_2_or_more_uploaded_files']}",
            "",
            "Core events",
        ]
    )
    lines.extend(f"  {event_type}: {events[event_type]}" for event_type in WATCHED_EVENTS)
    lines.extend(
        [
            "",
            "Active users",
            f"  last 24h: {active['last_24h']}",
            f"  last 7d: {active['last_7d']}",
            "",
            "MVP signals",
            f"  activation_count: {signals['activation_count']}",
            f"  first_read_count: {signals['first_read_count']}",
            f"  continue_users: {signals['continue_users']}",
            f"  organization_users: {signals['organization_users']}",
            "",
            "Top event types",
        ]
    )
    if metrics["top_event_types"]:
        lines.extend(f"  {item['type']}: {item['count']}" for item in metrics["top_event_types"])
    else:
        lines.append("  none: 0")
    return "\n".join(lines)


def database_url_from_env() -> str:
    raw_url = os.environ.get("DATABASE_URL") or Settings().database_url
    return normalize_database_url(raw_url)


def main() -> int:
    parser = argparse.ArgumentParser(description="Print aggregate Telegram Library MVP metrics.")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args()

    engine = create_engine(database_url_from_env(), pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine)
    with SessionLocal() as db:
        metrics = collect_metrics(db)

    if args.json:
        print(json.dumps(metrics, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_report(metrics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
