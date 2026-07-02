export {
  BookFileError,
  apiHeaders,
  fetchBookFile,
  parsePdfPage,
  parseTextLocator,
  parseTxtLocator,
  textPositionPercent,
  txtPositionPercent,
  type PdfReaderController,
  type PdfReaderOptions,
  type Position,
  type ReaderContentTheme,
  type ReaderFontFamily,
  type ReaderLineSpacing,
  type ReaderMargin,
  type TextReaderController,
  type TextReaderOptions,
  type TextReaderStatus,
  type TextRenderMode,
} from "./readers/shared";

export async function openFoliateReader(
  ...args: Parameters<typeof import("./readers/textReader").openFoliateReader>
): Promise<ReturnType<typeof import("./readers/textReader").openFoliateReader> extends Promise<infer T> ? T : never> {
  const { openFoliateReader } = await import("./readers/textReader");
  return openFoliateReader(...args);
}

export async function openPdfReader(
  ...args: Parameters<typeof import("./readers/pdfReader").openPdfReader>
): Promise<ReturnType<typeof import("./readers/pdfReader").openPdfReader> extends Promise<infer T> ? T : never> {
  const { openPdfReader } = await import("./readers/pdfReader");
  return openPdfReader(...args);
}
