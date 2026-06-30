import {
  BookFileError,
  type PdfReaderController,
  type ReaderContentTheme,
  type ReaderLineSpacing,
  type ReaderMargin,
  type TextReaderController,
  apiHeaders,
  fetchBookFile,
  openFoliateReader,
  openPdfReader,
} from "./readerCore";
import { readerFeatureFlags } from "./featureFlags";
import "./styles.css";

type Book = {
  id: number;
  file_name: string;
  title: string;
  author: string | null;
  format: string;
  cover_ref: string | null;
  cover_url: string | null;
  size_bytes: number;
  too_large: boolean;
  // TODO: expose duplicate_of id before adding an "Open similar item" action.
  possible_duplicate: boolean;
  sort_order: number;
  folder_id: number | null;
  progress_percent: number;
};

type Folder = {
  id: number;
  name: string;
  sort_order: number;
};

type Note = {
  id: number;
  book_id: number;
  locator: string;
  percent: number;
  note_text: string | null;
  created_at: string;
  updated_at: string;
};

type Home = {
  continue_book: Book | null;
  recent: Book[];
  folders: Folder[];
};

type View = "home" | "library" | "reader";
type LibraryScope = "inbox" | "all" | number;
type LibrarySort = "manual" | "recent_opened" | "recent_added";
type SheetState =
  | { kind: "actions"; book: Book; error: string | null }
  | { kind: "move"; book: Book; targetFolderId: number | null }
  | { kind: "edit"; book: Book; title: string; author: string; error: string | null }
  | { kind: "remove"; book: Book; error: string | null }
  | { kind: "reorderConfirm"; book: Book; direction: "up" | "down"; error: string | null }
  | { kind: "folder"; name: string; error: string | null }
  | { kind: "folderManage"; error: string | null }
  | { kind: "folderEdit"; folder: Folder; name: string; error: string | null }
  | { kind: "folderRemove"; folder: Folder; error: string | null }
  | { kind: "readerSettings"; book: Book }
  | { kind: "note"; book: Book; locator: string; percent: number; noteText: string; error: string | null }
  | { kind: "notes"; book: Book; notes: Note[]; isLoading: boolean; error: string | null }
  | null;
type AppTheme = "day" | "night";
type PendingAction = "folder" | "folderEdit" | "folderRemove" | "move" | "edit" | "remove" | "reorder" | "note" | null;
type ToastKind = "info" | "success" | "error";

const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 3;
const READER_AA_NUDGE_MAX = 3;

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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
let librarySort: LibrarySort = readLibrarySort();
let activeBook: Book | null = null;
let activeSheet: SheetState = null;
let isHomeLoading = false;
let isLibraryLoading = false;
let errorMessage: string | null = null;
let appTheme: AppTheme = readAppTheme();
let readerTheme: ReaderContentTheme = readReaderTheme();
let activeReaderSave: (() => void) | null = null;
let activeReaderDestroy: (() => void) | null = null;
let activeTextReader: TextReaderController | null = null;
let activePdfReader: PdfReaderController | null = null;
let activeReaderRestoreLocator: string | null = null;
let readerToolbarVisible = true;
let readerFontSizePx = readReaderFontSize();
let readerLineSpacing = readReaderLineSpacing();
let readerMargin = readReaderMargin();
let pdfZoom = readPdfZoom();
let readerStatusLabel = "Opening...";
let readerStatusPercent = 0;
let toastMessage: string | null = null;
let toastKind: ToastKind = "info";
let toastTimer = 0;
let pendingAction: PendingAction = null;
let positionSaveErrorShown = false;
const coverObjectUrlCache = new Map<string, string>();
const coverCacheKeyByBookId = new Map<number, string>();
const pendingCoverFetches = new Map<string, Promise<string | null>>();

function init() {
  tg?.ready?.();
  tg?.expand?.();
  document.body.classList.add("dark");
  window.addEventListener("pagehide", revokeAllCoverObjectUrls);
  applyAppTheme();
  void loadHome();
}

function headers(): HeadersInit {
  return apiHeaders(initData());
}

function initData(): string {
  return tg?.initData || import.meta.env.VITE_DEV_INIT_DATA || "";
}

function apiUrl(path: string): string {
  return new URL(path, API_BASE).toString();
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
    throw new ApiError(response.status, await responseMessage(response));
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
    hapticNotification("error");
    showToast("Network error. Try again.", "error");
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
    const [allBooks, folders] = await Promise.all([
      api<Book[]>(`/api/books?sort=${encodeURIComponent(librarySort)}`),
      api<Folder[]>("/api/folders"),
    ]);
    allBooksState = allBooks;
    foldersState = folders;
    booksState = filterBooks(allBooksState);
  } catch (error) {
    errorMessage = readableError(error);
    hapticNotification("error");
    showToast("Network error. Try again.", "error");
  } finally {
    isLibraryLoading = false;
    render();
  }
}

async function createFolder() {
  hapticImpact();
  activeSheet = { kind: "folder", name: "", error: null };
  render();
}

