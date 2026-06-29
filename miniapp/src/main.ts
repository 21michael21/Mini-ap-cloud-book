import { apiHeaders, fetchBookFile, openFoliateReader, openPdfReader } from "./readerCore";
import "./styles.css";

type Book = {
  id: number;
  file_name: string;
  title: string;
  author: string | null;
  format: string;
  cover_ref: string | null;
  size_bytes: number;
  too_large: boolean;
  folder_id: number | null;
  progress_percent: number;
};

type Folder = {
  id: number;
  name: string;
  sort_order: number;
};

type Home = {
  continue_book: Book | null;
  recent: Book[];
  folders: Folder[];
};

type View = "home" | "library" | "reader";
type LibraryScope = "inbox" | "all" | number;
type SheetState = { kind: "move"; book: Book; targetFolderId: number | null } | null;

const API_BASE = import.meta.env.VITE_API_BASE ?? window.location.origin;
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const tg = window.Telegram?.WebApp;

let view: View = "home";
let homeState: Home | null = null;
let allBooksState: Book[] = [];
let booksState: Book[] = [];
let foldersState: Folder[] = [];
let selectedFolderId: LibraryScope = "all";
let searchQuery = "";
let activeBook: Book | null = null;
let activeSheet: SheetState = null;
let isHomeLoading = false;
let isLibraryLoading = false;
let errorMessage: string | null = null;
let readerTheme: "light" | "dark" = "dark";

function init() {
  tg?.ready?.();
  tg?.expand?.();
  document.body.classList.add("dark");
  void loadHome();
}

function headers(): HeadersInit {
  return apiHeaders(initData());
}

function initData(): string {
  return tg?.initData || import.meta.env.VITE_DEV_INIT_DATA || "";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers(),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function loadHome() {
  view = "home";
  isHomeLoading = true;
  errorMessage = null;
  render();
  try {
    const [home, allBooks] = await Promise.all([api<Home>("/api/home"), api<Book[]>("/api/books")]);
    homeState = home;
    foldersState = home.folders;
    allBooksState = allBooks;
  } catch (error) {
    errorMessage = readableError(error);
  } finally {
    isHomeLoading = false;
    render();
  }
}

async function loadBooks(scope: LibraryScope = selectedFolderId) {
  selectedFolderId = scope;
  view = "library";
  isLibraryLoading = true;
  errorMessage = null;
  render();
  try {
    const [allBooks, folders] = await Promise.all([api<Book[]>("/api/books"), api<Folder[]>("/api/folders")]);
    allBooksState = allBooks;
    foldersState = folders;
    booksState = filterBooks(allBooksState);
  } catch (error) {
    errorMessage = readableError(error);
  } finally {
    isLibraryLoading = false;
    render();
  }
}

async function createFolder() {
  const name = window.prompt("Folder name");
  if (!name?.trim()) return;
  await api<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });
  if (view === "library") {
    await loadBooks(selectedFolderId);
  } else {
    await loadHome();
  }
}

async function moveBookToFolder(book: Book, folderId: number | null) {
  await api<Book>(`/api/books/${book.id}/move`, {
    method: "PATCH",
    body: JSON.stringify({ folder_id: folderId }),
  });
  activeSheet = null;
  await loadBooks(selectedFolderId);
}

function filterBooks(books: Book[]): Book[] {
  const scoped = books.filter((book) => {
    if (selectedFolderId === "all") return true;
    if (selectedFolderId === "inbox") return book.folder_id === null;
    return book.folder_id === selectedFolderId;
  });
  const query = searchQuery.trim().toLowerCase();
  if (!query) return scoped;
  return scoped.filter((book) => {
    return `${book.title} ${book.author ?? ""}`.toLowerCase().includes(query);
  });
}

function render() {
  if (view === "reader" && activeBook) {
    renderReader(activeBook);
    return;
  }

  appEl.className = "app";
  appEl.innerHTML = `
    <main class="screen">
      ${renderTopbar(view === "home" ? "Home" : "Library")}
      ${errorMessage ? renderError(errorMessage) : view === "home" ? renderHome() : renderLibrary()}
    </main>
    ${renderNav()}
    ${activeSheet ? renderSheet(activeSheet) : ""}
  `;

  bindShellControls();
  bindBookButtons();
  bindLibraryControls();
  bindSheetControls();
}

