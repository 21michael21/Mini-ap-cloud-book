import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const screenshotDir = resolve(repoDir, "tests/screenshots/artifacts");
const saveScreenshots = process.env.READER_E2E_SCREENSHOTS === "1";

const books = {
  epub: "Reader E2E Multi Section EPUB",
  fb2: "Reader E2E Long FB2",
  txt: "Reader E2E Long TXT",
  pdf: "Reader E2E Small PDF",
  rename: "Reader E2E Simple EPUB",
  delete: "Reader E2E Bad Markup EPUB",
  move: "Reader E2E CP1251 FB2",
};

test.describe("reader e2e", () => {
  test("EPUB opens, changes font, saves progress, and restores position", async ({ page }, testInfo) => {
    await openBook(page, books.epub);
    await expect(page.locator("#readerSettingsButton")).toBeVisible();
    await expect(page.locator("#readerBottomProgress")).toBeVisible();
    const frame = await waitForBookFrame(page);
    await expectVisibleText(frame, 400);
    await expect(page.locator("#readerBottomLabel")).toContainText(/Section|%/);

    const before = await bodyFontSize(frame);
    await page.locator("#readerSettingsButton").click();
    await page.locator("#readerFontUp").click();
    await expect.poll(() => bodyFontSize(frame)).toBeGreaterThan(before);
    await page.locator('[data-reader-theme="sepia"]').click();
    await expectReadableButton(page.locator("#readerSettingsButton"));
    await closeSheet(page);

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
    await openBook(page, books.pdf);
    const canvas = page.locator(".pdf-canvas");
    await expect(canvas).toBeVisible();
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await expect(page.locator("#readerPdfZoomIn")).toBeVisible();
    await expect(canvas).toPassCanvasDprCheck();

    const widthBefore = await canvasCssWidth(page);
    await page.locator("#readerPdfZoomIn").click();
    await expect.poll(() => canvasCssWidth(page)).toBeGreaterThan(widthBefore);
    await page.locator("#readerNext").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
    await page.locator("#readerPrev").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/1 \/ 2/);
    await page.locator("#readerNext").click();
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
    await maybeScreenshot(page, testInfo, "pdf-reader");

    await leaveReader(page);
    await openBook(page, books.pdf);
    await expect(page.locator("#readerBottomLabel")).toContainText(/2 \/ 2/);
  });

  test("library management actions are visible and work", async ({ page }, testInfo) => {
    await openLibrary(page);
    const cover = page.locator(".book-row", { hasText: books.rename }).locator(".book-cover").first();
    await expect(cover).toBeVisible();

    await openBookActions(page, books.rename);
    await page.locator("#sheetEdit").click();
    await page.locator("#bookTitleInput").fill("Reader E2E Renamed EPUB");
    await page.locator("#confirmBookEdit").click();
    await page.locator("#searchInput").fill("Reader E2E Renamed EPUB");
    await expect(page.locator(".book-row", { hasText: "Reader E2E Renamed EPUB" })).toBeVisible();

    await openBookActions(page, books.move);
    await page.locator("#sheetMove").click();
    await page.locator("[data-sheet-folder]").filter({ hasText: "E2E Folder" }).click();
    await page.locator("#confirmMove").click();
    await expect(page.locator(".toast")).toContainText(/Moved|Saved|Updated/i);

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

async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  const scrim = page.locator("#sheetScrim");
  if (await scrim.count()) await scrim.click({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await expect(page.locator(".bottom-sheet")).toHaveCount(0);
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

async function maybeScreenshot(page: Page, testInfo: { project: { name: string } }, name: string): Promise<void> {
  if (!saveScreenshots) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDir, `${testInfo.project.name}-${name}.png`),
    fullPage: true,
  });
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