async function submitFolder(name: string) {
  if (!name.trim() || pendingAction) return;
  pendingAction = "folder";
  render();
  try {
    await api<Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    activeSheet = null;
    hapticNotification("success");
    showToast("Folder created", "success");
    if (view === "library") {
      await loadBooks(selectedFolderId);
    } else {
      await loadHome();
    }
  } catch (error) {
    hapticNotification("error");
    showToast("Could not create folder", "error");
    pendingAction = null;
    activeSheet = { kind: "folder", name, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function updateFolderName(folder: Folder, name: string) {
  if (pendingAction) return;
  if (!name.trim()) {
    activeSheet = { kind: "folderEdit", folder, name, error: "Folder name must not be empty." };
    render();
    return;
  }
  pendingAction = "folderEdit";
  render();
  try {
    const updated = await api<Folder>(`/api/folders/${folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    foldersState = foldersState.map((item) => (item.id === updated.id ? updated : item));
    activeSheet = { kind: "folderManage", error: null };
    hapticNotification("success");
    showToast("Folder renamed", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not rename folder", "error");
    pendingAction = null;
    activeSheet = { kind: "folderEdit", folder, name, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function removeFolder(folder: Folder) {
  if (pendingAction) return;
  pendingAction = "folderRemove";
  render();
  try {
    await api<void>(`/api/folders/${folder.id}`, { method: "DELETE" });
    if (selectedFolderId === folder.id) selectedFolderId = "all";
    foldersState = foldersState.filter((item) => item.id !== folder.id);
    allBooksState = allBooksState.map((book) => (book.folder_id === folder.id ? { ...book, folder_id: null } : book));
    booksState = filterBooks(allBooksState);
    activeSheet = { kind: "folderManage", error: null };
    hapticNotification("success");
    showToast("Folder deleted", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not delete folder", "error");
    pendingAction = null;
    activeSheet = { kind: "folderRemove", folder, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function reorderFolder(folder: Folder, direction: "up" | "down") {
  if (pendingAction) return;
  pendingAction = "reorder";
  render();
  try {
    await api<Folder>(`/api/folders/${folder.id}/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ direction }),
    });
    foldersState = await api<Folder[]>("/api/folders");
    activeSheet = { kind: "folderManage", error: null };
    hapticSelection();
    showToast("Folder moved", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not move folder", "error");
    pendingAction = null;
    activeSheet = { kind: "folderManage", error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function moveBookToFolder(book: Book, folderId: number | null) {
  if (pendingAction) return;
  pendingAction = "move";
  render();
  try {
    const updated = await api<Book>(`/api/books/${book.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ folder_id: folderId }),
    });
    replaceBookInState(updated);
    activeSheet = null;
    hapticNotification("success");
    showToast("Moved", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not move book", "error");
    pendingAction = null;
    if (error instanceof ApiError && error.status === 404) {
      activeSheet = { kind: "actions", book, error: "This item was not found. Refreshing your library." };
      render();
      window.setTimeout(() => void refreshCurrentView(), 700);
      return;
    }
    activeSheet = { kind: "actions", book, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function reorderBook(book: Book, direction: "up" | "down") {
  if (pendingAction) return;
  pendingAction = "reorder";
  librarySort = "manual";
  writeLibrarySort();
  render();
  try {
    await api<Book>(`/api/books/${book.id}/reorder`, {
      method: "PATCH",
      body: JSON.stringify({
        direction,
        ...currentBookScopePayload(),
      }),
    });
    activeSheet = null;
    hapticSelection();
    showToast("Moved", "success");
    await loadBooks(selectedFolderId);
  } catch (error) {
    hapticNotification("error");
    showToast("Could not reorder book", "error");
    pendingAction = null;
    if (error instanceof ApiError && error.status === 404) {
      activeSheet = { kind: "actions", book, error: "This item was not found in the current view. Refreshing your library." };
      render();
      window.setTimeout(() => void refreshCurrentView(), 700);
      return;
    }
    activeSheet = { kind: "actions", book, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function updateBookMetadata(book: Book, title: string, author: string) {
  if (pendingAction) return;
  if (!title.trim()) {
    activeSheet = { kind: "edit", book, title, author, error: "Title must not be empty." };
    render();
    return;
  }
  pendingAction = "edit";
  render();
  try {
    const updated = await api<Book>(`/api/books/${book.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: title.trim(),
        author: author.trim() || null,
      }),
    });
    replaceBookInState(updated);
    activeSheet = null;
    hapticNotification("success");
    showToast("Book updated", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not update book", "error");
    pendingAction = null;
    if (error instanceof ApiError && error.status === 404) {
      activeSheet = { kind: "edit", book, title, author, error: "This item was not found. Refreshing your library." };
      render();
      window.setTimeout(() => void refreshCurrentView(), 700);
      return;
    }
    activeSheet = { kind: "edit", book, title, author, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function removeBookFromLibrary(book: Book) {
  if (pendingAction) return;
  pendingAction = "remove";
  render();
  try {
    await api<void>(`/api/books/${book.id}`, { method: "DELETE" });
    if (activeBook?.id === book.id) {
      cleanupActiveReader(true);
      activeBook = null;
    }
    removeBookFromState(book.id);
    activeSheet = null;
    hapticNotification("success");
    showToast("Removed", "success");
    render();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not remove book", "error");
    pendingAction = null;
    if (error instanceof ApiError && error.status === 404) {
      activeSheet = { kind: "remove", book, error: "This item was already removed. Refreshing your library." };
      render();
      window.setTimeout(() => void refreshCurrentView(), 700);
      return;
    }
    activeSheet = { kind: "remove", book, error: readableError(error) };
    render();
  } finally {
    pendingAction = null;
  }
}

async function createNote(book: Book, locator: string, percent: number, noteText: string) {
  if (pendingAction) return;
  pendingAction = "note";
  updateActiveSheet();
  try {
    await api<Note>(`/api/books/${book.id}/notes`, {
      method: "POST",
      body: JSON.stringify({
        locator,
        percent,
        note_text: noteText.trim() || null,
      }),
    });
    hapticNotification("success");
    showToast(noteText.trim() ? "Note saved" : "Bookmark saved", "success");
    closeSheet();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not save bookmark", "error");
    pendingAction = null;
    activeSheet = { kind: "note", book, locator, percent, noteText, error: readableError(error) };
    updateActiveSheet();
  } finally {
    pendingAction = null;
  }
}

async function showNotesForBook(book: Book) {
  hapticSelection();
  presentSheet({ kind: "notes", book, notes: [], isLoading: true, error: null });
  try {
    const notes = await api<Note[]>(`/api/books/${book.id}/notes`);
    if (activeSheet?.kind !== "notes" || activeSheet.book.id !== book.id) return;
    presentSheet({ kind: "notes", book, notes, isLoading: false, error: null });
  } catch (error) {
    hapticNotification("error");
    if (activeSheet?.kind !== "notes" || activeSheet.book.id !== book.id) return;
    presentSheet({ kind: "notes", book, notes: [], isLoading: false, error: readableError(error) });
  }
}

async function deleteNote(note: Note) {
  if (pendingAction) return;
  pendingAction = "note";
  updateActiveSheet();
  try {
    await api<void>(`/api/notes/${note.id}`, { method: "DELETE" });
    hapticNotification("success");
    showToast("Bookmark removed", "success");
    if (activeSheet?.kind === "notes") {
      activeSheet = { ...activeSheet, notes: activeSheet.notes.filter((item) => item.id !== note.id) };
    }
    updateActiveSheet();
  } catch (error) {
    hapticNotification("error");
    showToast("Could not remove bookmark", "error");
  } finally {
    pendingAction = null;
    updateActiveSheet();
  }
}

async function refreshCurrentView() {
  if (view === "library") {
    await loadBooks(selectedFolderId);
    return;
  }
  if (view === "reader") {
    await loadBooks("all");
    return;
  }
  await loadHome();
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

function bookOrderState(book: Book): { canMoveUp: boolean; canMoveDown: boolean } {
  const visibleBooks = filterBooks(allBooksState);
  const index = visibleBooks.findIndex((item) => item.id === book.id);
  return {
    canMoveUp: index > 0,
    canMoveDown: index >= 0 && index < visibleBooks.length - 1,
  };
}

function currentBookScopePayload(): { inbox?: boolean; folder_id?: number } {
  if (selectedFolderId === "inbox") return { inbox: true };
  if (typeof selectedFolderId === "number") return { folder_id: selectedFolderId };
  return {};
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
    ${renderActiveSheet()}
    ${renderToast()}
  `;

  bindShellControls();
  bindBookButtons();
  bindLibraryControls();
  bindSheetControls();
  bindCoverImages();
  pruneCoverObjectUrls();
}

function renderTopbar(title: string): string {
  return `
    <header class="topbar">
      <div class="screen-title">${escapeHtml(title)}</div>
      <button class="theme-toggle" id="appThemeButton" type="button" aria-label="Toggle app theme" aria-pressed="${appTheme === "day"}">
        <span class="${appTheme === "day" ? "theme-toggle__active" : ""}">${icon("sun")}</span>
        <span class="${appTheme === "night" ? "theme-toggle__active" : ""}">${icon("moon")}</span>
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
        <div class="empty-orbit__pulse pulse-ring"></div>
        <div class="empty-icon">${icon("bookOpen")}</div>
      </div>
      <h2>Your library is empty</h2>
      <p>Send EPUB, FB2, TXT or PDF to the bot.</p>
      <div class="empty-cta">
        <span>Send EPUB, FB2, TXT or PDF to the bot</span>
        <span class="arrow-bob">${icon("arrowDown")}</span>
      </div>
    </div>
  `;
}

function renderContinueHero(book: Book): string {
  const hasProgress = book.progress_percent > 0;
  return `
    <button class="continue-hero glow" type="button" data-open="${book.id}">
      ${renderCover(book, "hero-cover")}
      <span class="continue-copy">
        <span class="format-badge">${escapeHtml(book.format.toUpperCase())}</span>
        <strong>${escapeHtml(book.title)}</strong>
        <em>${escapeHtml(book.author ?? "Unknown author")}</em>
        <span class="continue-action">${hasProgress ? "Continue" : "Start reading"}</span>
        ${renderProgress(book, "Continue reading", continueProgressDetail(book))}
      </span>
    </button>
  `;
}

function renderRecentCard(book: Book): string {
  return `
    <button class="recent-card" type="button" data-open="${book.id}">
      ${renderCover(book, "recent-cover", true)}
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
    ${renderSortSelector()}
    ${
      noBooksAtAll
        ? renderLibraryEmpty()
        : !hasQuery && filteredBooks.length === 0
          ? renderScopedEmpty()
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
    <div class="folder-strip">${renderFolderChips(true)}<button class="folder-manage-button" type="button" id="manageFolders" aria-label="Manage folders">${icon("more")}<span>Manage folders</span></button></div>
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

function renderSortSelector(): string {
  return `
    <div class="sort-row" role="group" aria-label="Library sort">
      ${renderSortButton("Manual", "manual")}
      ${renderSortButton("Recently opened", "recent_opened")}
      ${renderSortButton("Recently added", "recent_added")}
    </div>
  `;
}

function renderSortButton(label: string, value: LibrarySort): string {
  return `<button class="sort-button ${librarySort === value ? "active" : ""}" type="button" data-sort="${value}">${label}</button>`;
}

function renderLibraryEmpty(): string {
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon("library")}</div>
      <h2>Nothing here yet</h2>
      <p>Send EPUB, FB2, TXT or PDF to the bot.</p>
    </div>
  `;
}

function renderScopedEmpty(): string {
  const isInbox = selectedFolderId === "inbox";
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon(isInbox ? "arrowDown" : "folderPlus")}</div>
      <h2>${isInbox ? "Inbox is empty" : "Folder is empty"}</h2>
      <p>${isInbox ? "New files land here first." : "Move books here with the ... menu."}</p>
    </div>
  `;
}

function renderNoResults(): string {
  return `
    <div class="empty-state empty-state--library">
      <div class="empty-icon">${icon("search")}</div>
      <h2>No matches for "${escapeHtml(searchQuery)}"</h2>
      <p>Search currently checks title and author.</p>
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
          ${book.possible_duplicate ? `<span class="duplicate-badge">Possible duplicate</span>` : ""}
        </div>
        <h2>${highlightMatch(book.title)}</h2>
        <p>${escapeHtml(book.author ?? "Unknown author")}</p>
        ${renderProgress(book, "Reading progress")}
      </div>
      <button class="row-menu-button" type="button" data-row-menu="${book.id}" aria-label="Open actions for ${escapeHtml(book.title)}">${icon("more")}</button>
    </article>
  `;
}

function renderCover(book: Book, className: string, withProgress = false): string {
  const coverKey = book.cover_ref ? `${book.id}:${book.cover_ref}` : "";
  const image = book.cover_url
    ? `<img class="cover-image" data-cover-book-id="${book.id}" data-cover-ref="${escapeHtml(book.cover_ref ?? "")}" data-cover-key="${escapeHtml(coverKey)}" data-cover-url="${escapeHtml(book.cover_url)}" alt="" loading="lazy" decoding="async" hidden />`
    : "";
  const hasImage = Boolean(book.cover_url);
  return `
    <span class="book-cover ${className} tone-${book.id % 5} ${hasImage ? "cover-loading" : "cover-fallback-active"}" data-cover-shell data-cover-book-id="${book.id}">
      ${image}
      <span class="cover-stripes"></span>
      <span class="cover-spine"></span>
      <span class="cover-format">${escapeHtml(book.format.toUpperCase())}</span>
      <span class="cover-initials">${escapeHtml(coverInitials(book.title))}</span>
      <span class="cover-title">${escapeHtml(book.title)}</span>
      <span class="cover-author">${escapeHtml(book.author ?? "Unknown author")}</span>
      ${withProgress ? renderCoverProgress(book) : ""}
    </span>
  `;
}

function renderProgress(book: Book, label: string, detail = progressDetail(book)): string {
  const percent = clamp(Math.round(book.progress_percent), 0, 100);
  return `
    <span class="progress-wrap" aria-label="${escapeHtml(label)}">
      <span class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <span class="progress-meter bar-fill ${progressClass(percent)}"></span>
      </span>
      <span class="progress-meta"><span>${escapeHtml(book.too_large ? "Download original" : detail)}</span><b>${progressLabel(book)}</b></span>
    </span>
  `;
}

function renderCoverProgress(book: Book): string {
  if (book.too_large) return "";
  const percent = clamp(Math.round(book.progress_percent), 0, 100);
  if (percent <= 0) return "";
  return `<span class="cover-progress"><span class="progress-meter ${progressClass(percent)}"></span></span>`;
}

function coverInitials(title: string): string {
  const words = title
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word).find((char) => char.toLowerCase() !== char.toUpperCase() || /\d/.test(char)) ?? "")
    .map((char) => char.toUpperCase())
    .join("");
  return initials || "TL";
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
  if (sheet.kind === "folder") return renderFolderSheet(sheet);
  if (sheet.kind === "folderManage") return renderFolderManageSheet(sheet);
  if (sheet.kind === "folderEdit") return renderFolderEditSheet(sheet);
  if (sheet.kind === "folderRemove") return renderFolderRemoveSheet(sheet);
  if (sheet.kind === "readerSettings") return renderReaderSettingsSheet(sheet);
  if (sheet.kind === "actions") return renderActionsSheet(sheet);
  if (sheet.kind === "edit") return renderEditBookSheet(sheet);
  if (sheet.kind === "remove") return renderRemoveBookSheet(sheet);
  if (sheet.kind === "reorderConfirm") return renderReorderConfirmSheet(sheet);
  if (sheet.kind === "note") return renderNoteSheet(sheet);
  if (sheet.kind === "notes") return renderNotesSheet(sheet);
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
        <button class="primary-action" type="button" id="confirmMove" ${pendingAction === "move" ? "disabled" : ""}>${pendingAction === "move" ? "Moving..." : "Move here"}</button>
      </section>
    </div>
  `;
}

function renderActiveSheet(): string {
  return activeSheet ? renderSheet(activeSheet) : "";
}

function renderSheetBook(book: Book): string {
  return `
    <div class="sheet-book">
      ${renderCover(book, "sheet-cover")}
      <div>
        <h2>${escapeHtml(book.title)}</h2>
        <p>${escapeHtml(book.author ?? "Unknown author")} · ${escapeHtml(book.format.toUpperCase())} · ${progressLabel(book)}</p>
      </div>
    </div>
  `;
}

function renderActionsSheet(sheet: Extract<SheetState, { kind: "actions" }>): string {
  const orderState = bookOrderState(sheet.book);
  const manualReorder = librarySort === "manual";
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Book actions">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <div class="sheet-actions">
          <button class="sheet-action" type="button" id="sheetRead">${icon("bookOpen")}<span class="sheet-action-copy"><strong>Read</strong><small>Open this book</small></span></button>
          <button class="sheet-action" type="button" id="sheetEdit" aria-label="Rename. Edit title and author">${icon("edit")}<span class="sheet-action-copy"><strong>Rename</strong><small>Edit title and author</small></span></button>
          <button class="sheet-action" type="button" id="sheetMove">${icon("folderPlus")}<span class="sheet-action-copy"><strong>Move to folder</strong><small>Inbox or any folder</small></span></button>
          <button class="sheet-action" type="button" id="sheetMoveUp" ${orderState.canMoveUp ? "" : "disabled"} data-reorder-needs-confirm="${manualReorder ? "false" : "true"}">${icon("arrowUp")}<span class="sheet-action-copy"><strong>Move up</strong><small>${manualReorder ? "Manual order" : "Switch to Manual sort first"}</small></span></button>
          <button class="sheet-action" type="button" id="sheetMoveDown" ${orderState.canMoveDown ? "" : "disabled"} data-reorder-needs-confirm="${manualReorder ? "false" : "true"}">${icon("arrowDown")}<span class="sheet-action-copy"><strong>Move down</strong><small>${manualReorder ? "Manual order" : "Switch to Manual sort first"}</small></span></button>
          <button class="sheet-action" type="button" id="sheetNotes">${icon("bookmark")}<span class="sheet-action-copy"><strong>Notes</strong><small>Bookmarks for this book</small></span></button>
          <button class="sheet-action danger" type="button" id="sheetRemove">${icon("trash")}<span class="sheet-action-copy"><strong>Remove from library</strong><small>Telegram file stays untouched</small></span></button>
        </div>
      </section>
    </div>
  `;
}

function renderReorderConfirmSheet(sheet: Extract<SheetState, { kind: "reorderConfirm" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Switch to manual sort">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        <h3>Switch to Manual sort?</h3>
        <p class="sheet-note">Move ${sheet.direction === "up" ? "up" : "down"} works in Manual order. Your list will switch from the current sort to Manual.</p>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <div class="sheet-buttons">
          <button class="ghost-button sheet-cancel" type="button" id="cancelReorder">Cancel</button>
          <button class="primary-action sheet-primary-inline" type="button" id="confirmReorder" ${pendingAction === "reorder" ? "disabled" : ""}>${pendingAction === "reorder" ? "Moving..." : "Switch and move"}</button>
        </div>
      </section>
    </div>
  `;
}

function renderNoteSheet(sheet: Extract<SheetState, { kind: "note" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Save bookmark">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        <h3>Save bookmark</h3>
        <p class="sheet-note">Saved at ${formatPercent(sheet.percent)}. Add a short note if you want.</p>
        <label class="folder-form">
          <span>Note optional</span>
          <textarea id="noteTextInput" maxlength="1200" rows="4" placeholder="What should future you remember?">${escapeHtml(sheet.noteText)}</textarea>
        </label>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <button class="primary-action" type="button" id="confirmNote" ${pendingAction === "note" ? "disabled" : ""}>${pendingAction === "note" ? "Saving..." : "Save"}</button>
      </section>
    </div>
  `;
}

function renderNotesSheet(sheet: Extract<SheetState, { kind: "notes" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up notes-sheet" aria-label="Book notes">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        <h3>Notes</h3>
        <p class="sheet-note">Bookmarks and notes saved for this book.</p>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        ${
          sheet.isLoading
            ? `<div class="notes-list"><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>`
            : sheet.notes.length
              ? `<div class="notes-list">${sheet.notes.map(renderNoteRow).join("")}</div>`
              : `<div class="empty-mini">No notes yet. Open the reader and tap Mark.</div>`
        }
      </section>
    </div>
  `;
}

function renderNoteRow(note: Note): string {
  return `
    <div class="note-row">
      <button class="note-open" type="button" data-open-note="${note.id}">
        <strong>${escapeHtml(note.note_text?.trim() || "Bookmark")}</strong>
        <span>${formatPercent(note.percent)} · ${formatNoteDate(note.created_at)}</span>
      </button>
      <button class="note-delete" type="button" data-delete-note="${note.id}" aria-label="Delete bookmark">${icon("trash")}</button>
    </div>
  `;
}

function renderEditBookSheet(sheet: Extract<SheetState, { kind: "edit" }>): string {
  const fallbackTitle = fallbackTitleFromFileName(sheet.book.file_name);
  const showFileNameHelper = sheet.book.title.trim() === fallbackTitle;
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Edit book">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        <h3>Rename</h3>
        <p class="sheet-note">Edit title and author.</p>
        <label class="folder-form">
          <span>Title</span>
          <input id="bookTitleInput" value="${escapeHtml(sheet.title)}" maxlength="240" autocomplete="off" autofocus />
          ${showFileNameHelper ? `<small class="field-helper">Current title came from file name: ${escapeHtml(sheet.book.file_name)}</small>` : ""}
        </label>
        <label class="folder-form">
          <span>Author</span>
          <input id="bookAuthorInput" value="${escapeHtml(sheet.author)}" maxlength="240" autocomplete="off" />
        </label>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <button class="primary-action" type="button" id="confirmBookEdit" ${sheet.title.trim() && pendingAction !== "edit" ? "" : "disabled"}>${pendingAction === "edit" ? "Saving..." : "Save"}</button>
      </section>
    </div>
  `;
}

function renderRemoveBookSheet(sheet: Extract<SheetState, { kind: "remove" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Remove book">
        <div class="sheet-handle"></div>
        ${renderSheetBook(sheet.book)}
        <h3>Remove from library?</h3>
        <p class="sheet-note">The original Telegram file is not deleted.</p>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <div class="sheet-buttons">
          <button class="ghost-button sheet-cancel" type="button" id="cancelRemove">Cancel</button>
          <button class="danger-action" type="button" id="confirmRemove" ${pendingAction === "remove" ? "disabled" : ""}>${pendingAction === "remove" ? "Removing..." : "Remove"}</button>
        </div>
      </section>
    </div>
  `;
}

function renderFolderSheet(sheet: Extract<SheetState, { kind: "folder" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Create folder">
        <div class="sheet-handle"></div>
        <h3>New folder</h3>
        <p class="sheet-note">Create a folder for organizing your library.</p>
        <label class="folder-form">
          <span>Name</span>
          <input id="folderNameInput" value="${escapeHtml(sheet.name)}" maxlength="120" autocomplete="off" />
        </label>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <button class="primary-action" type="button" id="confirmFolder" ${sheet.name.trim() && pendingAction !== "folder" ? "" : "disabled"}>${pendingAction === "folder" ? "Creating..." : "Create"}</button>
      </section>
    </div>
  `;
}

function renderReaderSettingsSheet(sheet: Extract<SheetState, { kind: "readerSettings" }>): string {
  const isPdf = sheet.book.format === "pdf";
  const isV2 = isReaderUiV2();
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up reader-settings-sheet" aria-label="Reader settings">
        <div class="sheet-handle"></div>
        <h3>Reader settings</h3>
        <p class="sheet-note">${escapeHtml(shortReaderTitle(sheet.book.title))}</p>
        ${
          isPdf
            ? `
              <div class="reader-setting-row">
                <span>Zoom</span>
                <div class="reader-stepper">
                  <button class="secondary reader-zoom-button" id="readerZoomOut" type="button" aria-label="Zoom out">&minus;</button>
                  <b id="readerPdfZoomValue">${Math.round(pdfZoom * 100)}%</b>
                  <button class="secondary reader-zoom-button" id="readerZoomIn" type="button" aria-label="Zoom in">+</button>
                </div>
              </div>
              <button class="ghost-button reader-fit-reset" type="button" id="readerFitWidth">Fit width</button>
              ${isV2 ? `<button class="ghost-button reader-fit-reset" type="button" id="readerResetPdfZoom">Reset zoom</button>` : ""}
              <div class="reader-setting-row reader-setting-row--stack">
                <span>Theme</span>
                <div class="reader-theme-options" role="group" aria-label="PDF reader theme">
                  ${renderReaderThemeButton("Dark", "dark")}
                  ${renderReaderThemeButton("Light", "light")}
                  ${renderReaderThemeButton("Sepia", "sepia")}
                </div>
              </div>
            `
            : `
              <div class="reader-setting-row">
                <span>Font size</span>
                <div class="reader-stepper">
                  <button class="secondary reader-font-button" id="readerFontDown" type="button" aria-label="Decrease font size">A-</button>
                  <b id="readerFontSizeValue">${readerFontSizePx}px</b>
                  <button class="secondary reader-font-button" id="readerFontUp" type="button" aria-label="Increase font size">A+</button>
                </div>
              </div>
              ${
                isV2
                  ? `
                    <div class="reader-setting-row reader-setting-row--stack">
                      <span>Line spacing</span>
                      <div class="reader-theme-options" role="group" aria-label="Line spacing">
                        ${renderReaderSegmentButton("Compact", "reader-line", "compact", readerLineSpacing)}
                        ${renderReaderSegmentButton("Normal", "reader-line", "normal", readerLineSpacing)}
                        ${renderReaderSegmentButton("Spacious", "reader-line", "spacious", readerLineSpacing)}
                      </div>
                    </div>
                    <div class="reader-setting-row reader-setting-row--stack">
                      <span>Margins</span>
                      <div class="reader-theme-options" role="group" aria-label="Reader margins">
                        ${renderReaderSegmentButton("Narrow", "reader-margin", "narrow", readerMargin)}
                        ${renderReaderSegmentButton("Normal", "reader-margin", "normal", readerMargin)}
                        ${renderReaderSegmentButton("Wide", "reader-margin", "wide", readerMargin)}
                      </div>
                    </div>
                  `
                  : ""
              }
              <div class="reader-setting-row reader-setting-row--stack">
                <span>Theme</span>
                <div class="reader-theme-options" role="group" aria-label="Reader theme">
                  ${renderReaderThemeButton("Dark", "dark")}
                  ${renderReaderThemeButton("Light", "light")}
                  ${renderReaderThemeButton("Sepia", "sepia")}
                </div>
              </div>
              ${isV2 ? `<button class="ghost-button reader-fit-reset" type="button" id="readerResetText">Reset defaults</button>` : ""}
            `
        }
      </section>
    </div>
  `;
}

function renderReaderThemeButton(label: string, theme: ReaderContentTheme): string {
  return `<button class="sort-button ${readerTheme === theme ? "active" : ""}" type="button" data-reader-theme="${theme}" aria-pressed="${readerTheme === theme ? "true" : "false"}">${label}</button>`;
}

function renderReaderSegmentButton(label: string, group: string, value: string, activeValue: string): string {
  return `<button class="sort-button ${activeValue === value ? "active" : ""}" type="button" data-${group}="${value}" aria-pressed="${activeValue === value ? "true" : "false"}">${label}</button>`;
}

function renderFolderManageSheet(sheet: Extract<SheetState, { kind: "folderManage" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up folder-manage-sheet" aria-label="Manage folders">
        <div class="sheet-handle"></div>
        <h3>Manage folders</h3>
        <p class="sheet-note">Rename, reorder, or delete folders. Deleting a folder keeps its books in Inbox.</p>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <div class="folder-manage-list">
          ${
            foldersState.length
              ? foldersState.map((folder, index) => renderFolderManageRow(folder, index)).join("")
              : `<div class="empty-mini">No folders yet.</div>`
          }
        </div>
        <button class="primary-action" type="button" id="folderManageNew">New folder</button>
      </section>
    </div>
  `;
}

function renderFolderManageRow(folder: Folder, index: number): string {
  const count = allBooksState.filter((book) => book.folder_id === folder.id).length;
  return `
    <div class="folder-manage-row">
      <span class="folder-dot ${folderDotClass(index)}"></span>
      <div class="folder-manage-copy">
        <strong>${escapeHtml(folder.name)}</strong>
        <small>${count} ${count === 1 ? "book" : "books"}</small>
      </div>
      <div class="folder-manage-actions">
        <button type="button" data-folder-edit="${folder.id}" aria-label="Rename folder">${icon("edit")}<span>Rename</span></button>
        <button type="button" data-folder-up="${folder.id}" ${index === 0 ? "disabled" : ""} aria-label="Move folder up">${icon("arrowUp")}<span>Up</span></button>
        <button type="button" data-folder-down="${folder.id}" ${index === foldersState.length - 1 ? "disabled" : ""} aria-label="Move folder down">${icon("arrowDown")}<span>Down</span></button>
        <button class="danger" type="button" data-folder-remove="${folder.id}" aria-label="Delete folder">${icon("trash")}<span>Delete</span></button>
      </div>
    </div>
  `;
}

function renderFolderEditSheet(sheet: Extract<SheetState, { kind: "folderEdit" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Rename folder">
        <div class="sheet-handle"></div>
        <h3>Rename folder</h3>
        <label class="folder-form">
          <span>Name</span>
          <input id="folderEditNameInput" value="${escapeHtml(sheet.name)}" maxlength="120" autocomplete="off" autofocus />
        </label>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <button class="primary-action" type="button" id="confirmFolderEdit" ${sheet.name.trim() && pendingAction !== "folderEdit" ? "" : "disabled"}>${pendingAction === "folderEdit" ? "Saving..." : "Save"}</button>
      </section>
    </div>
  `;
}

function renderFolderRemoveSheet(sheet: Extract<SheetState, { kind: "folderRemove" }>): string {
  return `
    <div class="sheet-layer" id="sheetScrim">
      <section class="bottom-sheet sheet-up" aria-label="Delete folder">
        <div class="sheet-handle"></div>
        <h3>Delete folder?</h3>
        <p class="sheet-note">Books stay in your library and move back to Inbox.</p>
        ${sheet.error ? `<p class="sheet-error">${escapeHtml(sheet.error)}</p>` : ""}
        <div class="sheet-buttons">
          <button class="ghost-button sheet-cancel" type="button" id="cancelFolderRemove">Cancel</button>
          <button class="danger-action" type="button" id="confirmFolderRemove" ${pendingAction === "folderRemove" ? "disabled" : ""}>${pendingAction === "folderRemove" ? "Deleting..." : "Delete"}</button>
        </div>
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
  document.querySelector("#appThemeButton")?.addEventListener("click", toggleAppTheme);
  document.querySelector("#homeNav")?.addEventListener("click", () => {
    cleanupActiveReader(true);
    void loadHome();
  });
  document.querySelector("#libraryNav")?.addEventListener("click", () => {
    cleanupActiveReader(true);
    selectedFolderId = "all";
    searchQuery = "";
    void loadBooks("all");
  });
  document.querySelector("#folderNav")?.addEventListener("click", () => void createFolder());
  document.querySelector("#retryLoad")?.addEventListener("click", () => {
    hapticImpact();
    showToast("Retrying...", "info");
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

  document.querySelectorAll<HTMLElement>("[data-row-menu]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const book = findBook(Number(button.dataset.rowMenu));
      if (!book) return;
      hapticImpact();
      activeSheet = { kind: "actions", book, error: null };
      render();
    });
  });

  document.querySelectorAll<HTMLElement>(".book-row[data-book-id]").forEach((row) => {
    let pressTimer = 0;
    let longPressed = false;
    const id = Number(row.dataset.bookId);

    row.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("[data-row-menu]")) return;
      longPressed = false;
      pressTimer = window.setTimeout(() => {
        const book = findBook(id);
        if (!book) return;
        longPressed = true;
        hapticImpact();
        activeSheet = { kind: "actions", book, error: null };
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
      hapticImpact();
      activeSheet = { kind: "actions", book, error: null };
      render();
    });
    row.addEventListener("click", () => {
      if (longPressed) return;
      openBookById(id, "Read");
    });
  });
}

function bindCoverImages(): void {
  document.querySelectorAll<HTMLImageElement>(".cover-image").forEach((image) => {
    image.addEventListener("error", () => activateCoverFallback(image), { once: true });
  });
  void loadCoverImages();
}

async function loadCoverImages(): Promise<void> {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>(".cover-image[data-cover-url]"));
  await Promise.all(
    images.map(async (image) => {
      const path = image.dataset.coverUrl;
      const bookId = Number(image.dataset.coverBookId);
      const coverRef = image.dataset.coverRef;
      const coverKey = image.dataset.coverKey;
      if (!path || !bookId || !coverRef || !coverKey) {
        activateCoverFallback(image);
        return;
      }
      try {
        const cachedUrl = coverObjectUrlCache.get(coverKey) ?? (await fetchCoverObjectUrl(path, bookId, coverKey));
        if (!cachedUrl) {
          activateCoverFallback(image);
          return;
        }
        if (!document.body.contains(image) || image.dataset.coverKey !== coverKey) return;
        const shell = image.closest("[data-cover-shell]");
        image.src = cachedUrl;
        image.hidden = false;
        await image.decode().catch(() => undefined);
        image.classList.remove("cover-image-broken");
        shell?.classList.remove("cover-loading", "cover-fallback-active");
      } catch {
        activateCoverFallback(image);
      }
    }),
  );
}

async function fetchCoverObjectUrl(path: string, bookId: number, coverKey: string): Promise<string | null> {
  const pending = pendingCoverFetches.get(coverKey);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch(apiUrl(path), { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cover request failed with HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith("image/")) return null;
    const objectUrl = URL.createObjectURL(blob);
    storeCoverObjectUrl(bookId, coverKey, objectUrl);
    return objectUrl;
  })().finally(() => {
    pendingCoverFetches.delete(coverKey);
  });
  pendingCoverFetches.set(coverKey, request);
  return request;
}

function storeCoverObjectUrl(bookId: number, coverKey: string, objectUrl: string): void {
  const previousKey = coverCacheKeyByBookId.get(bookId);
  if (previousKey && previousKey !== coverKey) {
    const previousUrl = coverObjectUrlCache.get(previousKey);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    coverObjectUrlCache.delete(previousKey);
  }
  coverCacheKeyByBookId.set(bookId, coverKey);
  coverObjectUrlCache.set(coverKey, objectUrl);
}

function activateCoverFallback(image: HTMLImageElement): void {
  image.classList.add("cover-image-broken");
  image.hidden = true;
  image.removeAttribute("src");
  const shell = image.closest("[data-cover-shell]");
  shell?.classList.add("cover-fallback-active");
  shell?.classList.remove("cover-loading");
}

function pruneCoverObjectUrls(): void {
  const knownBookIds = new Set<number>();
  const collect = (book: Book | null | undefined) => {
    if (book) knownBookIds.add(book.id);
  };
  allBooksState.forEach(collect);
  booksState.forEach(collect);
  homeState?.recent.forEach(collect);
  collect(homeState?.continue_book);
  collect(activeBook);
  if (activeSheet && "book" in activeSheet) collect(activeSheet.book);

  coverCacheKeyByBookId.forEach((coverKey, bookId) => {
    if (knownBookIds.has(bookId)) return;
    const objectUrl = coverObjectUrlCache.get(coverKey);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    coverObjectUrlCache.delete(coverKey);
    coverCacheKeyByBookId.delete(bookId);
  });
}

function revokeCoverObjectUrlForBook(bookId: number): void {
  const coverKey = coverCacheKeyByBookId.get(bookId);
  if (!coverKey) return;
  const objectUrl = coverObjectUrlCache.get(coverKey);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  coverObjectUrlCache.delete(coverKey);
  coverCacheKeyByBookId.delete(bookId);
}

function revokeAllCoverObjectUrls(): void {
  coverObjectUrlCache.forEach((url) => URL.revokeObjectURL(url));
  coverObjectUrlCache.clear();
  coverCacheKeyByBookId.clear();
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
      hapticSelection();
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
      hapticSelection();
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
  document.querySelectorAll<HTMLElement>("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const sort = button.dataset.sort as LibrarySort;
      librarySort = sort;
      writeLibrarySort();
      hapticSelection();
      void loadBooks(selectedFolderId);
    });
  });
  document.querySelector("#manageFolders")?.addEventListener("click", () => {
    hapticImpact();
    activeSheet = { kind: "folderManage", error: null };
    render();
  });
}

function bindSheetControls() {
  if (!activeSheet) return;
  document.querySelector("#sheetScrim")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeSheet();
    }
  });
  if (activeSheet.kind === "folder") {
    const input = document.querySelector<HTMLInputElement>("#folderNameInput");
    input?.focus();
    input?.addEventListener("input", () => {
      if (!activeSheet || activeSheet.kind !== "folder") return;
      activeSheet = { ...activeSheet, name: input.value, error: null };
      render();
    });
    document.querySelector("#confirmFolder")?.addEventListener("click", () => {
      if (!activeSheet || activeSheet.kind !== "folder") return;
      void submitFolder(activeSheet.name);
    });
    return;
  }
  if (activeSheet.kind === "folderManage") {
    document.querySelector("#folderManageNew")?.addEventListener("click", () => {
      activeSheet = { kind: "folder", name: "", error: null };
      updateActiveSheet();
    });
    document.querySelectorAll<HTMLElement>("[data-folder-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const folder = findFolder(Number(button.dataset.folderEdit));
        if (!folder) return;
        hapticSelection();
        activeSheet = { kind: "folderEdit", folder, name: folder.name, error: null };
        updateActiveSheet();
      });
    });
    document.querySelectorAll<HTMLElement>("[data-folder-up]").forEach((button) => {
      button.addEventListener("click", () => {
        const folder = findFolder(Number(button.dataset.folderUp));
        if (!folder) return;
        void reorderFolder(folder, "up");
      });
    });
    document.querySelectorAll<HTMLElement>("[data-folder-down]").forEach((button) => {
      button.addEventListener("click", () => {
        const folder = findFolder(Number(button.dataset.folderDown));
        if (!folder) return;
        void reorderFolder(folder, "down");
      });
    });
    document.querySelectorAll<HTMLElement>("[data-folder-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        const folder = findFolder(Number(button.dataset.folderRemove));
        if (!folder) return;
        hapticSelection();
        activeSheet = { kind: "folderRemove", folder, error: null };
        updateActiveSheet();
      });
    });
    return;
  }
  if (activeSheet.kind === "folderEdit") {
    const input = document.querySelector<HTMLInputElement>("#folderEditNameInput");
    const saveButton = document.querySelector<HTMLButtonElement>("#confirmFolderEdit");
    input?.focus();
    input?.addEventListener("input", () => {
      if (!activeSheet || activeSheet.kind !== "folderEdit") return;
      activeSheet = { ...activeSheet, name: input.value, error: null };
      if (saveButton) saveButton.disabled = !activeSheet.name.trim();
    });
    document.querySelector("#confirmFolderEdit")?.addEventListener("click", () => {
      if (!activeSheet || activeSheet.kind !== "folderEdit") return;
      void updateFolderName(activeSheet.folder, activeSheet.name);
    });
    return;
  }
  if (activeSheet.kind === "folderRemove") {
    const folder = activeSheet.folder;
    document.querySelector("#cancelFolderRemove")?.addEventListener("click", () => {
      activeSheet = { kind: "folderManage", error: null };
      updateActiveSheet();
    });
    document.querySelector("#confirmFolderRemove")?.addEventListener("click", () => {
      void removeFolder(folder);
    });
    return;
  }
  if (activeSheet.kind === "readerSettings") {
    document.querySelector("#readerFontDown")?.addEventListener("click", () => {
      changeReaderFontSize(-1);
    });
    document.querySelector("#readerFontUp")?.addEventListener("click", () => {
      changeReaderFontSize(1);
    });
    document.querySelector("#readerZoomOut")?.addEventListener("click", () => void changePdfZoom(-1));
    document.querySelector("#readerZoomIn")?.addEventListener("click", () => void changePdfZoom(1));
    document.querySelector("#readerFitWidth")?.addEventListener("click", () => void resetPdfZoom());
    document.querySelector("#readerResetPdfZoom")?.addEventListener("click", () => void resetPdfZoom());
    document.querySelector("#readerResetText")?.addEventListener("click", resetReaderTextSettings);
    document.querySelectorAll<HTMLElement>("[data-reader-line]").forEach((button) => {
      button.addEventListener("click", () => setReaderLineSpacing(button.dataset.readerLine as ReaderLineSpacing));
    });
    document.querySelectorAll<HTMLElement>("[data-reader-margin]").forEach((button) => {
      button.addEventListener("click", () => setReaderMargin(button.dataset.readerMargin as ReaderMargin));
    });
    document.querySelectorAll<HTMLElement>("[data-reader-theme]").forEach((button) => {
      button.addEventListener("click", () => setReaderTheme(button.dataset.readerTheme as ReaderContentTheme));
    });
    updateReaderFontButtons();
    updatePdfZoomButtons(pdfZoom);
    return;
  }
  if (activeSheet.kind === "actions") {
    const book = activeSheet.book;
    document.querySelector("#sheetRead")?.addEventListener("click", () => {
      closeSheet();
      openBookById(book.id, "Read");
    });
    document.querySelector("#sheetMove")?.addEventListener("click", () => {
      hapticSelection();
      activeSheet = { kind: "move", book, targetFolderId: book.folder_id };
      updateActiveSheet();
    });
    document.querySelector("#sheetEdit")?.addEventListener("click", () => {
      hapticSelection();
      activeSheet = { kind: "edit", book, title: book.title, author: book.author ?? "", error: null };
      updateActiveSheet();
    });
    document.querySelector("#sheetMoveUp")?.addEventListener("click", () => startBookReorder(book, "up"));
    document.querySelector("#sheetMoveDown")?.addEventListener("click", () => startBookReorder(book, "down"));
    document.querySelector("#sheetNotes")?.addEventListener("click", () => void showNotesForBook(book));
    document.querySelector("#sheetRemove")?.addEventListener("click", () => {
      hapticSelection();
      activeSheet = { kind: "remove", book, error: null };
      updateActiveSheet();
    });
    return;
  }
  if (activeSheet.kind === "reorderConfirm") {
    const book = activeSheet.book;
    const direction = activeSheet.direction;
    document.querySelector("#cancelReorder")?.addEventListener("click", () => {
      activeSheet = { kind: "actions", book, error: null };
      updateActiveSheet();
    });
    document.querySelector("#confirmReorder")?.addEventListener("click", () => {
      void reorderBook(book, direction);
    });
    return;
  }
  if (activeSheet.kind === "note") {
    const input = document.querySelector<HTMLTextAreaElement>("#noteTextInput");
    input?.focus();
    input?.addEventListener("input", () => {
      if (!activeSheet || activeSheet.kind !== "note") return;
      activeSheet = { ...activeSheet, noteText: input.value, error: null };
    });
    document.querySelector("#confirmNote")?.addEventListener("click", () => {
      if (!activeSheet || activeSheet.kind !== "note") return;
      void createNote(activeSheet.book, activeSheet.locator, activeSheet.percent, activeSheet.noteText);
    });
    return;
  }
  if (activeSheet.kind === "notes") {
    document.querySelectorAll<HTMLElement>("[data-open-note]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!activeSheet || activeSheet.kind !== "notes") return;
        const note = activeSheet.notes.find((item) => item.id === Number(button.dataset.openNote));
        if (!note) return;
        openNote(activeSheet.book, note);
      });
    });
    document.querySelectorAll<HTMLElement>("[data-delete-note]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!activeSheet || activeSheet.kind !== "notes") return;
        const note = activeSheet.notes.find((item) => item.id === Number(button.dataset.deleteNote));
        if (!note) return;
        void deleteNote(note);
      });
    });
    return;
  }
  if (activeSheet.kind === "edit") {
    const titleInput = document.querySelector<HTMLInputElement>("#bookTitleInput");
    const authorInput = document.querySelector<HTMLInputElement>("#bookAuthorInput");
    const saveButton = document.querySelector<HTMLButtonElement>("#confirmBookEdit");
    titleInput?.focus();
    const syncEditSheet = () => {
      if (!activeSheet || activeSheet.kind !== "edit") return;
      activeSheet = {
        ...activeSheet,
        title: titleInput?.value ?? "",
        author: authorInput?.value ?? "",
        error: null,
      };
      if (saveButton) saveButton.disabled = !activeSheet.title.trim();
    };
    titleInput?.addEventListener("input", syncEditSheet);
    authorInput?.addEventListener("input", syncEditSheet);
    document.querySelector("#confirmBookEdit")?.addEventListener("click", () => {
      if (!activeSheet || activeSheet.kind !== "edit") return;
      void updateBookMetadata(activeSheet.book, activeSheet.title, activeSheet.author);
    });
    return;
  }
  if (activeSheet.kind === "remove") {
    const book = activeSheet.book;
    document.querySelector("#cancelRemove")?.addEventListener("click", () => {
      activeSheet = { kind: "actions", book, error: null };
      updateActiveSheet();
    });
    document.querySelector("#confirmRemove")?.addEventListener("click", () => {
      void removeBookFromLibrary(book);
    });
    return;
  }
  document.querySelectorAll<HTMLElement>("[data-sheet-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeSheet || activeSheet.kind !== "move") return;
      const raw = button.dataset.sheetFolder!;
      activeSheet = { ...activeSheet, targetFolderId: raw === "inbox" ? null : Number(raw) };
      hapticSelection();
      updateActiveSheet();
    });
  });
  document.querySelector("#sheetNewFolder")?.addEventListener("click", () => void createFolder());
  document.querySelector("#confirmMove")?.addEventListener("click", () => {
    if (!activeSheet || activeSheet.kind !== "move") return;
    void moveBookToFolder(activeSheet.book, activeSheet.targetFolderId);
  });
}

