from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_database_url(database_url: str) -> str:
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+psycopg://", 1)
    return database_url


class Settings(BaseSettings):
    bot_token: str = ""
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/telegram_library"
    webapp_url: str = "http://localhost:5173"
    backend_public_url: str = "http://localhost:8000"
    file_cache_dir: Path = Path("./file_cache")
    file_cache_max_bytes: int = 512 * 1024 * 1024
    file_cache_max_age_seconds: int = 60 * 60 * 24 * 14
    initdata_max_age_seconds: int = 60 * 60 * 24
    max_telegram_download_bytes: int = 20 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode="after")
    def use_installed_postgres_driver(self) -> "Settings":
        self.database_url = normalize_database_url(self.database_url)
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
