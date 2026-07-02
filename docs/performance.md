# Performance Instrumentation

Telegram Library has lightweight local performance instrumentation for the Mini App and backend.
It is diagnostic only: it does not change reader behavior and is hidden from normal users.

## Enable Mini App Perf Debug

Use either option in a local/dev session:

```js
localStorage.setItem("telegram-library-debug-perf", "1")
```

or open the Mini App with:

```text
?debugPerf=1
```

When enabled, the Mini App shows a small debug overlay with the latest timings and exposes:

```js
window.TelegramLibraryPerf.reportPerfSummary()
```

The same summary is printed as a console table when `reportPerfSummary()` runs.

## Frontend Timings

- `app_init_start` -> first app module execution.
- `telegram_ready` -> Telegram WebApp `ready()` was called.
- `home_fetch` -> `/api/home` plus the home book list fetch.
- `library_fetch` -> `/api/books` plus `/api/folders`.
- `app_init_to_first_render` -> first visible shell render after app start.
- `cover_fetch:<bookId>` -> authenticated cover fetch for one book.
- `cover_object_url_created:<bookId>` -> cover Blob was converted into an object URL.
- `search_input_to_results` -> input event to rendered search results.
- `reader_position_fetch` -> saved reading position request.
- `reader_file_fetch` -> authenticated book file fetch.
- `reader_engine_import` -> text reader engine module selection/import.
- `reader_parse` -> reader engine opening/parsing work.
- `open_book_to_first_reader_paint` -> user tap to first reader paint.
- `position_save` -> reading position PUT request.
- `settings_change_apply_time` -> applying Aa/settings changes to live reader UI.
- `toolbar_toggle_time` -> tap-to-toggle reader chrome.

## PDF Timings

- `pdf_import` -> PDF engine availability marker.
- `pdf_file_fetch` -> authenticated PDF file fetch.
- `pdf_parse` -> PDF.js document parse.
- `pdf_page_render` and `pdf_page_render:<page>` -> canvas page render.
- `pdf_canvas_paint` -> rendered page copied into the visible canvas.
- `pdf_zoom_render` -> zoom-triggered PDF render.
- `pdf_next_prev_render` -> page navigation-triggered PDF render.

## Backend Logs

The backend logs compact request timings for low-volume app/API routes, successful book-file fetches, and all errors:

```text
request method=GET path=/api/books status=200 duration_ms=34.7
```

The log intentionally excludes query strings, Telegram `initData`, request bodies, usernames, and raw document content.
Successful CORS preflight, cover, and position-save noise is skipped so production logs stay readable.

## Target Budgets

- App visible: `< 1500ms` warm.
- Home API: `< 500ms`.
- Cached book file fetch: `< 500ms`.
- First text reader paint: `< 2000ms`.
- PDF first page: `< 2500ms`.
- Settings change: `< 100ms`.

If real-device testing feels slow, capture the overlay/console summary first and compare these timings before optimizing.
