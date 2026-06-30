"""Add manual order for books.

Revision ID: 0004_book_manual_order
Revises: 0003_book_duplicates
Create Date: 2026-06-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_book_manual_order"
down_revision: str | None = "0003_book_duplicates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("books", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_books_user_sort", "books", ["user_id", "sort_order"])


def downgrade() -> None:
    op.drop_index("ix_books_user_sort", table_name="books")
    op.drop_column("books", "sort_order")