function renderTopbar(title: string): string {
  return `
    <header class="topbar">
      <div class="screen-title">${escapeHtml(title)}</div>
      <button class="theme-toggle" id="themeButton" type="button" aria-label="Toggle reader theme">
        <span>${icon("sun")}</span>
        <span class="theme-toggle__active">${icon("moon")}</span>
      </button>
    </header>
  `;
}

function renderHome(): string {
  if (isHomeLoading) return renderHomeSkeleton();
  const state = homeState;
  if (!state) return renderEmptyHome();
  const hasBooks = Boolean(state.continue_book || state.recent.length);
  if (!hasBooks) return renderEmptyHome();

  return `
    <section class="home-section">
      <div class="eyebrow">Continue</div>
      ${
        state.continue_book
          ? renderContinueHero(state.continue_book)
          : `<div class="empty-mini">No active book yet.</div>`
      }
    </section>
    <section class="home-section">
      <div class="section-row">
        <h2>Recent</h2>
        <button class="text-button" data-nav-library="all" type="button">See all</button>
      </div>
      <div class="recent-rail">
        ${state.recent.map(renderRecentCard).join("") || `<div class="empty-mini">No books yet</div>`}
      </div>
    </section>
    <section class="home-section">
      <h2 class="section-heading">Folders</h2>
      ${renderFolderChips(false)}
    </section>
  `;
}

function renderHomeSkeleton(): string {
  return `
    <div class="home-skeleton">
      <div class="skel skel-hero"></div>
      <div class="skel skel-label"></div>
      <div class="skeleton-row">
        <div><div class="skel skel-cover"></div><div class="skel skel-line"></div></div>
        <div><div class="skel skel-cover"></div><div class="skel skel-line short"></div></div>
        <div><div class="skel skel-cover"></div></div>
      </div>
      <div class="skel skel-label small"></div>
      <div class="chip-row">
        <div class="skel skel-chip"></div>
        <div class="skel skel-chip wide"></div>
        <div class="skel skel-chip narrow"></div>
      </div>
    </div>
  `;
}

function renderEmptyHome(): string {
  return `
    <div class="empty-state empty-state--home">
      <div class="empty-orbit">
        <div class="empty-orbit__pulse"></div>
        <div class="empty-icon">${icon("bookOpen")}</div>
      </div>
      <h2>Your library is empty</h2>
      <p>Send an EPUB, FB2, TXT, or PDF to the bot. It will appear here automatically.</p>
      <div class="empty-arrow">${icon("arrowDown")}</div>
      <span>Use the Telegram attachment button below</span>
    </div>
  `;
}

function renderContinueHero(book: Book): string {
  return `
    <button class="continue-hero glow" type="button" data-open="${book.id}">
      ${renderCover(book, "hero-cover")}
      <span class="continue-copy">
        <span class="format-badge">${escapeHtml(book.format.toUpperCase())}</span>
        <strong>${escapeHtml(book.title)}</strong>
        <em>${escapeHtml(book.author ?? "Unknown author")}</em>
        ${renderProgress(book, "Chapter progress")}
      </span>
    </button>
  `;
}

function renderRecentCard(book: Book): string {
  return `
    <button class="recent-card" type="button" data-open="${book.id}">
      ${renderCover(book, "recent-cover")}
      <span class="recent-title">${escapeHtml(book.title)}</span>
      <span class="recent-meta">${escapeHtml(shortAuthor(book))} · ${progressLabel(book)}</span>
    </button>
  `;
}

function renderLibrary(): string {
  const filteredBooks = filterBooks(allBooksState.length ? allBooksState : booksState);
  booksState = filteredBooks;
  if (isLibraryLoading) return renderLibrarySkeleton();
  const noBooksAtAll = allBooksState.length === 0;
  const hasQuery = searchQuery.trim().length > 0;

  return `
    ${renderLibraryTabs()}
    ${renderSearchBox(hasQuery)}
    ${
      noBooksAtAll
        ? renderLibraryEmpty()
        : hasQuery && filteredBooks.length === 0
          ? renderNoResults()
          : `<div class="book-list">${filteredBooks.map((book, index) => renderBookRow(book, index)).join("")}</div>`
    }
  `;
}

