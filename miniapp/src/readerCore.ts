import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

export type Position = {
  locator: string;
  percent: number;
};

export type TextLocator = {
  type: "text";
  sectionIndex: number;
  scrollRatio: number;
};

export type TxtLocator = {
  type: "txt";
  scrollRatio: number;
};

export type PdfLocator = {
  type: "pdf";
  page: number;
};

export type TextReaderStatus = {
  canGoPrevious: boolean;
  canGoNext: boolean;
  label: string;
};

export type TextReaderController = {
  previousSection: () => Promise<void>;
  nextSection: () => Promise<void>;
  setFontSize: (fontSizePx: number) => void;
  saveNow: () => void;
  getCurrentPosition: () => Position;
  destroy: () => void;
  getSectionIndex: () => number;
  getScrollRatio: () => number;
  getSectionCount: () => number;
};

export type TextReaderOptions = {
  fontSizePx?: number;
  onTap?: () => void;
  onNearTop?: () => void;
};

export type PdfReaderController = {
  getPageNumber: () => number;
  getZoom: () => number;
  pageCount: number;
  canvas: HTMLCanvasElement;
  renderPage: (page: number) => Promise<void>;
  previousPage: () => Promise<void>;
  nextPage: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomIn: () => Promise<void>;
  getCurrentPosition: () => Position;
};

export type PdfReaderOptions = {
  zoom?: number;
  onZoom?: (zoom: number) => void;
};

export class BookFileError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BookFileError";
  }
}

type PlainTextBook = {
  metadata: { title: string; language: string };
  dir: "ltr";
  sections: Array<{
    id: string;
    size: number;
    cfi: string;
    load: () => string;
    unload: () => void;
    createDocument: () => Document;
  }>;
  splitTOCHref: (href: string) => [string, string];
  getTOCFragment: (doc: Document) => Node;
};

