import { expect, type ConsoleMessage, type FrameLocator, type Page, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const screenshotDir = resolve(repoDir, "tests/screenshots/artifacts");
const saveScreenshots = process.env.READER_E2E_SCREENSHOTS === "1";
const reportPath = process.env.READER_E2E_REPORT_PATH ?? "";
const experimentFlags = parseExperimentFlags();
const reportScreenshotDir = reportPath ? resolve(dirname(reportPath), "screenshots", process.env.READER_E2E_RUN_NAME ?? "reader") : "";
const envPayload = readSeedEnv();
const experimentRecords: ExperimentRecord[] = [];
const isReaderUiV2 = experimentFlags.readerUi === "v2";

const books = {
  simple: "Reader E2E Simple EPUB",
  badMarkup: "Reader E2E Bad Markup EPUB",
  epub: "Reader E2E Multi Section EPUB",
  fb2: "Reader E2E Long FB2",
  cp1251: "Reader E2E CP1251 FB2",
  txt: "Reader E2E Long TXT",
  pdf: "Reader E2E Small PDF",
  scannedPdf: "Reader E2E Scanned Like PDF",
  rename: "Reader E2E Simple EPUB",
  delete: "Reader E2E Bad Markup EPUB",
  move: "Reader E2E CP1251 FB2",
};

const experimentFixtures: Array<{ fixture: string; title: string; format: string }> = [
  { fixture: "simple.epub", title: books.simple, format: "epub" },
  { fixture: "bad_markup.epub", title: books.badMarkup, format: "epub" },
  { fixture: "multi_section.epub", title: books.epub, format: "epub" },
  { fixture: "long_text.fb2", title: books.fb2, format: "fb2" },
  { fixture: "cp1251.fb2", title: books.cp1251, format: "fb2" },
  { fixture: "long.txt", title: books.txt, format: "txt" },
  { fixture: "small.pdf", title: books.pdf, format: "pdf" },
  { fixture: "scanned_like.pdf", title: books.scannedPdf, format: "pdf" },
];

type ExperimentFlags = {
  textReaderEngine: string;
  textRenderMode: string;
  pdfReaderMode: string;
  readerUi: string;
};

type ExperimentRecord = {
  fixture: string;
  title: string;
  format: string;
  engine: string;
  renderMode: string;
  pdfReaderMode: string;
  readerUi: string;
  opened: boolean;
  visibleTextLength: number;
  progressVisible: boolean;
  positionRestore: boolean;
  fontSizeWorks: boolean;
  pdfCanvasQuality: boolean | null;
  screenshotPath: string | null;
  errors: string[];
};

type SeedEnv = {
  apiBase: string;
  initData: string;
  books: Record<string, number>;
};

test.describe("reader e2e", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(() => {
    writeExperimentReport();
  });

  for (const fixture of experimentFixtures) {
    test(`experiment smoke records ${fixture.fixture}`, async ({ page }, testInfo) => {
      await runFixtureExperiment(page, testInfo, fixture);
    });
  }

  test("EPUB opens, changes font, saves progress, and restores position", async ({ page }, testInfo) => {
    test.skip(experimentFlags.textReaderEngine === "foliate-view", "Strict restore gate targets the stable custom reader.");
    await resetBookPosition("multi_section.epub", JSON.stringify({ type: "text", sectionIndex: 0, scrollRatio: 0 }), 0);
    if (isReaderUiV2) {
      await page.addInitScript(() => window.localStorage.removeItem("telegram-library-reader-hint-seen"));
    }
    await openBook(page, books.epub);
    await expect(page.locator("#readerSettingsButton")).toBeVisible();
    await expect(page.locator("#readerMark")).toBeVisible();
    await expect(page.locator("#readerBottomProgress")).toBeVisible();
    const frame = await waitForBookFrame(page);
    await expectVisibleText(frame, 400);
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section|%/);
    if (isReaderUiV2) {
      await expect(page.locator("#readerHint")).toContainText("Tap the page for controls. Use Aa to change reading settings.");
      await maybeScreenshot(page, testInfo, "reader-v2-text-controls");
    } else {
      await maybeScreenshot(page, testInfo, "text-controls-visible");
    }
    await page.locator("#readerStage").click({ position: { x: 320, y: 360 } }).catch(() => undefined);
    await page.waitForTimeout(200);
    await expect(page.locator("#readerBottomProgress")).toBeVisible();
    if (isReaderUiV2) {
      await expect(page.locator("#readerToolbar")).toHaveClass(/is-hidden/);
      await maybeScreenshot(page, testInfo, "reader-v2-text-hidden-controls");
    } else {
      await maybeScreenshot(page, testInfo, "text-controls-hidden");
    }
    await page.locator("#readerStage").click({ position: { x: 320, y: 360 } }).catch(() => undefined);
    await expect(page.locator("#readerSettingsButton")).toBeVisible();

    const before = await bodyFontSize(frame);
    await page.locator("#readerSettingsButton").click();
    await expect(page.locator(".reader-settings-sheet")).toBeVisible();
    if (isReaderUiV2) {
      await expect(page.locator("[data-reader-line='spacious']")).toBeVisible();
      await expect(page.locator("[data-reader-margin='wide']")).toBeVisible();
      await maybeScreenshotElementIfVisible(page, testInfo, ".sheet-layer", "reader-v2-aa-sheet");
    } else {
      await maybeScreenshot(page, testInfo, "text-aa-settings-sheet");
    }
    await page.locator("#readerFontUp").click();
    await expect.poll(() => bodyFontSize(frame)).toBeGreaterThan(before);
    if (isReaderUiV2) {
      await page.locator("[data-reader-line='spacious']").click();
      await page.locator("[data-reader-margin='wide']").click();
    }
    await page.locator('[data-reader-theme="sepia"]').click();
    await expectReadableButton(page.locator("#readerSettingsButton"));
    await closeSheet(page);
    if (await page.locator("#readerMark").isVisible().catch(() => false)) {
      await page.locator("#readerMark").click();
      if (isReaderUiV2) {
        await expect(page.locator(".bottom-sheet")).toBeVisible();
        await maybeScreenshotElementIfVisible(page, testInfo, ".sheet-layer", "reader-v2-note-sheet");
      } else {
        await maybeScreenshotIfVisible(page, testInfo, ".bottom-sheet", "notes-sheet");
      }
      await closeSheet(page);
    }

    await page.locator("#readerNext").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section 2\/3/);
    const progressAfterNext = await progressPercent(page);
    expect(progressAfterNext).toBeGreaterThan(0);
    await maybeScreenshot(page, testInfo, "epub-reader");

    await leaveReader(page);
    await openBook(page, books.epub);
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section 2\/3/);
  });

  test("FB2 opens, keeps controls readable, and restores section position", async ({ page }) => {
    test.skip(experimentFlags.textReaderEngine === "foliate-view", "Strict restore gate targets the stable custom reader.");
    await resetBookPosition("long_text.fb2", JSON.stringify({ type: "text", sectionIndex: 0, scrollRatio: 0 }), 0);
    await openBook(page, books.fb2);
    const frame = await waitForBookFrame(page);
    await expectVisibleText(frame, 400);
    await expect(page.locator("#readerSettingsButton")).toBeVisible();
    await page.locator("#readerSettingsButton").click();
    await page.locator("#readerFontUp").click();
    await page.locator('[data-reader-theme="light"]').click();
    await expectReadableButton(page.locator("#readerSettingsButton"));
    await closeSheet(page);

    await page.locator("#readerNext").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section 2\/2/);
    await leaveReader(page);
    await openBook(page, books.fb2);
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section 2\/2/);
  });

  test("TXT opens, scroll progress saves, and restores scroll position", async ({ page }) => {
    test.skip(experimentFlags.textReaderEngine === "foliate-view", "Strict restore gate targets the stable custom reader.");
    await resetBookPosition("long.txt", JSON.stringify({ type: "txt", scrollRatio: 0 }), 0);
    await openBook(page, books.txt);
    const frame = await waitForBookFrame(page);
    await expectVisibleText(frame, 700);
    await expect(page.locator("#readerBottomProgress")).toBeVisible();
    await scrollBookFrame(frame, 0.55);
    await expect.poll(() => progressPercent(page)).toBeGreaterThan(10);
    await page.locator("#readerSettingsButton").click();
    const before = await bodyFontSize(frame);
    await page.locator("#readerFontUp").click();
    await expect.poll(() => bodyFontSize(frame)).toBeGreaterThan(before);
    await closeSheet(page);
    await leaveReader(page);

    await openBook(page, books.txt);
    const restoredFrame = await waitForBookFrame(page);
    await expect.poll(() => frameScrollRatio(restoredFrame)).toBeGreaterThan(0.2);
  });

  test("PDF opens high-DPI, zooms, navigates, and restores page", async ({ page }, testInfo) => {
    await resetBookPosition("small.pdf", "1", 0);
    await page.addInitScript(() => window.localStorage.setItem("telegram-library-pdf-zoom", "1"));
    await openBook(page, books.pdf);
    const canvas = page.locator(".pdf-canvas");
    await expect(canvas).toBeVisible();
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await expect(canvas).toPassCanvasDprCheck();
    await expectPdfFitWidth(page);
    await expect.poll(() => canvasNonBlankScore(page)).toBeGreaterThan(20);
    await maybeScreenshot(page, testInfo, "pdf-fit-width");
    if (isReaderUiV2) await maybeScreenshot(page, testInfo, "reader-v2-pdf");

    const widthBefore = await canvasCssWidth(page);
    await openPdfSettings(page);
    await expect(page.locator("#readerZoomIn")).toBeVisible();
    await expect(page.locator("#readerFitWidth")).toBeVisible();
    await page.locator("#readerZoomIn").click();
    await closeSheet(page);
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await expect.poll(() => canvasCssWidth(page)).toBeGreaterThan(widthBefore);
    await maybeScreenshot(page, testInfo, "pdf-zoomed");

    await openPdfSettings(page);
    await page.locator("#readerFitWidth").click();
    await closeSheet(page);
    await expect.poll(() => canvasCssWidth(page)).toBeLessThan(widthBefore + 3);
    await expectPdfFitWidth(page);

    await page.locator("#readerNext").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
    await page.locator("#readerPrev").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await page.locator("#readerNext").evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
    await maybeScreenshot(page, testInfo, "pdf-reader");

    await leaveReader(page);
    await openBook(page, books.pdf);
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
  });

  test("scanned-like PDF renders nonblank at fit width", async ({ page }, testInfo) => {
    await resetBookPosition("scanned_like.pdf", "1", 0);
    await page.addInitScript(() => window.localStorage.setItem("telegram-library-pdf-zoom", "1"));
    await openBook(page, books.scannedPdf);
    const canvas = page.locator(".pdf-canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).toPassCanvasDprCheck();
    await expectPdfFitWidth(page);
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await expect.poll(() => canvasNonBlankScore(page)).toBeGreaterThan(20);
    await maybeScreenshot(page, testInfo, "pdf-scanned-like");
  });

  test("library covers load real images and polished fallbacks", async ({ page }, testInfo) => {
    await openLibrary(page);
    const realCoverRow = page.locator(".book-row", { hasText: books.simple }).first();
    await expect(realCoverRow).toBeVisible();
    await expectLoadedCover(realCoverRow);
    await maybeScreenshot(page, testInfo, "library-with-real-cover");

    await page.locator("#searchInput").fill("Reader E2E Long TXT");
    const txtRow = page.locator(".book-row", { hasText: books.txt }).first();
    await expect(txtRow).toBeVisible();
    await expectFallbackCover(txtRow);

    await page.locator("#searchInput").fill("Reader E2E Small PDF");
    const pdfRow = page.locator(".book-row", { hasText: books.pdf }).first();
    await expect(pdfRow).toBeVisible();
    await expectFallbackCover(pdfRow);
    await maybeScreenshot(page, testInfo, "library-with-fallback-covers");
  });

  test("broken cover URL gracefully falls back", async ({ page }) => {
    await page.route("**/api/books/*/cover", (route) => route.fulfill({ status: 404, body: "missing" }));
    await openLibrary(page);
    const row = page.locator(".book-row", { hasText: books.simple }).first();
    await expect(row).toBeVisible();
    await expectFallbackCover(row);
    await page.unroute("**/api/books/*/cover");
  });

  test("home continue card shows cover", async ({ page }, testInfo) => {
    await resetBookPosition("simple.epub", JSON.stringify({ type: "text", sectionIndex: 0, scrollRatio: 0.33 }), 33);
    await page.goto("/");
    const hero = page.locator(".continue-hero", { hasText: books.simple }).first();
    await expect(hero).toBeVisible();
    await expectLoadedCover(hero);
    await maybeScreenshot(page, testInfo, "home-continue-card-with-cover");
  });

  test("library management actions are visible and work", async ({ page }, testInfo) => {
    await openLibrary(page);
    const cover = page.locator(".book-row", { hasText: books.rename }).locator(".book-cover").first();
    await expect(cover).toBeVisible();
    await maybeScreenshot(page, testInfo, "library-card-cover-fallback");

    await openBookActions(page, books.rename);
    await expectLoadedCover(page.locator(".bottom-sheet"));
    await maybeScreenshot(page, testInfo, "book-actions-sheet");
    await page.locator("#sheetEdit").click();
    await page.locator("#bookTitleInput").fill("Reader E2E Renamed EPUB");
    await page.locator("#confirmBookEdit").click();
    await page.locator("#searchInput").fill("Reader E2E Renamed EPUB");
    const renamedRow = page.locator(".book-row", { hasText: "Reader E2E Renamed EPUB" }).first();
    await expect(renamedRow).toBeVisible();
    await expectLoadedCover(renamedRow);

    await openBookActions(page, books.move);
    await page.locator("#sheetMove").click();
    await page.locator("[data-sheet-folder]").filter({ hasText: "E2E Folder" }).click();
    await page.locator("#confirmMove").click();
    await expect(page.locator(".toast")).toContainText(/Moved|Saved|Updated/i);
    await page.locator("#searchInput").fill(books.move);
    await expectFallbackCover(page.locator(".book-row", { hasText: books.move }).first());

    await openBookActions(page, books.delete);
    await page.locator("#sheetRemove").click();
    await page.locator("#confirmRemove").click();
    await expect(page.locator(".book-row", { hasText: books.delete })).toHaveCount(0);
    await maybeScreenshot(page, testInfo, "library-management");
  });

  test.skip("duplicate fixture upload path requires Telegram bot document transport", async () => {
    // Local e2e seeds books directly into the backend cache. Telegram document
    // upload/dedup is covered by backend/bot tests, not browser e2e.
  });
});

