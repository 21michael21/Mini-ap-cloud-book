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

## Library Management MVP

Books can be renamed, assigned an author, moved to folders, removed from the local library, and manually reordered from the Mini App actions sheet. Removing a book deletes only the local library record and cached copy; it does not delete the original Telegram file.

Manual book order is intentionally simple for the MVP: `books.sort_order` is global per user and then applied inside All, Inbox, and folder views. This means a manual move in a folder can affect the relative order seen in All, but it avoids a separate per-folder ordering table while alpha testing the workflow.

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
FILE_CACHE_MAX_BYTES=536870912
FILE_CACHE_MAX_AGE_SECONDS=1209600
COVER_CACHE_DIR=./file_cache/covers
COVER_CACHE_MAX_BYTES=67108864
COVER_IMAGE_MAX_BYTES=2097152
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
FILE_CACHE_MAX_BYTES=536870912
FILE_CACHE_MAX_AGE_SECONDS=1209600
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

## VDS Deploy

The VDS deployment uses Docker Compose v2 on the server and the existing Caddy container from `/opt/interview-base`.

Public Mini App URL:

```text
https://telegram-library.89.124.84.4.sslip.io
```

Server layout:

```text
/opt/telegram-library/docker-compose.yml
/opt/telegram-library/.env
/opt/telegram-library/file_cache/
```

Backend and bot use the same Docker image. The backend joins the existing `interview-base_default` Docker network so the existing Caddy container can reverse proxy to `telegram-library-backend:8000`.

### Safe VDS deploy on 10 GB disk

The current VDS has about 10 GB of disk. Treat disk as a deployment risk: Docker builds, dangling images, build cache, JSON logs, and downloaded book files can fill the server.

Before deploying, check disk usage:

```bash
ssh root@89.124.84.4
cd /opt/telegram-library
./scripts/vds_disk_report.sh
```

Deploy with the guarded script:

```bash
cd /opt/telegram-library
./scripts/vds_deploy_safe.sh
```

Expected output includes:

```text
== pre-build disk guard ==
Free disk is OK: ...
== docker compose build ==
== docker compose up ==
== health ==
{"status":"ok", ...}
== api version ==
{"status":"ok", ...}
```

Rules for this small server:

- Never run `docker system prune --volumes`.
- Do not delete named Docker volumes unless you are intentionally deleting data.
- Do not delete the Postgres volume.
- Do not delete `./file_cache` unless explicitly asked; it contains cached user files.
- Safe cleanup is limited to dangling images and old build cache: `docker image prune -f` and `docker builder prune -f --filter "until=24h"`.
- The deploy script requires at least 2.5 GB free before Docker build and aborts if safe cleanup cannot reach that.

For a 10 GB server, keep file cache capped in `.env`:

```text
FILE_CACHE_MAX_BYTES=268435456
FILE_CACHE_MAX_AGE_SECONDS=1209600
COVER_CACHE_DIR=./file_cache/covers
COVER_CACHE_MAX_BYTES=33554432
COVER_IMAGE_MAX_BYTES=2097152
```

Do not increase the cache above `536870912` bytes (512 MB) on this VPS size. The backend already respects `FILE_CACHE_MAX_BYTES` and `FILE_CACHE_MAX_AGE_SECONDS` via the file cache cleanup path, so lower the cap first if disk gets tight.
Keep cover thumbnails small too: `COVER_CACHE_MAX_BYTES=33554432` (32 MB) is enough for alpha testing, and `COVER_IMAGE_MAX_BYTES=2097152` rejects oversized embedded images.

Rollback note: after safe pruning, the previous Docker image may no longer be available locally. Test `/health` and `/api/version` immediately after deploy. If rollback is needed, deploy the previous Git commit again rather than relying on a local old image.

### VDS Verification Before Phone Testing

Run this before opening the Mini App on your phone:

```bash
ssh root@89.124.84.4
cd /opt/telegram-library
git log --oneline -1 || true
docker compose ps
curl -fsS https://telegram-library.89.124.84.4.sslip.io/health
curl -fsS https://telegram-library.89.124.84.4.sslip.io/api/version
```

Or from the project directory on the server:

```bash
./scripts/vds_verify.sh
```

Expected health/version shape:

```json
{
  "status": "ok",
  "app": "telegram-library",
  "commit": "bb20d92...",
  "built_at": "2026-06-29T18:00:00Z",
  "environment": "production",
  "service": "backend"
}
```

If `commit` or `built_at` is `unknown`, the image was built without the Docker build args. The app can still run, but you cannot confirm the deployed commit from your phone.

### Version sanity without user-facing debug UI

