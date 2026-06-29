from __future__ import annotations

from pathlib import Path

from backend.app.config import Settings
from backend.app.main import content_security_policy


def test_backend_csp_has_no_cdn_or_unsafe_script_sources(tmp_path: Path) -> None:
    csp = content_security_policy(
        Settings(
            bot_token="test-token",
            database_url="sqlite+pysqlite:///:memory:",
            webapp_url="https://telegram-library.example.test",
            backend_public_url="https://telegram-library.example.test",
            file_cache_dir=tmp_path,
        )
    )

    assert "https://cdn.jsdelivr.net" not in csp
    assert "unsafe-inline" not in csp
    assert "unsafe-eval" not in csp
    assert "script-src 'self' https://telegram.org;" in csp
    assert "worker-src 'self' blob:;" in csp


def test_index_html_does_not_define_a_meta_csp() -> None:
    index_html = Path("miniapp/index.html").read_text(encoding="utf8")

    assert 'http-equiv="Content-Security-Policy"' not in index_html
