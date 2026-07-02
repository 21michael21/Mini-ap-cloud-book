import "foliate-js/view.js";
import type {
  Position,
  ReaderContentTheme,
  ReaderFontFamily,
  ReaderLineSpacing,
  ReaderMargin,
  TextReaderController,
  TextReaderOptions,
  TextReaderStatus,
} from "../readers/shared";

type FoliateProgressSection = {
  current?: number;
  total?: number;
};

type FoliateLocation = {
  fraction?: number;
  section?: FoliateProgressSection;
  cfi?: string;
  range?: Range;
};

type FoliateRenderer = {
  page?: number;
  pages?: number;
  getContents?: () => Array<{ index: number; doc: Document }>;
  render?: () => void;
};

type FoliateViewElement = HTMLElement & {
  book?: FoliateBook;
  lastLocation?: FoliateLocation;
  renderer?: FoliateRenderer;
  open: (book: File | FoliateBook) => Promise<void>;
  init: (options: { lastLocation?: FoliateTarget; showTextStart?: boolean }) => Promise<void>;
  prev: (distance?: number) => Promise<void>;
  next: (distance?: number) => Promise<void>;
  goLeft?: () => Promise<void>;
  goRight?: () => Promise<void>;
  close: () => void;
};

type FoliateTarget = string | number | { fraction: number };

type FoliateViewLocator = {
  type: "foliate-view";
  target: FoliateTarget | null;
  percent: number;
  sectionIndex: number;
  scrollRatio: number;
  page: number | null;
  pageCount: number | null;
};

type RestoreLocator =
  | {
      type: "foliate-view";
      target: FoliateTarget | null;
      percent: number;
      sectionIndex: number | null;
      scrollRatio: number | null;
      page: number | null;
      pageCount: number | null;
    }
  | { type: "text"; sectionIndex: number; scrollRatio: number }
  | { type: "txt"; scrollRatio: number }
  | null;

type FoliateBook = {
  metadata: { title: string; language: string };
  dir: "ltr";
  toc: [];
  sections: Array<{
    id: string;
    size: number;
    cfi: string;
    load: () => string;
    unload: () => void;
    createDocument: () => Document;
  }>;
  splitTOCHref: (href: string) => [string, string];
  getTOCFragment: (doc: Document, fragment?: string) => Node | null;
  resolveHref: (href: string) => { index: number; anchor?: number };
};

type PlainTextBook = FoliateBook & {
  destroy: () => void;
};

const MIN_FONT_SIZE = 15;
const MAX_FONT_SIZE = 26;

