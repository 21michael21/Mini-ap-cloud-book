"""Add per-book bookmarks and notes.

Revision ID: 0002_notes
Revises: 0001_initial_schema
Create Date: 2026-06-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_notes"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("book_id", sa.Integer(), sa.ForeignKey("books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("percent", sa.Float(), nullable=False, server_default="0"),
        sa.Column("note_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_notes_user_book_created", "notes", ["user_id", "book_id", "created_at"])
    op.create_index("ix_notes_book_percent", "notes", ["book_id", "percent"])


def downgrade() -> None:
    op.drop_index("ix_notes_book_percent", table_name="notes")
    op.drop_index("ix_notes_user_book_created", table_name="notes")
    op.drop_table("notes")
