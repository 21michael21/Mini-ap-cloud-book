from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    tg_user_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    books: Mapped[list["Book"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    folders: Mapped[list["Folder"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    notes: Mapped[list["Note"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Folder(Base):
    __tablename__ = "folders"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_folders_user_name"),
        Index("ix_folders_user_sort", "user_id", "sort_order"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="folders")
    books: Mapped[list["Book"]] = relationship(back_populates="folder")


class Book(Base):
    __tablename__ = "books"
    __table_args__ = (
        UniqueConstraint("user_id", "tg_file_unique_id", name="uq_books_user_file_unique"),
        Index("ix_books_user_folder", "user_id", "folder_id"),
        Index("ix_books_user_added", "user_id", "added_at"),
        Index("ix_books_user_sort", "user_id", "sort_order"),
        Index("ix_books_user_content_sha256", "user_id", "content_sha256"),
        Index("ix_books_user_normalized_title", "user_id", "normalized_title"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tg_file_id: Mapped[str] = mapped_column(Text, nullable=False)
    tg_file_unique_id: Mapped[str] = mapped_column(String(255), nullable=False)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(255))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str | None] = mapped_column(Text)
    normalized_title: Mapped[str | None] = mapped_column(Text)
    format: Mapped[str] = mapped_column(String(16), nullable=False)
    cover_ref: Mapped[str | None] = mapped_column(Text)
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    too_large: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    possible_duplicate: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"))
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    original_message_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="books")
    folder: Mapped[Folder | None] = relationship(back_populates="books")
    reading_pos: Mapped["ReadingPosition | None"] = relationship(
        back_populates="book", cascade="all, delete-orphan"
    )
    notes: Mapped[list["Note"]] = relationship(back_populates="book", cascade="all, delete-orphan")


class ReadingPosition(Base):
    __tablename__ = "reading_pos"

    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), primary_key=True, nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, nullable=False
    )
    locator: Mapped[str] = mapped_column(Text, nullable=False)
    percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    book: Mapped[Book] = relationship(back_populates="reading_pos")


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (
        Index("ix_notes_user_book_created", "user_id", "book_id", "created_at"),
        Index("ix_notes_book_percent", "book_id", "percent"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    locator: Mapped[str] = mapped_column(Text, nullable=False)
    percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    note_text: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="notes")
    book: Mapped[Book] = relationship(back_populates="notes")


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (Index("ix_events_user_type_created", "user_id", "type", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(String(80), nullable=False)
    book_id: Mapped[int | None] = mapped_column(ForeignKey("books.id", ondelete="SET NULL"))
    meta: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