function renderLibrarySkeleton(): string {
  return `
    ${renderLibraryTabs()}
    <div class="search-shell"><div class="skel search-skel"></div></div>
    <div class="book-list">
      ${Array.from({ length: 4 })
        .map(
          () => `
            <div class="book-row">
              <div class="skel row-cover-skel"></div>
              <div class="row-body">
                <div class="skel skel-line tiny"></div>
                <div class="skel skel-line"></div>
                <div class="skel skel-line short"></div>
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderLibraryTabs(): string {
  const inboxCount = allBooksState.filter((book) => book.folder_id === null).length;
  const folderCount = foldersState.length;
  return `
    <div class="segmented" role="tablist">
      ${renderTab("Inbox", inboxCount, "inbox", selectedFolderId === "inbox")}
      ${renderTab("All", allBooksState.length, "all", selectedFolderId === "all")}
      ${renderTab("Folders", folderCount, "folders", typeof selectedFolderId === "number")}
    </div>
    ${
      typeof selectedFolderId === "number" || selectedFolderId === "all"
        ? `<div class="folder-strip">${renderFolderChips(true)}</div>`
        : ""
    }
  `;
}

function renderTab(label: string, count: number, scope: "inbox" | "all" | "folders", active: boolean): string {
  return `
    <button class="segment ${active ? "active" : ""}" type="button" data-scope="${scope}">
      ${label} <span>${count}</span>
    </button>
  `;
}

function renderSearchBox(focused: boolean): string {
  return `
    <label class="search-shell ${focused ? "is-focused" : ""}">
      ${icon("search")}
      <input id="searchInput" value="${escapeHtml(searchQuery)}" placeholder="Search title or author" autocomplete="off" />
      ${focused ? `<button class="clear-search" type="button" id="clearSearch">${icon("x")}</button>` : ""}
    </label>
    ${focused ? `<div class="result-count">${booksState.length} ${booksState.length === 1 ? "result" : "results"}</div>` : ""}
  `;
}

function renderLibraryEmpty(): string {
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon("library")}</div>
      <h2>Nothing here yet</h2>
      <p>Books you send to the bot will fill your library automatically.</p>
    </div>
  `;
}

function renderNoResults(): string {
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon("search")}</div>
      <h2>No matches for "${escapeHtml(searchQuery)}"</h2>
      <p>Try another title or author. Search looks at metadata, not file names.</p>
      <button class="ghost-button" type="button" id="clearSearchEmpty">Clear search</button>
    </div>
  `;
}

function renderFolderChips(interactive: boolean): string {
  const chipTabIndex = interactive ? "" : `tabindex="0"`;
  const chips = [
    `<button class="folder-chip ${selectedFolderId === "inbox" ? "active" : ""}" type="button" data-folder="inbox" ${chipTabIndex}>
      <span class="folder-dot dot-accent"></span><b>Inbox</b><small>${allBooksState.filter((book) => book.folder_id === null).length}</small>
    </button>`,
    ...foldersState.map((folder, index) => {
      const count = allBooksState.filter((book) => book.folder_id === folder.id).length;
      return `
        <button class="folder-chip ${selectedFolderId === folder.id ? "active" : ""}" type="button" data-folder="${folder.id}" ${chipTabIndex}>
          <span class="folder-dot ${folderDotClass(index)}"></span><b>${escapeHtml(folder.name)}</b><small>${count}</small>
        </button>
      `;
    }),
  ];
  return `<div class="chip-row">${chips.join("")}</div>`;
}

function renderBookRow(book: Book, index: number): string {
  return `
    <article class="book-row card-in ${delayClass(index)}" data-book-id="${book.id}">
      ${renderCover(book, "row-cover")}
      <div class="row-body">
        <div class="row-badges">
          <span class="format-badge">${escapeHtml(book.format.toUpperCase())}</span>
          ${book.progress_percent <= 0 ? `<span class="new-badge">NEW</span>` : ""}
          ${book.too_large ? `<span class="new-badge">TOO LARGE</span>` : ""}
        </div>
        <h2>${highlightMatch(book.title)}</h2>
        <p>${escapeHtml(book.author ?? "Unknown author")}</p>
        ${renderProgress(book, "Reading progress")}
      </div>
    </article>
  `;
}

function renderCover(book: Book, className: string): string {
  return `
    <span class="book-cover ${className} tone-${book.id % 5}">
      <span class="cover-stripes"></span>
      <span class="cover-spine"></span>
      <span class="cover-title">${escapeHtml(book.title)}</span>
    </span>
  `;
}

