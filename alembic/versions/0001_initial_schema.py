"""Initial Telegram Library schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-06-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tg_user_id", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tg_user_id"),
    )
    op.create_index("ix_users_tg_user_id", "users", ["tg_user_id"])

    op.create_table(
        "folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_folders_user_name"),
    )
    op.create_index("ix_folders_user_sort", "folders", ["user_id", "sort_order"])

    op.create_table(
        "books",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tg_file_id", sa.Text(), nullable=False),
        sa.Column("tg_file_unique_id", sa.String(length=255), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("format", sa.String(length=16), nullable=False),
        sa.Column("cover_ref", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("too_large", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "tg_file_unique_id", name="uq_books_user_file_unique"),
    )
    op.create_index("ix_books_user_folder", "books", ["user_id", "folder_id"])
    op.create_index("ix_books_user_added", "books", ["user_id", "added_at"])

    op.create_table(
        "reading_pos",
        sa.Column("book_id", sa.Integer(), sa.ForeignKey("books.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("percent", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(length=80), nullable=False),
        sa.Column("book_id", sa.Integer(), sa.ForeignKey("books.id", ondelete="SET NULL"), nullable=True),
        sa.Column("meta", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_events_user_type_created", "events", ["user_id", "type", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_events_user_type_created", table_name="events")
    op.drop_table("events")
    op.drop_table("reading_pos")
    op.drop_index("ix_books_user_added", table_name="books")
    op.drop_index("ix_books_user_folder", table_name="books")
    op.drop_table("books")
    op.drop_index("ix_folders_user_sort", table_name="folders")
    op.drop_table("folders")
    op.drop_index("ix_users_tg_user_id", table_name="users")
    op.drop_table("users")