function startBookReorder(book: Book, direction: "up" | "down") {
  if (librarySort !== "manual") {
    hapticSelection();
    activeSheet = { kind: "reorderConfirm", book, direction, error: null };
    updateActiveSheet();
    return;
  }
  void reorderBook(book, direction);
}

function clearSearch() {
  searchQuery = "";
  booksState = filterBooks(allBooksState);
  render();
}

function presentSheet(sheet: NonNullable<SheetState>) {
  activeSheet = sheet;
  updateActiveSheet();
}

function closeSheet() {
  activeSheet = null;
  if (view === "reader") {
    document.querySelector(".sheet-layer")?.remove();
    pruneCoverObjectUrls();
    return;
  }
  render();
}

function updateActiveSheet() {
  if (view === "reader") {
    document.querySelector(".sheet-layer")?.remove();
    if (activeSheet) {
      appEl.insertAdjacentHTML("beforeend", renderActiveSheet());
      bindSheetControls();
      bindCoverImages();
      pruneCoverObjectUrls();
    }
    return;
  }
  render();
}

function replaceBookInState(updated: Book) {
  const replace = (book: Book) => (book.id === updated.id ? updated : book);
  allBooksState = allBooksState.map(replace);
  booksState = filterBooks(allBooksState);
  if (homeState) {
    homeState = {
      ...homeState,
      continue_book: homeState.continue_book?.id === updated.id ? updated : homeState.continue_book,
      recent: homeState.recent.map(replace),
    };
  }
  if (activeBook?.id === updated.id) activeBook = updated;
}

