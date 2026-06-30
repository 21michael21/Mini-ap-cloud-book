import { apiHeaders, fetchBookFile, type Position } from "./readerCore";
import { openFoliateViewReader } from "./readerEngines/foliateViewEngine";
import "./styles.css";

type Book = {
  id: number;
  file_name: string;
  title: string;
  format: "epub" | "fb2" | "txt";
};

type FoliateViewHarnessResult = {
  format: Book["format"];
  visibleText: boolean;
  nextPrevious: boolean;
  progressFromRelocate: boolean;
  positionRestored: boolean;
  cspViolations: string[];
  locator: string | null;
  error: string | null;
};

declare global {
  interface Window {
    __FOLIATE_VIEW_HARNESS_RESULTS__?: FoliateViewHarnessResult[];
    __HARNESS_DONE__?: boolean;
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const INIT_DATA = import.meta.env.VITE_DEV_INIT_DATA ?? "";
const formats: Array<Book["format"]> = ["epub", "fb2", "txt"];
const cspViolations: string[] = [];
const root = document.querySelector<HTMLElement>("#harness")!;

window.addEventListener("securitypolicyviolation", (event) => {
  cspViolations.push(
    [
      event.violatedDirective,
      event.blockedURI,
      event.sourceFile,
      event.lineNumber,
      event.sample,
    ].join(":"),
  );
});

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...apiHeaders(INIT_DATA), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function savePosition(bookId: number, position: Position): Promise<void> {
  await api(`/api/books/${bookId}/position`, {
    method: "PUT",
    body: JSON.stringify(position),
  });
}

async function getPosition(bookId: number): Promise<Position | null> {
  return api<Position | null>(`/api/books/${bookId}/position`);
}

function statusCard(format: string): HTMLElement {
  const card = document.createElement("section");
  card.className = "book-card";
  card.innerHTML = `
    <div class="cover">${format}</div>
    <div>
      <h2 class="book-title">Foliate-view ${format.toUpperCase()}</h2>
      <p class="book-meta"><span data-status>Running</span></p>
      <div class="reader-stage" data-stage></div>
    </div>
  `;
  root.append(card);
  return card;
}

async function verifyFormat(book: Book): Promise<FoliateViewHarnessResult> {
  const card = statusCard(book.format);
  const stage = card.querySelector<HTMLElement>("[data-stage]")!;
  let visibleText = "";
  let saved: Position | null = null;
  let saveDone: Promise<void> = Promise.resolve();
  const file = await fetchBookFile(API_BASE, INIT_DATA, book);
  const reader = await openFoliateViewReader(
    stage,
    file,
    null,
    (position) => {
      saved = position;
      saveDone = savePosition(book.id, position);
    },
    (text) => {
      visibleText = text;
    },
    book.format,
  );

  await waitFor(() => visibleText.trim().length > 0, 7000);
  const firstPosition = reader.getCurrentPosition();
  await reader.nextSection();
  await waitFor(() => Boolean(saved?.locator), 7000);
  const afterNext = reader.getCurrentPosition();
  await reader.previousSection();
  await saveDone;
  const persisted = await getPosition(book.id);
  const restoreStage = document.createElement("div");
  restoreStage.className = "reader-stage";
  card.append(restoreStage);
  let restoredText = "";
  const restoredReader = await openFoliateViewReader(
    restoreStage,
    file,
    persisted?.locator ?? null,
    () => undefined,
    (text) => {
      restoredText = text;
    },
    book.format,
  );
  await waitFor(() => restoredText.trim().length > 0, 7000);
  const restoredPosition = restoredReader.getCurrentPosition();
  const savedPosition = saved as Position | null;
  reader.destroy();
  restoredReader.destroy();

  return {
    format: book.format,
    visibleText: visibleText.trim().length > 0 && restoredText.trim().length > 0,
    nextPrevious: afterNext.locator !== firstPosition.locator || afterNext.percent !== firstPosition.percent,
    progressFromRelocate: Boolean(savedPosition?.locator && (savedPosition.percent > 0 || afterNext.percent > 0)),
    positionRestored: Boolean(persisted?.locator && restoredPosition.locator),
    cspViolations: [...cspViolations],
    locator: persisted?.locator ?? null,
    error: null,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for foliate-view reader");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(): Promise<void> {
  root.className = "app stack";
  root.innerHTML = `<h1 class="title">Foliate View Reader Harness</h1>`;
  if (!INIT_DATA) throw new Error("VITE_DEV_INIT_DATA is required");
  const books = await api<Book[]>("/api/books");
  const results: FoliateViewHarnessResult[] = [];

  for (const format of formats) {
    cspViolations.length = 0;
    const book = books.find((item) => item.format === format && item.title === `Harness ${format.toUpperCase()}`);
    if (!book) {
      results.push({
        format,
        visibleText: false,
        nextPrevious: false,
        progressFromRelocate: false,
        positionRestored: false,
        cspViolations: [...cspViolations],
        locator: null,
        error: "Book not seeded",
      });
      continue;
    }

    try {
      results.push(await verifyFormat(book));
    } catch (error) {
      results.push({
        format,
        visibleText: false,
        nextPrevious: false,
        progressFromRelocate: false,
        positionRestored: false,
        cspViolations: [...cspViolations],
        locator: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  window.__FOLIATE_VIEW_HARNESS_RESULTS__ = results;
  window.__HARNESS_DONE__ = true;
  root.insertAdjacentHTML("beforeend", `<pre id="results">${escapeHtml(JSON.stringify(results, null, 2))}</pre>`);
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

void run().catch((error) => {
  window.__FOLIATE_VIEW_HARNESS_RESULTS__ = formats.map((format) => ({
    format,
    visibleText: false,
    nextPrevious: false,
    progressFromRelocate: false,
    positionRestored: false,
    cspViolations: [...cspViolations],
    locator: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  window.__HARNESS_DONE__ = true;
  root.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
});