export async function openFoliateViewReader(
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
  const view = document.createElement("foliate-view") as FoliateViewElement;
  view.className = "foliate-view-reader";
  view.setAttribute("flow", "paginated");
  view.setAttribute("animated", "");
  view.setAttribute("margin", "0");
  view.setAttribute("max-inline-size", "760px");
  view.setAttribute("max-column-count", "1");

  let destroyed = false;
  let navigating = false;
  let saveTimer = 0;
  let fontSizePx = clamp(options.fontSizePx ?? 18, MIN_FONT_SIZE, MAX_FONT_SIZE);
  let fontFamily: ReaderFontFamily = options.fontFamily ?? "literata";
  let theme: ReaderContentTheme = options.theme ?? "dark";
  let lineSpacing: ReaderLineSpacing = options.lineSpacing ?? "normal";
  let margin: ReaderMargin = options.margin ?? "normal";
  let latestLocation: FoliateLocation | null = null;
  let latestPosition: Position = { locator: makeFoliateLocator(null, 0, 0, 0, null, null), percent: 0 };
  const loadedDocs = new Set<Document>();
  const pointerStarts = new WeakMap<Document, { x: number; y: number; time: number }>();
  let hostPointerStart: { x: number; y: number; time: number } | null = null;
  const plainTextBook = isTxt ? await makePlainTextBook(file) : null;
  const restored = parseRestoreLocator(restoreLocator);

  const applyToLoadedDocs = () => {
    for (const doc of loadedDocs) applyReaderDocumentClasses(doc, fontSizePx, fontFamily, theme, lineSpacing, margin);
    requestPaginatorRender();
    syncDiagnostics();
  };

  const emitStatus = () => {
    const percent = latestPosition.percent;
    const section = latestLocation?.section;
    const current = typeof section?.current === "number" ? section.current : 0;
    const total = typeof section?.total === "number" && section.total > 0 ? section.total : getSectionCount();
    const pageInfo = getPageInfo();
    const pageLabel = pageInfo ? `Page ${pageInfo.page}/${pageInfo.pageCount}` : "Page 1/1";
    const percentLabel = `${Math.round(percent)}%`;
    onStatus?.({
      canGoPrevious: percent > 0.1 || current > 0 || (pageInfo?.page ?? 1) > 1,
      canGoNext: true,
      label: isTxt ? `${pageLabel} · ${percentLabel}` : `${pageLabel} · Section ${current + 1}/${total} · ${percentLabel}`,
    });
    syncDiagnostics();
  };

  const handleLoad = (event: Event) => {
    const detail = (event as CustomEvent<{ doc?: Document; index?: number }>).detail;
    const doc = detail?.doc;
    if (!doc) return;
    loadedDocs.add(doc);
    applyReaderDocumentClasses(doc, fontSizePx, fontFamily, theme, lineSpacing, margin);
    doc.querySelector('link[data-reader-content-css="true"]')?.addEventListener("load", syncDiagnostics, { once: true });
    doc.querySelector('link[data-reader-content-css="true"]')?.addEventListener("error", syncDiagnostics, { once: true });
    doc.addEventListener("pointerdown", handleDocumentPointerDown);
    doc.addEventListener("pointerup", handleDocumentPointerUp);
    onVisibleText?.(visibleText());
    syncDiagnostics();
    void doc.fonts?.ready?.then(syncDiagnostics).catch(() => undefined);
  };

  const handleRelocate = (event: Event) => {
    latestLocation = (event as CustomEvent<FoliateLocation>).detail ?? null;
    latestPosition = positionFromLocation(latestLocation);
    debouncedSave();
    emitStatus();
  };

  const beforeUnload = () => {
    if (!destroyed) onPosition(getCurrentPosition());
  };

  view.addEventListener("load", handleLoad);
  view.addEventListener("relocate", handleRelocate);
  view.addEventListener("pointerdown", handleHostPointerDown);
  view.addEventListener("pointerup", handleHostPointerUp);
  container.replaceChildren(view);

  try {
    await view.open(plainTextBook ?? file);
    const restoreTarget = resolveRestoreTarget(restored, getSectionCount(), isTxt);
    await view.init({
      lastLocation: restoreTarget ?? undefined,
      showTextStart: !restoreTarget,
    });
  } catch (error) {
    plainTextBook?.destroy();
    view.removeEventListener("load", handleLoad);
    view.removeEventListener("relocate", handleRelocate);
    view.removeEventListener("pointerdown", handleHostPointerDown);
    view.removeEventListener("pointerup", handleHostPointerUp);
    view.remove();
    throw error;
  }

  window.addEventListener("beforeunload", beforeUnload);
  applyToLoadedDocs();
  latestLocation = view.lastLocation ?? latestLocation;
  latestPosition = positionFromLocation(latestLocation);
  emitStatus();

  async function navigate(direction: "previous" | "next"): Promise<void> {
    if (destroyed || navigating) return;
    navigating = true;
    try {
      if (direction === "previous") await (view.goLeft?.() ?? view.prev());
      else await (view.goRight?.() ?? view.next());
      saveNow();
      emitStatus();
    } finally {
      navigating = false;
    }
  }

  function getSectionCount(): number {
    const total = latestLocation?.section?.total;
    if (typeof total === "number" && total > 0) return Math.max(total, getBookSectionCount());
    return getBookSectionCount();
  }

  function getBookSectionCount(): number {
    return Math.max(view.book?.sections?.length ?? plainTextBook?.sections.length ?? 1, 1);
  }

  function getSectionIndex(): number {
    return clampNumber(latestLocation?.section?.current, 0, getSectionCount() - 1, 0);
  }

  function getScrollRatio(): number {
    return clampNumber(readLocatorField("scrollRatio"), 0, 1, latestPosition.percent / 100);
  }

  function getCurrentPosition(): Position {
    if (latestLocation) latestPosition = positionFromLocation(latestLocation);
    return latestPosition;
  }

  function saveNow(): void {
    window.clearTimeout(saveTimer);
    onPosition(getCurrentPosition());
  }

  function debouncedSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 180);
  }

  function positionFromLocation(location: FoliateLocation | null): Position {
    const rawFraction = location?.fraction;
    const fraction =
      typeof rawFraction === "number" && Number.isFinite(rawFraction)
        ? rawFraction
        : restored?.type === "foliate-view"
          ? restored.percent / 100
          : 0;
    const percent = clamp(fraction * 100, 0, 100);
    const pageInfo = getPageInfo();
    const sectionIndex = getSectionIndex();
    const sectionCount = getSectionCount();
    const scrollRatio = sectionCount <= 1 ? percent / 100 : clamp(percent / 100 * sectionCount - sectionIndex, 0, 1);
    const restoredTarget = restored?.type === "foliate-view" ? restored.target : null;
    const target = isTxt
      ? sectionIndex
      : pageInfo?.pageCount === 1 && sectionCount > 1
        ? sectionIndex
      : typeof location?.fraction === "number"
        ? { fraction: clamp(location.fraction, 0, 1) }
        : location?.cfi ?? restoredTarget;
    return {
      locator: makeFoliateLocator(target, percent, sectionIndex, scrollRatio, pageInfo?.page ?? null, pageInfo?.pageCount ?? null),
      percent,
    };
  }

  function getPageInfo(): { page: number; pageCount: number } | null {
    let rawPage: number | undefined;
    let rawPages: number | undefined;
    try {
      rawPage = view.renderer?.page;
      rawPages = view.renderer?.pages;
    } catch {
      return null;
    }
    if (typeof rawPage !== "number" || typeof rawPages !== "number" || rawPages <= 0) return null;
    const pageCount = Math.max(rawPages - 2, 1);
    const page = clamp(Math.round(rawPage), 1, pageCount);
    return { page, pageCount };
  }

  function requestPaginatorRender(): void {
    window.requestAnimationFrame(() => {
      if (destroyed) return;
      view.renderer?.render?.();
      syncDiagnostics();
      emitStatus();
    });
  }

  function visibleText(): string {
    const texts = [
      ...Array.from(loadedDocs).map((doc) => doc.body?.innerText ?? doc.documentElement?.textContent ?? ""),
      ...(view.renderer?.getContents?.() ?? []).map(({ doc }) => doc.body?.innerText ?? doc.documentElement?.textContent ?? ""),
    ];
    return texts.join("\n").replace(/\s+/g, " ").trim();
  }

  function syncDiagnostics(): void {
    const text = visibleText();
    const doc = loadedDocs.values().next().value ?? view.renderer?.getContents?.()[0]?.doc ?? null;
    const body = doc?.body ?? null;
    const root = doc?.documentElement ?? null;
    const pageInfo = getPageInfo();
    const locator = getCurrentPosition();
    view.dataset.engine = "foliate-view";
    view.dataset.visibleTextLength = String(text.length);
    view.dataset.readerFontSize = body ? getComputedStyle(body).fontSize : `${fontSizePx}px`;
    view.dataset.readerFontFamily = body ? getComputedStyle(body).fontFamily : fontFamily;
    view.dataset.readerLineHeight = body ? getComputedStyle(body).lineHeight : lineSpacing;
    view.dataset.readerCssLoaded = hasReaderContentStylesheet(doc) ? "true" : "false";
    view.dataset.readerFontFaces = doc?.fonts ? Array.from(doc.fonts).map((fontFace) => fontFace.family).join(",") : "";
    view.dataset.sectionIndex = String(getSectionIndex());
    view.dataset.sectionCount = String(getSectionCount());
    view.dataset.scrollRatio = String(getScrollRatio());
    view.dataset.percent = String(locator.percent);
    view.dataset.locator = locator.locator;
    view.dataset.page = pageInfo ? String(pageInfo.page) : "1";
    view.dataset.pageCount = pageInfo ? String(pageInfo.pageCount) : "1";
    view.dataset.rootClasses = root ? Array.from(root.classList).join(" ") : "";
  }

  function readLocatorField(field: "sectionIndex" | "scrollRatio"): number | null {
    try {
      const parsed = JSON.parse(latestPosition.locator) as Record<string, unknown>;
      const value = parsed[field];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea, summary, [role='button']")) return;
    pointerStarts.set(event.currentTarget as Document, { x: event.clientX, y: event.clientY, time: event.timeStamp });
  }

  function handleDocumentPointerUp(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea, summary, [role='button']")) return;
    const doc = event.currentTarget as Document;
    const start = pointerStarts.get(doc);
    pointerStarts.delete(doc);
    const width = doc.defaultView?.innerWidth ?? window.innerWidth;
    handlePageGesture(event.clientX, width, start ?? null, event);
  }

  function handleHostPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea, summary, [role='button']")) return;
    hostPointerStart = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  }

  function handleHostPointerUp(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea, summary, [role='button']")) return;
    const start = hostPointerStart;
    hostPointerStart = null;
    const rect = view.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    handlePageGesture(event.clientX - rect.left, width, start, event);
  }

  function handlePageGesture(
    x: number,
    width: number,
    start: { x: number; y: number; time: number } | null,
    event: PointerEvent,
  ): void {
    const dx = start ? start.x - event.clientX : 0;
    const dy = start ? start.y - event.clientY : 0;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      void navigate(dx > 0 ? "next" : "previous");
      return;
    }
    if (x <= width * 0.24) {
      void navigate("previous");
      return;
    }
    if (x >= width * 0.76) {
      void navigate("next");
      return;
    }
    options.onTap?.();
  }

  return {
    previousSection: () => navigate("previous"),
    nextSection: () => navigate("next"),
    setFontSize: (nextFontSizePx: number) => {
      fontSizePx = clamp(nextFontSizePx, MIN_FONT_SIZE, MAX_FONT_SIZE);
      applyToLoadedDocs();
    },
    setFontFamily: (nextFontFamily: ReaderFontFamily) => {
      fontFamily = nextFontFamily;
      applyToLoadedDocs();
    },
    setLineSpacing: (nextLineSpacing: ReaderLineSpacing) => {
      lineSpacing = nextLineSpacing;
      applyToLoadedDocs();
    },
    setMargin: (nextMargin: ReaderMargin) => {
      margin = nextMargin;
      applyToLoadedDocs();
    },
    setTheme: (nextTheme: ReaderContentTheme) => {
      theme = nextTheme;
      applyToLoadedDocs();
    },
    saveNow,
    getCurrentPosition,
    destroy: () => {
      destroyed = true;
      window.clearTimeout(saveTimer);
      window.removeEventListener("beforeunload", beforeUnload);
      view.removeEventListener("load", handleLoad);
      view.removeEventListener("relocate", handleRelocate);
      view.removeEventListener("pointerdown", handleHostPointerDown);
      view.removeEventListener("pointerup", handleHostPointerUp);
      for (const doc of loadedDocs) {
        doc.removeEventListener("pointerdown", handleDocumentPointerDown);
        doc.removeEventListener("pointerup", handleDocumentPointerUp);
      }
      loadedDocs.clear();
      try {
        view.close();
      } catch (error) {
        console.warn("Could not close foliate-view reader cleanly", error);
      }
      view.remove();
      plainTextBook?.destroy();
    },
    getSectionIndex,
    getScrollRatio,
    getSectionCount,
  };
}