function findFolder(folderId: number): Folder | null {
  return foldersState.find((folder) => folder.id === folderId) ?? null;
}

function removeBookFromState(bookId: number) {
  revokeCoverObjectUrlForBook(bookId);
  allBooksState = allBooksState.filter((book) => book.id !== bookId);
  booksState = filterBooks(allBooksState);
  if (homeState) {
    homeState = {
      ...homeState,
      continue_book: homeState.continue_book?.id === bookId ? null : homeState.continue_book,
      recent: homeState.recent.filter((book) => book.id !== bookId),
    };
  }
}

function showToast(message: string, kind: ToastKind = "info") {
  toastMessage = message;
  toastKind = kind;
  window.clearTimeout(toastTimer);
  if (view === "reader") syncToastElement();
  toastTimer = window.setTimeout(() => {
    toastMessage = null;
    document.querySelectorAll(".toast").forEach((toast) => toast.remove());
    if (view !== "reader") render();
  }, 2200);
}

function renderToast(): string {
  return toastMessage ? `<div class="toast toast--${toastKind}" role="status" aria-live="polite">${escapeHtml(toastMessage)}</div>` : "";
}

function syncToastElement() {
  const existing = document.querySelector<HTMLElement>(".toast");
  if (!toastMessage) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.className = `toast toast--${toastKind}`;
    existing.textContent = toastMessage;
    return;
  }
  document.body.insertAdjacentHTML("beforeend", renderToast());
}

