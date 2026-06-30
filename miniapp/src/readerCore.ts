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
  setLineSpacing: (lineSpacing: ReaderLineSpacing) => void;
  setMargin: (margin: ReaderMargin) => void;
  setTheme: (theme: ReaderContentTheme) => void;
  saveNow: () => void;
  getCurrentPosition: () => Position;
  destroy: () => void;
  getSectionIndex: () => number;
  getScrollRatio: () => number;
  getSectionCount: () => number;
};

export type TextReaderOptions = {
  fontSizePx?: number;
  theme?: ReaderContentTheme;
  lineSpacing?: ReaderLineSpacing;
  margin?: ReaderMargin;
  renderMode?: TextRenderMode;
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
  setZoom: (zoom: number) => Promise<void>;
  setTheme: (theme: ReaderContentTheme) => void;
  getCurrentPosition: () => Position;
  destroy: () => void;
};

export type PdfReaderOptions = {
  zoom?: number;
  theme?: ReaderContentTheme;
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

export type ReaderContentTheme = "dark" | "light" | "sepia";
export type ReaderLineSpacing = "compact" | "normal" | "spacious";
export type ReaderMargin = "narrow" | "normal" | "wide";
export type TextRenderMode = "clean" | "original";

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

const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 3;
const PDF_ZOOM_STEP = 0.25;
const PDF_MAX_DPR = 1.75;
const PDF_ZOOMED_MAX_DPR = 1.5;
const PDF_CACHE_LIMIT = 3;
const PDF_BLANK_WHITE_RATIO = 0.996;
const PDF_BLANK_RETRY_WHITE_RATIO = 0.999;
const PDF_WARM_DELAY_MS = 140;
const PDF_ZOOM_RENDER_DEBOUNCE_MS = 140;
const EMPTY_SECTION_TITLE = "This section has no readable text";
const EMPTY_SECTION_HINT = "Try next section";
const MIN_READABLE_SECTION_CHARS = 8;
const CLEAN_READER_TAGS = new Set([
  "main",
  "article",
  "section",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "sup",
  "sub",
  "u",
  "s",
  "mark",
  "ruby",
  "rt",
  "rp",
  "figure",
  "figcaption",
  "hr",
  "dl",
  "dt",
  "dd",
]);
const BLOCK_READER_TAGS = new Set([
  "main",
  "article",
  "section",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "table",
  "figure",
  "figcaption",
  "hr",
  "dl",
  "dt",
  "dd",
]);
const INLINE_READER_TAGS = new Set(["a", "strong", "em", "b", "i", "small", "sup", "sub", "u", "s", "mark", "ruby", "rt", "rp", "span", "code", "br"]);
const DROPPED_READER_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "svg",
  "canvas",
]);

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
  let theme: ReaderContentTheme = options.theme ?? "dark";
  let lineSpacing: ReaderLineSpacing = options.lineSpacing ?? "normal";
  let margin: ReaderMargin = options.margin ?? "normal";
  const renderMode: TextRenderMode = options.renderMode ?? "clean";

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
      theme,
      lineSpacing,
      margin,
      renderMode,
    );
    const renderedText = iframe.contentDocument?.body?.innerText?.trim() || `${EMPTY_SECTION_TITLE} ${EMPTY_SECTION_HINT}`;
    const frameMetrics = readerFrameMetrics(iframe);
    warnReaderDiagnostics(
      normalizedFormat ?? (isTxt ? "txt" : "epub"),
      sections.length,
      sectionIndex,
      frameMetrics.textLength || renderedText.length,
      frameMetrics.imageCount,
      frameMetrics.overflowWidth,
    );
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
    setLineSpacing: (nextLineSpacing: ReaderLineSpacing) => {
      lineSpacing = nextLineSpacing;
      applyIframeLineSpacing(iframe, lineSpacing);
    },
    setMargin: (nextMargin: ReaderMargin) => {
      margin = nextMargin;
      applyIframeMargin(iframe, margin);
    },
    setTheme: (nextTheme: ReaderContentTheme) => {
      theme = nextTheme;
      applyIframeTheme(iframe, theme);
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
  const pageShell = document.createElement("div");
  pageShell.className = "pdf-page-shell";
  pageShell.setAttribute("aria-live", "polite");
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  applyPdfCanvasTheme(canvas, options.theme ?? "dark");
  const blankLabel = document.createElement("div");
  blankLabel.className = "pdf-blank-label";
  blankLabel.textContent = "This page appears blank";
  pageShell.append(canvas);
  pageShell.append(blankLabel);
  container.replaceChildren(pageShell);
  type RenderedPdfPage = {
    canvas: HTMLCanvasElement;
    cssWidth: number;
    cssHeight: number;
    dpr: number;
    isBlank: boolean;
    whitePixelRatio: number;
    hasContent: boolean;
    retryAttempted: boolean;
  };
  let pageNumber = parsePdfPage(restoreLocator, pdf.numPages);
  let requestedPage = pageNumber;
  let zoom = clamp(options.zoom ?? 1, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
  let renderPromise: Promise<void> | null = null;
  let requestedRenderId = 0;
  let completedRenderId = -1;
  let destroyed = false;
  const pageCache = new Map<string, RenderedPdfPage>();
  const warmTimers = new Set<number>();
  const warmingKeys = new Set<string>();
  let warmGeneration = 0;
  let zoomTimer = 0;
  let zoomRenderPromise: Promise<void> | null = null;
  let resolveZoomRender: (() => void) | null = null;
  let blankRetryCount = 0;
  let renderCount = 0;
  let evictedCanvasCount = 0;
  let maxCacheSize = 0;

  const syncPdfDebugDataset = () => {
    pageShell.dataset.cacheSize = String(pageCache.size);
    pageShell.dataset.maxCacheSize = String(maxCacheSize);
    pageShell.dataset.evictedCanvasCount = String(evictedCanvasCount);
    pageShell.dataset.retryCount = String(blankRetryCount);
    pageShell.dataset.renderCount = String(renderCount);
    pageShell.dataset.warmInFlight = String(warmingKeys.size);
    pageShell.dataset.warmTimers = String(warmTimers.size);
  };

  const releaseRenderedPdfPage = (rendered: RenderedPdfPage | undefined) => {
    if (!rendered) return;
    releaseCanvas(rendered.canvas);
  };

  const clearPageCache = () => {
    for (const rendered of pageCache.values()) releaseRenderedPdfPage(rendered);
    pageCache.clear();
    syncPdfDebugDataset();
  };

  const cancelWarmRenders = () => {
    warmGeneration += 1;
    for (const timer of warmTimers) window.clearTimeout(timer);
    warmTimers.clear();
    syncPdfDebugDataset();
  };

  const renderPageToCanvas = async (page: number, force = false, trimAroundPage = page): Promise<RenderedPdfPage> => {
    const nextPageNumber = Math.min(Math.max(page, 1), pdf.numPages);
    const pdfPage = await pdf.getPage(nextPageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const containerWidth = await waitForStablePdfContainerWidth(container);
    const fitWidthScale = containerWidth / baseViewport.width;
    const scale = fitWidthScale * zoom;
    const viewport = pdfPage.getViewport({ scale });
    const dpr = pdfRenderDpr(zoom);
    const cssWidth = Math.ceil(viewport.width);
    const cssHeight = Math.ceil(viewport.height);
    const cacheKey = `${nextPageNumber}:${containerWidth}:${zoom.toFixed(2)}:${dpr.toFixed(2)}`;
    const cached = pageCache.get(cacheKey);
    if (cached && !force) return cached;

    let renderCanvas = await renderPdfPageCanvas(pdfPage, viewport, cssWidth, cssHeight, dpr);
    let renderCssWidth = cssWidth;
    let renderCssHeight = cssHeight;
    let blankStats = samplePdfCanvasBlankness(renderCanvas);
    let hasContent = false;
    let retryAttempted = false;
    if (blankStats.isBlank && blankStats.whitePixelRatio >= PDF_BLANK_RETRY_WHITE_RATIO && !force) {
      hasContent = await pdfPageHasDetectableContent(pdfPage);
    }
    if (blankStats.isBlank && blankStats.whitePixelRatio >= PDF_BLANK_RETRY_WHITE_RATIO && hasContent && !force) {
      retryAttempted = true;
      blankRetryCount += 1;
      const safeViewport = pdfPage.getViewport({ scale: fitWidthScale });
      const safeCssWidth = Math.ceil(safeViewport.width);
      const safeCssHeight = Math.ceil(safeViewport.height);
      const retryCanvas = await renderPdfPageCanvas(pdfPage, safeViewport, safeCssWidth, safeCssHeight, dpr);
      const retryBlankStats = samplePdfCanvasBlankness(retryCanvas);
      if (!retryBlankStats.isBlank || retryBlankStats.whitePixelRatio <= blankStats.whitePixelRatio) {
        releaseCanvas(renderCanvas);
        blankStats = retryBlankStats;
        renderCanvas = retryCanvas;
        renderCssWidth = safeCssWidth;
        renderCssHeight = safeCssHeight;
      } else {
        releaseCanvas(retryCanvas);
      }
    }
    if (import.meta.env.DEV) {
      console.warn(
        "[pdf diagnostic]",
        JSON.stringify({
          pageNumber: nextPageNumber,
          canvasWidth: renderCanvas.width,
          canvasHeight: renderCanvas.height,
          dpr,
          whitePixelRatio: blankStats.whitePixelRatio,
          hasContent,
          retryAttempted,
          cacheSize: pageCache.size,
        }),
      );
    }
    const rendered = {
      canvas: renderCanvas,
      cssWidth: renderCssWidth,
      cssHeight: renderCssHeight,
      dpr,
      isBlank: blankStats.isBlank,
      whitePixelRatio: blankStats.whitePixelRatio,
      hasContent,
      retryAttempted,
    };
    releaseRenderedPdfPage(pageCache.get(cacheKey));
    pageCache.set(cacheKey, rendered);
    renderCount += 1;
    trimPageCache(trimAroundPage);
    syncPdfDebugDataset();
    return rendered;
  };

  const trimPageCache = (currentPage: number) => {
    for (const [key, rendered] of pageCache) {
      const cachedPage = Number(key.split(":", 1)[0]);
      if (!Number.isFinite(cachedPage) || Math.abs(cachedPage - currentPage) > 1) {
        releaseRenderedPdfPage(rendered);
        evictedCanvasCount += 1;
        pageCache.delete(key);
      }
    }
    while (pageCache.size > PDF_CACHE_LIMIT) {
      const oldestKey = pageCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      releaseRenderedPdfPage(pageCache.get(oldestKey));
      evictedCanvasCount += 1;
      pageCache.delete(oldestKey);
    }
    maxCacheSize = Math.max(maxCacheSize, pageCache.size);
    syncPdfDebugDataset();
  };

  const warmAdjacentPages = (currentPage: number) => {
    cancelWarmRenders();
    const generation = warmGeneration;
    for (const nearbyPage of [currentPage - 1, currentPage + 1]) {
      if (nearbyPage < 1 || nearbyPage > pdf.numPages) continue;
      const warmKey = `${nearbyPage}:${zoom.toFixed(2)}`;
      if (warmingKeys.has(warmKey)) continue;
      const timer = window.setTimeout(() => {
        warmTimers.delete(timer);
        if (destroyed || generation !== warmGeneration || requestedPage !== currentPage || warmingKeys.has(warmKey)) {
          syncPdfDebugDataset();
          return;
        }
        warmingKeys.add(warmKey);
        syncPdfDebugDataset();
        void renderPageToCanvas(nearbyPage, false, currentPage)
          .catch((error) => {
            console.warn("Could not warm PDF page cache", error);
          })
          .finally(() => {
            warmingKeys.delete(warmKey);
            if (generation !== warmGeneration || requestedPage !== currentPage) trimPageCache(requestedPage);
            syncPdfDebugDataset();
          });
      }, PDF_WARM_DELAY_MS);
      warmTimers.add(timer);
    }
    syncPdfDebugDataset();
  };

  const renderPageNow = async (page: number, renderId: number) => {
    const nextPageNumber = Math.min(Math.max(page, 1), pdf.numPages);
    pageShell.classList.add("is-loading");
    const rendered = await renderPageToCanvas(nextPageNumber);
    if (renderId !== requestedRenderId) return;

    pageNumber = nextPageNumber;
    canvas.width = rendered.canvas.width;
    canvas.height = rendered.canvas.height;
    canvas.style.width = `${rendered.cssWidth}px`;
    canvas.style.height = `${rendered.cssHeight}px`;
    const visibleContext = canvas.getContext("2d")!;
    visibleContext.setTransform(1, 0, 0, 1, 0, 0);
    visibleContext.clearRect(0, 0, canvas.width, canvas.height);
    visibleContext.drawImage(rendered.canvas, 0, 0);
    pageShell.classList.remove("is-loading");
    pageShell.classList.toggle("is-blank", rendered.isBlank);
    pageShell.dataset.blank = rendered.isBlank ? "true" : "false";
    pageShell.dataset.whitePixelRatio = rendered.whitePixelRatio.toFixed(4);
    pageShell.dataset.renderDpr = rendered.dpr.toFixed(2);
    pageShell.dataset.retryAttempted = rendered.retryAttempted ? "true" : "false";
    completedRenderId = renderId;
    trimPageCache(pageNumber);
    warmAdjacentPages(pageNumber);
    onPosition({ locator: String(pageNumber), percent: (pageNumber / pdf.numPages) * 100 });
    onStatus?.(`${pageNumber} / ${pdf.numPages}`);
  };

  const renderLatestRequestedPage = async () => {
    while (!destroyed && completedRenderId !== requestedRenderId) {
      const pageToRender = requestedPage;
      const renderId = requestedRenderId;
      await renderPageNow(pageToRender, renderId);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  };

  const renderPage = async (page: number) => {
    if (destroyed) return;
    cancelWarmRenders();
    requestedPage = Math.min(Math.max(page, 1), pdf.numPages);
    requestedRenderId += 1;
    renderPromise ??= renderLatestRequestedPage().finally(() => {
      renderPromise = null;
    });
    await renderPromise;
  };

  const setZoom = async (nextZoom: number) => {
    const clampedZoom = clamp(nextZoom, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
    if (Math.abs(clampedZoom - zoom) < 0.001) return zoomRenderPromise ?? Promise.resolve();
    zoom = clampedZoom;
    cancelWarmRenders();
    clearPageCache();
    options.onZoom?.(zoom);
    if (!zoomRenderPromise) {
      zoomRenderPromise = new Promise((resolve) => {
        resolveZoomRender = resolve;
      });
    }
    window.clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => {
      zoomTimer = 0;
      const done = resolveZoomRender;
      void renderPage(requestedPage).finally(() => {
        done?.();
        zoomRenderPromise = null;
        resolveZoomRender = null;
      });
    }, PDF_ZOOM_RENDER_DEBOUNCE_MS);
    await zoomRenderPromise;
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
    zoomOut: () => setZoom(zoom - PDF_ZOOM_STEP),
    zoomIn: () => setZoom(zoom + PDF_ZOOM_STEP),
    setZoom,
    setTheme: (theme) => applyPdfCanvasTheme(canvas, theme),
    getCurrentPosition: () => ({
      locator: String(pageNumber),
      percent: (pageNumber / pdf.numPages) * 100,
    }),
    destroy: () => {
      destroyed = true;
      cancelWarmRenders();
      window.clearTimeout(zoomTimer);
      resolveZoomRender?.();
      zoomRenderPromise = null;
      resolveZoomRender = null;
      clearPageCache();
      releaseCanvas(canvas);
      void pdf.cleanup();
    },
  };
}

function applyPdfCanvasTheme(canvas: HTMLCanvasElement, theme: ReaderContentTheme): void {
  canvas.dataset.pdfTheme = theme;
}

function pdfRenderDpr(zoom: number): number {
  const cap = zoom > 1.25 ? PDF_ZOOMED_MAX_DPR : PDF_MAX_DPR;
  return clamp(window.devicePixelRatio || 1, 1, cap);
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

async function waitForStablePdfContainerWidth(container: HTMLElement): Promise<number> {
  let previous = 0;
  let stableFrames = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const width = Math.floor(container.clientWidth || container.getBoundingClientRect().width || 0);
    if (width > 16 && Math.abs(width - previous) <= 1) stableFrames += 1;
    else stableFrames = 0;
    if (width > 16 && stableFrames >= 1) return width;
    previous = width;
  }
  return Math.max(Math.floor(container.clientWidth || container.getBoundingClientRect().width || window.innerWidth), 1);
}

async function renderPdfPageCanvas(
  pdfPage: pdfjs.PDFPageProxy,
  viewport: pdfjs.PageViewport,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): Promise<HTMLCanvasElement> {
  const retryCanvas = document.createElement("canvas");
  retryCanvas.width = Math.ceil(cssWidth * dpr);
  retryCanvas.height = Math.ceil(cssHeight * dpr);
  const retryContext = retryCanvas.getContext("2d")!;
  retryContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  retryContext.clearRect(0, 0, cssWidth, cssHeight);
  await pdfPage.render({ canvas: retryCanvas, canvasContext: retryContext, viewport }).promise;
  return retryCanvas;
}

function samplePdfCanvasBlankness(canvas: HTMLCanvasElement): { isBlank: boolean; whitePixelRatio: number } {
  if (canvas.width <= 0 || canvas.height <= 0) return { isBlank: true, whitePixelRatio: 1 };
  const sample = document.createElement("canvas");
  sample.width = Math.min(96, Math.max(1, canvas.width));
  sample.height = Math.min(128, Math.max(1, canvas.height));
  const context = sample.getContext("2d");
  if (!context) return { isBlank: false, whitePixelRatio: 0 };
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const data = context.getImageData(0, 0, sample.width, sample.height).data;
  let white = 0;
  let total = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 255;
    const green = data[index + 1] ?? 255;
    const blue = data[index + 2] ?? 255;
    const alpha = data[index + 3] ?? 0;
    const isWhite = alpha < 8 || (red >= 248 && green >= 248 && blue >= 248);
    if (isWhite) white += 1;
    total += 1;
  }
  const whitePixelRatio = total <= 0 ? 1 : white / total;
  return { isBlank: whitePixelRatio >= PDF_BLANK_WHITE_RATIO, whitePixelRatio };
}

async function pdfPageHasDetectableContent(pdfPage: {
  getTextContent?: () => Promise<{ items?: unknown[] }>;
  getOperatorList?: () => Promise<{ fnArray?: unknown[] }>;
}): Promise<boolean> {
  const [textContent, operatorList] = await Promise.all([
    pdfPage.getTextContent?.().catch(() => null) ?? Promise.resolve(null),
    pdfPage.getOperatorList?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  return Boolean((textContent?.items?.length ?? 0) > 0 || (operatorList?.fnArray?.length ?? 0) > 0);
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
  theme: ReaderContentTheme,
  lineSpacing: ReaderLineSpacing,
  margin: ReaderMargin,
  renderMode: TextRenderMode,
): Promise<HTMLIFrameElement> {
  const { src, srcdoc } = await makeSafeSectionUrl(section, renderMode);
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
  applyIframeTheme(iframe, theme);
  applyIframeLineSpacing(iframe, lineSpacing);
  applyIframeMargin(iframe, margin);
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
  renderMode: TextRenderMode,
): Promise<{ src: string | null; srcdoc: string | null }> {
  const doc = section.createDocument ? await section.createDocument() : null;
  if (!doc) {
    const source = await section.load();
    const parsed = parseLoadedHtml(source);
    if (parsed) {
      return { src: null, srcdoc: makeReaderHtml(parsed, renderMode) };
    }
    return { src: source, srcdoc: null };
  }
  return { src: null, srcdoc: makeReaderHtml(doc, renderMode) };
}

function parseLoadedHtml(source: string): Document | null {
  if (!source.trim().startsWith("<")) return null;
  return new DOMParser().parseFromString(source, "text/html");
}

function makeReaderHtml(sourceDoc: Document, renderMode: TextRenderMode): string {
  return renderMode === "original" ? makeOriginalReaderHtml(sourceDoc) : makeCleanReaderHtml(sourceDoc);
}

function makeCleanReaderHtml(sourceDoc: Document): string {
  const cleanDoc = document.implementation.createHTMLDocument(sourceDoc.title || "Book section");
  const lang =
    sourceDoc.documentElement.getAttribute("lang") ??
    sourceDoc.documentElement.getAttribute("xml:lang") ??
    sourceDoc.body?.getAttribute("lang") ??
    "ru";
  cleanDoc.documentElement.lang = lang;
  const dir = sourceDoc.documentElement.getAttribute("dir") ?? sourceDoc.body?.getAttribute("dir");
  if (dir === "ltr" || dir === "rtl" || dir === "auto") cleanDoc.documentElement.dir = dir;

  const charset = cleanDoc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  cleanDoc.head.append(charset);
  const viewport = cleanDoc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  cleanDoc.head.append(viewport);
  const stylesheet = cleanDoc.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/reader-content.css";
  stylesheet.dataset.readerContentCss = "true";
  cleanDoc.head.append(stylesheet);

  const article = cleanDoc.createElement("article");
  article.className = "reader-article";
  cleanDoc.body.append(article);
  const sourceRoot = sourceDoc.body ?? sourceDoc.documentElement;
  appendCleanChildren(sourceRoot, article, cleanDoc);
  if (isUnreadableCleanSection(article)) appendEmptySectionFallback(article, cleanDoc);
  return `<!doctype html>${cleanDoc.documentElement.outerHTML}`;
}

function makeOriginalReaderHtml(sourceDoc: Document): string {
  const originalDoc = document.implementation.createHTMLDocument(sourceDoc.title || "Book section");
  const sourceRoot = sourceDoc.documentElement.cloneNode(true) as HTMLElement;
  sanitizeOriginalReaderNode(sourceRoot);
  const sourceHead = sourceRoot.querySelector("head");
  const sourceBody = sourceRoot.querySelector("body");

  originalDoc.documentElement.lang =
    sourceRoot.getAttribute("lang") ?? sourceRoot.getAttribute("xml:lang") ?? sourceBody?.getAttribute("lang") ?? "ru";
  const dir = sourceRoot.getAttribute("dir") ?? sourceBody?.getAttribute("dir");
  if (dir === "ltr" || dir === "rtl" || dir === "auto") originalDoc.documentElement.dir = dir;

  const charset = originalDoc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  originalDoc.head.append(charset);
  const viewport = originalDoc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  originalDoc.head.append(viewport);
  const stylesheet = originalDoc.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/reader-content.css";
  stylesheet.dataset.readerContentCss = "true";
  originalDoc.head.append(stylesheet);
  sourceHead
    ?.querySelectorAll("title, meta[name], meta[property]")
    .forEach((node) => originalDoc.head.append(node.cloneNode(true)));

  const article = originalDoc.createElement("article");
  article.className = "reader-article reader-article--original";
  const children = sourceBody ? sourceBody.childNodes : sourceRoot.childNodes;
  article.append(...Array.from(children).map((node) => node.cloneNode(true)));
  originalDoc.body.append(article);
  if (isUnreadableCleanSection(article)) appendEmptySectionFallback(article, originalDoc);
  return `<!doctype html>${originalDoc.documentElement.outerHTML}`;
}

function sanitizeOriginalReaderNode(root: Element): void {
  root.querySelectorAll(Array.from(DROPPED_READER_TAGS).join(",")).forEach((node) => node.remove());
  root.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on") || name === "style" || name === "srcset") {
        node.removeAttribute(attribute.name);
        return;
      }
      if ((name === "href" || name === "xlink:href") && !isSafeReaderLinkUrl(value)) {
        node.removeAttribute(attribute.name);
      }
      if (name === "src" && !isSafeReaderImageUrl(value)) {
        node.removeAttribute(attribute.name);
      }
    });
  });
}

