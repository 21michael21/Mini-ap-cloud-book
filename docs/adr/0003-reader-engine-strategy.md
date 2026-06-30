# ADR 0003: Reader Engine Strategy

Date: 2026-06-30

Status: Proposed

## Context

Telegram Library's core promise is simple: a user sends a book/document to the bot, opens it in the Telegram Mini App, reads comfortably, closes the Mini App, reopens it, and continues at the same position.

The current implementation keeps the bot/backend/library model, but the reader layer has accumulated too much custom code:

- EPUB/FB2/TXT rendering is unstable across real-world files.
- PDF quality is inconsistent, especially on mobile screens.
- Covers do not display reliably.
- Reader logic now includes custom section loading, sanitization, iframe rendering, font/theme plumbing, position persistence, PDF canvas rendering, and harness logic.

This ADR evaluates whether to continue hardening the custom reader or move closer to established reader engines.

## Decision Drivers

- Must work inside Telegram Mini App WebView on iOS/Android.
- Must remain CSP-safe: no `unsafe-inline`, no `unsafe-eval`, no CDN runtime dependency.
- Must support EPUB, FB2, and TXT now.
- Must improve PDF quality without exposing raw Telegram URLs or bot tokens.
- Must stay small enough for the current VDS target with about 10 GB disk.
- Must be maintainable by a small team.
- Must have acceptable license risk.
- Must have a migration path that can be tested with private fixtures before production rollout.

## Candidates

### 1. foliate-js `<foliate-view>` high-level renderer