function hapticImpact() {
  tg?.HapticFeedback?.impactOccurred("light");
}

function hapticSelection() {
  tg?.HapticFeedback?.selectionChanged();
}

function hapticNotification(type: "success" | "error" | "warning") {
  tg?.HapticFeedback?.notificationOccurred(type);
}

function openBookmarkSheet(book: Book) {
  const position = activeTextReader?.getCurrentPosition() ?? activePdfReader?.getCurrentPosition() ?? null;
  if (!position?.locator) {
    hapticNotification("warning");
    showToast("Wait until the reader finishes opening", "error");
    return;
  }
  hapticImpact();
  presentSheet({
    kind: "note",
    book,
    locator: position.locator,
    percent: position.percent,
    noteText: "",
    error: null,
  });
}

function openNote(book: Book, note: Note) {
  activeReaderRestoreLocator = note.locator;
  closeSheet();
  openBookById(book.id, "Read");
}

function openBookById(id: number, sourceText: string) {
  const book = findBook(id);
  if (!book) return;
  cleanupActiveReader(true);
  activeBook = book;
  positionSaveErrorShown = false;
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
  cleanupActiveReader(false);
  readerToolbarVisible = true;
  readerStatusLabel = "Opening...";
  readerStatusPercent = clamp(book.progress_percent, 0, 100);
  activeTextReader = null;
  activePdfReader = null;
  const showHint = shouldShowReaderHint();
  if (showHint) markReaderHintSeen();
  const showAaNudge = shouldShowReaderSettingsNudge();
  if (showAaNudge) markReaderSettingsNudgeShown();
  const isV2 = isReaderUiV2();
  appEl.className = `reader ${isV2 ? "reader-v2" : "reader-v1"}`;
  applyReaderTheme();
  appEl.innerHTML = `
    <div class="reader-toolbar ${isV2 ? "reader-toolbar--v2" : ""}" id="readerToolbar">
      <button class="secondary" id="backButton" type="button" aria-label="Back">${icon("arrowLeft")}<span>Back</span></button>
      <div class="reader-title-wrap">
        <strong>${escapeHtml(shortReaderTitle(book.title))}</strong>
        ${isV2 ? "" : `<span class="reader-progress" id="readerProgress">${escapeHtml(readerStatusLabel)}</span>`}
      </div>
      <button class="secondary reader-aa-button ${showAaNudge ? "reader-aa-nudge" : ""}" id="readerSettingsButton" type="button" aria-label="Reader settings">Aa</button>
      <button class="secondary reader-mark-button" id="readerMark" type="button" aria-label="Save bookmark">${icon("bookmark")}${isV2 ? "<span>Mark</span>" : ""}</button>
    </div>
    <div class="reader-stage" id="readerStage"></div>
    <div class="reader-bottom-progress ${book.format === "pdf" ? "reader-bottom-progress--pdf" : ""} ${isV2 ? "reader-bottom-progress--v2" : ""}" id="readerBottomProgress">
      ${book.format === "pdf" && !isV2 ? `<button class="secondary reader-pdf-zoom-button" id="readerPdfZoomOut" type="button" aria-label="Zoom out">&minus;</button>` : ""}
      <button class="secondary reader-nav-button" id="readerPrev" type="button">${icon("arrowLeft")}<span>${book.format === "pdf" ? "Page" : "Section"}</span></button>
      <div class="reader-progress-panel">
        <div class="reader-progress-copy">
          <span id="readerBottomLabel">${escapeHtml(readerStatusLabel)}</span>
          <b id="readerBottomPercent">${formatPercent(readerStatusPercent)}</b>
        </div>
        <span class="progress-track reader-progress-track" aria-hidden="true">
          <span class="progress-meter ${progressClass(readerStatusPercent)}" id="readerProgressMeter"></span>
        </span>
      </div>
      <button class="secondary reader-nav-button" id="readerNext" type="button"><span>${book.format === "pdf" ? "Page" : "Section"}</span>${icon("arrowRight")}</button>
      ${book.format === "pdf" && !isV2 ? `<button class="secondary reader-pdf-zoom-button" id="readerPdfZoomIn" type="button" aria-label="Zoom in">+</button>` : ""}
    </div>
    ${showHint ? `<button class="reader-hint toast-in" id="readerHint" type="button">${isV2 ? "Tap the page for controls. Use Aa to change reading settings." : "Tap the screen for controls. Use Aa to change text size."}</button>` : ""}
    ${renderToast()}
  `;
  document.querySelector("#backButton")?.addEventListener("click", () => {
    cleanupActiveReader(true);
    void loadHome();
  });
  document.querySelector("#readerSettingsButton")?.addEventListener("click", () => {
    hapticImpact();
    showReaderToolbar();
    document.querySelector("#readerSettingsButton")?.classList.remove("reader-aa-nudge");
    presentSheet({ kind: "readerSettings", book });
  });
  document.querySelector("#readerHint")?.addEventListener("click", dismissReaderHint);
  document.querySelector("#readerStage")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    toggleReaderToolbar();
  });
  document.querySelector("#readerStage")?.addEventListener("scroll", () => {
    const stage = document.querySelector<HTMLElement>("#readerStage");
    if ((stage?.scrollTop ?? 0) <= 24) showReaderToolbar();
  }, { passive: true });
  document.querySelector("#readerMark")?.addEventListener("click", () => openBookmarkSheet(book));
  updateReaderToolbarVisibility();
  updateReaderControls(readerStatusLabel, false, false, readerStatusPercent);

  if (book.too_large) {
    renderDownloadOriginal(document.querySelector<HTMLElement>("#readerStage")!, book);
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
  renderReaderLoading(stage);
  try {
    const pos = await api<{ locator: string } | null>(`/api/books/${book.id}/position`);
    const restoreLocator = activeReaderRestoreLocator ?? pos?.locator ?? null;
    activeReaderRestoreLocator = null;
    const file = await fetchBookFile(API_BASE, initData(), book);
    const openTextReader =
      readerFeatureFlags.textReaderEngine === "foliate-view"
        ? (await import("./readerEngines/foliateViewEngine")).openFoliateViewReader
        : openFoliateReader;
    const controller = await openTextReader(
      stage,
      file,
      restoreLocator,
      (position) => {
        savePositionSafely(book.id, position.locator, position.percent);
      },
      undefined,
      book.format,
      (status) => updateReaderControls(status.label, status.canGoPrevious, status.canGoNext, parseReaderPercent(status.label)),
      {
        fontSizePx: readerFontSizePx,
        theme: readerTheme,
        lineSpacing: readerLineSpacing,
        margin: readerMargin,
        onTap: toggleReaderToolbar,
        onNearTop: showReaderToolbar,
        renderMode: readerFeatureFlags.textRenderMode,
      },
    );
    bindTextReaderControls(controller);
  } catch (error) {
    renderReaderError(stage, book, error);
  }
}

