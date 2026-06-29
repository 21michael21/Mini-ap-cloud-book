from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.config import Settings, get_settings
from backend.app.db import get_db
from backend.app.models import User


@dataclass(frozen=True)
class TelegramIdentity:
    tg_user_id: int
    username: str | None = None


def validate_init_data(init_data: str, bot_token: str, max_age_seconds: int) -> TelegramIdentity:
    if not bot_token:
        raise ValueError("bot token is not configured")
    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise ValueError("initData hash is missing")

    auth_date_raw = pairs.get("auth_date")
    if not auth_date_raw:
        raise ValueError("auth_date is missing")
    auth_date = int(auth_date_raw)
    now = time.time()
    if auth_date - now > 300:
        raise ValueError("initData auth_date is in the future")
    if now - auth_date > max_age_seconds:
        raise ValueError("initData is stale")

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        raise ValueError("initData signature is invalid")

    user_raw = pairs.get("user")
    if not user_raw:
        raise ValueError("user is missing")
    user = json.loads(user_raw)
    return TelegramIdentity(tg_user_id=int(user["id"]), username=user.get("username"))


def get_or_create_user(db: Session, tg_user_id: int) -> User:
    user = db.scalar(select(User).where(User.tg_user_id == tg_user_id))
    if user:
        return user
    user = User(tg_user_id=tg_user_id)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def current_user(
    x_telegram_init_data: str | None = Header(None, alias="X-Telegram-Init-Data"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    try:
        identity = validate_init_data(
            x_telegram_init_data or "",
            settings.bot_token,
            settings.initdata_max_age_seconds,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Telegram initData",
        ) from exc
    return get_or_create_user(db, identity.tg_user_id)