The Mini App does not show debug build metadata to normal users. To verify what is deployed, use:

```bash
curl -fsS <BACKEND_PUBLIC_URL>/api/version
```

The bot also responds to `/version` with the bot/backend URLs and build metadata configured for the running service.

### Reader Quality Gate Before VDS Deploy

Reader changes must stay local until the quality gate is clean. Run:

```bash
scripts/local_quality_gate.sh
cd miniapp && npm run e2e:reader:screenshots
```

If `dev/reader_fixtures/private/` contains problematic real books, the gate
automatically includes them and writes:

```text
reports/reader-experiments/private-fixtures-summary.json
```

The screenshot artifacts are written to:

```text
tests/screenshots/artifacts/
```

They are for human review right now. Do not deploy if public fixtures fail,
private fixtures fail, or screenshots show broken layout. After deploying, check
`/api/version` before phone testing so the VDS commit matches the commit you
intended to test.

## Telegram Client E2E Checklist

Run this in the real Telegram mobile client after deploy:

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
   Expected: the file appears in the library as a `too_large` record with a `Download original` action; the Mini App does not expose a bot token or raw Telegram file URL. It sends you back to Telegram, where the original file message in the bot chat is the download source.

If any Mini App request fails, check that `WEBAPP_URL` and `BACKEND_PUBLIC_URL` point to the same deployed HTTPS backend URL and that the bot service was restarted after env changes.

## PDF Reader QA Checklist

Run this on a real phone inside Telegram after deploy:

1. Open a PDF from the Mini App library.
   Expected: text edges look crisp, not blurry or pixelated.
2. Tap `+` and `-` in the PDF toolbar.
   Expected: zoom changes smoothly, current page stays current, and text remains readable.
3. Tap `Prev` and `Next` quickly a few times.
   Expected: the final rendered page matches the last requested page.
4. Close the Mini App and reopen the same PDF via Continue.
   Expected: the saved page restores correctly.
5. If a PDF still looks low quality after zooming, check the original file.
   Scanned or low-resolution source PDFs cannot be sharpened without OCR or source replacement.

## How to Check MVP Metrics

Run the aggregate console report against the production or staging database:

```bash
DATABASE_URL=postgresql+psycopg://user:password@host:5432/telegram_library \
  .venv/bin/python scripts/mvp_metrics.py
```

For machine-readable output:

```bash
DATABASE_URL=postgresql+psycopg://user:password@host:5432/telegram_library \
  .venv/bin/python scripts/mvp_metrics.py --json
```

The report prints only aggregate counts: users, books, formats, core events,
active users, and simple MVP signals. It does not print Telegram usernames or
raw Telegram user ids.

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

The Mini App CSP is intentionally strict and has a single source of truth:
the FastAPI HTTP response header in `backend/app/main.py`. `miniapp/index.html`
does not define a CSP `<meta http-equiv>` tag, so production cannot drift between
HTML and the backend header. The HTTP header wins in deployed clients.

```text
default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <BACKEND_PUBLIC_URL> https://telegram.org https://web.telegram.org; worker-src 'self' blob:; frame-src blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org;
```

`pdf.js` uses a Vite-bundled same-origin worker asset, so no CDN is needed in
`script-src` or `worker-src`. CORS is allowlisted to `WEBAPP_URL` and
`BACKEND_PUBLIC_URL`; wildcard origins are intentionally not used.
The PDF reader renders pages in-memory with high-DPI canvases and a tiny
previous/current/next page cache only; it does not write permanent page images.
TODO: add a selectable PDF.js text layer after validating it can be styled
without CSP violations in Telegram WebView.

Book HTML is sanitized before rendering and placed in sandboxed iframes with `sandbox="allow-same-origin"` and no `allow-scripts`.

Reader A/B flags are for local experiments only and must not be set on VDS until
a reader decision is made. See `docs/reader-quality/ab-reader-experiments.md`
for `VITE_TEXT_READER_ENGINE`, `VITE_TEXT_RENDER_MODE`, `VITE_PDF_READER_MODE`,
and `VITE_READER_UI`.

Private reader fixtures are local-only and gitignored. If files exist in
`dev/reader_fixtures/private/`, `scripts/local_quality_gate.sh` runs the private
fixture gate and writes
`reports/reader-experiments/private-fixtures-summary.json` without logging raw
book content.

The backend file cache is bounded by `FILE_CACHE_MAX_BYTES` and `FILE_CACHE_MAX_AGE_SECONDS`.
Cleanup runs around file fetches and removes expired files first, then least-recently-used files until the cache is under the size cap.

Completion requires the local and remote hashes to match:

```bash
git rev-parse HEAD
git ls-remote origin main
```
