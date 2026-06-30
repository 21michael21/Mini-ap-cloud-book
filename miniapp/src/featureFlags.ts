export type TextReaderEngine = "custom" | "foliate-view";
export type TextRenderMode = "clean" | "original";
export type PdfReaderMode = "canvas" | "viewer-shell";
export type ReaderUiVersion = "v1" | "v2";

export type ReaderFeatureFlags = {
  textReaderEngine: TextReaderEngine;
  textRenderMode: TextRenderMode;
  pdfReaderMode: PdfReaderMode;
  readerUi: ReaderUiVersion;
};

const TEXT_READER_ENGINES = new Set<TextReaderEngine>(["custom", "foliate-view"]);
const TEXT_RENDER_MODES = new Set<TextRenderMode>(["clean", "original"]);
const PDF_READER_MODES = new Set<PdfReaderMode>(["canvas", "viewer-shell"]);
const READER_UI_VERSIONS = new Set<ReaderUiVersion>(["v1", "v2"]);

function readFlag<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

export const readerFeatureFlags: ReaderFeatureFlags = {
  textReaderEngine: readFlag(
    import.meta.env.VITE_TEXT_READER_ENGINE ?? import.meta.env.VITE_READER_ENGINE,
    TEXT_READER_ENGINES,
    "custom",
  ),
  textRenderMode: readFlag(import.meta.env.VITE_TEXT_RENDER_MODE, TEXT_RENDER_MODES, "clean"),
  pdfReaderMode: readFlag(import.meta.env.VITE_PDF_READER_MODE, PDF_READER_MODES, "canvas"),
  readerUi: readFlag(import.meta.env.VITE_READER_UI, READER_UI_VERSIONS, "v2"),
};