function parseRestoreLocator(locator: string | null | undefined): RestoreLocator {
  if (!locator) return null;
  if (locator.startsWith("epubcfi(")) return null;
  try {
    const parsed = JSON.parse(locator) as {
      type?: unknown;
      target?: unknown;
      percent?: unknown;
      sectionIndex?: unknown;
      scrollRatio?: unknown;
      page?: unknown;
      pageCount?: unknown;
    };
    if (parsed.type === "foliate-view") {
      return {
        type: "foliate-view",
        target: parseTarget(parsed.target),
        percent: clampNumber(parsed.percent, 0, 100, 0),
        sectionIndex: typeof parsed.sectionIndex === "number" && Number.isFinite(parsed.sectionIndex) ? Math.max(0, Math.round(parsed.sectionIndex)) : null,
        scrollRatio: typeof parsed.scrollRatio === "number" && Number.isFinite(parsed.scrollRatio) ? clamp(parsed.scrollRatio, 0, 1) : null,
        page: typeof parsed.page === "number" && Number.isFinite(parsed.page) ? Math.max(1, Math.round(parsed.page)) : null,
        pageCount: typeof parsed.pageCount === "number" && Number.isFinite(parsed.pageCount) ? Math.max(1, Math.round(parsed.pageCount)) : null,
      };
    }
    if (parsed.type === "text") {
      return {
        type: "text",
        sectionIndex: clampNumber(parsed.sectionIndex, 0, Number.MAX_SAFE_INTEGER, 0),
        scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0),
      };
    }
    if (parsed.type === "txt") {
      return { type: "txt", scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0) };
    }
    return null;
  } catch {
    return null;
  }
}