async function runFixtureExperiment(
  page: Page,
  testInfo: { project: { name: string } },
  fixture: { fixture: string; title: string; format: string },
): Promise<void> {
  const errors: string[] = [];
  let opened = false;
  let visibleTextLength = 0;
  let progressVisible = false;
  let positionRestore = false;
  let fontSizeWorks = false;
  let pdfCanvasQuality: boolean | null = fixture.format === "pdf" ? false : null;
  let screenshotPath: string | null = null;
  const capturePageError = (error: Error) => errors.push(`pageerror: ${error.message}`);
  const captureConsoleError = (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() === "error" && !isExpectedSandboxBlock(text)) errors.push(`console: ${text}`);
  };
  page.on("pageerror", capturePageError);
  page.on("console", captureConsoleError);

  try {
    await resetFixturePosition(fixture.fixture, fixture.format);
    if (fixture.format !== "pdf") {
      await page.addInitScript(() => window.localStorage.setItem("telegram-library-reader-font-size", "18"));
    }
    await openBook(page, fixture.title);
    opened = (await page.locator("#readerStage").isVisible().catch(() => false)) && (await page.locator(".reader-error").count()) === 0;
    progressVisible = await page.locator("#readerBottomProgress").isVisible().catch(() => false);
    visibleTextLength = await waitForReaderVisibleTextLength(page, fixture.format);
    if (!opened) errors.push("reader did not open cleanly");
    if (!progressVisible) errors.push("bottom progress was not visible");
    if (fixture.format !== "pdf" && visibleTextLength < 200) {
      errors.push(`visible text too short: ${visibleTextLength}`);
    }

    if (fixture.format === "pdf") {
      pdfCanvasQuality = await page.locator(".pdf-canvas").evaluate((canvasElement: HTMLCanvasElement) => {
        const cssWidth = Number.parseFloat(canvasElement.style.width);
        const cssHeight = Number.parseFloat(canvasElement.style.height);
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        return (
          Number.isFinite(cssWidth) &&
          Number.isFinite(cssHeight) &&
          canvasElement.width >= Math.floor(cssWidth * dpr) - 2 &&
          canvasElement.height >= Math.floor(cssHeight * dpr) - 2
        );
      }).catch((error) => {
        errors.push(String(error));
        return false;
      });
      positionRestore = await checkPdfPositionRestore(page, fixture.title, errors);
    } else {
      const beforeFont = await waitForOptionalReaderFontSize(page);
      const settingsButton = page.locator("#readerSettingsButton");
      const fontUpButton = page.locator("#readerFontUp");
      if (!(await settingsButton.isVisible().catch(() => false))) {
        await page.locator("#readerStage").click({ position: { x: 180, y: 260 }, timeout: 500 }).catch(() => undefined);
        await settingsButton.waitFor({ state: "visible", timeout: 1000 }).catch(() => undefined);
      }
      if (await settingsButton.isVisible().catch(() => false)) {
        await settingsButton.click({ timeout: 500 }).catch(() => undefined);
        await fontUpButton.waitFor({ state: "visible", timeout: 1000 }).catch(() => undefined);
        await fontUpButton.click({ timeout: 500 }).catch(() => undefined);
        await page.waitForTimeout(150);
      }
      const afterFont = await optionalReaderFontSize(page);
      fontSizeWorks = beforeFont !== null && afterFont !== null ? afterFont > beforeFont : false;
      if (!fontSizeWorks) {
        errors.push(`font size did not change observably: before=${beforeFont ?? "unknown"} after=${afterFont ?? "unknown"}`);
      }
      await page.locator('[data-reader-theme="sepia"]').click({ timeout: 500 }).catch(() => undefined);
      await expectReadableButton(settingsButton).catch((error) => errors.push(`theme contrast check failed: ${error.message}`));
      await quickCloseSheet(page);
      positionRestore = await checkTextPositionRestore(page, fixture.title, errors);
    }
    if (!positionRestore) errors.push("position restore did not return to the exercised location");

    screenshotPath = await saveExperimentScreenshot(page, testInfo, fixture.fixture);
    await page.locator("#backButton").click({ timeout: 500 }).catch(() => undefined);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    screenshotPath = await saveExperimentScreenshot(page, testInfo, fixture.fixture).catch(() => null);
    await page.locator("#backButton").click({ timeout: 500 }).catch(() => undefined);
  }
  page.off("pageerror", capturePageError);
  page.off("console", captureConsoleError);

  experimentRecords.push({
    fixture: fixture.fixture,
    title: fixture.title,
    format: fixture.format,
    engine: experimentFlags.textReaderEngine,
    renderMode: experimentFlags.textRenderMode,
    pdfReaderMode: experimentFlags.pdfReaderMode,
    readerUi: experimentFlags.readerUi,
    opened,
    visibleTextLength,
    progressVisible,
    positionRestore,
    fontSizeWorks,
    pdfCanvasQuality,
    screenshotPath,
    errors,
  });
}

