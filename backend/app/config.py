from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    bot_token: str = ""
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/telegram_library"
    webapp_url: str = "http://localhost:5173"
    file_cache_dir: Path = Path("./file_cache")
    initdata_max_age_seconds: int = 60 * 60 * 24
    max_telegram_download_bytes: int = 20 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
