from __future__ import annotations

from backend.app.config import Settings


def test_railway_postgres_url_uses_installed_psycopg_driver() -> None:
    settings = Settings(database_url="postgresql://user:pass@example.railway.internal:5432/railway")

    assert settings.database_url == "postgresql+psycopg://user:pass@example.railway.internal:5432/railway"


def test_explicit_sqlalchemy_driver_url_is_preserved() -> None:
    settings = Settings(database_url="postgresql+psycopg://user:pass@localhost:5432/app")

    assert settings.database_url == "postgresql+psycopg://user:pass@localhost:5432/app"


def test_sqlite_url_is_preserved() -> None:
    settings = Settings(database_url="sqlite+pysqlite:///dev.sqlite3")

    assert settings.database_url == "sqlite+pysqlite:///dev.sqlite3"