function renderProgress(book: Book, label: string): string {
  const percent = clamp(Math.round(book.progress_percent), 0, 100);
  return `
    <span class="progress-wrap" aria-label="${escapeHtml(label)}">
      <span class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <span class="progress-meter ${progressClass(percent)}"></span>
      </span>
      <span class="progress-meta"><span>${book.too_large ? "Download original" : progressDetail(book)}</span><b>${progressLabel(book)}</b></span>
    </span>
  `;
}

function renderNav(): string {
  return `
    <nav class="nav">
      <button id="homeNav" class="${view === "home" ? "active" : ""}" type="button">${icon("home")}<span>Home</span></button>
      <button id="libraryNav" class="${view === "library" ? "active" : ""}" type="button">${icon("library")}<span>Library</span></button>
      <button id="folderNav" type="button">${icon("folderPlus")}<span>New folder</span></button>
    </nav>
  `;
}

function renderSheet(sheet: SheetState): string {
  if (!sheet) return "";
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Move book">
        <div class="sheet-handle"></div>
        <div class="sheet-book">
          ${renderCover(sheet.book, "sheet-cover")}
          <div>
            <h2>${escapeHtml(sheet.book.title)}</h2>
            <p>${escapeHtml(sheet.book.author ?? "Unknown author")} · ${escapeHtml(sheet.book.format.toUpperCase())} · ${progressLabel(sheet.book)}</p>
          </div>
        </div>
        <h3>Move to folder</h3>
        <p class="sheet-note">Choose a destination for "${escapeHtml(sheet.book.title)}".</p>
        <div class="chip-row sheet-chips">
          <button class="folder-chip ${sheet.targetFolderId === null ? "active" : ""}" type="button" data-sheet-folder="inbox">
            <span class="folder-dot dot-accent"></span><b>Inbox</b><small>${allBooksState.filter((book) => book.folder_id === null).length}</small>
          </button>
          ${foldersState
            .map((folder, index) => {
              return `
                <button class="folder-chip ${sheet.targetFolderId === folder.id ? "active" : ""}" type="button" data-sheet-folder="${folder.id}">
                  <span class="folder-dot ${folderDotClass(index)}"></span><b>${escapeHtml(folder.name)}</b><small>${allBooksState.filter((book) => book.folder_id === folder.id).length}</small>
                </button>
              `;
            })
            .join("")}
          <button class="folder-chip dashed" type="button" id="sheetNewFolder">${icon("plus")}<b>New folder</b></button>
        </div>
        <button class="primary-action" type="button" id="confirmMove">Move here</button>
      </section>
    </div>
  `;
}

function renderError(message: string): string {
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon("alert")}</div>
      <h2>Could not load library</h2>
      <p>${escapeHtml(message)}</p>
      <button class="ghost-button" type="button" id="retryLoad">Retry</button>
    </div>
  `;
}

function bindShellControls() {
  document.querySelector("#themeButton")?.addEventListener("click", toggleTheme);
  document.querySelector("#homeNav")?.addEventListener("click", () => void loadHome());
  document.querySelector("#libraryNav")?.addEventListener("click", () => {
    selectedFolderId = "all";
    searchQuery = "";
    void loadBooks("all");
  });
  document.querySelector("#folderNav")?.addEventListener("click", () => void createFolder());
  document.querySelector("#retryLoad")?.addEventListener("click", () => {
    if (view === "home") void loadHome();
    else void loadBooks(selectedFolderId);
  });
  document.querySelectorAll<HTMLElement>("[data-nav-library]").forEach((button) => {
    button.addEventListener("click", () => void loadBooks("all"));
  });
}