async function renderPdf(book: Book) {
  const stage = document.querySelector<HTMLElement>("#readerStage")!;
  renderReaderLoading(stage);
  try {
    const pos = await api<{ locator: string } | null>(`/api/books/${book.id}/position`);
    const restoreLocator = activeReaderRestoreLocator ?? pos?.locator ?? null;
    activeReaderRestoreLocator = null;
    const file = await fetchBookFile(API_BASE, initData(), book);
    if (readerFeatureFlags.pdfReaderMode === "viewer-shell") {
      console.warn("PDF viewer-shell experiment is not implemented yet; using canvas reader.");
    }
    let pdfReader: PdfReaderController | null = null;
    pdfReader = await openPdfReader(
      stage,
      file,
      restoreLocator,
      (position) => {
        savePositionSafely(book.id, position.locator, position.percent);
      },
      (label) =>
        updateReaderControls(
          formatPdfReaderLabel(label, pdfReader?.getPageNumber() ?? 1, pdfReader?.pageCount ?? 1),
          (pdfReader?.getPageNumber() ?? 1) > 1,
          (pdfReader?.getPageNumber() ?? 1) < (pdfReader?.pageCount ?? 1),
          ((pdfReader?.getPageNumber() ?? 1) / (pdfReader?.pageCount ?? 1)) * 100,
        ),
      {
        zoom: pdfZoom,
        theme: readerTheme,
        onZoom: (zoom) => {
          pdfZoom = zoom;
          window.localStorage.setItem("telegram-library-pdf-zoom", String(pdfZoom));
          updatePdfZoomButtons(pdfZoom);
        },
      },
    );

    bindPdfReaderControls(pdfReader);
  } catch (error) {
    renderReaderError(stage, book, error);
  }
}