function isUnreadableCleanSection(article: HTMLElement): boolean {
  if (article.querySelector("img")) return false;
  const readableText = article.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return readableText.length < MIN_READABLE_SECTION_CHARS;
}

function appendEmptySectionFallback(article: HTMLElement, cleanDoc: Document): void {
  article.replaceChildren();
  const empty = cleanDoc.createElement("section");
  empty.className = "reader-empty-section";
  const title = cleanDoc.createElement("h2");
  title.textContent = EMPTY_SECTION_TITLE;
  const hint = cleanDoc.createElement("p");
  hint.textContent = EMPTY_SECTION_HINT;
  empty.append(title, hint);
  article.append(empty);
}

function appendCleanChildren(source: Node, target: Node, cleanDoc: Document): void {
  Array.from(source.childNodes).forEach((child) => appendCleanNode(child, target, cleanDoc));
}

function appendCleanNode(source: Node, target: Node, cleanDoc: Document): void {
  if (source.nodeType === Node.TEXT_NODE) {
    if (source.textContent) target.appendChild(cleanDoc.createTextNode(source.textContent));
    return;
  }
  if (source.nodeType !== Node.ELEMENT_NODE || !(source instanceof Element)) return;

  const tagName = source.tagName.toLowerCase();
  if (DROPPED_READER_TAGS.has(tagName)) return;
  if (!CLEAN_READER_TAGS.has(tagName)) {
    appendUnknownCleanNode(source, target, cleanDoc);
    return;
  }

  if (tagName === "img" && !isSafeReaderImageUrl(source.getAttribute("src"))) return;
  const element = cleanDoc.createElement(tagName);
  copyCleanReaderAttributes(source, element, tagName);
  target.appendChild(element);
  if (tagName !== "img" && tagName !== "br") appendCleanChildren(source, element, cleanDoc);
}

