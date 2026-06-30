import {
  apiHeaders,
  fetchBookFile,
  openFoliateReader,
  openPdfReader,
  parseTextLocator,
  parseTxtLocator,
  type Position,
} from "./readerCore";
import "./styles.css";

type Book = {
  id: number;
  file_name: string;
  title: string;
  format: "epub" | "fb2" | "txt" | "pdf";
};

type HarnessResult = {
  format: Book["format"];
  rendered: boolean;
  positionSaved: boolean;
  positionRestored: boolean;
  cleanDom?: boolean;
  highDpiCanvas?: boolean | null;
  cspViolations: string[];
  locator: string | null;
  error: string | null;
};

declare global {
  interface Window {
    __HARNESS_RESULTS__?: HarnessResult[];
    __HARNESS_DONE__?: boolean;
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const INIT_DATA = import.meta.env.VITE_DEV_INIT_DATA ?? "";
const formats: Array<Book["format"]> = ["epub", "fb2", "txt", "pdf"];
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
      <h2 class="book-title">Harness ${format.toUpperCase()}</h2>
      <p class="book-meta"><span data-status>Running</span></p>
      <div class="reader-stage" data-stage></div>
    </div>
  `;
  root.append(card);
  return card;
}

async function verifyTextFormat(book: Book): Promise<HarnessResult> {
  const card = statusCard(book.format);
  const stage = card.querySelector<HTMLElement>("[data-stage]")!;
  let visibleText = "";
  let saved: Position | null = null;
  let saveDone: Promise<void> = Promise.resolve();
  const file = await fetchBookFile(API_BASE, INIT_DATA, book);
  const reader = await openFoliateReader(
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
  const cleanDom = verifyCleanDom(stage, book.format);
  if (book.format === "txt") {
    scrollReaderFrame(stage, 0.55);
  } else {
    await reader.nextSection();
    scrollReaderFrame(stage, 0.35);
  }
  await waitFor(() => Boolean(visibleText) && Boolean(saved?.locator) && (saved?.percent ?? 0) > 0, 7000);
  await saveDone;
  const persisted = await getPosition(book.id);
  const restoreStage = document.createElement("div");
  restoreStage.className = "reader-stage";
  card.append(restoreStage);
  let restoredText = "";
  const restoredReader = await openFoliateReader(
    restoreStage,
    file,
    persisted?.locator ?? null,
    () => undefined,
    (text) => {
      restoredText = text;
    },
    book.format,
  );
  await waitFor(() => Boolean(restoredText), 7000);
  const textLocator = book.format === "txt" ? null : parseTextLocator(persisted?.locator, 20);
  const txtLocator = book.format === "txt" ? parseTxtLocator(persisted?.locator) : null;
  const expectedSectionRestored = book.format === "txt" || restoredReader.getSectionIndex() === textLocator?.sectionIndex;
  const expectedScrollRestored =
    book.format === "txt"
      ? Math.abs(restoredReader.getScrollRatio() - (txtLocator?.scrollRatio ?? 0)) < 0.15
      : Math.abs(restoredReader.getScrollRatio() - (textLocator?.scrollRatio ?? 0)) < 0.15;

  return {
    format: book.format,
    rendered: (hasCleanHarnessText(visibleText) || hasCleanHarnessText(restoredText)) && cleanDom,
    positionSaved:
      book.format === "txt"
        ? Boolean(txtLocator && txtLocator.scrollRatio > 0 && (persisted?.percent ?? 0) > 0)
        : Boolean(textLocator && textLocator.sectionIndex > 0 && (persisted?.percent ?? 0) > 0),
    positionRestored: Boolean(restoredText && expectedSectionRestored && expectedScrollRestored),
    cleanDom,
    cspViolations: [...cspViolations],
    locator: persisted?.locator ?? null,
    error: null,
  };
}

function hasCleanHarnessText(text: string): boolean {
  return text.includes("Harness") && text.includes("Clean Mode") && text.includes("Привет");
}

function verifyCleanDom(stage: HTMLElement, format: Book["format"]): boolean {
  const doc = stage.querySelector<HTMLIFrameElement>(".book-frame")?.contentDocument;
  if (!doc) return false;
  if (doc.querySelector("script, iframe, object, embed, form, input, button, select, textarea")) return false;
  if (doc.querySelector("[style], [onclick], [onload], [onerror]")) return false;
  if (!doc.querySelector(".reader-article")) return false;
  if (format !== "epub") return true;
  return Boolean(
    doc.querySelector("h1") &&
      doc.querySelector("h2") &&
      doc.querySelector("ul li") &&
      doc.querySelector("blockquote") &&
      doc.querySelector("table th") &&
      doc.querySelector('img[alt="Harness inline image"]'),
  );
}

async function verifyPdf(book: Book): Promise<HarnessResult> {
  const card = statusCard(book.format);
  const stage = card.querySelector<HTMLElement>("[data-stage]")!;
  let saved: Position | null = null;
  let saveDone: Promise<void> = Promise.resolve();
  const file = await fetchBookFile(API_BASE, INIT_DATA, book);
  const reader = await openPdfReader(stage, file, null, (position) => {
    saved = position;
    saveDone = savePosition(book.id, position);
  });
  await reader.nextPage();
  await waitFor(() => saved?.locator === String(Math.min(2, reader.pageCount)), 3000);
  await saveDone;
  const persisted = await getPosition(book.id);
  const restoreStage = document.createElement("div");
  restoreStage.className = "reader-stage";
  card.append(restoreStage);
  const restored = await openPdfReader(restoreStage, file, persisted?.locator ?? null, () => undefined);
  const highDpiCanvas = pdfCanvasUsesHighDpiBackingStore(restored.canvas);

  return {
    format: "pdf",
    rendered: canvasHasInk(restored.canvas) && highDpiCanvas !== false,
    positionSaved: persisted?.locator === String(Math.min(2, reader.pageCount)),
    positionRestored: restored.getPageNumber() === Number(persisted?.locator),
    highDpiCanvas,
    cspViolations: [...cspViolations],
    locator: persisted?.locator ?? null,
    error: null,
  };
}

function scrollReaderFrame(stage: HTMLElement, ratio: number): void {
  const frame = stage.querySelector<HTMLIFrameElement>(".book-frame");
  const scroller = frame?.contentDocument?.scrollingElement;
  if (!frame?.contentWindow || !scroller) return;
  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  scroller.scrollTop = maxScroll * ratio;
  frame.contentWindow.dispatchEvent(new Event("scroll"));
}

function canvasHasInk(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) return false;
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 0; index < data.length; index += 16) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) return true;
  }
  return false;
}

function pdfCanvasUsesHighDpiBackingStore(canvas: HTMLCanvasElement): boolean | null {
  if ((window.devicePixelRatio || 1) <= 1) return null;
  const cssWidth = Number.parseFloat(canvas.style.width);
  const cssHeight = Number.parseFloat(canvas.style.height);
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return false;
  return canvas.width > cssWidth && canvas.height > cssHeight;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for reader");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(): Promise<void> {
  root.className = "app stack";
  root.innerHTML = `<h1 class="title">Reader Harness</h1>`;
  if (!INIT_DATA) throw new Error("VITE_DEV_INIT_DATA is required");
  verifyInvalidLocatorsStartAtBeginning();
  const books = await api<Book[]>("/api/books");
  const results: HarnessResult[] = [];

  for (const format of formats) {
    cspViolations.length = 0;
    const book = books.find((item) => item.format === format && item.title === `Harness ${format.toUpperCase()}`);
    if (!book) {
      results.push({
        format,
        rendered: false,
        positionSaved: false,
        positionRestored: false,
        cspViolations: [...cspViolations],
        locator: null,
        error: "Book not seeded",
      });
      continue;
    }

    try {
      results.push(format === "pdf" ? await verifyPdf(book) : await verifyTextFormat(book));
    } catch (error) {
      results.push({
        format,
        rendered: false,
        positionSaved: false,
        positionRestored: false,
        cspViolations: [...cspViolations],
        locator: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  window.__HARNESS_RESULTS__ = results;
  window.__HARNESS_DONE__ = true;
  root.insertAdjacentHTML(
    "beforeend",
    `<pre id="results">${escapeHtml(JSON.stringify(results, null, 2))}</pre>`,
  );
}

function verifyInvalidLocatorsStartAtBeginning(): void {
  for (const value of ["", "not-json", "epubcfi(/2/1:12)"]) {
    const text = parseTextLocator(value, 3);
    const txt = parseTxtLocator(value);
    if (text.sectionIndex !== 0 || text.scrollRatio !== 0) {
      throw new Error(`Invalid text locator did not start at beginning: ${value}`);
    }
    if (txt.scrollRatio !== 0) {
      throw new Error(`Invalid txt locator did not start at beginning: ${value}`);
    }
  }
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
  window.__HARNESS_RESULTS__ = formats.map((format) => ({
    format,
    rendered: false,
    positionSaved: false,
    positionRestored: false,
    cspViolations: [...cspViolations],
    locator: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  window.__HARNESS_DONE__ = true;
  root.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
});