function bindBookButtons() {
  document.querySelectorAll<HTMLElement>("[data-open]").forEach((button) => {
    button.addEventListener("click", () => openBookById(Number(button.dataset.open), button.textContent ?? ""));
  });

  document.querySelectorAll<HTMLElement>(".book-row[data-book-id]").forEach((row) => {
    let pressTimer = 0;
    let longPressed = false;
    const id = Number(row.dataset.bookId);

    row.addEventListener("pointerdown", () => {
      longPressed = false;
      pressTimer = window.setTimeout(() => {
        const book = findBook(id);
        if (!book) return;
        longPressed = true;
        activeSheet = { kind: "move", book, targetFolderId: book.folder_id };
        render();
      }, 520);
    });
    row.addEventListener("pointerup", () => {
      window.clearTimeout(pressTimer);
    });
    row.addEventListener("pointerleave", () => {
      window.clearTimeout(pressTimer);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const book = findBook(id);
      if (!book) return;
      activeSheet = { kind: "move", book, targetFolderId: book.folder_id };
      render();
    });
    row.addEventListener("click", () => {
      if (longPressed) return;
      openBookById(id, "Read");
    });
  });
}

function bindLibraryControls() {
  document.querySelectorAll<HTMLElement>("[data-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      const scope = button.dataset.scope;
      if (scope === "folders") {
        selectedFolderId = foldersState[0]?.id ?? "all";
      } else {
        selectedFolderId = scope === "inbox" ? "inbox" : "all";
      }
      booksState = filterBooks(allBooksState);
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.folder!;
      selectedFolderId = raw === "inbox" ? "inbox" : Number(raw);
      searchQuery = "";
      view = "library";
      if (allBooksState.length) {
        booksState = filterBooks(allBooksState);
        render();
      } else {
        void loadBooks(selectedFolderId);
      }
    });
  });
  document.querySelector("#searchInput")?.addEventListener("input", (event) => {
    searchQuery = (event.target as HTMLInputElement).value;
    booksState = filterBooks(allBooksState);
    render();
    const input = document.querySelector<HTMLInputElement>("#searchInput");
    input?.focus();
    input?.setSelectionRange(searchQuery.length, searchQuery.length);
  });
  document.querySelector("#clearSearch")?.addEventListener("click", clearSearch);
  document.querySelector("#clearSearchEmpty")?.addEventListener("click", clearSearch);
}

function bindSheetControls() {
  if (!activeSheet) return;
  document.querySelector("#sheetScrim")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      activeSheet = null;
      render();
    }
  });
  document.querySelectorAll<HTMLElement>("[data-sheet-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeSheet) return;
      const raw = button.dataset.sheetFolder!;
      activeSheet = { ...activeSheet, targetFolderId: raw === "inbox" ? null : Number(raw) };
      render();
    });
  });
  document.querySelector("#sheetNewFolder")?.addEventListener("click", () => void createFolder());
  document.querySelector("#confirmMove")?.addEventListener("click", () => {
    if (!activeSheet) return;
    void moveBookToFolder(activeSheet.book, activeSheet.targetFolderId);
  });
}

function clearSearch() {
  searchQuery = "";
  booksState = filterBooks(allBooksState);
  render();
}

function openBookById(id: number, sourceText: string) {
  const book = findBook(id);
  if (!book) return;
  activeBook = book;
  if (sourceText.includes("Continue")) {
    void api<void>("/api/events", {
      method: "POST",
      body: JSON.stringify({ type: "continue_clicked", book_id: book.id }),
    });
  }
  view = "reader";
  render();
}

function findBook(id: number): Book | undefined {
  return [...allBooksState, ...(homeState?.recent ?? []), ...(homeState?.continue_book ? [homeState.continue_book] : [])].find(
    (book) => book.id === id,
  );
}

function renderReader(book: Book) {
  appEl.className = "reader";
  appEl.innerHTML = `
    <div class="reader-toolbar">
      <button class="secondary" id="backButton" type="button">${icon("arrowLeft")}<span>Back</span></button>
      <button class="secondary" id="themeButton" type="button">Theme</button>
    </div>
    <div class="reader-stage" id="readerStage"></div>
  `;
  document.querySelector("#backButton")?.addEventListener("click", () => void loadHome());
  document.querySelector("#themeButton")?.addEventListener("click", toggleTheme);

  if (book.too_large) {
    document.querySelector("#readerStage")!.innerHTML =
      `<div class="empty-state empty-state--library"><div class="empty-icon">${icon("download")}</div><h2>Download original</h2><p>This file is over 20 MB. Use the original Telegram message to download it.</p></div>`;
    void api<void>("/api/events", {
      method: "POST",
      body: JSON.stringify({ type: "too_large_file_opened", book_id: book.id }),
    });
    return;
  }

  if (book.format === "pdf") {
    void renderPdf(book);
  } else {
    void renderTextBook(book);
  }
}