function bindTextReaderControls(controller: TextReaderController) {
  activeTextReader = controller;
  activeReaderSave = controller.saveNow;
  activeReaderDestroy = controller.destroy;
  document.querySelector("#readerPrev")?.addEventListener("click", () => void controller.previousSection());
  document.querySelector("#readerNext")?.addEventListener("click", () => void controller.nextSection());
  updateReaderFontButtons();
}

function bindPdfReaderControls(controller: PdfReaderController) {
  activeTextReader = null;
  activePdfReader = controller;
  activeReaderSave = null;
  activeReaderDestroy = controller.destroy;
  controller.setTheme(readerTheme);
  updateReaderControls(
    formatPdfReaderLabel(`${controller.getPageNumber()} / ${controller.pageCount}`, controller.getPageNumber(), controller.pageCount),
    controller.getPageNumber() > 1,
    controller.getPageNumber() < controller.pageCount,
    (controller.getPageNumber() / controller.pageCount) * 100,
  );
  document.querySelector("#readerPrev")?.addEventListener("click", () => void controller.previousPage());
  document.querySelector("#readerNext")?.addEventListener("click", () => void controller.nextPage());
  document.querySelector("#readerPdfZoomOut")?.addEventListener("click", () => void changePdfZoom(-1));
  document.querySelector("#readerPdfZoomIn")?.addEventListener("click", () => void changePdfZoom(1));
  updatePdfZoomButtons(controller.getZoom());
}

function updateReaderControls(label: string, canGoPrevious: boolean, canGoNext: boolean, percent = parseReaderPercent(label)) {
  const progress = document.querySelector<HTMLElement>("#readerProgress");
  const bottomLabel = document.querySelector<HTMLElement>("#readerBottomLabel");
  const bottomPercent = document.querySelector<HTMLElement>("#readerBottomPercent");
  const progressMeter = document.querySelector<HTMLElement>("#readerProgressMeter");
  const previous = document.querySelector<HTMLButtonElement>("#readerPrev");
  const next = document.querySelector<HTMLButtonElement>("#readerNext");
  readerStatusLabel = label;
  readerStatusPercent = clamp(percent, 0, 100);
  if (progress) progress.textContent = label;
  if (bottomLabel) bottomLabel.textContent = label;
  if (bottomPercent) bottomPercent.textContent = formatPercent(readerStatusPercent);
  if (progressMeter) progressMeter.className = `progress-meter ${progressClass(readerStatusPercent)}`;
  if (previous) previous.disabled = !canGoPrevious;
  if (next) next.disabled = !canGoNext;
}

function cleanupActiveReader(save: boolean) {
  if (save) activeReaderSave?.();
  activeReaderDestroy?.();
  activeReaderSave = null;
  activeReaderDestroy = null;
  activeTextReader = null;
  activePdfReader = null;
}

function renderReaderLoading(stage: HTMLElement) {
  stage.innerHTML = `<div class="reader-loading"><div class="skel skel-reader"></div><p>Opening document...</p></div>`;
}

function renderReaderError(stage: HTMLElement, book: Book, error: unknown) {
  if (error instanceof BookFileError && error.status === 413) {
    renderDownloadOriginal(stage, book);
    return;
  }

  const { title, message } = readerErrorCopy(error, book);
  stage.innerHTML = `
    <div class="empty-state empty-state--library reader-error">
      <div class="empty-icon">${icon("alert")}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <button class="ghost-button" type="button" id="readerRetry">Retry</button>
      <button class="ghost-button" type="button" id="readerBackLibrary">Back to Library</button>
    </div>
  `;
  document.querySelector("#readerRetry")?.addEventListener("click", () => {
    if (book.format === "pdf") void renderPdf(book);
    else void renderTextBook(book);
  });
  document.querySelector("#readerBackLibrary")?.addEventListener("click", () => {
    cleanupActiveReader(true);
    activeBook = null;
    void loadBooks(selectedFolderId);
  });
}

function renderDownloadOriginal(stage: HTMLElement, book: Book) {
  stage.innerHTML = `
    <div class="empty-state empty-state--library reader-error">
      <div class="empty-icon">${icon("download")}</div>
      <h2>Download original</h2>
      <p>This file is too large to open in the Mini App. Return to the bot chat and use the original Telegram file message to download it.</p>
      <button class="ghost-button" type="button" id="closeMiniApp">Back to Telegram</button>
    </div>
  `;
  void api<void>("/api/events", {
    method: "POST",
    body: JSON.stringify({ type: "too_large_file_opened", book_id: book.id }),
  }).catch((error) => console.warn("Could not log too-large event", error));
  document.querySelector("#closeMiniApp")?.addEventListener("click", () => {
    tg?.close?.();
  });
}

function readerErrorCopy(error: unknown, book: Book): { title: string; message: string } {
  if (error instanceof ApiError && error.status === 401) {
    return { title: "Session expired", message: "Close and reopen the Mini App from Telegram to refresh access." };
  }
  if ((error instanceof ApiError || error instanceof BookFileError) && error.status === 404) {
    return { title: "File not found", message: "This book is no longer available in your library." };
  }
  if (error instanceof BookFileError && error.status === 422) {
    return { title: "Empty file", message: error.message };
  }
  if (error instanceof TypeError) {
    return { title: "Network problem", message: "Check your connection and try again." };
  }
  if (book.format === "pdf") {
    return { title: "Could not render this PDF", message: "Try again or return to your library." };
  }
  return { title: "Could not open document", message: readableError(error) };
}

async function savePosition(bookId: number, locator: string, percent: number) {
  await api(`/api/books/${bookId}/position`, {
    method: "PUT",
    body: JSON.stringify({ locator, percent }),
  });
}

function savePositionSafely(bookId: number, locator: string, percent: number) {
  void savePosition(bookId, locator, percent).catch((error) => {
    console.warn("Could not save reading position", error);
    if (positionSaveErrorShown) return;
    positionSaveErrorShown = true;
    showToast("Could not save position", "error");
  });
}

function toggleAppTheme() {
  appTheme = appTheme === "night" ? "day" : "night";
  window.localStorage.setItem("telegram-library-theme", appTheme);
  applyAppTheme();
  render();
}

function applyAppTheme() {
  document.documentElement.dataset.theme = appTheme;
}

function readAppTheme(): AppTheme {
  return window.localStorage.getItem("telegram-library-theme") === "day" ? "day" : "night";
}

function readLibrarySort(): LibrarySort {
  const stored = window.localStorage.getItem("telegram-library-sort");
  if (stored === "manual" || stored === "recent_opened" || stored === "recent_added") return stored;
  return "recent_added";
}

function writeLibrarySort() {
  window.localStorage.setItem("telegram-library-sort", librarySort);
}

