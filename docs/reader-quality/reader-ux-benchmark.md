# Reader UX Benchmark and Quality Spec

Status: draft benchmark for Telegram Library reader stabilization.
Scope: reader UX quality only. Do not treat this as approval to add AI, social features, a catalog, or a wholesale embedded reader app.

## Current Problems

- Some EPUB/FB2 books render poorly.
- PDF quality has been weak or blurry in mobile WebView.
- Reader controls feel unclear.
- Font size controls are not discoverable enough.
- Progress is not visible enough.
- Covers were missing or unreliable, making the library feel unfinished.
- Some management features exist but feel hidden or dead because core actions are not obvious.

## Reference Sources

- Kindle reading app and reading customization references: Amazon Kindle app and Kindle accessibility/help materials.
- Apple Books user guide: reading books, changing appearance, bookmarks, notes, and highlights.
- Google Play Books help: reading ebooks, display options, bookmarks, highlights, notes, and PDFs.
- Kobo help: reading settings including font, margins, line spacing, themes, bookmarks, annotations, and table of contents.
- KOReader user guide/wiki: status bar/progress, typography controls, PDF reflow/zoom, bookmarks, highlights, TOC, search.
- Koodo Reader official docs/site: multi-format reader UX, themes, highlights, notes, TOC, search, sync/export.
- ReadEra official listing/site: lightweight mobile reader with formats, bookmarks, notes/highlights, reading settings.
- Foliate official project docs/site: lightweight desktop ebook reader with progress, themes, bookmarks/annotations, search.

Useful links:
- https://support.apple.com/guide/iphone/read-books-iph3d7ed6a47/ios
- https://support.google.com/googleplay/answer/185545
- https://help.kobo.com/
- https://koreader.rocks/
- https://github.com/koreader/koreader/wiki
- https://www.koodoreader.com/
- https://readera.org/
- https://johnfactotum.github.io/foliate/

## Core Reader Principles

1. Reading screen must be clean.
   The default state should be text or page content first. Chrome is useful, but it should not compete with reading.

2. Tap reveals controls.
   A reader can hide chrome while reading, but controls must appear with a simple tap. The user should not have to discover long-press gestures for core actions.

3. Progress is always visible.
   Even when top chrome is hidden, a subtle bottom progress indicator should remain visible: percent for text, page X/Y for PDF, and a thin progress bar.

4. Aa settings are obvious.
   Font size, theme, margins, and line spacing are baseline reader controls. The Aa entry point must be visible in the top bar.

5. Bookmark/note is obvious.
   Saving the current place or making a note is a core reader action. It should be a visible top action, not buried in a book card menu.

6. No hidden core actions behind long press only.
   Long press can be a shortcut, but Rename, Move, Delete, Bookmark, and Continue must also have visible controls.

7. Reading position must be reliable.
   Close/reopen and Continue must restore the real previous position, not a placeholder percent or fake locator.

8. Documents matter as much as novels.
   PDF zoom/fit, page clarity, page restore, and controls must be good enough for technical documents, scans, and manuals.

## Feature Matrix

Legend: Yes = expected first-class behavior; Basic = acceptable MVP-level behavior; Partial = exists but needs polish; Target = required target behavior for Telegram Library.

| Reader | Visible progress | Aa/text settings | Themes | Margins/line spacing | Bookmarks | Notes/highlights | TOC | Search in book | PDF zoom/fit | Library sort/edit/delete | Covers | Resume position |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kindle | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Yes | Yes | Yes |
| Apple Books | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Basic | Yes | Yes |
| Google Play Books | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Basic | Yes | Yes |
| Kobo | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Yes | Yes | Yes |
| KOReader | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Basic | Yes |
| Koodo | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Basic | Yes | Yes |
| Telegram Library target | Target | Target | Target | Target | Target | Basic now, improve later | Target | Later | Target | Target | Target | Target |

## Telegram Library Target UX

### Default Reading State

- Main content fills the screen.
- Top chrome may hide after reading starts.
- Bottom progress remains visible at all times.
- No marketing text, onboarding panels, or decorative cards inside the reading surface.

### Top Bar

Required controls:
- Back
- Short book title
- Aa
- Bookmark/Note

Behavior:
- Tap reading area toggles top bar.
- Top bar must not reflow content when shown/hidden.
- Title can truncate, but buttons must remain tappable.
- Bookmark/Note should save the current position with a short success toast.

### Bottom Bar

