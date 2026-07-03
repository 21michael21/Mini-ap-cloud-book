import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { mark, measure, timeAsync } from "../perf";
import {
  type PdfReaderController,
  type PdfReaderOptions,
  type Position,
  type ReaderContentTheme,
  clamp,
  parsePdfPage,
} from "./shared";

type PdfJsModule = typeof import("pdfjs-dist");
let pdfJsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 3;
const PDF_ZOOM_STEP = 0.25;
const PDF_MAX_DPR = 1.75;
const PDF_ZOOMED_MAX_DPR = 1.5;
const PDF_CACHE_LIMIT = 3;
const PDF_BLANK_WHITE_RATIO = 0.996;
const PDF_BLANK_RETRY_WHITE_RATIO = 0.999;
const PDF_RENDER_DETECTION_BUDGET_MS = 2500;
const PDF_OPERATOR_LIST_MIN_BUDGET_MS = 250;
const PDF_WARM_DELAY_MS = 140;
const PDF_ZOOM_RENDER_DEBOUNCE_MS = 140;
const PDF_NAV_SETTLE_FRAME_COUNT = 1;

export async function openPdfReader(
  container: HTMLElement,
  file: File,
  restoreLocator: string | null,
  onPosition: (position: Position) => void,
  onStatus?: (label: string) => void,
  options: PdfReaderOptions = {},
): Promise<PdfReaderController> {
  mark("pdf_import_start");
  const pdfjs = await loadPdfJs();
  mark("pdf_import_end");
  measure("pdf_import", "pdf_import_start", "pdf_import_end");
  mark("pdf_parse_start");
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  mark("pdf_parse_end");
  measure("pdf_parse", "pdf_parse_start", "pdf_parse_end");
  const pageShell = document.createElement("div");
  pageShell.className = "pdf-page-shell";
  pageShell.setAttribute("aria-live", "polite");
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  applyPdfCanvasTheme(canvas, options.theme ?? "dark");
  const blankLabel = document.createElement("div");
  blankLabel.className = "pdf-blank-label";
  blankLabel.textContent = "This page appears blank";
  const loadingOverlay = document.createElement("div");
  loadingOverlay.className = "pdf-render-overlay";
  loadingOverlay.setAttribute("aria-hidden", "true");
  loadingOverlay.innerHTML = '<span class="pdf-render-spinner"></span><span>Rendering page...</span>';
  pageShell.append(canvas);
  pageShell.append(loadingOverlay);
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
    renderMs: number;
    contentCheckMs: number;
    operatorListChecks: number;
    contentCheckTimedOut: boolean;
    contentCheckSkipped: boolean;
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

    const renderToken = `${nextPageNumber}:${performance.now().toFixed(3)}`;
    const perfStart = `pdf_page_render_start:${renderToken}`;
    const perfEnd = `pdf_page_render_end:${renderToken}`;
    mark("pdf_page_render_start");
    mark(perfStart);
    const renderStartedAt = performance.now();
    let renderCanvas = await renderPdfPageCanvas(pdfPage, viewport, cssWidth, cssHeight, dpr);
    let renderCssWidth = cssWidth;
    let renderCssHeight = cssHeight;
    let blankStats = samplePdfCanvasBlankness(renderCanvas);
    let hasContent = false;
    let retryAttempted = false;
    let contentCheckMs = 0;
    let operatorListChecks = 0;
    let contentCheckTimedOut = false;
    let contentCheckSkipped = false;
    if (blankStats.isBlank && blankStats.whitePixelRatio >= PDF_BLANK_RETRY_WHITE_RATIO && !force) {
      const remainingBudgetMs = PDF_RENDER_DETECTION_BUDGET_MS - (performance.now() - renderStartedAt);
      if (remainingBudgetMs > 0) {
        const contentCheck = await pdfPageHasDetectableContent(pdfPage, remainingBudgetMs);
        hasContent = contentCheck.hasContent;
        contentCheckMs = contentCheck.elapsedMs;
        operatorListChecks = contentCheck.usedOperatorList ? 1 : 0;
        contentCheckTimedOut = contentCheck.timedOut;
        contentCheckSkipped = contentCheck.skipped;
      } else {
        contentCheckSkipped = true;
      }
    }
    if (
      blankStats.isBlank
      && blankStats.whitePixelRatio >= PDF_BLANK_RETRY_WHITE_RATIO
      && hasContent
      && !force
      && performance.now() - renderStartedAt < PDF_RENDER_DETECTION_BUDGET_MS
    ) {
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
    const renderMs = performance.now() - renderStartedAt;
    mark(`pdf_blank_ratio:${nextPageNumber}:${blankStats.whitePixelRatio.toFixed(4)}`);
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
          renderMs: Number(renderMs.toFixed(1)),
          contentCheckMs: Number(contentCheckMs.toFixed(1)),
          operatorListChecks,
          contentCheckTimedOut,
          contentCheckSkipped,
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
      renderMs,
      contentCheckMs,
      operatorListChecks,
      contentCheckTimedOut,
      contentCheckSkipped,
    };
    releaseRenderedPdfPage(pageCache.get(cacheKey));
    pageCache.set(cacheKey, rendered);
    renderCount += 1;
    trimPageCache(trimAroundPage);
    syncPdfDebugDataset();
    mark("pdf_page_render_end");
    mark(perfEnd);
    measure("pdf_page_render", perfStart, perfEnd);
    measure("pdf_page_render_ms", perfStart, perfEnd);
    measure(`pdf_page_render:${nextPageNumber}`, perfStart, perfEnd);
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
    pageShell.dataset.loadingPage = String(nextPageNumber);
    await waitForAnimationFrames(PDF_NAV_SETTLE_FRAME_COUNT);
    if (renderId !== requestedRenderId || destroyed) return;
    const rendered = await renderPageToCanvas(nextPageNumber);
    if (renderId !== requestedRenderId || destroyed) return;

    const paintToken = `${nextPageNumber}:${performance.now().toFixed(3)}`;
    const paintStart = `pdf_page_paint_start:${paintToken}`;
    const paintEnd = `pdf_page_paint_end:${paintToken}`;
    mark("pdf_page_paint_start");
    mark(paintStart);
    pageNumber = nextPageNumber;
    canvas.width = rendered.canvas.width;
    canvas.height = rendered.canvas.height;
    canvas.style.width = `${rendered.cssWidth}px`;
    canvas.style.height = `${rendered.cssHeight}px`;
    const visibleContext = canvas.getContext("2d")!;
    visibleContext.setTransform(1, 0, 0, 1, 0, 0);
    visibleContext.clearRect(0, 0, canvas.width, canvas.height);
    visibleContext.drawImage(rendered.canvas, 0, 0);
    mark("pdf_canvas_paint");
    await waitForAnimationFrames(1);
    mark("pdf_page_paint_end");
    mark(paintEnd);
    measure("pdf_page_paint_ms", paintStart, paintEnd);
    pageShell.classList.remove("is-loading");
    delete pageShell.dataset.loadingPage;
    pageShell.classList.toggle("is-blank", rendered.isBlank);
    pageShell.dataset.blank = rendered.isBlank ? "true" : "false";
    pageShell.dataset.whitePixelRatio = rendered.whitePixelRatio.toFixed(4);
    pageShell.dataset.renderDpr = rendered.dpr.toFixed(2);
    pageShell.dataset.retryAttempted = rendered.retryAttempted ? "true" : "false";
    pageShell.dataset.renderMs = rendered.renderMs.toFixed(1);
    pageShell.dataset.contentCheckMs = rendered.contentCheckMs.toFixed(1);
    pageShell.dataset.operatorListChecks = String(rendered.operatorListChecks);
    pageShell.dataset.contentCheckTimedOut = rendered.contentCheckTimedOut ? "true" : "false";
    pageShell.dataset.contentCheckSkipped = rendered.contentCheckSkipped ? "true" : "false";
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
    previousPage: () => timeAsync("pdf_next_prev_render", () => renderPage(requestedPage - 1)),
    nextPage: () => timeAsync("pdf_next_prev_render", () => renderPage(requestedPage + 1)),
    zoomOut: () => timeAsync("pdf_zoom_render", () => timeAsync("pdf_zoom_render_ms", () => setZoom(zoom - PDF_ZOOM_STEP))),
    zoomIn: () => timeAsync("pdf_zoom_render", () => timeAsync("pdf_zoom_render_ms", () => setZoom(zoom + PDF_ZOOM_STEP))),
    setZoom: (nextZoom: number) => timeAsync("pdf_zoom_render", () => timeAsync("pdf_zoom_render_ms", () => setZoom(nextZoom))),
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

async function waitForAnimationFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
}

