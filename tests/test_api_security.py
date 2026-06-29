from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from backend.app.config import Settings, get_settings
from backend.app.db import Base, get_db
from backend.app.main import app
from backend.app.models import Book, Folder, Note, ReadingPosition, User
from backend.app.services import cache_path


BOT_TOKEN = "test-token"


def signed_init_data(user_id: int, auth_date: int | None = None, bot_token: str = BOT_TOKEN) -> str:
    pairs = {
        "auth_date": str(auth_date or int(time.time())),
        "query_id": "test-query",
        "user": json.dumps({"id": user_id, "username": f"user{user_id}"}, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    pairs["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(pairs)


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'api-security.sqlite3'}")
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)

    def override_db() -> Iterator[Session]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_settings() -> Settings:
        return Settings(
            bot_token=BOT_TOKEN,
            database_url="sqlite+pysqlite:///:memory:",
            webapp_url="https://telegram-library.example.test",
            backend_public_url="https://telegram-library.example.test",
            file_cache_dir=tmp_path / "file_cache",
            initdata_max_age_seconds=60,
        )

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_settings] = override_settings
    app.state.testing_session_local = TestingSessionLocal
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        del app.state.testing_session_local
        Base.metadata.drop_all(bind=engine)


def auth_headers(user_id: int, init_data: str | None = None) -> dict[str, str]:
    return {"X-Telegram-Init-Data": signed_init_data(user_id) if init_data is None else init_data}


def seed_owner_data(client: TestClient) -> dict[str, int]:
    SessionLocal = client.app.state.testing_session_local
    with SessionLocal() as db:
        user_a = User(tg_user_id=1001)
        user_b = User(tg_user_id=2002)
        db.add_all([user_a, user_b])
        db.flush()
        folder_a = Folder(user_id=user_a.id, name="A folder", sort_order=1)
        folder_b = Folder(user_id=user_b.id, name="B folder", sort_order=1)
        db.add_all([folder_a, folder_b])
        db.flush()
        book_a = Book(
            user_id=user_a.id,
            tg_file_id="a-file",
            tg_file_unique_id="a-unique",
            file_name="a.epub",
            mime_type="application/epub+zip",
            title="A book",
            author="A author",
            format="epub",
            size_bytes=1024,
            too_large=False,
            folder_id=None,
        )
        book_b = Book(
            user_id=user_b.id,
            tg_file_id="b-file",
            tg_file_unique_id="b-unique",
            file_name="b.epub",
            mime_type="application/epub+zip",
            title="B book",
            author="B author",
            format="epub",
            size_bytes=1024,
            too_large=False,
            folder_id=folder_b.id,
        )
        too_large = Book(
            user_id=user_a.id,
            tg_file_id="large-file",
            tg_file_unique_id="large-unique",
            file_name="large.pdf",
            mime_type="application/pdf",
            title="Large PDF",
            author=None,
            format="pdf",
            size_bytes=25 * 1024 * 1024,
            too_large=True,
            folder_id=None,
        )
        db.add_all([book_a, book_b, too_large])
        db.commit()
        return {
            "book_a": book_a.id,
            "book_b": book_b.id,
            "folder_b": folder_b.id,
            "too_large": too_large.id,
        }


def test_user_cannot_read_or_move_another_users_book_or_folder(client: TestClient) -> None:
    ids = seed_owner_data(client)

    read_other_book = client.get(f"/api/books/{ids['book_b']}", headers=auth_headers(1001))
    update_other_book = client.patch(
        f"/api/books/{ids['book_b']}",
        json={"title": "Mine now"},
        headers=auth_headers(1001),
    )
    delete_other_book = client.delete(f"/api/books/{ids['book_b']}", headers=auth_headers(1001))
    move_other_book = client.patch(
        f"/api/books/{ids['book_b']}/move",
        json={"folder_id": None},
        headers=auth_headers(1001),
    )
    list_other_folder = client.get(f"/api/books?folder_id={ids['folder_b']}", headers=auth_headers(1001))
    move_to_other_folder = client.patch(
        f"/api/books/{ids['book_a']}/move",
        json={"folder_id": ids["folder_b"]},
        headers=auth_headers(1001),
    )

    assert read_other_book.status_code == 404
    assert update_other_book.status_code == 404
    assert delete_other_book.status_code == 404
    assert move_other_book.status_code == 404
    assert list_other_folder.status_code == 404
    assert move_to_other_folder.status_code == 404


