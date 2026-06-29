import * as pdfjs from "pdfjs-dist";

export type Position = {
  locator: string;
  percent: number;
};

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

pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.mjs";

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
  if (!response.ok) throw new Error(await response.text());
  const blob = await response.blob();
  return new File([blob], book.file_name, { type: blob.type });
}

export async function openFoliateReader(
  container: HTMLElement,
  file: File,
  restoreLocator: string | null,
  onPosition: (position: Position) => void,
  onVisibleText?: (text: string) => void,
): Promise<HTMLIFrameElement> {
  const book = file.name.toLowerCase().endsWith(".txt")
    ? await makePlainTextBook(file)
    : await makeFoliateBook(file);
  const section = selectSection(book, restoreLocator);
  const { src, srcdoc, text } = await makeSafeSectionUrl(section);
  const iframe = document.createElement("iframe");
  iframe.className = "book-frame";
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("title", file.name);
  container.replaceChildren(iframe);
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out loading book iframe")), 7000);
    const poll = window.setInterval(() => {
      const bodyText = iframe.contentDocument?.body?.innerText?.trim();
      if (bodyText) {
        window.clearInterval(poll);
        window.clearTimeout(timeout);
        resolve();
      }
    }, 100);
    iframe.addEventListener(
      "load",
      () => {
        window.clearInterval(poll);
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
      reject(new Error("Book section has no renderable source"));
    }
  });
  const renderedText = iframe.contentDocument?.body?.innerText?.trim() || text;
  if (renderedText) onVisibleText?.(renderedText);
  onPosition({ locator: normalizeCfi(section.cfi ?? restoreLocator), percent: restoreLocator ? 25 : 0 });
  return iframe;
}

export async function openPdfReader(
  container: HTMLElement,
  file: File,
  restoreLocator: string | null,
  onPosition: (position: Position) => void,
): Promise<{
  getPageNumber: () => number;
  pageCount: number;
  canvas: HTMLCanvasElement;
  renderPage: (page: number) => Promise<void>;
}> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  container.replaceChildren(canvas);
  let pageNumber = Math.min(Math.max(Number(restoreLocator ?? 1), 1), pdf.numPages);

  const renderPage = async (page: number) => {
    pageNumber = Math.min(Math.max(page, 1), pdf.numPages);
    const pdfPage = await pdf.getPage(pageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min((container.clientWidth || window.innerWidth) / baseViewport.width, 1.6);
    const viewport = pdfPage.getViewport({ scale });
    const context = canvas.getContext("2d")!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
    onPosition({ locator: String(pageNumber), percent: (pageNumber / pdf.numPages) * 100 });
  };

  await renderPage(pageNumber);
  return { getPageNumber: () => pageNumber, pageCount: pdf.numPages, canvas, renderPage };
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

async function makeFoliateBook(file: File): Promise<FoliateBook> {
  if (file.name.toLowerCase().endsWith(".fb2")) {
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

type ZipEntry = {
  filename: string;
  uncompressedSize: number;
  getData: <T>(writer: unknown) => Promise<T>;
};

function selectSection(book: FoliateBook, restoreLocator: string | null) {
  if (restoreLocator) {
    const match = book.sections.find((section) => normalizeCfi(section.cfi) === restoreLocator);
    if (match) return match;
  }
  const firstLinear = book.sections.find((section) => section.load);
  if (!firstLinear) throw new Error("Book has no renderable sections");
  return firstLinear;
}

function normalizeCfi(locator: string | null | undefined): string {
  if (!locator) return "epubcfi(/2/1)";
  return locator.startsWith("epubcfi(") ? locator : `epubcfi(${locator})`;
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