function copyCleanReaderAttributes(source: Element, target: Element, tagName: string): void {
  if (tagName === "a") {
    const href = source.getAttribute("href") ?? source.getAttribute("xlink:href");
    if (isSafeReaderLinkUrl(href)) {
      target.setAttribute("href", href!);
      target.setAttribute("rel", "noopener noreferrer");
      target.setAttribute("target", "_blank");
    }
  }
  if (tagName === "img") {
    const src = source.getAttribute("src") ?? source.getAttribute("href") ?? source.getAttribute("xlink:href");
    if (isSafeReaderImageUrl(src)) target.setAttribute("src", src!);
    for (const attr of ["alt", "title", "width", "height", "loading"]) copyPlainAttribute(source, target, attr);
    return;
  }
  if (tagName === "td" || tagName === "th") {
    for (const attr of ["colspan", "rowspan", "scope"]) copyPlainAttribute(source, target, attr);
  }
  if (tagName === "ol") {
    for (const attr of ["start", "type"]) copyPlainAttribute(source, target, attr);
  }
  if (tagName === "li") copyPlainAttribute(source, target, "value");
  copyPlainAttribute(source, target, "title");
}

function appendUnknownCleanNode(source: Element, target: Node, cleanDoc: Document): void {
  const readableText = source.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (!readableText) {
    appendCleanChildren(source, target, cleanDoc);
    return;
  }
  const hasBlockChild = Array.from(source.children).some((child) => BLOCK_READER_TAGS.has(child.tagName.toLowerCase()));
  if (hasBlockChild) {
    appendCleanChildren(source, target, cleanDoc);
    return;
  }
  const sourceTag = source.tagName.toLowerCase();
  const wrapperTag = targetAllowsBlock(target) && !INLINE_READER_TAGS.has(sourceTag) ? "p" : "span";
  const wrapper = cleanDoc.createElement(wrapperTag);
  appendCleanChildren(source, wrapper, cleanDoc);
  if (wrapper.textContent?.replace(/\s+/g, " ").trim() || wrapper.querySelector("img")) {
    target.appendChild(wrapper);
  }
}