function isExpectedSandboxBlock(message: string): boolean {
  return message.includes("Blocked script execution") && message.includes("allow-scripts");
}

async function openLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#libraryNav").click();
  await expect(page.locator(".book-row").first()).toBeVisible();
}

async function openBook(page: Page, title: string): Promise<void> {
  await openLibrary(page);
  await page.locator("#searchInput").fill(title);
  const row = page.locator(".book-row", { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#readerStage")).toBeVisible();
}

async function leaveReader(page: Page): Promise<void> {
  await page.locator("#backButton").click();
  await expect(page.locator("#libraryNav")).toBeVisible();
}

async function openBookActions(page: Page, title: string): Promise<void> {
  await openLibrary(page);
  await page.locator("#searchInput").fill(title);
  const row = page.locator(".book-row", { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.locator("[data-row-menu]").click();
  await expect(page.locator(".bottom-sheet")).toBeVisible();
}

async function expectLoadedCover(scope: ReturnType<Page["locator"]>): Promise<void> {
  const cover = scope.locator(".book-cover").first();
  await expect(cover).toBeVisible();
  await expect(cover.locator(".cover-image:not(.cover-image-broken)")).toBeVisible();
  await expect(cover).not.toHaveClass(/cover-fallback-active/);
}

async function expectFallbackCover(scope: ReturnType<Page["locator"]>): Promise<void> {
  const cover = scope.locator(".book-cover").first();
  await expect(cover).toBeVisible();
  await expect(cover).toHaveClass(/cover-fallback-active/);
  await expect(cover.locator(".cover-initials")).toBeVisible();
  await expect(cover.locator(".cover-title")).toBeVisible();
}

async function waitForBookFrame(page: Page): Promise<FrameLocator> {
  const frame = page.frameLocator(".book-frame");
  await expect(frame.locator("body")).toBeVisible();
  return frame;
}

async function expectVisibleText(frame: FrameLocator, threshold: number): Promise<void> {
  await expect.poll(async () => (await frame.locator("body").innerText()).trim().length).toBeGreaterThan(threshold);
}

async function bodyFontSize(frame: FrameLocator): Promise<number> {
  return frame.locator("body").evaluate((body) => Number.parseFloat(getComputedStyle(body).fontSize));
}

async function scrollBookFrame(frame: FrameLocator, ratio: number): Promise<void> {
  await frame.locator("body").evaluate((body, nextRatio) => {
    const scroller = document.scrollingElement ?? document.documentElement ?? body;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    scroller.scrollTop = maxScroll * nextRatio;
    window.dispatchEvent(new Event("scroll"));
  }, ratio);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function frameScrollRatio(frame: FrameLocator): Promise<number> {
  return frame.locator("body").evaluate((body) => {
    const scroller = document.scrollingElement ?? document.documentElement ?? body;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    return maxScroll <= 0 ? 0 : scroller.scrollTop / maxScroll;
  });
}

async function progressPercent(page: Page): Promise<number> {
  const text = await page.locator("#readerBottomPercent").innerText();
  return Number.parseFloat(text.replace("%", "")) || 0;
}

async function checkTextPositionRestore(page: Page, title: string, errors: string[]): Promise<boolean> {
  const before = await readerPositionSignature(page);
  const next = page.locator("#readerNext");
  if (await next.isVisible().catch(() => false)) {
    const disabled = await next.evaluate((button: HTMLButtonElement) => button.disabled).catch(() => true);
    if (!disabled) await next.click({ timeout: 700 }).catch((error) => errors.push(`next failed: ${error.message}`));
  }
  await page.waitForTimeout(800);
  let exercised = await readerPositionSignature(page);
  if (!positionMoved(before, exercised)) {
    await scrollCurrentReader(page, 0.6);
    await page.waitForTimeout(800);
    exercised = await readerPositionSignature(page);
  }
  if (!positionMoved(before, exercised)) {
    errors.push(`text position did not move from "${before.label}" (${before.percent}%)`);
    return false;
  }
  await leaveReader(page);
  await openBook(page, title);
  await page.waitForTimeout(800);
  const restored = await readerPositionSignature(page);
  if (positionsMatch(exercised, restored)) return true;
  errors.push(
    `text restore mismatch: exercised="${exercised.label}" ${exercised.percent}%, restored="${restored.label}" ${restored.percent}%`,
  );
  return false;
}

async function checkPdfPositionRestore(page: Page, title: string, errors: string[]): Promise<boolean> {
  const before = await readerPositionSignature(page);
  const next = page.locator("#readerNext");
  if (await next.isVisible().catch(() => false)) await next.click({ timeout: 700 }).catch((error) => errors.push(`pdf next failed: ${error.message}`));
  await page.waitForTimeout(800);
  const exercised = await readerPositionSignature(page);
  if (!positionMoved(before, exercised)) {
    errors.push(`pdf page did not move from "${before.label}"`);
    return false;
  }
  await leaveReader(page);
  await openBook(page, title);
  await page.waitForTimeout(800);
  const restored = await readerPositionSignature(page);
  if (positionsMatch(exercised, restored)) return true;
  errors.push(`pdf restore mismatch: exercised="${exercised.label}", restored="${restored.label}"`);
  return false;
}

async function readerPositionSignature(page: Page): Promise<{ label: string; percent: number }> {
  const label = (await page.locator("#readerBottomLabel").innerText().catch(() => "")).trim();
  return { label, percent: await progressPercent(page).catch(() => 0) };
}

function positionMoved(before: { label: string; percent: number }, after: { label: string; percent: number }): boolean {
  return before.label !== after.label || Math.abs(after.percent - before.percent) >= 1;
}

function positionsMatch(expected: { label: string; percent: number }, actual: { label: string; percent: number }): boolean {
  if (expected.label && expected.label === actual.label) return true;
  return Math.abs(expected.percent - actual.percent) <= 2 && actual.percent > 0;
}

async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  const scrim = page.locator("#sheetScrim");
  if (await scrim.count()) await scrim.click({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await expect(page.locator(".bottom-sheet")).toHaveCount(0);
}

async function quickCloseSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  const scrim = page.locator("#sheetScrim");
  if ((await scrim.count().catch(() => 0)) > 0) await scrim.click({ position: { x: 4, y: 4 }, timeout: 500 }).catch(() => undefined);
}

async function expectReadableButton(locator: ReturnType<Page["locator"]>): Promise<void> {
  await expect(locator).toBeVisible();
  const readable = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.color !== "rgba(0, 0, 0, 0)" && style.opacity !== "0" && box.width > 0 && box.height > 0;
  });
  expect(readable).toBe(true);
}

async function canvasCssWidth(page: Page): Promise<number> {
  return page.locator(".pdf-canvas").evaluate((canvas) => Number.parseFloat((canvas as HTMLCanvasElement).style.width));
}

async function openPdfSettings(page: Page): Promise<void> {
  const settings = page.locator("#readerSettingsButton");
  if (!(await settings.isVisible().catch(() => false))) {
    await page.locator("#readerStage").click({ position: { x: 180, y: 260 }, timeout: 500 }).catch(() => undefined);
  }
  await settings.click();
  await expect(page.locator(".reader-settings-sheet")).toBeVisible();
}

async function expectPdfFitWidth(page: Page): Promise<void> {
  const fits = await page.locator(".pdf-canvas").evaluate((canvasElement: HTMLCanvasElement) => {
    const stage = document.querySelector<HTMLElement>("#readerStage");
    if (!stage) return false;
    const cssWidth = Number.parseFloat(canvasElement.style.width);
    return Number.isFinite(cssWidth) && cssWidth <= stage.clientWidth + 3 && stage.scrollWidth <= stage.clientWidth + 3;
  });
  expect(fits).toBe(true);
}

async function canvasNonBlankScore(page: Page): Promise<number> {
  return page.locator(".pdf-canvas").evaluate((canvasElement: HTMLCanvasElement) => {
    if (canvasElement.width <= 0 || canvasElement.height <= 0) return 0;
    const sample = document.createElement("canvas");
    sample.width = 96;
    sample.height = 128;
    const context = sample.getContext("2d");
    if (!context) return 0;
    context.drawImage(canvasElement, 0, 0, sample.width, sample.height);
    const image = context.getImageData(0, 0, sample.width, sample.height).data;
    let nonWhite = 0;
    for (let index = 0; index < image.length; index += 16) {
      const red = image[index] ?? 255;
      const green = image[index + 1] ?? 255;
      const blue = image[index + 2] ?? 255;
      const alpha = image[index + 3] ?? 0;
      if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) nonWhite += 1;
    }
    return nonWhite;
  });
}

async function maybeScreenshot(page: Page, testInfo: { project: { name: string } }, name: string): Promise<void> {
  if (!saveScreenshots) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDir, `${testInfo.project.name}-${name}.png`),
    fullPage: true,
  });
}