def test_user_can_update_own_book_title_and_author(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.patch(
        f"/api/books/{ids['book_a']}",
        json={"title": "  Clean Title  ", "author": "  New Author  "},
        headers=auth_headers(1001),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["title"] == "Clean Title"
    assert payload["author"] == "New Author"


def test_update_book_empty_title_is_rejected(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.patch(
        f"/api/books/{ids['book_a']}",
        json={"title": "   "},
        headers=auth_headers(1001),
    )

    assert response.status_code == 422


def test_update_book_empty_author_is_stored_as_null(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.patch(
        f"/api/books/{ids['book_a']}",
        json={"author": "   "},
        headers=auth_headers(1001),
    )

    assert response.status_code == 200
    assert response.json()["author"] is None


def test_delete_book_removes_reading_position(client: TestClient) -> None:
    ids = seed_owner_data(client)
    SessionLocal = client.app.state.testing_session_local
    settings = client.app.dependency_overrides[get_settings]()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.tg_user_id == 1001))
        assert user is not None
        book = db.get(Book, ids["book_a"])
        assert book is not None
        cached_file = cache_path(settings, book)
        cached_file.parent.mkdir(parents=True, exist_ok=True)
        cached_file.write_text("cached", encoding="utf-8")
        db.add(ReadingPosition(book_id=ids["book_a"], user_id=user.id, locator="5", percent=50.0))
        db.commit()

    response = client.delete(f"/api/books/{ids['book_a']}", headers=auth_headers(1001))

    assert response.status_code == 204
    assert not cached_file.exists()
    with SessionLocal() as db:
        assert db.get(Book, ids["book_a"]) is None
        assert db.scalar(select(ReadingPosition).where(ReadingPosition.book_id == ids["book_a"])) is None


def test_user_can_crud_own_notes(client: TestClient) -> None:
    ids = seed_owner_data(client)
    headers = auth_headers(1001)

    created = client.post(
        f"/api/books/{ids['book_a']}/notes",
        json={"locator": '{"type":"text","sectionIndex":1,"scrollRatio":0.2}', "percent": 42.5, "note_text": "  key bit  "},
        headers=headers,
    )
    assert created.status_code == 201
    note = created.json()
    assert note["note_text"] == "key bit"
    assert note["percent"] == 42.5

    listed = client.get(f"/api/books/{ids['book_a']}/notes", headers=headers)
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [note["id"]]

    updated = client.patch(f"/api/notes/{note['id']}", json={"note_text": "updated"}, headers=headers)
    assert updated.status_code == 200
    assert updated.json()["note_text"] == "updated"

    deleted = client.delete(f"/api/notes/{note['id']}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/books/{ids['book_a']}/notes", headers=headers).json() == []


def test_user_cannot_access_notes_for_another_users_book(client: TestClient) -> None:
    ids = seed_owner_data(client)
    SessionLocal = client.app.state.testing_session_local
    with SessionLocal() as db:
        owner = db.scalar(select(User).where(User.tg_user_id == 2002))
        assert owner is not None
        note = Note(user_id=owner.id, book_id=ids["book_b"], locator="1", percent=10, note_text="private")
        db.add(note)
        db.commit()
        note_id = note.id

    assert client.get(f"/api/books/{ids['book_b']}/notes", headers=auth_headers(1001)).status_code == 404
    assert client.post(
        f"/api/books/{ids['book_b']}/notes",
        json={"locator": "1", "percent": 10, "note_text": None},
        headers=auth_headers(1001),
    ).status_code == 404
    assert client.patch(f"/api/notes/{note_id}", json={"note_text": "peek"}, headers=auth_headers(1001)).status_code == 404
    assert client.delete(f"/api/notes/{note_id}", headers=auth_headers(1001)).status_code == 404


def test_delete_book_cascades_notes(client: TestClient) -> None:
    ids = seed_owner_data(client)
    SessionLocal = client.app.state.testing_session_local
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.tg_user_id == 1001))
        assert user is not None
        db.add(Note(user_id=user.id, book_id=ids["book_a"], locator="5", percent=50.0, note_text=None))
        db.commit()

    response = client.delete(f"/api/books/{ids['book_a']}", headers=auth_headers(1001))

    assert response.status_code == 204
    with SessionLocal() as db:
        assert db.scalar(select(Note).where(Note.book_id == ids["book_a"])) is None


def test_note_percent_must_be_valid(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.post(
        f"/api/books/{ids['book_a']}/notes",
        json={"locator": "1", "percent": 101, "note_text": None},
        headers=auth_headers(1001),
    )

    assert response.status_code == 422


def test_delete_too_large_book_works(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.delete(f"/api/books/{ids['too_large']}", headers=auth_headers(1001))

    assert response.status_code == 204
    assert client.get(f"/api/books/{ids['too_large']}", headers=auth_headers(1001)).status_code == 404


@pytest.mark.parametrize(
    "init_data",
    [
        "",
        signed_init_data(1001, bot_token="wrong-token"),
        signed_init_data(1001, auth_date=int(time.time()) - 120),
    ],
)
def test_invalid_stale_or_forged_init_data_returns_401(client: TestClient, init_data: str) -> None:
    response = client.get("/api/home", headers=auth_headers(1001, init_data=init_data))

    assert response.status_code == 401


def test_missing_init_data_header_returns_401(client: TestClient) -> None:
    response = client.get("/api/home")

    assert response.status_code == 401


def test_too_large_book_file_endpoint_returns_413(client: TestClient) -> None:
    ids = seed_owner_data(client)

    response = client.get(f"/api/books/{ids['too_large']}/file", headers=auth_headers(1001))

    assert response.status_code == 413


def test_create_duplicate_folder_returns_409(client: TestClient) -> None:
    headers = auth_headers(1001)
    created = client.post("/api/folders", json={"name": "Research"}, headers=headers)
    duplicate = client.post("/api/folders", json={"name": "Research"}, headers=headers)

    assert created.status_code == 201
    assert duplicate.status_code == 409


def test_rename_duplicate_folder_returns_409(client: TestClient) -> None:
    headers = auth_headers(1001)
    first = client.post("/api/folders", json={"name": "Research"}, headers=headers)
    second = client.post("/api/folders", json={"name": "Archive"}, headers=headers)

    response = client.patch(f"/api/folders/{second.json()['id']}", json={"name": "Research"}, headers=headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert response.status_code == 409