function resolveRestoreTarget(restored: RestoreLocator, sectionCount: number, isTxt = false): FoliateTarget | null {
  if (!restored) return null;
  if (restored.type === "foliate-view") {
    if (isTxt && restored.sectionIndex !== null) return clamp(restored.sectionIndex, 0, Math.max(sectionCount - 1, 0));
    if (restored.pageCount === 1 && restored.sectionIndex !== null && sectionCount > 1) {
      return clamp(restored.sectionIndex, 0, Math.max(sectionCount - 1, 0));
    }
    if (!isTxt && restored.target !== null) return restored.target;
    if (restored.sectionIndex !== null) return clamp(restored.sectionIndex, 0, Math.max(sectionCount - 1, 0));
    return { fraction: clamp(restored.percent / 100, 0, 1) };
  }
  if (restored.type === "txt") return { fraction: clamp(restored.scrollRatio, 0, 1) };
  if (!isTxt && sectionCount > 1) return clamp(Math.round(restored.sectionIndex), 0, sectionCount - 1);
  const safeSectionCount = Math.max(sectionCount, 1);
  return { fraction: clamp((clamp(Math.round(restored.sectionIndex), 0, safeSectionCount - 1) + restored.scrollRatio) / safeSectionCount, 0, 1) };
}

function parseTarget(value: unknown): FoliateTarget | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (value && typeof value === "object" && "fraction" in value) {
    const fraction = (value as { fraction?: unknown }).fraction;
    if (typeof fraction === "number" && Number.isFinite(fraction)) return { fraction: clamp(fraction, 0, 1) };
  }
  return null;
}