`foliate-js` is already in the project. Its own README describes it as a browser e-book rendering library supporting EPUB, MOBI/KF8, FB2, CBZ, and experimental PDF via PDF.js; it is pure JavaScript, small/modular, has no hard dependencies, and is MIT licensed. Source: [foliate-js GitHub](https://github.com/johnfactotum/foliate-js).

Pros:

- Best match for current supported text formats, especially EPUB and FB2.
- Already installed and already patched for iframe sandbox safety.
- Likely reduces our custom text section/iframe/render code if `<foliate-view>` can replace the lower-level path.
- Client-side and VDS-friendly.
- MIT license is low-risk for this app.

Cons:

- Need a spike to prove `<foliate-view>` works from authenticated Blob bytes, not just file input.
- Need to verify CSP and sandbox behavior after using the higher-level component.
- Need to confirm position restore APIs and how they map to our existing `reading_pos.locator` string.
- PDF support is marked experimental, so PDF should remain separate for now.

### 2. Readium Web / Readium TypeScript toolkit

Readium's TypeScript toolkit is a broader toolkit for ebooks, audiobooks, comics, and web readers; its repository is BSD-3-Clause licensed. Readium Web/Thorium Web are positioned as a toolkit/web reader stack, with Readium CLI able to stream publications over HTTP/HTTPS or storage backends. Sources: [readium/ts-toolkit](https://github.com/readium/ts-toolkit), [Readium Web](https://readium.org/web/).

Pros:

- Architecturally mature, standards-oriented reading stack.
- More complete long-term direction if the project becomes a serious multi-format reader.
- BSD-3-Clause license is acceptable.

Cons:

- Larger migration than foliate-js.
- Likely wants a more formal publication server/streaming model, which increases backend complexity.
- EPUB/Web publication focus does not directly solve FB2/TXT in the MVP.
- Higher risk for Telegram WebView/CSP integration until proven.
- Too much for the immediate VDS/private-library MVP unless foliate-js fails.

### 3. epub.js

`epub.js` is a browser EPUB renderer with common ebook functions like rendering, persistence, and pagination, and has a permissive BSD-style license. Source: [futurepress/epub.js](https://github.com/futurepress/epub.js/).

Pros:

- Established browser EPUB renderer.
- Smaller than adopting a whole server/library app.
- Good fallback if foliate-js high-level rendering is not viable for EPUB.

Cons:

- EPUB-only for our practical needs; does not solve FB2/TXT without conversion.
- Would add another renderer beside foliate-js even though foliate-js already supports FB2.
- Would not address PDF quality.
- Migration effort may be similar to foliate-js `<foliate-view>` but with less format coverage.

### 4. PDF.js full web viewer vs current custom PDF canvas

PDF.js is the standard open-source JavaScript PDF renderer/viewer from Mozilla, Apache-2.0 licensed. Its repo includes the full web viewer demo, and the PDF.js site describes it as a general-purpose web standards platform for parsing/rendering PDFs. Sources: [PDF.js GitHub](https://github.com/mozilla/pdf.js/), [PDF.js site](https://mozilla.github.io/pdf.js/).

Pros:

- Keep current dependency and same-origin worker model.
- Full viewer shell could improve navigation, zoom, page rendering, search/sidebar/outline later.
- Current custom canvas can be improved incrementally with DPR, render queue, and better layout.

Cons:

- Full viewer shell is heavier and may need careful CSP review.
- Full viewer UI may not fit Telegram Mini App chrome and touch constraints without customization.
- Current custom canvas is smaller but easy to underbuild.

Recommendation for PDF: keep PDF.js, but evaluate two tracks in spike:

1. Continue custom PDF.js canvas with high-DPI rendering, render queue, fit-width/zoom, and page controls.
2. Prototype same-origin PDF.js full viewer shell in an iframe/static route and verify CSP, mobile layout, and authenticated Blob loading.

### 5. Koodo Reader as UX/reference only

Koodo Reader is a cross-platform ebook manager/reader supporting EPUB, PDF, TXT, FB2, and many other formats; it is AGPL-3.0 licensed. Sources: [Koodo GitHub](https://github.com/koodo-reader/koodo-reader), [Koodo website](https://www.koodoreader.com/en).

Pros:

- Strong UX reference for reader controls, library organization, format breadth, notes/highlights, sync patterns.
- Useful for studying mobile/desktop reader ergonomics.

Cons:

- AGPL-3.0 creates license risk for embedding/copying code.
- Much broader product than Telegram Library.
- Includes many product areas we explicitly do not want now.

Decision: do not embed or copy Koodo code. Use only as UX inspiration.

### 6. Kavita / Calibre-Web / Komga as server/library references only

Kavita is a full self-hosted reading server under GPL-3.0; Komga is a media server for comics/manga/magazines/eBooks with a webreader and MIT license; Calibre-Web is a web app for browsing/reading/downloading an existing Calibre library and is GPL-3. Sources: [Kavita GitHub](https://github.com/Kareadita/Kavita), [Komga GitHub](https://github.com/gotson/komga), [Komga site](https://komga.org/), [LinuxServer Calibre-Web docs](https://docs.linuxserver.io/images/docker-calibre-web/).

Pros:

- Good references for metadata, covers, webreader UX, library organization, and server-side collection management.
- Komga is especially useful as a reference for webreader modes and metadata/cover workflows.
- Kavita and Calibre-Web are useful references for self-hosted library expectations.

Cons:

- They are full server applications, not drop-in reader engines.
- Embedding them wholesale would duplicate/replace our Telegram bot/backend/auth/library model.
- GPL/AGPL projects carry stronger license obligations if code is copied.
- Heavy for a 10 GB VDS and not aligned with the Mini App architecture.

Decision: do not embed Kavita, Calibre-Web, or Komga. Use them only as UX and architecture references.

## Comparison Table

| Candidate | Telegram WebView fit | CSP safety | EPUB/FB2/TXT | PDF quality | VDS size fit | Maintainability | License risk | Migration effort | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| foliate-js `<foliate-view>` | Likely good, must spike | Likely good if sandbox remains no-scripts | Strong: EPUB/FB2; TXT via adapter | Not primary path | Good | Best near-term | Low, MIT | Medium | Preferred text-reader path |
| Readium Web / ts-toolkit | Unknown until spike | Needs careful review | Strong EPUB; weaker direct FB2/TXT | Not primary path | Medium/large | High once adopted, high setup | Low, BSD-3 | High | Future option, not MVP |
| epub.js | Likely good | Needs review | EPUB only | None | Good | Medium | Low, BSD-style | Medium | Fallback for EPUB only |
| PDF.js custom canvas | Proven in app | Proven with same-origin worker | N/A | Medium if polished | Good | Medium | Low, Apache-2.0 | Low | Keep and harden |
| PDF.js full web viewer | Unknown in Telegram UI | Needs review | N/A | High if it fits | Medium | Better PDF feature surface | Low, Apache-2.0 | Medium | Spike as PDF option |
| Koodo Reader | Not as embedded app | Unknown | Broad | Broad | Too broad | Not maintainable to fork | High, AGPL-3 | Very high | UX reference only |
| Kavita | Server app, not Mini App engine | Not applicable | Broad server reader | Built-in reader | Heavy | Duplicates backend | GPL-3 | Very high | Reference only |
| Calibre-Web | Server app, not Mini App engine | Not applicable | Library/reader app | Reader app | Heavy-ish | Duplicates backend | GPL-3 | Very high | Reference only |
| Komga | Server app, not Mini App engine | Not applicable | EPUB/PDF/comics focus | Built-in webreader | Heavy | Duplicates backend | Low, MIT | Very high | Reference only |

## Decision

Keep Telegram Library's existing Telegram bot, backend, authenticated file endpoint, ownership model, and library UI.

Replace the text-reader internals with `foliate-js` `<foliate-view>` if a spike proves it works under our constraints:

- File bytes must still come from the existing authenticated endpoint as Blob/ArrayBuffer.
- CSP must stay strict.
- Foliate content iframes must remain sandboxed without `allow-scripts`.
- Position restore must be real and stable.
- Font/theme settings must remain user-controllable.
- EPUB and FB2 must be first-class; TXT can remain an adapter if needed.

Keep PDF on PDF.js:

- Continue improving the custom PDF.js canvas path if it remains small and reliable.
- Spike a same-origin PDF.js full viewer shell for better PDF controls and rendering, but only adopt it if it fits Telegram WebView, CSP, Blob loading, and bundle size constraints.

Do not embed Koodo, Kavita, Calibre-Web, or Komga wholesale.

Use Koodo/Kavita/Calibre-Web/Komga only as UX and architecture references.

Add a cover extraction pipeline:

- Extract best-effort cover metadata at upload/index time.
- Store a safe internal `cover_ref`, not remote URLs.
- Serve covers via authenticated or same-origin controlled endpoints/assets.
- Add fallback generated covers only when extraction fails.

## Reader Engine Spike Checklist

- [ ] Use 5 local private fixtures from `dev/private_reader_fixtures/`.
- [ ] Do not commit private/copyrighted books.
- [ ] Include at least EPUB, FB2, TXT, PDF, and one messy real-world EPUB/FB2.
- [ ] Load bytes through the existing authenticated file endpoint.
- [ ] Verify CSP: no console CSP violations.
- [ ] Verify foliate iframe sandbox remains without `allow-scripts`.
- [ ] Verify EPUB position save/restore across full Mini App close/reopen.
- [ ] Verify FB2 position save/restore across full Mini App close/reopen.
- [ ] Verify TXT position save/restore or adapter behavior.
- [ ] Verify font size/theme settings.
- [ ] Verify PDF quality on a real phone.
- [ ] Verify PDF page restore.
- [ ] Verify cover extraction for at least EPUB and FB2, plus fallback cover.
- [ ] Confirm bundle size and VDS disk impact.
- [ ] Document any CSP directive change proposal before implementation.

## Consequences

Positive:

- Reduces custom reader code and moves text rendering closer to a purpose-built engine.
- Keeps the Telegram-native upload/library/auth architecture.
- Keeps server footprint small.
- Avoids GPL/AGPL embedding risk from full reader/server apps.

Negative:

- Requires a careful spike before implementation.
- `<foliate-view>` may not expose exactly the position/font/theme hooks we need, requiring adapter code.
- PDF still needs its own path.
- Cover extraction becomes a separate pipeline, not solved by reader UI alone.

## Sources

- foliate-js: https://github.com/johnfactotum/foliate-js
- Readium TypeScript toolkit: https://github.com/readium/ts-toolkit
- Readium Web: https://readium.org/web/
- epub.js: https://github.com/futurepress/epub.js/
- PDF.js: https://github.com/mozilla/pdf.js/ and https://mozilla.github.io/pdf.js/
- Koodo Reader: https://github.com/koodo-reader/koodo-reader and https://www.koodoreader.com/en
- Kavita: https://github.com/Kareadita/Kavita
- Komga: https://github.com/gotson/komga and https://komga.org/
- Calibre-Web Docker docs: https://docs.linuxserver.io/images/docker-calibre-web/