type FoliateBook = PlainTextBook & {
  sections: Array<{
    id?: string;
    cfi?: string;
    load: () => string | Promise<string>;
    unload?: () => void;
    createDocument?: () => Document | Promise<Document>;
  }>;
};

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function apiHeaders(initData: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

export async function fetchBookFile(
  apiBase: string,
  initData: string,
  book: { id: number; file_name: string },
): Promise<File> {
  const response = await fetch(`${apiBase}/api/books/${book.id}/file`, {
    headers: apiHeaders(initData),
  });
  if (!response.ok) throw new BookFileError(response.status, await responseMessage(response));
  const blob = await response.blob();
  if (blob.size === 0) throw new BookFileError(422, "This file is empty and cannot be opened.");
  return new File([blob], book.file_name, { type: blob.type });
}

export async function openFoliateReader(
  container: HTMLElement,
  file: File,
  restoreLocator: string | null,
  onPosition: (position: Position) => void,
  onVisibleText?: (text: string) => void,
  format?: string,
  onStatus?: (status: TextReaderStatus) => void,
  options: TextReaderOptions = {},
): Promise<TextReaderController> {
  const normalizedFormat = format?.toLowerCase();
  const isTxt = normalizedFormat === "txt" || file.name.toLowerCase().endsWith(".txt");
  const book = isTxt ? await makePlainTextBook(file) : await makeFoliateBook(file, normalizedFormat);
  const sections = book.sections.filter((section) => section.load);
  if (!sections.length) throw new Error("Book has no renderable sections");

  const restoredText = isTxt ? null : parseTextLocator(restoreLocator, sections.length);
  const restoredTxt = isTxt ? parseTxtLocator(restoreLocator) : null;
  let sectionIndex = restoredText?.sectionIndex ?? 0;
  let scrollRatio = restoredTxt?.scrollRatio ?? restoredText?.scrollRatio ?? 0;
  let iframe: HTMLIFrameElement | null = null;
  let scrollTimer = 0;
  let destroyed = false;
  let isSwitchingSection = false;
  let fontSizePx = options.fontSizePx ?? 18;

  const currentPosition = (): Position => {
    const currentRatio = getIframeScrollRatio(iframe);
    scrollRatio = currentRatio;
    const percent = isTxt
      ? clamp(currentRatio * 100, 0, 100)
      : clamp(((sectionIndex + currentRatio) / sections.length) * 100, 0, 100);
    const locator = isTxt
      ? JSON.stringify({ type: "txt", scrollRatio: currentRatio } satisfies TxtLocator)
      : JSON.stringify({ type: "text", sectionIndex, scrollRatio: currentRatio } satisfies TextLocator);
    return { locator, percent };
  };

  const save = () => {
    if (destroyed) return;
    const position = currentPosition();
    onPosition(position);
    emitStatus();
  };

  const debouncedSave = () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(save, 250);
    if (getIframeScrollTop(iframe) <= 24) options.onNearTop?.();
  };

  const emitStatus = () => {
    const currentRatio = getIframeScrollRatio(iframe);
    const percent = isTxt
      ? clamp(currentRatio * 100, 0, 100)
      : clamp(((sectionIndex + currentRatio) / sections.length) * 100, 0, 100);
    onStatus?.({
      canGoPrevious: !isTxt && sectionIndex > 0,
      canGoNext: !isTxt && sectionIndex < sections.length - 1,
      label: isTxt ? `${Math.round(percent)}%` : `Section ${sectionIndex + 1}/${sections.length} · ${Math.round(percent)}%`,
    });
  };

  const renderSection = async (nextIndex: number, nextScrollRatio: number, shouldSave: boolean) => {
    window.clearTimeout(scrollTimer);
    sectionIndex = clamp(Math.round(nextIndex), 0, sections.length - 1);
    scrollRatio = clamp(nextScrollRatio, 0, 1);
    iframe = await renderSectionIframe(
      container,
      file.name,
      sections[sectionIndex],
      scrollRatio,
      debouncedSave,
      () => options.onTap?.(),
      fontSizePx,
    );
    const renderedText = iframe.contentDocument?.body?.innerText?.trim();
    if (!renderedText) throw new Error("This document opened, but no readable text was found.");
    onVisibleText?.(renderedText);
    emitStatus();
    if (shouldSave) save();
  };

  await renderSection(sectionIndex, scrollRatio, false);

  const beforeUnload = () => save();
  window.addEventListener("beforeunload", beforeUnload);

  return {
    previousSection: async () => {
      if (isSwitchingSection || sectionIndex <= 0) return;
      isSwitchingSection = true;
      try {
        await renderSection(sectionIndex - 1, 0, true);
      } finally {
        isSwitchingSection = false;
      }
    },
    nextSection: async () => {
      if (isSwitchingSection || sectionIndex >= sections.length - 1) return;
      isSwitchingSection = true;
      try {
        await renderSection(sectionIndex + 1, 0, true);
      } finally {
        isSwitchingSection = false;
      }
    },
    setFontSize: (nextFontSizePx: number) => {
      fontSizePx = clamp(nextFontSizePx, 15, 26);
      applyIframeFontSize(iframe, fontSizePx);
    },
    saveNow: save,
    getCurrentPosition: currentPosition,
    destroy: () => {
      destroyed = true;
      window.clearTimeout(scrollTimer);
      window.removeEventListener("beforeunload", beforeUnload);
    },
    getSectionIndex: () => sectionIndex,
    getScrollRatio: () => getIframeScrollRatio(iframe),
    getSectionCount: () => sections.length,
  };
}

