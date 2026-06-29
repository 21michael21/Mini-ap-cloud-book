from __future__ import annotations

import os
import time
from pathlib import Path

from backend.app.config import Settings
from backend.app.services import cleanup_file_cache


def test_cleanup_file_cache_removes_expired_files(tmp_path: Path) -> None:
    old_file = tmp_path / "old.pdf"
    fresh_file = tmp_path / "fresh.pdf"
    old_file.write_bytes(b"old")
    fresh_file.write_bytes(b"fresh")
    old_mtime = time.time() - 3600
    os.utime(old_file, (old_mtime, old_mtime))

    cleanup_file_cache(settings(tmp_path, max_age_seconds=60))

    assert not old_file.exists()
    assert fresh_file.exists()


def test_cleanup_file_cache_evicts_lru_until_under_size_cap(tmp_path: Path) -> None:
    oldest = tmp_path / "oldest.pdf"
    newest = tmp_path / "newest.pdf"
    oldest.write_bytes(b"a" * 80)
    newest.write_bytes(b"b" * 80)
    now = time.time()
    os.utime(oldest, (now - 20, now - 20))
    os.utime(newest, (now, now))

    cleanup_file_cache(settings(tmp_path, max_bytes=100))

    assert not oldest.exists()
    assert newest.exists()


def settings(tmp_path: Path, max_bytes: int = 512, max_age_seconds: int = 3600) -> Settings:
    return Settings(
        bot_token="test-token",
        database_url="sqlite+pysqlite:///:memory:",
        webapp_url="https://telegram-library.example.test",
        backend_public_url="https://telegram-library.example.test",
        file_cache_dir=tmp_path,
        file_cache_max_bytes=max_bytes,
        file_cache_max_age_seconds=max_age_seconds,
    )