async function maybeScreenshotIfVisible(
  page: Page,
  testInfo: { project: { name: string } },
  selector: string,
  name: string,
): Promise<void> {
  if (!saveScreenshots) return;
  if (!(await page.locator(selector).isVisible().catch(() => false))) return;
  await maybeScreenshot(page, testInfo, name);
}

async function maybeScreenshotElementIfVisible(
  page: Page,
  testInfo: { project: { name: string } },
  selector: string,
  name: string,
): Promise<void> {
  if (!saveScreenshots) return;
  const element = page.locator(selector).first();
  if (!(await element.isVisible().catch(() => false))) return;
  await page.waitForTimeout(300);
  mkdirSync(screenshotDir, { recursive: true });
  await element.screenshot({
    path: resolve(screenshotDir, `${testInfo.project.name}-${name}.png`),
  });
}

async function saveExperimentScreenshot(
  page: Page,
  testInfo: { project: { name: string } },
  fixtureName: string,
): Promise<string | null> {
  if (!reportScreenshotDir) return null;
  mkdirSync(reportScreenshotDir, { recursive: true });
  const safeName = fixtureName.replace(/[^a-z0-9_.-]/gi, "_");
  const path = resolve(reportScreenshotDir, `${testInfo.project.name}-${safeName}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function readerVisibleTextLength(page: Page, format: string): Promise<number> {
  if (format === "pdf") {
    return (await page.locator("#readerBottomLabel").innerText().catch(() => "")).trim().length;
  }
  const frameCount = await page.locator(".book-frame").count();
  if (frameCount > 0) {
    return page.locator(".book-frame").evaluateAll((iframes: HTMLIFrameElement[]) => {
      return Math.max(
        0,
        ...iframes.map((iframe) => {
          const doc = iframe.contentDocument;
          const candidates = [
            doc?.body?.innerText,
            doc?.body?.textContent,
            doc?.documentElement?.innerText,
            doc?.documentElement?.textContent,
          ];
          return Math.max(0, ...candidates.map((text) => (text ?? "").replace(/\s+/g, " ").trim().length));
        }),
      );
    }).catch(() => 0);
  }
  const foliateCount = await page.locator(".foliate-view-reader").count();
  if (foliateCount > 0) {
    return page.locator(".foliate-view-reader").evaluate((element) => {
      const texts: string[] = [];
      const collect = (root: ParentNode | null | undefined) => {
        if (!root) return;
        if (root instanceof Document) {
          texts.push(root.body?.innerText ?? "", root.body?.textContent ?? "", root.documentElement?.textContent ?? "");
        }
        if (root instanceof ShadowRoot && root.textContent) texts.push(root.textContent);
        root.querySelectorAll?.("iframe").forEach((iframe) => {
          if (iframe instanceof HTMLIFrameElement) {
            texts.push(
              iframe.contentDocument?.body?.innerText ?? "",
              iframe.contentDocument?.body?.textContent ?? "",
              iframe.contentDocument?.documentElement?.textContent ?? "",
            );
          }
        });
        root.querySelectorAll?.("*").forEach((node) => {
          const shadowRoot = (node as Element).shadowRoot;
          if (shadowRoot) collect(shadowRoot);
        });
      };
      collect(element.shadowRoot);
      collect(element);
      if (!texts.join("").trim() && element.textContent) texts.push(element.textContent);
      return texts.join("\n").trim().length;
    }).catch(() => 0);
  }
  return (await page.locator("#readerStage").innerText().catch(() => "")).trim().length;
}

async function waitForReaderVisibleTextLength(page: Page, format: string): Promise<number> {
  const threshold = format === "pdf" ? 1 : 200;
  let latest = 0;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    latest = await readerVisibleTextLength(page, format);
    if (latest >= threshold) return latest;
    await page.waitForTimeout(100);
  }
  return latest;
}

async function optionalReaderFontSize(page: Page): Promise<number | null> {
  const frameCount = await page.locator(".book-frame").count();
  if (frameCount > 0) {
    return page.locator(".book-frame").evaluateAll((iframes: HTMLIFrameElement[]) => {
      const sizes = iframes.flatMap((iframe) => {
        const rect = iframe.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return [];
        const body = iframe.contentDocument?.body;
        const root = iframe.contentDocument?.documentElement;
        const bodySize = body ? Number.parseFloat(getComputedStyle(body).fontSize) : Number.NaN;
        const rootSize = root ? Number.parseFloat(getComputedStyle(root).fontSize) : Number.NaN;
        return [bodySize, rootSize].filter(Number.isFinite);
      });
      return sizes.length ? Math.max(...sizes) : null;
    }).catch(() => null);
  }
  const foliateCount = await page.locator(".foliate-view-reader").count();
  if (foliateCount > 0) {
    return page.locator(".foliate-view-reader").evaluate((element) => {
      const hostSize = Number.parseFloat(getComputedStyle(element).fontSize);
      const shadow = element.shadowRoot;
      const iframe = shadow?.querySelector("iframe") ?? element.querySelector("iframe");
      const body = iframe instanceof HTMLIFrameElement ? iframe.contentDocument?.body : null;
      const bodySize = body ? Number.parseFloat(getComputedStyle(body).fontSize) : Number.NaN;
      if (Number.isFinite(bodySize)) return bodySize;
      return Number.isFinite(hostSize) ? hostSize : null;
    }).catch(() => null);
  }
  return null;
}

async function waitForOptionalReaderFontSize(page: Page): Promise<number | null> {
  let latest: number | null = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    latest = await optionalReaderFontSize(page);
    if (latest !== null) return latest;
    await page.waitForTimeout(100);
  }
  return latest;
}

async function scrollCurrentReader(page: Page, ratio: number): Promise<void> {
  const frameCount = await page.locator(".book-frame").count();
  if (frameCount > 0) {
    await page.locator(".book-frame").evaluate((iframe: HTMLIFrameElement, nextRatio) => {
      const doc = iframe.contentDocument;
      const scroller = doc?.scrollingElement ?? doc?.documentElement ?? doc?.body;
      if (!scroller) return;
      const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
      scroller.scrollTop = maxScroll * nextRatio;
      iframe.contentWindow?.dispatchEvent(new Event("scroll"));
    }, ratio);
    await page.waitForTimeout(250);
    return;
  }
  await page.locator("#readerStage").evaluate((stage, nextRatio) => {
    const maxScroll = Math.max(stage.scrollHeight - stage.clientHeight, 0);
    stage.scrollTop = maxScroll * nextRatio;
    stage.dispatchEvent(new Event("scroll"));
  }, ratio).catch(() => undefined);
}

function parseExperimentFlags(): ExperimentFlags {
  try {
    const parsed = JSON.parse(process.env.READER_E2E_FLAGS_JSON ?? "{}") as Partial<ExperimentFlags>;
    return {
      textReaderEngine: parsed.textReaderEngine ?? process.env.VITE_TEXT_READER_ENGINE ?? "custom",
      textRenderMode: parsed.textRenderMode ?? process.env.VITE_TEXT_RENDER_MODE ?? "clean",
      pdfReaderMode: parsed.pdfReaderMode ?? process.env.VITE_PDF_READER_MODE ?? "canvas",
      readerUi: parsed.readerUi ?? process.env.VITE_READER_UI ?? "v1",
    };
  } catch {
    return { textReaderEngine: "custom", textRenderMode: "clean", pdfReaderMode: "canvas", readerUi: "v1" };
  }
}

function readSeedEnv(): SeedEnv | null {
  const path = process.env.READER_E2E_ENV_PATH;
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as SeedEnv;
}

async function resetFixturePosition(fixture: string, format: string): Promise<void> {
  if (format === "pdf") return resetBookPosition(fixture, "1", 0);
  if (format === "txt") return resetBookPosition(fixture, JSON.stringify({ type: "txt", scrollRatio: 0 }), 0);
  return resetBookPosition(fixture, JSON.stringify({ type: "text", sectionIndex: 0, scrollRatio: 0 }), 0);
}

async function resetBookPosition(fixture: string, locator: string, percent: number): Promise<void> {
  if (!envPayload) return;
  const bookId = envPayload.books[fixture];
  if (!bookId) return;
  const response = await fetch(`${envPayload.apiBase}/api/books/${bookId}/position`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": envPayload.initData,
    },
    body: JSON.stringify({ locator, percent }),
  });
  if (!response.ok) throw new Error(`Could not reset ${fixture} position: HTTP ${response.status}`);
}

function writeExperimentReport(): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runName: process.env.READER_E2E_RUN_NAME ?? null,
        project: process.env.PLAYWRIGHT_PROJECT_NAME ?? null,
        flags: experimentFlags,
        records: experimentRecords,
      },
      null,
      2,
    )}\n`,
  );
}

expect.extend({
  async toPassCanvasDprCheck(locator) {
    const pass = await locator.evaluate((canvasElement: HTMLCanvasElement) => {
      const cssWidth = Number.parseFloat(canvasElement.style.width);
      const cssHeight = Number.parseFloat(canvasElement.style.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      return (
        Number.isFinite(cssWidth) &&
        Number.isFinite(cssHeight) &&
        canvasElement.width >= Math.floor(cssWidth * dpr) - 2 &&
        canvasElement.height >= Math.floor(cssHeight * dpr) - 2
      );
    });
    return {
      pass,
      message: () => "expected PDF canvas backing store to match clamped DPR",
    };
  },
});

declare global {
  namespace PlaywrightTest {
    interface Matchers<R> {
      toPassCanvasDprCheck(): R;
    }
  }
}