export async function openPdfReader(
  container: HTMLElement,
  file: File,
  restoreLocator: string | null,
  onPosition: (position: Position) => void,
  onStatus?: (label: string) => void,
  options: PdfReaderOptions = {},
): Promise<PdfReaderController> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  container.replaceChildren(canvas);
  let pageNumber = parsePdfPage(restoreLocator, pdf.numPages);
  let requestedPage = pageNumber;
  let zoom = clamp(options.zoom ?? 1, 0.7, 2.2);
  let renderPromise: Promise<void> | null = null;
  let requestedRenderId = 0;
  let completedRenderId = -1;

  const renderPageNow = async (page: number, renderId: number) => {
    pageNumber = Math.min(Math.max(page, 1), pdf.numPages);
    const pdfPage = await pdf.getPage(pageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const fitWidthScale = (container.clientWidth || window.innerWidth) / baseViewport.width;
    const scale = Math.min(fitWidthScale * zoom, 2.4);
    const viewport = pdfPage.getViewport({ scale });
    const context = canvas.getContext("2d")!;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const cssWidth = Math.ceil(viewport.width);
    const cssHeight = Math.ceil(viewport.height);
    canvas.width = Math.ceil(cssWidth * dpr);
    canvas.height = Math.ceil(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
    completedRenderId = renderId;
    onPosition({ locator: String(pageNumber), percent: (pageNumber / pdf.numPages) * 100 });
    onStatus?.(`${pageNumber} / ${pdf.numPages}`);
  };

  const renderLatestRequestedPage = async () => {
    while (completedRenderId !== requestedRenderId) {
      const pageToRender = requestedPage;
      const renderId = requestedRenderId;
      await renderPageNow(pageToRender, renderId);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  };

  const renderPage = async (page: number) => {
    requestedPage = Math.min(Math.max(page, 1), pdf.numPages);
    requestedRenderId += 1;
    renderPromise ??= renderLatestRequestedPage().finally(() => {
      renderPromise = null;
    });
    await renderPromise;
  };

  const setZoom = async (nextZoom: number) => {
    zoom = clamp(nextZoom, 0.7, 2.2);
    options.onZoom?.(zoom);
    await renderPage(requestedPage);
  };

  await renderPage(pageNumber);
  return {
    getPageNumber: () => pageNumber,
    getZoom: () => zoom,
    pageCount: pdf.numPages,
    canvas,
    renderPage,
    previousPage: () => renderPage(requestedPage - 1),
    nextPage: () => renderPage(requestedPage + 1),
    zoomOut: () => setZoom(zoom - 0.15),
    zoomIn: () => setZoom(zoom + 0.15),
    getCurrentPosition: () => ({
      locator: String(pageNumber),
      percent: (pageNumber / pdf.numPages) * 100,
    }),
  };
}

async function makePlainTextBook(file: File): Promise<PlainTextBook> {
  const text = await file.text();
  const escaped = escapeHtml(text);
  const html = `<!doctype html><html><head><title>${escapeHtml(file.name)}</title></head><body><pre>${escaped}</pre></body></html>`;
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  return {
    metadata: { title: file.name, language: "en" },
    dir: "ltr",
    splitTOCHref: (href: string) => [href, ""],
    getTOCFragment: (document: Document) => document.body,
    sections: [
      {
        id: "text",
        size: text.length,
        cfi: "epubcfi(/2/1)",
        load: () => blobUrl,
        unload: () => URL.revokeObjectURL(blobUrl),
        createDocument: () => doc,
      },
    ],
  };
}

async function makeFoliateBook(file: File, format?: string): Promise<FoliateBook> {
  if (format === "fb2" || file.name.toLowerCase().endsWith(".fb2")) {
    const module = (await import("foliate-js/fb2.js")) as { makeFB2: (file: File) => Promise<FoliateBook> };
    return module.makeFB2(file);
  }
  const module = (await import("foliate-js/epub.js")) as {
    EPUB: new (loader: ZipLoader) => { init: () => Promise<FoliateBook> };
  };
  return new module.EPUB(await makeZipLoader(file)).init();
}

type ZipLoader = {
  entries: Array<{ filename: string }>;
  loadText: (filename: string) => Promise<string | null>;
  loadBlob: (filename: string, type?: string) => Promise<Blob | null>;
  getSize: (filename: string) => number;
};

async function makeZipLoader(file: File): Promise<ZipLoader> {
  const zipModule = (await import("foliate-js/vendor/zip.js")) as {
    configure: (options: { useWebWorkers: boolean }) => void;
    ZipReader: new (reader: unknown) => { getEntries: () => Promise<ZipEntry[]> };
    BlobReader: new (blob: Blob) => unknown;
    TextWriter: new () => unknown;
    BlobWriter: new (type?: string) => unknown;
  };
  zipModule.configure({ useWebWorkers: false });
  const reader = new zipModule.ZipReader(new zipModule.BlobReader(file));
  const entries = await reader.getEntries();
  const map = new Map(entries.map((entry) => [entry.filename, entry]));
  return {
    entries,
    loadText: (filename: string) =>
      map.has(filename) ? map.get(filename)!.getData(new zipModule.TextWriter()) : Promise.resolve(null),
    loadBlob: (filename: string, type?: string) =>
      map.has(filename) ? map.get(filename)!.getData(new zipModule.BlobWriter(type)) : Promise.resolve(null),
    getSize: (filename: string) => map.get(filename)?.uncompressedSize ?? 0,
  };
}

type RenderableSection = FoliateBook["sections"][number];

type ZipEntry = {
  filename: string;
  uncompressedSize: number;
  getData: <T>(writer: unknown) => Promise<T>;
};

export function parseTextLocator(locator: string | null | undefined, sectionCount: number): TextLocator {
  const fallback: TextLocator = { type: "text", sectionIndex: 0, scrollRatio: 0 };
  if (!locator || locator.startsWith("epubcfi(")) return fallback;
  try {
    const parsed = JSON.parse(locator) as Partial<TextLocator>;
    if (parsed.type !== "text") return fallback;
    return {
      type: "text",
      sectionIndex: clampNumber(parsed.sectionIndex, 0, Math.max(sectionCount - 1, 0), 0),
      scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0),
    };
  } catch {
    return fallback;
  }
}

export function parseTxtLocator(locator: string | null | undefined): TxtLocator {
  const fallback: TxtLocator = { type: "txt", scrollRatio: 0 };
  if (!locator || locator.startsWith("epubcfi(")) return fallback;
  try {
    const parsed = JSON.parse(locator) as Partial<TxtLocator>;
    if (parsed.type !== "txt") return fallback;
    return {
      type: "txt",
      scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0),
    };
  } catch {
    return fallback;
  }
}