async function renderTextBook(book: Book) {
  const stage = document.querySelector<HTMLElement>("#readerStage")!;
  const pos = await api<{ locator: string } | null>(`/api/books/${book.id}/position`);
  const file = await fetchBookFile(API_BASE, initData(), book);
  await openFoliateReader(stage, file, pos?.locator ?? null, (position) => {
    void savePosition(book.id, position.locator, position.percent);
  });
}

async function renderPdf(book: Book) {
  const stage = document.querySelector<HTMLElement>("#readerStage")!;
  const pos = await api<{ locator: string } | null>(`/api/books/${book.id}/position`);
  const file = await fetchBookFile(API_BASE, initData(), book);
  const pdfReader = await openPdfReader(stage, file, pos?.locator ?? null, (position) => {
    void savePosition(book.id, position.locator, position.percent);
  });

  stage.addEventListener("click", (event) => {
    const nextPage = pdfReader.getPageNumber() + ((event as MouseEvent).clientX > window.innerWidth / 2 ? 1 : -1);
    void pdfReader.renderPage(nextPage);
  });
}

async function savePosition(bookId: number, locator: string, percent: number) {
  await api(`/api/books/${bookId}/position`, {
    method: "PUT",
    body: JSON.stringify({ locator, percent }),
  });
}

function toggleTheme() {
  readerTheme = readerTheme === "dark" ? "light" : "dark";
  document.body.classList.toggle("reader-light", readerTheme === "light");
}

function highlightMatch(value: string): string {
  const query = searchQuery.trim();
  if (!query) return escapeHtml(value);
  const lower = value.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) return escapeHtml(value);
  return `${escapeHtml(value.slice(0, index))}<mark>${escapeHtml(value.slice(index, index + query.length))}</mark>${escapeHtml(
    value.slice(index + query.length),
  )}`;
}

function progressLabel(book: Book): string {
  if (book.too_large) return "Original";
  const percent = clamp(Math.round(book.progress_percent), 0, 100);
  return percent > 0 ? `${percent}%` : "New";
}

function progressDetail(book: Book): string {
  if (book.progress_percent <= 0) return "Not started";
  return "Reading progress";
}

function folderDotClass(index: number): string {
  return ["dot-warm", "dot-pass", "dot-info", "dot-lilac"][index % 4];
}

function delayClass(index: number): string {
  return `delay-${clamp(index, 0, 6)}`;
}

function progressClass(percent: number): string {
  return `progress-${Math.round(clamp(percent, 0, 100) / 5) * 5}`;
}

function shortAuthor(book: Book): string {
  if (!book.author) return "Unknown";
  const parts = book.author.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return book.author;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function icon(name: string): string {
  const attrs = `width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const filled = `width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"`;
  const icons: Record<string, string> = {
    home: `<svg ${attrs}><path d="M3 10.5 12 4l9 6.5"></path><path d="M5 9.5V20h14V9.5"></path></svg>`,
    library: `<svg ${attrs}><path d="M5 4h5v16H5z"></path><path d="M13 4h3l3 16h-3z"></path></svg>`,
    folderPlus: `<svg ${attrs}><path d="M4 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M12 11v4M10 13h4"></path></svg>`,
    search: `<svg ${attrs}><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`,
    x: `<svg ${attrs} width="11" height="11"><path d="M5 5l14 14M19 5 5 19"></path></svg>`,
    sun: `<svg ${attrs} width="13" height="13"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"></path></svg>`,
    moon: `<svg ${filled}><path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"></path></svg>`,
    bookOpen: `<svg ${attrs} width="34" height="34"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z"></path><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z"></path></svg>`,
    arrowDown: `<svg ${attrs}><path d="M12 5v14"></path><path d="m6 13 6 6 6-6"></path></svg>`,
    arrowLeft: `<svg ${attrs}><path d="m15 18-6-6 6-6"></path></svg>`,
    alert: `<svg ${attrs}><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 4.4 2.8 17.4A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.6L13.7 4.4a2 2 0 0 0-3.4 0z"></path></svg>`,
    download: `<svg ${attrs}><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>`,
    plus: `<svg ${attrs} width="13" height="13"><path d="M12 5v14M5 12h14"></path></svg>`,
  };
  return icons[name] ?? "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char];
  });
}

init();
