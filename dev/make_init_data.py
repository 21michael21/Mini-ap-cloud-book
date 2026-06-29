from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode


def make_init_data(bot_token: str, tg_user_id: int, username: str = "reader_harness") -> str:
    pairs = {
        "auth_date": str(int(time.time())),
        "query_id": "reader-harness",
        "user": json.dumps({"id": tg_user_id, "username": username}, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    pairs["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(pairs)


def main() -> None:
    bot_token = os.environ["BOT_TOKEN"]
    tg_user_id = int(os.environ.get("HARNESS_TG_USER_ID", "42424242"))
    print(make_init_data(bot_token, tg_user_id))


if __name__ == "__main__":
    main()
