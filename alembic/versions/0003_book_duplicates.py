"""Add book duplicate detection fields.

Revision ID: 0003_book_duplicates
Revises: 0002_notes
Create Date: 2026-06-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_book_duplicates"
down_revision: str | None = "0002_notes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("books", sa.Column("content_sha256", sa.String(length=64), nullable=True))
    op.add_column("books", sa.Column("normalized_title", sa.Text(), nullable=True))
    op.add_column("books", sa.Column("original_message_date", sa.DateTime(timezone=True), nullable=True))
    op.add_column("books", sa.Column("possible_duplicate", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_books_user_content_sha256", "books", ["user_id", "content_sha256"])
    op.create_index("ix_books_user_normalized_title", "books", ["user_id", "normalized_title"])


def downgrade() -> None:
    op.drop_index("ix_books_user_normalized_title", table_name="books")
    op.drop_index("ix_books_user_content_sha256", table_name="books")
    op.drop_column("books", "possible_duplicate")
    op.drop_column("books", "original_message_date")
    op.drop_column("books", "normalized_title")
    op.drop_column("books", "content_sha256")
