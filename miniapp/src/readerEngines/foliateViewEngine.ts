import "foliate-js/view.js";
import type {
  Position,
  ReaderContentTheme,
  TextReaderController,
  TextReaderOptions,
  TextReaderStatus,
} from "../readerCore";

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

type FoliateViewElement = HTMLElement & {
  book?: FoliateBook;
  lastLocation?: FoliateLocation;
  open: (book: File | FoliateBook) => Promise<void>;
  init: (options: { lastLocation?: FoliateTarget; showTextStart?: boolean }) => Promise<void>;
  prev: (distance?: number) => Promise<void>;
  next: (distance?: number) => Promise<void>;
  close: () => void;
};

type FoliateTarget = string | number | { fraction: number };

type FoliateViewLocator = {
  type: "foliate-view";
  target: FoliateTarget | null;
  percent: number;
};

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
  view.setAttribute("margin", "0");
  view.setAttribute("max-inline-size", "760px");
  view.setAttribute("max-column-count", "1");

  let destroyed = false;
  let navigating = false;
  let fontSizePx = clamp(options.fontSizePx ?? 18, MIN_FONT_SIZE, MAX_FONT_SIZE);
  let theme: ReaderContentTheme = options.theme ?? "dark";
  let latestLocation: FoliateLocation | null = null;
  let latestPosition: Position = { locator: makeFoliateLocator(null, 0), percent: 0 };
  const loadedDocs = new Set<Document>();
  const plainTextBook = isTxt ? await makePlainTextBook(file) : null;
  const restored = parseFoliateViewLocator(restoreLocator);

  const applyToLoadedDocs = () => {
    for (const doc of loadedDocs) applyReaderDocumentClasses(doc, fontSizePx, theme);
  };

  const emitStatus = () => {
    const percent = latestPosition.percent;
    const section = latestLocation?.section;
    const current = typeof section?.current === "number" ? section.current : 0;
    const total = typeof section?.total === "number" && section.total > 0 ? section.total : getSectionCount();
    onStatus?.({
      canGoPrevious: percent > 0 || current > 0,
      canGoNext: percent < 99.5 || current < total - 1,
      label: isTxt ? `${Math.round(percent)}%` : `Section ${current + 1}/${total} · ${Math.round(percent)}%`,
    });
  };

  const handleLoad = (event: Event) => {
    const detail = (event as CustomEvent<{ doc?: Document; index?: number }>).detail;
    const doc = detail?.doc;
    if (!doc) return;
    loadedDocs.add(doc);
    applyReaderDocumentClasses(doc, fontSizePx, theme);
    doc.addEventListener("pointerup", handleDocumentPointerUp);
    onVisibleText?.(doc.body?.innerText?.trim() ?? "");
  };

  const handleRelocate = (event: Event) => {
    latestLocation = (event as CustomEvent<FoliateLocation>).detail ?? null;
    latestPosition = positionFromLocation(latestLocation);
    onPosition(latestPosition);
    emitStatus();
  };

  const beforeUnload = () => {
    if (!destroyed) onPosition(getCurrentPosition());
  };

  view.addEventListener("load", handleLoad);
  view.addEventListener("relocate", handleRelocate);
  container.replaceChildren(view);

  try {
    await view.open(plainTextBook ?? file);
    await view.init({
      lastLocation: restored?.target ?? undefined,
      showTextStart: !restored?.target,
    });
  } catch (error) {
    plainTextBook?.destroy();
    view.removeEventListener("load", handleLoad);
    view.removeEventListener("relocate", handleRelocate);
    view.remove();
    throw error;
  }

  window.addEventListener("beforeunload", beforeUnload);
  applyToLoadedDocs();
  emitStatus();

  async function navigate(direction: "previous" | "next"): Promise<void> {
    if (destroyed || navigating) return;
    navigating = true;
    try {
      if (direction === "previous") await view.prev();
      else await view.next();
      onPosition(getCurrentPosition());
      emitStatus();
    } finally {
      navigating = false;
    }
  }

  function getSectionCount(): number {
    const total = latestLocation?.section?.total;
    if (typeof total === "number" && total > 0) return total;
    return Math.max(view.book?.sections?.length ?? plainTextBook?.sections.length ?? 1, 1);
  }

  function getSectionIndex(): number {
    return clampNumber(latestLocation?.section?.current, 0, getSectionCount() - 1, 0);
  }

  function getScrollRatio(): number {
    return clampNumber(latestLocation?.fraction, 0, 1, latestPosition.percent / 100);
  }

  function getCurrentPosition(): Position {
    if (latestLocation) latestPosition = positionFromLocation(latestLocation);
    return latestPosition;
  }

  function positionFromLocation(location: FoliateLocation | null): Position {
    const rawFraction = location?.fraction;
    const fraction = typeof rawFraction === "number" && Number.isFinite(rawFraction) ? rawFraction : (restored?.percent ?? 0) / 100;
    const percent = clamp(fraction * 100, 0, 100);
    const target = location?.cfi ?? (typeof location?.fraction === "number" ? { fraction: location.fraction } : restored?.target ?? null);
    return {
      locator: makeFoliateLocator(target, percent),
      percent,
    };
  }

  function handleDocumentPointerUp(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, select, textarea")) return;
    options.onTap?.();
  }

  return {
    previousSection: () => navigate("previous"),
    nextSection: () => navigate("next"),
    setFontSize: (nextFontSizePx: number) => {
      fontSizePx = clamp(nextFontSizePx, MIN_FONT_SIZE, MAX_FONT_SIZE);
      applyToLoadedDocs();
    },
    setTheme: (nextTheme: ReaderContentTheme) => {
      theme = nextTheme;
      applyToLoadedDocs();
    },
    saveNow: () => onPosition(getCurrentPosition()),
    getCurrentPosition,
    destroy: () => {
      destroyed = true;
      window.removeEventListener("beforeunload", beforeUnload);
      view.removeEventListener("load", handleLoad);
      view.removeEventListener("relocate", handleRelocate);
      for (const doc of loadedDocs) doc.removeEventListener("pointerup", handleDocumentPointerUp);
      loadedDocs.clear();
      view.close();
      view.remove();
      plainTextBook?.destroy();
    },
    getSectionIndex,
    getScrollRatio,
    getSectionCount,
  };
}