function makeFoliateLocator(
  target: FoliateTarget | null,
  percent: number,
  sectionIndex: number,
  scrollRatio: number,
  page: number | null,
  pageCount: number | null,
): string {
  return JSON.stringify({
    type: "foliate-view",
    target,
    percent: clamp(percent, 0, 100),
    sectionIndex: Math.max(0, Math.round(sectionIndex)),
    scrollRatio: clamp(scrollRatio, 0, 1),
    page,
    pageCount,
  } satisfies FoliateViewLocator);
}

async function makePlainTextBook(file: File): Promise<PlainTextBook> {
  const text = await file.text();
  const chunks = chunkPlainText(text);
  const parser = new DOMParser();
  const sections = chunks.map((chunk, index) => {
    const html = plainTextSectionHtml(file.name, chunk, index + 1, chunks.length);
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    return {
      id: `text-${index + 1}`,
      size: Math.max(chunk.length, 1),
      cfi: `epubcfi(/2/${index * 2 + 1})`,
      load: () => blobUrl,
      unload: () => undefined,
      createDocument: () => parser.parseFromString(html, "text/html"),
      destroy: () => URL.revokeObjectURL(blobUrl),
    };
  });
  return {
    metadata: { title: file.name, language: "ru" },
    dir: "ltr",
    toc: [],
    splitTOCHref: (href: string) => [href || "text", ""],
    getTOCFragment: (doc: Document) => doc.body,
    resolveHref: (href: string) => {
      const match = href.match(/text-(\d+)/);
      return { index: match ? clamp(Math.round(Number(match[1])) - 1, 0, sections.length - 1) : 0, anchor: 0 };
    },
    sections,
    destroy: () => sections.forEach((section) => section.destroy()),
  };
}

