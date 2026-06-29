from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.config import Settings, get_settings
from backend.app.main import app


def test_health_and_version_include_build_metadata() -> None:
    def override_settings() -> Settings:
        return Settings(
            bot_token="test-token",
            database_url="sqlite+pysqlite:///:memory:",
            webapp_url="https://telegram-library.example.test",
            backend_public_url="https://telegram-library.example.test",
            git_commit="abc123",
            build_time="2026-06-29T18:00:00Z",
            app_env="production",
        )

    app.dependency_overrides[get_settings] = override_settings
    try:
        with TestClient(app) as client:
            for path in ["/health", "/api/version"]:
                response = client.get(path)
                assert response.status_code == 200
                payload = response.json()
                assert payload == {
                    "status": "ok",
                    "app": "telegram-library",
                    "commit": "abc123",
                    "built_at": "2026-06-29T18:00:00Z",
                    "environment": "production",
                    "service": "backend",
                }
    finally:
        app.dependency_overrides.clear()
