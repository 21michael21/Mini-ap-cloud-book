"""Add user onboarding flag.

Revision ID: 0005_user_onboarding
Revises: 0004_book_manual_order
Create Date: 2026-07-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_user_onboarding"
down_revision: str | None = "0004_book_manual_order"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("onboarded_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "onboarded_at")