Required elements:
- Persistent thin progress bar.
- EPUB/FB2: percent and section X/Y.
- TXT: percent.
- PDF: page X/Y and progress.
- Prev/Next when useful for the format.

Behavior:
- Bottom progress is always visible, even when top chrome is hidden.
- It must respect iOS/Telegram safe area.
- Buttons must have mobile-size tap targets.

### Aa Sheet

Text formats:
- Font size: A- current size A+
- Line spacing
- Margins
- Theme: Dark, Light, Sepia

PDF:
- Zoom - current zoom +
- Fit width reset
- Page mode choice later if needed

Behavior:
- Sheet opens from visible Aa button.
- Changes apply live.
- Settings persist locally.
- Disabled states must be legible in every theme.

### Library/Card Management

- Book card/menu actions must be visible via a 44x44 "..." target.
- Long press can open the same menu, but cannot be the only path.
- Required visible actions: Read, Rename, Move to folder, Move up/down when manual sort is active, Remove from library.
- Covers should show when available; fallback generated covers must look intentional.

## Acceptance Criteria

A book/document is considered readable only if all relevant checks pass:

1. Visible content exists.
   EPUB/FB2/TXT must show readable text. PDF must show a rendered page with nonblank canvas pixels.

2. Controls are discoverable.
   Tap reveals controls. Aa and Bookmark/Note are visible in the top bar.

3. Progress is visible.
   A persistent bottom progress bar remains visible. Text shows percent; PDF shows page X/Y.

4. Font or zoom can be changed.
   Text formats support font size changes. PDF supports zoom in/out and fit-width reset.

5. Close/reopen restores position.
   Continue must restore the actual section/scroll ratio for text and actual page for PDF.

6. Theme contrast passes.
   Dark, Light, and Sepia controls and content must remain legible. Disabled controls cannot disappear.

7. PDF is high-DPI.
   On retina devices, canvas backing pixels must exceed CSS pixels, clamped to a safe DPR max.

8. Normal text has no horizontal overflow.
   Paragraphs, long words, URLs, tables, and images must not break the reading viewport. Tables may scroll horizontally inside their own container.

9. No blank-screen failure.
   Network, auth, 404, unsupported content, malformed section, and PDF render errors must show a friendly error with Retry and Back to Library.

10. CSP and sandbox stay strict.
    No `unsafe-inline`, no `unsafe-eval`, no CDN scripts, and no `allow-scripts` in book iframes.

## Local Quality Gates Before Reader Deploys

- Run unit/backend tests.
- Run production miniapp build.
- Run reader harness.
- Open seeded EPUB, FB2, TXT, and PDF locally.
- Verify no console CSP violations.
- Verify position restore after full close/reopen.
- Verify high-DPI PDF canvas dimensions.
- Verify at least 5 private problematic fixtures locally.
- Do not commit private books.
- Do not deploy reader changes without local pass.

Suggested future screenshot gates:
- Mobile portrait text reader, top hidden.
- Mobile portrait text reader, controls visible.
- Aa sheet text mode.
- PDF fit-width at 100%.
- PDF zoomed in.
- Error state.
- Empty/no-readable-section state.

## Non-Goals

- No AI.
- No social features.
- No content store, catalog, public library, or browsable index.
- No wholesale embedding of Koodo, Kavita, Calibre-Web, Komga, or another heavy reader/library app.
- No server-side permanent PDF page image pre-rendering.
- No weakening auth, CSP, or iframe sandbox rules for convenience.

## Implementation Recommendations

1. Keep Telegram bot/backend/library.
   The upload, auth, ownership, folder, cache, and Mini App shell are the product foundation. Replace only weak reader internals as needed.

2. Evaluate `foliate-view` as the text reader engine.
   It is the most plausible path to reduce custom iframe code while keeping EPUB/FB2 support. The spike must prove CSP safety, position restore, font/theme settings, and private fixture quality before production switch.

3. Keep PDF.js, but continue improving the shell.
   PDF.js is appropriate. Prioritize high-DPI rendering, fit-width, zoom, page restore, render queue stability, and possibly a full viewer-like shell if the custom canvas remains too limited.

4. Add local e2e/screenshot gates.
   Reader changes should fail locally if EPUB/FB2/TXT/PDF visibility, progress, position restore, or PDF DPR regress.

5. Treat covers as part of perceived reader quality.
   Library trust starts before opening the book. Cover extraction/fallbacks should remain reliable and disk-bounded.

6. Avoid deploy-by-hope.
   Reader changes must not go to VDS until local tests and harness pass. Phone testing should verify the deployed `/api/version` commit first.
