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

This repo deploys as three Railway resources:

- `telegram-library-backend`: FastAPI API and the built Mini App static files.
- `telegram-library-bot`: aiogram worker.
- Railway Postgres.

The Mini App is served by the backend service over HTTPS, so `WEBAPP_URL` and `BACKEND_PUBLIC_URL` should usually be the same public Railway backend URL.
The root `railway.json` uses the included Dockerfile and deploys the backend service by default. The Docker image installs Python dependencies, builds `miniapp/dist`, and starts the backend with Alembic migrations.

Required env vars:

```text
BOT_TOKEN=BotFather token
DATABASE_URL=Railway Postgres connection URL
WEBAPP_URL=https://your-backend.up.railway.app
BACKEND_PUBLIC_URL=https://your-backend.up.railway.app
FILE_CACHE_DIR=/data/file_cache
INITDATA_MAX_AGE_SECONDS=86400
MAX_TELEGRAM_DOWNLOAD_BYTES=20971520
```

Railway Postgres may provide `DATABASE_URL` as `postgresql://...`; the app normalizes it to the installed `psycopg` v3 SQLAlchemy driver at startup.

Backend service:

```bash
railway service create telegram-library-backend
railway variables --set "BOT_TOKEN=<botfather-token>" \
  --set "DATABASE_URL=<railway-postgres-url>" \
  --set "WEBAPP_URL=https://your-backend.up.railway.app" \
  --set "BACKEND_PUBLIC_URL=https://your-backend.up.railway.app" \
  --set "FILE_CACHE_DIR=/data/file_cache"
railway up --service telegram-library-backend
```

In Railway settings for `telegram-library-backend`:

```text
Builder: Dockerfile
Start command: ./scripts/railway_backend_start.sh
Healthcheck path: /health
Volume mount: /data
```

The backend start command validates Railway env, runs `alembic upgrade head`, then starts Uvicorn. If the deploy crashes immediately, the logs should name the missing or invalid env var.

Bot worker service:

```bash
railway service create telegram-library-bot
railway variables --set "BOT_TOKEN=<botfather-token>" \
  --set "DATABASE_URL=<railway-postgres-url>" \
  --set "WEBAPP_URL=https://your-backend.up.railway.app" \
  --set "BACKEND_PUBLIC_URL=https://your-backend.up.railway.app" \
  --set "FILE_CACHE_DIR=/data/file_cache"
railway up --service telegram-library-bot
```

In Railway settings for `telegram-library-bot`:

```text
Builder: Dockerfile
Start command: ./scripts/railway_bot_start.sh
```

Use the same env vars as the backend service. The bot does not serve HTTP, so it should be a worker service, not the public Mini App URL.

Postgres:

```bash
railway add --database postgres
```

If you create services from the GitHub repo in the Railway UI, create/link Postgres first, then add these variables to both backend and bot services. `DATABASE_URL` must come from the Railway Postgres service, not a local `localhost` URL. After Railway gives the backend a public HTTPS domain, set both `WEBAPP_URL` and `BACKEND_PUBLIC_URL` to that exact URL and redeploy/restart both services.

After deploy, open the backend public URL in a browser. It should load the Mini App shell over HTTPS. The bot registers a Telegram menu button named `Library` on startup and still sends an `Open Library` Web App button after file uploads.

## Telegram Client E2E Checklist

Run this in the real Telegram mobile client after Railway deploy:

1. Open the bot chat and send a small EPUB file.
   Expected: the bot replies `Added to Inbox: ...` with an `Open Library` button.
2. Tap `Open Library`.
   Expected: Telegram opens the Mini App over HTTPS; the library loads without login; the uploaded EPUB appears in Inbox.
3. Tap the EPUB and read enough to change position.
   Expected: the book renders inside Telegram; no external browser opens.
4. Fully close the Mini App, reopen it from the bot, and tap `Continue reading`.
   Expected: the same EPUB opens and restores the previous locator.
5. Send a small PDF file and open it from the Mini App.
   Expected: PDF page 1 renders; tapping the right side advances pages; closing and reopening restores the saved page number.
6. Send a file larger than `MAX_TELEGRAM_DOWNLOAD_BYTES` (20 MB by default).
   Expected: the file appears in the library as a `too_large` record with a `Download original` action; the Mini App does not call the in-app reader for it and tells the user to use the original Telegram message for download.

If any Mini App request fails, check that `WEBAPP_URL` and `BACKEND_PUBLIC_URL` point to the same deployed HTTPS backend URL and that the bot service was restarted after env changes.

## Verification

```bash
python -m pytest -q
python -m compileall backend bot
cd miniapp && npm install && npm run build
```

Reader harness verification uses local generated files and the same authenticated file endpoint as the app:

```bash
python dev/generate_reader_samples.py
export HARNESS_BOT_TOKEN="use-a-valid-test-token-shape"
BOT_TOKEN="$HARNESS_BOT_TOKEN" \
DATABASE_URL=sqlite+pysqlite:///dev/reader_harness.sqlite3 \
FILE_CACHE_DIR=dev/file_cache \
PYTHONPATH=. python dev/seed_reader_harness.py

INIT_DATA=$(BOT_TOKEN="$HARNESS_BOT_TOKEN" python dev/make_init_data.py)
cd miniapp
VITE_API_BASE=http://localhost:8000 VITE_DEV_INIT_DATA="$INIT_DATA" npm run build:harness
```

The Mini App CSP is intentionally strict:

```text
default-src 'self'; script-src 'self' https://telegram.org https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://telegram.org https://web.telegram.org; worker-src 'self' blob: https://cdn.jsdelivr.net; frame-src blob: data:; object-src 'none'; base-uri 'none';
```

Book HTML is sanitized before rendering and placed in sandboxed iframes with `sandbox="allow-same-origin"` and no `allow-scripts`.

Completion requires the local and remote hashes to match:

```bash
git rev-parse HEAD
git ls-remote origin main
```
