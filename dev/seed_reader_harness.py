from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy import select

from backend.app.config import get_settings
from backend.app.db import Base, SessionLocal, engine
from backend.app.formats import detect_format, extract_metadata
from backend.app.models import Book, User


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
TG_USER_ID = 42424242
SAMPLES = {
    "txt": FIXTURES / "sample.txt",
    "epub": FIXTURES / "sample.epub",
    "fb2": FIXTURES / "sample.fb2",
    "pdf": FIXTURES / "sample.pdf",
}


def main() -> None:
    settings = get_settings()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    settings.file_cache_dir.mkdir(parents=True, exist_ok=True)

    with SessionLocal() as db:
        user = User(tg_user_id=TG_USER_ID)
        db.add(user)
        db.flush()

        for fmt, path in SAMPLES.items():
            file_name = path.name
            detected = detect_format(file_name, None)
            if detected != fmt:
                raise RuntimeError(f"Expected {fmt}, detected {detected}")
            metadata = extract_metadata(path, file_name, fmt)
            book = Book(
                user_id=user.id,
                tg_file_id=f"harness-{fmt}",
                tg_file_unique_id=f"harness-{fmt}",
                file_name=file_name,
                mime_type=mime_type_for(fmt),
                title=f"Harness {fmt.upper()}",
                author=metadata.author or "Harness Author",
                format=fmt,
                cover_ref=None,
                size_bytes=path.stat().st_size,
                too_large=False,
                folder_id=None,
            )
            db.add(book)
            db.flush()
            shutil.copyfile(path, settings.file_cache_dir / f"{book.id}.{fmt}")

        db.commit()

    books = []
    with SessionLocal() as db:
        for book in db.scalars(select(Book).order_by(Book.id)):
            books.append(f"{book.id}:{book.title}:{book.format}")
    print("Seeded reader harness books:")
    print("\n".join(books))


def mime_type_for(fmt: str) -> str:
    return {
        "txt": "text/plain",
        "epub": "application/epub+zip",
        "fb2": "application/x-fictionbook+xml",
        "pdf": "application/pdf",
    }[fmt]


if __name__ == "__main__":
    main()