function parseFoliateViewLocator(locator: string | null | undefined): FoliateViewLocator | null {
  if (!locator) return null;
  if (locator.startsWith("epubcfi(")) return { type: "foliate-view", target: locator, percent: 0 };
  try {
    const parsed = JSON.parse(locator) as Partial<FoliateViewLocator>;
    if (parsed.type !== "foliate-view") return null;
    const percent = clampNumber(parsed.percent, 0, 100, 0);
    const target = parseTarget(parsed.target);
    return { type: "foliate-view", target, percent };
  } catch {
    return null;
  }
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

function makeFoliateLocator(target: FoliateTarget | null, percent: number): string {
  return JSON.stringify({
    type: "foliate-view",
    target,
    percent: clamp(percent, 0, 100),
  } satisfies FoliateViewLocator);
}

async function makePlainTextBook(file: File): Promise<PlainTextBook> {
  const text = await file.text();
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
    file.name,
  )}</title></head><body><article class="reader-article"><pre>${escapeHtml(text)}</pre></article></body></html>`;
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const parser = new DOMParser();
  const createDocument = () => parser.parseFromString(html, "text/html");

  return {
    metadata: { title: file.name, language: "ru" },
    dir: "ltr",
    toc: [],
    splitTOCHref: (href: string) => [href || "text", ""],
    getTOCFragment: (doc: Document) => doc.body,
    resolveHref: () => ({ index: 0, anchor: 0 }),
    sections: [
      {
        id: "text",
        size: Math.max(text.length, 1),
        cfi: "epubcfi(/2/1)",
        load: () => blobUrl,
        unload: () => undefined,
        createDocument,
      },
    ],
    destroy: () => URL.revokeObjectURL(blobUrl),
  };
}

function applyReaderDocumentClasses(doc: Document, fontSizePx: number, theme: ReaderContentTheme): void {
  if (!doc.querySelector('link[data-reader-content-css="true"]')) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "/reader-content.css";
    link.dataset.readerContentCss = "true";
    (doc.head ?? doc.documentElement).prepend(link);
  }
  const root = doc.documentElement;
  Array.from(root.classList)
    .filter((className) => className.startsWith("reader-font-"))
    .forEach((className) => root.classList.remove(className));
  root.classList.add(`reader-font-${Math.round(clamp(fontSizePx, MIN_FONT_SIZE, MAX_FONT_SIZE))}`);
  root.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-sepia");
  root.classList.add(`reader-theme-${theme}`);
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
