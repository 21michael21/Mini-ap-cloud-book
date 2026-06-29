from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from backend.app.auth import validate_init_data


def signed_init_data(bot_token: str, user_id: int = 42, auth_date: int | None = None) -> str:
    pairs = {
        "auth_date": str(auth_date or int(time.time())),
        "query_id": "test-query",
        "user": json.dumps({"id": user_id, "username": "reader"}, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    pairs["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(pairs)


def test_validate_init_data_accepts_valid_signature() -> None:
    identity = validate_init_data(signed_init_data("token"), "token", max_age_seconds=60)

    assert identity.tg_user_id == 42
    assert identity.username == "reader"


def test_validate_init_data_rejects_tampering() -> None:
    init_data = signed_init_data("token").replace("reader", "attacker")

    with pytest.raises(ValueError, match="signature"):
        validate_init_data(init_data, "token", max_age_seconds=60)


def test_validate_init_data_rejects_stale_auth_date() -> None:
    init_data = signed_init_data("token", auth_date=int(time.time()) - 120)

    with pytest.raises(ValueError, match="stale"):
        validate_init_data(init_data, "token", max_age_seconds=60)
