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
  setFontFamily: (fontFamily: ReaderFontFamily) => void;
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
  fontFamily?: ReaderFontFamily;
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

export type ReaderContentTheme = "dark" | "light" | "sepia";
export type ReaderFontFamily = "literata" | "serif" | "sans";
export type ReaderLineSpacing = "compact" | "normal" | "spacious";
export type ReaderMargin = "narrow" | "normal" | "wide";
export type TextRenderMode = "clean" | "original";

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

export function parseTextLocator(locator: string | null | undefined, sectionCount: number): TextLocator {
  const fallback: TextLocator = { type: "text", sectionIndex: 0, scrollRatio: 0 };
  if (!locator || locator.startsWith("epubcfi(")) return fallback;
  try {
    const parsed = JSON.parse(locator) as {
      type?: unknown;
      sectionIndex?: unknown;
      scrollRatio?: unknown;
      percent?: unknown;
    };
    if (parsed.type === "text") {
      return {
        type: "text",
        sectionIndex: clampNumber(parsed.sectionIndex, 0, Math.max(sectionCount - 1, 0), 0),
        scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0),
      };
    }
    if (parsed.type === "foliate-view") {
      return {
        type: "text",
        sectionIndex: clampNumber(parsed.sectionIndex, 0, Math.max(sectionCount - 1, 0), 0),
        scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, 0),
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function parseTxtLocator(locator: string | null | undefined): TxtLocator {
  const fallback: TxtLocator = { type: "txt", scrollRatio: 0 };
  if (!locator || locator.startsWith("epubcfi(")) return fallback;
  try {
    const parsed = JSON.parse(locator) as { type?: unknown; scrollRatio?: unknown; percent?: unknown };
    if (parsed.type === "foliate-view") {
      return {
        type: "txt",
        scrollRatio: clampNumber(parsed.scrollRatio, 0, 1, clampNumber(parsed.percent, 0, 100, 0) / 100),
      };
    }
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

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