export function parsePdfPage(locator: string | null | undefined, pageCount: number): number {
  if (!locator) return 1;
  try {
    const parsed = JSON.parse(locator) as Partial<PdfLocator>;
    if (parsed.type === "pdf") {
      return clampNumber(parsed.page, 1, pageCount, 1);
    }
  } catch {
    // Legacy PDF locators are plain page strings.
  }
  return clampNumber(Number(locator), 1, pageCount, 1);
}

export function textPositionPercent(sectionIndex: number, scrollRatio: number, sectionCount: number): number {
  return clamp(((clamp(sectionIndex, 0, Math.max(sectionCount - 1, 0)) + clamp(scrollRatio, 0, 1)) / sectionCount) * 100, 0, 100);
}

export function txtPositionPercent(scrollRatio: number): number {
  return clamp(scrollRatio, 0, 1) * 100;
}

async function renderSectionIframe(
  container: HTMLElement,
  title: string,
  section: RenderableSection,
  restoreScrollRatio: number,
  onScroll: () => void,
  onTap: () => void,
  fontSizePx: number,
): Promise<HTMLIFrameElement> {
  const { src, srcdoc } = await makeSafeSectionUrl(section);
  const iframe = document.createElement("iframe");
  iframe.className = "book-frame";
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("title", title);
  container.replaceChildren(iframe);
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out loading book iframe")), 7000);
    iframe.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    if (srcdoc) {
      iframe.srcdoc = srcdoc;
    } else if (src) {
      iframe.src = src;
    } else {
      window.clearTimeout(timeout);
      reject(new Error("Book section has no renderable source"));
    }
  });
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  applyIframeFontSize(iframe, fontSizePx);
  setIframeScrollRatio(iframe, restoreScrollRatio);
  iframe.contentWindow?.addEventListener("scroll", onScroll, { passive: true });
  iframe.contentDocument?.addEventListener("pointerup", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea")) return;
    onTap();
  });
  return iframe;
}

async function makeSafeSectionUrl(
  section: FoliateBook["sections"][number],
): Promise<{ src: string | null; srcdoc: string | null; text: string }> {
  const doc = section.createDocument ? await section.createDocument() : null;
  if (!doc) {
    return { src: await section.load(), srcdoc: null, text: "" };
  }
  const safeDoc = doc.cloneNode(true) as Document;
  safeDoc.querySelectorAll("script, style").forEach((node) => node.remove());
  safeDoc.querySelectorAll("[style]").forEach((node) => node.removeAttribute("style"));
  const text = safeDoc.body?.innerText?.trim() ?? "";
  const html = new XMLSerializer().serializeToString(safeDoc);
  return {
    src: null,
    srcdoc: html,
    text,
  };
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

function getIframeScroller(iframe: HTMLIFrameElement | null): Element | null {
  const doc = iframe?.contentDocument;
  return doc?.scrollingElement ?? doc?.documentElement ?? doc?.body ?? null;
}

function getIframeScrollRatio(iframe: HTMLIFrameElement | null): number {
  const scroller = getIframeScroller(iframe);
  if (!scroller) return 0;
  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  if (maxScroll <= 0) return 0;
  return clamp(scroller.scrollTop / maxScroll, 0, 1);
}

function getIframeScrollTop(iframe: HTMLIFrameElement | null): number {
  return getIframeScroller(iframe)?.scrollTop ?? 0;
}

function setIframeScrollRatio(iframe: HTMLIFrameElement, ratio: number): void {
  const scroller = getIframeScroller(iframe);
  if (!scroller) return;
  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  scroller.scrollTop = clamp(ratio, 0, 1) * maxScroll;
}

function applyIframeFontSize(iframe: HTMLIFrameElement | null, fontSizePx: number): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  if (!doc.querySelector('link[data-reader-content-css="true"]')) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "/reader-content.css";
    link.dataset.readerContentCss = "true";
    (doc.head ?? doc.documentElement).prepend(link);
  }
  const size = Math.round(clamp(fontSizePx, 15, 26));
  const root = doc.documentElement;
  Array.from(root.classList)
    .filter((className) => className.startsWith("reader-font-"))
    .forEach((className) => root.classList.remove(className));
  root.classList.add(`reader-font-${size}`);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