function targetAllowsBlock(target: Node): boolean {
  if (target.nodeType !== Node.ELEMENT_NODE || !(target instanceof Element)) return true;
  return !INLINE_READER_TAGS.has(target.tagName.toLowerCase()) && target.tagName.toLowerCase() !== "p";
}

function copyPlainAttribute(source: Element, target: Element, name: string): void {
  const value = source.getAttribute(name);
  if (value && !/[<>]/.test(value)) target.setAttribute(name, value);
}

function isSafeReaderLinkUrl(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  if (normalized.startsWith("data:")) return false;
  return true;
}

function isSafeReaderImageUrl(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
  if (normalized.startsWith("http:") || normalized.startsWith("https:") || normalized.startsWith("//")) return false;
  return true;
}

function warnReaderDiagnostics(
  format: string,
  sectionCount: number,
  sectionIndex: number,
  textLength: number,
  imageCount: number,
  overflowWidth: number,
): void {
  if (!import.meta.env.DEV) return;
  console.warn("[reader diagnostic]", {
    format,
    sectionCount,
    sectionIndex,
    textLength,
    imageCount,
    overflowWidth,
  });
}

function readerFrameMetrics(iframe: HTMLIFrameElement): { textLength: number; imageCount: number; overflowWidth: number } {
  const doc = iframe.contentDocument;
  if (!doc) return { textLength: 0, imageCount: 0, overflowWidth: 0 };
  const root = doc.scrollingElement ?? doc.documentElement;
  const body = doc.body;
  const scrollWidth = Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
  const clientWidth = Math.max(root?.clientWidth ?? 0, body?.clientWidth ?? 0, iframe.clientWidth);
  return {
    textLength: (body?.innerText ?? "").trim().length,
    imageCount: doc.images.length,
    overflowWidth: Math.max(0, Math.round(scrollWidth - clientWidth)),
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

function applyIframeTheme(iframe: HTMLIFrameElement | null, theme: ReaderContentTheme): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  if (!doc.querySelector('link[data-reader-content-css="true"]')) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "/reader-content.css";
    link.dataset.readerContentCss = "true";
    (doc.head ?? doc.documentElement).prepend(link);
  }
  const root = doc.documentElement;
  root.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-sepia");
  root.classList.add(`reader-theme-${theme}`);
}

function applyIframeLineSpacing(iframe: HTMLIFrameElement | null, lineSpacing: ReaderLineSpacing): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  const root = doc.documentElement;
  root.classList.remove("reader-line-compact", "reader-line-normal", "reader-line-spacious");
  root.classList.add(`reader-line-${lineSpacing}`);
}

function applyIframeMargin(iframe: HTMLIFrameElement | null, margin: ReaderMargin): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  const root = doc.documentElement;
  root.classList.remove("reader-margin-narrow", "reader-margin-normal", "reader-margin-wide");
  root.classList.add(`reader-margin-${margin}`);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
