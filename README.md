# Telegram Library MVP

Personal book/document library inside Telegram. Users send their own EPUB, FB2, TXT, or PDF files to a bot; the Telegram Mini App shows an organized library and reader with synced progress.

## Scope

This repo intentionally implements only the v1 MVP:

- Telegram bot accepts document uploads and places new books in Inbox.
- Backend stores Telegram file ids, metadata, folders, reading positions, and events.
- Mini App shows Continue, Recent, folders, Library, search by title/author, and a clean reader.
- EPUB/FB2/TXT are opened through `foliate-js`.
- PDF is opened through a separate `pdf.js` path.
- Files over 20 MB are kept as records but are not opened in-app.

No catalogs, scraping, piracy search, AI, Celery, Redis, RabbitMQ, React, or RAG.

## Structure

```text
backend/app/       FastAPI app, SQLAlchemy models, Telegram initData auth
bot/               aiogram 3 bot document handler
miniapp/           Vite + vanilla TypeScript Telegram Mini App
alembic/           PostgreSQL migrations
tests/             Python unit tests
file_cache/        Local cache for Telegram files <= 20 MB
```

## Environment

Copy `.env.example` to `.env` and fill:

```text
BOT_TOKEN=replace-me
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/telegram_library
WEBAPP_URL=https://your-miniapp.example.com
FILE_CACHE_DIR=./file_cache
INITDATA_MAX_AGE_SECONDS=86400
MAX_TELEGRAM_DOWNLOAD_BYTES=20971520
```

## Local Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn backend.app.main:app --reload --port 8000
```

In another terminal:

```bash
source .venv/bin/activate
python -m bot.main
```

Mini App:

```bash
cd miniapp
npm install
VITE_API_BASE=http://localhost:8000 npm run dev
```

For local browser-only development, pass a generated Telegram `initData` string through `VITE_DEV_INIT_DATA`. Real Telegram clients provide `window.Telegram.WebApp.initData`.

## Railway Deploy

1. Create a Railway Postgres database.
2. Create one service for the FastAPI backend:

   ```bash
   uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
   ```

3. Create one worker service for the bot:

   ```bash
   python -m bot.main
   ```

4. Add a Railway volume and point `FILE_CACHE_DIR` to it.
5. Set `BOT_TOKEN`, `DATABASE_URL`, `WEBAPP_URL`, `FILE_CACHE_DIR`.
6. Run `alembic upgrade head` during deploy or as a one-off Railway command.
7. Deploy `miniapp/` as a static Vite app and set BotFather's Web App URL to that deploy URL.

## Verification

```bash
python -m pytest -q
python -m compileall backend bot
cd miniapp && npm install && npm run build
```

Completion requires the local and remote hashes to match:

```bash
git rev-parse HEAD
git ls-remote origin main
```
