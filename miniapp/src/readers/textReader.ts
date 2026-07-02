import {
  type Position,
  type ReaderContentTheme,
  type ReaderFontFamily,
  type ReaderLineSpacing,
  type ReaderMargin,
  type TextReaderController,
  type TextReaderOptions,
  type TextReaderStatus,
  type TextRenderMode,
  type TextLocator,
  type TxtLocator,
  parseTextLocator,
  parseTxtLocator,
  clamp,
} from "./shared";

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
  let fontFamily: ReaderFontFamily = options.fontFamily ?? "literata";
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
      fontFamily,
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
    setFontFamily: (nextFontFamily: ReaderFontFamily) => {
      fontFamily = nextFontFamily;
      applyIframeFontFamily(iframe, fontFamily);
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

async function renderSectionIframe(
  container: HTMLElement,
  title: string,
  section: RenderableSection,
  restoreScrollRatio: number,
  onScroll: () => void,
  onTap: () => void,
  fontSizePx: number,
  fontFamily: ReaderFontFamily,
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
  applyIframeFontFamily(iframe, fontFamily);
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
  stylesheet.href = new URL("/reader-content.css", window.location.origin).toString();
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
  stylesheet.href = new URL("/reader-content.css", window.location.origin).toString();
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
  ensureReaderContentStylesheet(doc);
  const size = Math.round(clamp(fontSizePx, 15, 26));
  const root = doc.documentElement;
  Array.from(root.classList)
    .filter((className) => className.startsWith("reader-font-"))
    .forEach((className) => root.classList.remove(className));
  root.classList.add(`reader-font-${size}`);
}

function applyIframeFontFamily(iframe: HTMLIFrameElement | null, fontFamily: ReaderFontFamily): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  ensureReaderContentStylesheet(doc);
  const root = doc.documentElement;
  root.classList.remove("reader-family-literata", "reader-family-serif", "reader-family-sans");
  root.classList.add(`reader-family-${fontFamily}`);
}

function applyIframeTheme(iframe: HTMLIFrameElement | null, theme: ReaderContentTheme): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  ensureReaderContentStylesheet(doc);
  const root = doc.documentElement;
  root.classList.remove("reader-theme-dark", "reader-theme-light", "reader-theme-sepia");
  root.classList.add(`reader-theme-${theme}`);
}

function ensureReaderContentStylesheet(doc: Document): void {
  if (doc.querySelector('link[data-reader-content-css="true"]')) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("/reader-content.css", window.location.origin).toString();
  link.dataset.readerContentCss = "true";
  (doc.head ?? doc.documentElement).prepend(link);
}

function applyIframeLineSpacing(iframe: HTMLIFrameElement | null, lineSpacing: ReaderLineSpacing): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  ensureReaderContentStylesheet(doc);
  const root = doc.documentElement;
  root.classList.remove("reader-line-compact", "reader-line-normal", "reader-line-spacious");
  root.classList.add(`reader-line-${lineSpacing}`);
}

function applyIframeMargin(iframe: HTMLIFrameElement | null, margin: ReaderMargin): void {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  ensureReaderContentStylesheet(doc);
  const root = doc.documentElement;
  root.classList.remove("reader-margin-narrow", "reader-margin-normal", "reader-margin-wide");
  root.classList.add(`reader-margin-${margin}`);
}