function chunkPlainText(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [""];
  const units = normalized.includes("\n\n") ? normalized.split(/\n{2,}/) : normalized.split(/\n/);
  const chunks: string[] = [];
  let current = "";
  const targetLength = 2600;
  for (const unit of units) {
    const paragraph = unit.trim();
    if (!paragraph) continue;
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && next.length > targetLength) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [normalized];
}

function plainTextSectionHtml(title: string, chunk: string, index: number, total: number): string {
  const paragraphs = chunk
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head><body><article class="reader-article"><h1>${escapeHtml(title)}</h1><p class="reader-kicker">Text section ${index}/${total}</p>${paragraphs}</article></body></html>`;
}

function applyReaderDocumentClasses(
  doc: Document,
  fontSizePx: number,
  fontFamily: ReaderFontFamily,
  theme: ReaderContentTheme,
  lineSpacing: ReaderLineSpacing,
  margin: ReaderMargin,
): void {
  if (!doc.querySelector('link[data-reader-content-css="true"]')) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("/reader-content.css", window.location.origin).toString();
    link.dataset.readerContentCss = "true";
    (doc.head ?? doc.documentElement).prepend(link);
  }
  const root = doc.documentElement;
  Array.from(root.classList)
    .filter((className) => className.startsWith("reader-font-"))
    .forEach((className) => root.classList.remove(className));
  root.classList.add(`reader-font-${Math.round(clamp(fontSizePx, MIN_FONT_SIZE, MAX_FONT_SIZE))}`);
  root.classList.remove("reader-family-literata", "reader-family-serif", "reader-family-sans");
  root.classList.add(`reader-family-${fontFamily}`);
  root.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-sepia");
  root.classList.add(`reader-theme-${theme}`);
  root.classList.remove("reader-line-compact", "reader-line-normal", "reader-line-spacious");
  root.classList.add(`reader-line-${lineSpacing}`);
  root.classList.remove("reader-margin-narrow", "reader-margin-normal", "reader-margin-wide");
  root.classList.add(`reader-margin-${margin}`);
}

function hasReaderContentStylesheet(doc: Document | null): boolean {
  if (!doc) return false;
  const link = doc.querySelector<HTMLLinkElement>('link[data-reader-content-css="true"]');
  if (!link) return false;
  const bodySize = doc.body ? Number.parseFloat(getComputedStyle(doc.body).fontSize) : 0;
  if (link.sheet && Math.abs(bodySize - Number(doc.documentElement.className.match(/reader-font-(\d+)/)?.[1] ?? 0)) <= 0.5) return true;
  return Array.from(doc.styleSheets).some((sheet) => {
    if (!sheet.href?.includes("reader-content.css")) return false;
    try {
      return sheet.cssRules.length > 0;
    } catch {
      return false;
    }
  });
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