async function renderPdfPageCanvas(
  pdfPage: PDFPageProxy,
  viewport: PageViewport,
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

type PdfContentCheckResult = {
  hasContent: boolean;
  usedOperatorList: boolean;
  timedOut: boolean;
  skipped: boolean;
  elapsedMs: number;
};

const timeoutResult = Symbol("timeout");

async function withTimeout<T>(promise: Promise<T | null>, timeoutMs: number): Promise<T | null | typeof timeoutResult> {
  if (timeoutMs <= 0) return timeoutResult;
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof timeoutResult>((resolve) => {
        timer = window.setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

async function pdfPageHasDetectableContent(pdfPage: {
  getTextContent?: () => Promise<{ items?: unknown[] }>;
  getOperatorList?: () => Promise<{ fnArray?: unknown[] }>;
}, budgetMs: number): Promise<PdfContentCheckResult> {
  const startedAt = performance.now();
  const done = (result: Omit<PdfContentCheckResult, "elapsedMs">): PdfContentCheckResult => ({
    ...result,
    elapsedMs: performance.now() - startedAt,
  });

  if (budgetMs <= 0) {
    return done({ hasContent: false, usedOperatorList: false, timedOut: false, skipped: true });
  }

  const textContent = await withTimeout(
    pdfPage.getTextContent?.().catch(() => null) ?? Promise.resolve(null),
    budgetMs,
  );
  if (textContent === timeoutResult) {
    return done({ hasContent: false, usedOperatorList: false, timedOut: true, skipped: false });
  }
  if ((textContent?.items?.length ?? 0) > 0) {
    return done({ hasContent: true, usedOperatorList: false, timedOut: false, skipped: false });
  }

  const remainingBudgetMs = budgetMs - (performance.now() - startedAt);
  if (!pdfPage.getOperatorList || remainingBudgetMs < PDF_OPERATOR_LIST_MIN_BUDGET_MS) {
    return done({ hasContent: false, usedOperatorList: false, timedOut: remainingBudgetMs <= 0, skipped: remainingBudgetMs > 0 });
  }

  const operatorList = await withTimeout(
    pdfPage.getOperatorList().catch(() => null),
    remainingBudgetMs,
  );
  if (operatorList === timeoutResult) {
    return done({ hasContent: false, usedOperatorList: true, timedOut: true, skipped: false });
  }
  return done({
    hasContent: (operatorList?.fnArray?.length ?? 0) > 0,
    usedOperatorList: true,
    timedOut: false,
    skipped: false,
  });
}
