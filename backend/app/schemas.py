from datetime import datetime

from pydantic import BaseModel, Field


class FolderOut(BaseModel):
    id: int
    name: str
    sort_order: int
    created_at: datetime

    model_config = {"from_attributes": True}


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class FolderUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class BookOut(BaseModel):
    id: int
    file_name: str
    title: str
    author: str | None
    format: str
    cover_ref: str | None
    size_bytes: int
    too_large: bool
    possible_duplicate: bool = False
    folder_id: int | None
    added_at: datetime
    last_opened_at: datetime | None
    progress_percent: float = 0.0


class MoveBookIn(BaseModel):
    folder_id: int | None = None


class BookUpdate(BaseModel):
    title: str | None = None
    author: str | None = None


class ReadingPositionIn(BaseModel):
    locator: str = Field(min_length=1)
    percent: float = Field(ge=0, le=100)


class ReadingPositionOut(BaseModel):
    book_id: int
    locator: str
    percent: float
    updated_at: datetime

    model_config = {"from_attributes": True}


class NoteIn(BaseModel):
    locator: str = Field(min_length=1)
    percent: float = Field(ge=0, le=100)
    note_text: str | None = None


class NoteUpdate(BaseModel):
    note_text: str | None = None


class NoteOut(BaseModel):
    id: int
    book_id: int
    locator: str
    percent: float
    note_text: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventIn(BaseModel):
    type: str = Field(min_length=1, max_length=80)
    book_id: int | None = None
    meta: dict | None = None


class HomeOut(BaseModel):
    continue_book: BookOut | None
    recent: list[BookOut]
    folders: list[FolderOut]