function setReaderTheme(theme: ReaderContentTheme) {
  if (readerTheme !== theme) hapticSelection();
  readerTheme = theme;
  window.localStorage.setItem("telegram-library-reader-theme", readerTheme);
  applyReaderTheme();
  activeTextReader?.setTheme(readerTheme);
  activePdfReader?.setTheme(readerTheme);
  scheduleReaderSettingsSync();
}

function applyReaderTheme() {
  document.body.classList.toggle("reader-light", readerTheme === "light");
  document.body.classList.toggle("reader-sepia", readerTheme === "sepia");
}

function readReaderTheme(): ReaderContentTheme {
  const stored = window.localStorage.getItem("telegram-library-reader-theme");
  if (stored === "light" || stored === "sepia") return stored;
  return "dark";
}

function toggleReaderToolbar() {
  readerToolbarVisible = !readerToolbarVisible;
  updateReaderToolbarVisibility();
}

function showReaderToolbar() {
  if (readerToolbarVisible) return;
  readerToolbarVisible = true;
  updateReaderToolbarVisibility();
}

function updateReaderToolbarVisibility() {
  document.querySelector<HTMLElement>("#readerToolbar")?.classList.toggle("is-hidden", !readerToolbarVisible);
  document.querySelector<HTMLElement>("#readerBottomProgress")?.classList.toggle("is-hidden", !readerToolbarVisible);
}

function isReaderUiV2(): boolean {
  return readerFeatureFlags.readerUi === "v2";
}

function changeReaderFontSize(delta: number) {
  const nextSize = clamp(readerFontSizePx + delta, 15, 26);
  if (nextSize === readerFontSizePx) return;
  hapticSelection();
  readerFontSizePx = nextSize;
  window.localStorage.setItem("telegram-library-reader-font-size", String(readerFontSizePx));
  activeTextReader?.setFontSize(readerFontSizePx);
  scheduleReaderSettingsSync();
}

function setReaderLineSpacing(lineSpacing: ReaderLineSpacing) {
  if (readerLineSpacing !== lineSpacing) hapticSelection();
  readerLineSpacing = lineSpacing;
  window.localStorage.setItem("telegram-library-reader-line-spacing", readerLineSpacing);
  activeTextReader?.setLineSpacing(readerLineSpacing);
  scheduleReaderSettingsSync();
}

function setReaderMargin(margin: ReaderMargin) {
  if (readerMargin !== margin) hapticSelection();
  readerMargin = margin;
  window.localStorage.setItem("telegram-library-reader-margin", readerMargin);
  activeTextReader?.setMargin(readerMargin);
  scheduleReaderSettingsSync();
}

function resetReaderTextSettings() {
  hapticSelection();
  readerFontSizePx = 18;
  readerLineSpacing = "normal";
  readerMargin = "normal";
  readerTheme = "dark";
  window.localStorage.setItem("telegram-library-reader-font-size", String(readerFontSizePx));
  window.localStorage.setItem("telegram-library-reader-line-spacing", readerLineSpacing);
  window.localStorage.setItem("telegram-library-reader-margin", readerMargin);
  window.localStorage.setItem("telegram-library-reader-theme", readerTheme);
  applyReaderTheme();
  activeTextReader?.setFontSize(readerFontSizePx);
  activeTextReader?.setLineSpacing(readerLineSpacing);
  activeTextReader?.setMargin(readerMargin);
  activeTextReader?.setTheme(readerTheme);
  activePdfReader?.setTheme(readerTheme);
  scheduleReaderSettingsSync();
}

async function changePdfZoom(direction: -1 | 1) {
  const reader = activePdfReader;
  if (!reader) return;
  hapticSelection();
  if (direction < 0) await reader.zoomOut();
  else await reader.zoomIn();
  pdfZoom = reader.getZoom();
  window.localStorage.setItem("telegram-library-pdf-zoom", String(pdfZoom));
  scheduleReaderSettingsSync();
}

async function resetPdfZoom() {
  const reader = activePdfReader;
  if (!reader) return;
  hapticSelection();
  pdfZoom = 1;
  window.localStorage.setItem("telegram-library-pdf-zoom", String(pdfZoom));
  await reader.setZoom(pdfZoom);
  scheduleReaderSettingsSync();
}

function scheduleReaderSettingsSync() {
  window.requestAnimationFrame(() => {
    syncReaderSettingsSheet();
  });
}

function syncReaderSettingsSheet() {
  if (activeSheet?.kind !== "readerSettings") return;
  const fontValue = document.querySelector<HTMLElement>("#readerFontSizeValue");
  if (fontValue) fontValue.textContent = `${readerFontSizePx}px`;
  const zoomValue = document.querySelector<HTMLElement>("#readerPdfZoomValue");
  if (zoomValue) zoomValue.textContent = `${Math.round(pdfZoom * 100)}%`;
  syncPressedButtons("[data-reader-line]", readerLineSpacing);
  syncPressedButtons("[data-reader-margin]", readerMargin);
  syncPressedButtons("[data-reader-theme]", readerTheme);
  updateReaderFontButtons();
  updatePdfZoomButtons(pdfZoom);
}

function syncPressedButtons(selector: string, activeValue: string) {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
    const value = button.dataset.readerLine ?? button.dataset.readerMargin ?? button.dataset.readerTheme;
    const isActive = value === activeValue;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function updateReaderFontButtons() {
  const down = document.querySelector<HTMLButtonElement>("#readerFontDown");
  const up = document.querySelector<HTMLButtonElement>("#readerFontUp");
  if (down) down.disabled = readerFontSizePx <= 15;
  if (up) up.disabled = readerFontSizePx >= 26;
}

function readReaderFontSize(): number {
  return clamp(Number(window.localStorage.getItem("telegram-library-reader-font-size")) || 18, 15, 26);
}

function readReaderLineSpacing(): ReaderLineSpacing {
  const stored = window.localStorage.getItem("telegram-library-reader-line-spacing");
  if (stored === "compact" || stored === "spacious") return stored;
  return "normal";
}

function readReaderMargin(): ReaderMargin {
  const stored = window.localStorage.getItem("telegram-library-reader-margin");
  if (stored === "narrow" || stored === "wide") return stored;
  return "normal";
}

function updatePdfZoomButtons(zoom: number) {
  document.querySelectorAll<HTMLButtonElement>("#readerZoomOut, #readerPdfZoomOut").forEach((button) => {
    button.disabled = zoom <= PDF_MIN_ZOOM;
  });
  document.querySelectorAll<HTMLButtonElement>("#readerZoomIn, #readerPdfZoomIn").forEach((button) => {
    button.disabled = zoom >= PDF_MAX_ZOOM;
  });
}

function readPdfZoom(): number {
  return clamp(Number(window.localStorage.getItem("telegram-library-pdf-zoom")) || 1, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
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

function formatPercent(percent: number): string {
  return `${Math.round(clamp(percent, 0, 100))}%`;
}

function parseReaderPercent(label: string): number {
  const match = label.match(/(\d+(?:\.\d+)?)%/);
  if (!match) return readerStatusPercent;
  return clamp(Number(match[1]), 0, 100);
}

function formatPdfReaderLabel(label: string, page: number, pageCount: number): string {
  const percent = pageCount > 0 ? (page / pageCount) * 100 : 0;
  return isReaderUiV2() ? `Page ${label} · ${formatPercent(percent)}` : `Page ${label}`;
}

function shouldShowReaderHint(): boolean {
  return window.localStorage.getItem("telegram-library-reader-hint-seen") !== "1";
}

function shouldShowReaderSettingsNudge(): boolean {
  return Number(window.localStorage.getItem("telegram-library-reader-aa-nudge-count") ?? "0") < READER_AA_NUDGE_MAX;
}

function markReaderSettingsNudgeShown() {
  const nextCount = Math.min(
    READER_AA_NUDGE_MAX,
    Number(window.localStorage.getItem("telegram-library-reader-aa-nudge-count") ?? "0") + 1,
  );
  window.localStorage.setItem("telegram-library-reader-aa-nudge-count", String(nextCount));
}

function markReaderHintSeen() {
  window.localStorage.setItem("telegram-library-reader-hint-seen", "1");
}

function dismissReaderHint() {
  document.querySelector("#readerHint")?.remove();
}

function shortReaderTitle(title: string): string {
  const clean = title.trim();
  if (clean.length <= 42) return clean || "Reader";
  return `${clean.slice(0, 39).trim()}...`;
}

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "saved";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fallbackTitleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || fileName;
}

function progressDetail(book: Book): string {
  if (book.progress_percent <= 0) return "Not started";
  return "Reading progress";
}

function continueProgressDetail(book: Book): string {
  if (book.too_large) return "Download original";
  if (book.progress_percent <= 0) return "Ready to read";
  return "Saved position";
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
  if (error instanceof ApiError && error.status === 401) return "Telegram session expired. Reopen the Mini App from the bot.";
  if (error instanceof ApiError && error.status === 404) return "This item was not found.";
  if (error instanceof TypeError) return "Network problem. Check your connection and try again.";
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `Request failed with HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    return text;
  }
  return text;
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
    arrowUp: `<svg ${attrs}><path d="M12 19V5"></path><path d="m6 11 6-6 6 6"></path></svg>`,
    arrowDown: `<svg ${attrs}><path d="M12 5v14"></path><path d="m6 13 6 6 6-6"></path></svg>`,
    arrowLeft: `<svg ${attrs}><path d="m15 18-6-6 6-6"></path></svg>`,
    arrowRight: `<svg ${attrs}><path d="m9 18 6-6-6-6"></path></svg>`,
    alert: `<svg ${attrs}><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 4.4 2.8 17.4A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.6L13.7 4.4a2 2 0 0 0-3.4 0z"></path></svg>`,
    download: `<svg ${attrs}><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>`,
    plus: `<svg ${attrs} width="13" height="13"><path d="M12 5v14M5 12h14"></path></svg>`,
    bookmark: `<svg ${attrs}><path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4z"></path></svg>`,
    more: `<svg ${attrs}><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>`,
    edit: `<svg ${attrs}><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path></svg>`,
    trash: `<svg ${attrs}><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path><path d="M10 11v6M14 11v6"></path></svg>`,
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
