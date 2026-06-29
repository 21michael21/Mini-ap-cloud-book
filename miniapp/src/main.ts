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

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const tg = window.Telegram?.WebApp;

let view: View = "home";
let homeState: Home | null = null;
let booksState: Book[] = [];
let foldersState: Folder[] = [];
let selectedFolderId: number | null | "inbox" | "all" = "all";
let activeBook: Book | null = null;
let readerTheme: "light" | "dark" = tg?.colorScheme === "dark" ? "dark" : "light";

function init() {
  tg?.ready?.();
  tg?.expand?.();
  document.body.classList.toggle("dark", readerTheme === "dark");
  void loadHome();
}

function headers(): HeadersInit {
  return apiHeaders(initData());
}

function initData(): string {
  return tg?.initData || import.meta.env.VITE_DEV_INIT_DATA || "";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function loadHome() {
  homeState = await api<Home>("/api/home");
  foldersState = homeState.folders;
  view = "home";
  render();
}

async function loadBooks() {
  let path = "/api/books";
  if (selectedFolderId === "inbox") path += "?inbox=true";
  if (typeof selectedFolderId === "number") path += `?folder_id=${selectedFolderId}`;
  booksState = await api<Book[]>(path);
  view = "library";
  render();
}

async function searchBooks(query: string) {
  booksState = await api<Book[]>(`/api/books?q=${encodeURIComponent(query)}`);
  view = "library";
  render();
}

async function createFolder() {
  const name = window.prompt("Folder name");
  if (!name?.trim()) return;
  await api<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadHome();
}

async function renameSelectedFolder() {
  if (typeof selectedFolderId !== "number") return;
  const folder = foldersState.find((item) => item.id === selectedFolderId);
  const name = window.prompt("Folder name", folder?.name ?? "");
  if (!name?.trim()) return;
  await api<Folder>(`/api/folders/${selectedFolderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.trim() }),
  });
  homeState = await api<Home>("/api/home");
  foldersState = homeState.folders;
  await loadBooks();
}

async function deleteSelectedFolder() {
  if (typeof selectedFolderId !== "number") return;
  const folder = foldersState.find((item) => item.id === selectedFolderId);
  if (!window.confirm(`Delete folder "${folder?.name ?? "Folder"}"? Books move back to Inbox.`)) return;
  await api<void>(`/api/folders/${selectedFolderId}`, { method: "DELETE" });
  selectedFolderId = "inbox";
  homeState = await api<Home>("/api/home");
  foldersState = homeState.folders;
  await loadBooks();
}

async function moveBook(book: Book) {
  const options = ["Inbox", ...foldersState.map((folder) => folder.name)];
  const target = window.prompt(`Move to: ${options.join(", ")}`, "Inbox");
  if (target === null) return;
  const folder = foldersState.find((item) => item.name.toLowerCase() === target.trim().toLowerCase());
  await api<Book>(`/api/books/${book.id}/move`, {
    method: "PATCH",
    body: JSON.stringify({ folder_id: folder?.id ?? null }),
  });
  await loadBooks();
}

function render() {
  if (view === "reader" && activeBook) {
    renderReader(activeBook);
    return;
  }

  appEl.className = "app";
  appEl.innerHTML = `
    <div class="topbar">
      <div>
        <h1 class="title">Telegram Library</h1>
        <div class="muted">Personal books and documents</div>
      </div>
      <button class="icon-button" id="themeButton" title="Toggle theme">◐</button>
    </div>
    ${view === "home" ? renderHome() : renderLibrary()}
    <nav class="nav">
      <button id="homeNav" class="${view === "home" ? "active" : ""}">Home</button>
      <button id="libraryNav" class="${view === "library" ? "active" : ""}">Library</button>
      <button id="folderNav">New folder</button>
    </nav>
  `;

  document.querySelector("#themeButton")?.addEventListener("click", toggleTheme);
  document.querySelector("#homeNav")?.addEventListener("click", () => void loadHome());
  document.querySelector("#libraryNav")?.addEventListener("click", () => {
    selectedFolderId = "all";
    void loadBooks();
  });
  document.querySelector("#folderNav")?.addEventListener("click", () => void createFolder());
  bindBookButtons();
  bindLibraryControls();
}

function renderHome(): string {
  const state = homeState;
  if (!state) return `<div class="empty">Loading library</div>`;
  return `
    <section>
      <div class="section-title">Continue</div>
      ${
        state.continue_book
          ? `<div class="continue-card">
              ${bookSummary(state.continue_book)}
              <button class="primary" data-open="${state.continue_book.id}">Continue reading</button>
            </div>`
          : `<div class="empty">Send a file to the bot to start your library.</div>`
      }
    </section>
    <section>
      <div class="section-title">Recent</div>
      <div class="stack">${state.recent.map(renderBookCard).join("") || `<div class="empty">No books yet</div>`}</div>
    </section>
    <section>
      <div class="section-title">Folders</div>
      <div class="folder-row">
        <button class="folder-card" data-folder="inbox">Inbox</button>
        <button class="folder-card" data-folder="all">All books</button>
        ${state.folders.map((folder) => `<button class="folder-card" data-folder="${folder.id}">${escapeHtml(folder.name)}</button>`).join("")}
      </div>
    </section>
  `;
}

function renderLibrary(): string {
  const selectedFolder = foldersState.find((folder) => folder.id === selectedFolderId);
  return `
    <div class="tabs">
      <button class="tab ${selectedFolderId === "inbox" ? "active" : ""}" data-folder="inbox">Inbox</button>
      <button class="tab ${selectedFolderId === "all" ? "active" : ""}" data-folder="all">All</button>
      <button class="tab" id="refreshFolders">Folders</button>
    </div>
    <div class="folder-row">
      ${foldersState.map((folder) => `<button class="folder-card" data-folder="${folder.id}">${escapeHtml(folder.name)}</button>`).join("")}
    </div>
    ${
      selectedFolder
        ? `<div class="topbar">
            <div class="muted">${escapeHtml(selectedFolder.name)}</div>
            <div>
              <button class="secondary" id="renameFolder">Rename</button>
              <button class="secondary" id="deleteFolder">Delete</button>
            </div>
          </div>`
        : ""
    }
    <input class="search" id="searchInput" placeholder="Search title or author" />
    <div class="stack">${booksState.map(renderBookCard).join("") || `<div class="empty">Nothing here yet</div>`}</div>
  `;
}

function renderBookCard(book: Book): string {
  return `
    <article class="book-card">
      <div class="cover">${escapeHtml(book.format)}</div>
      <div>
        ${bookSummary(book)}
        <button class="secondary" data-open="${book.id}">${book.too_large ? "Details" : "Read"}</button>
        <button class="secondary" data-move="${book.id}">Move</button>
      </div>
    </article>
  `;
}

function bookSummary(book: Book): string {
  return `
    <h2 class="book-title">${escapeHtml(book.title)}</h2>
    <p class="book-meta">
      <span>${escapeHtml(book.author ?? "Unknown author")}</span>
      <span>${escapeHtml(book.format.toUpperCase())}</span>
      <span>${Math.round(book.progress_percent)}%</span>
    </p>
    <progress class="progress" max="100" value="${book.progress_percent}" aria-label="Reading progress"></progress>
  `;
}

function bindBookButtons() {
  document.querySelectorAll<HTMLElement>("[data-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.open);
      const book = [...(homeState?.recent ?? []), ...(homeState?.continue_book ? [homeState.continue_book] : []), ...booksState].find(
        (item) => item.id === id,
      );
      if (!book) return;
      activeBook = book;
      if (button.textContent?.includes("Continue")) {
        void api<void>("/api/events", {
          method: "POST",
          body: JSON.stringify({ type: "continue_clicked", book_id: book.id }),
        });
      }
      view = "reader";
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const book = booksState.find((item) => item.id === Number(button.dataset.move));
      if (book) void moveBook(book);
    });
  });
}

function bindLibraryControls() {
  document.querySelectorAll<HTMLElement>("[data-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.folder!;
      selectedFolderId = raw === "inbox" || raw === "all" ? raw : Number(raw);
      void loadBooks();
    });
  });
  document.querySelector("#searchInput")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) void searchBooks(value);
  });
  document.querySelector("#refreshFolders")?.addEventListener("click", () => {
    if (foldersState[0]) {
      selectedFolderId = foldersState[0].id;
      void loadBooks();
      return;
    }
    void createFolder();
  });
  document.querySelector("#renameFolder")?.addEventListener("click", () => void renameSelectedFolder());
  document.querySelector("#deleteFolder")?.addEventListener("click", () => void deleteSelectedFolder());
}

function renderReader(book: Book) {
  appEl.className = "reader";
  appEl.innerHTML = `
    <div class="reader-toolbar">
      <button class="secondary" id="backButton">Back</button>
      <button class="secondary" id="themeButton">Theme</button>
    </div>
    <div class="reader-stage" id="readerStage"></div>
  `;
  document.querySelector("#backButton")?.addEventListener("click", () => void loadHome());
  document.querySelector("#themeButton")?.addEventListener("click", toggleTheme);

  if (book.too_large) {
    document.querySelector("#readerStage")!.innerHTML =
      `<div class="empty">This file is over 20 MB. In the MVP it stays in your library but cannot open in-app.</div>`;
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
  document.body.classList.toggle("dark", readerTheme === "dark");
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
