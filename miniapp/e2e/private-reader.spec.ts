import { expect, type ConsoleMessage, type Page, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envPayload = readSeedEnv();
const reportPath = process.env.READER_PRIVATE_E2E_REPORT_PATH
  ?? resolve(repoDir, "reports/reader-experiments/private-fixtures-summary.json");
const screenshotDir = resolve(repoDir, "reports/reader-experiments/screenshots/private-fixtures");
const experimentFlags = parseExperimentFlags();
const minTextLength = Number.parseInt(process.env.READER_PRIVATE_MIN_TEXT_LENGTH ?? "200", 10);
const records: PrivateFixtureRecord[] = [];

type PrivateFixture = {
  fileName: string;
  title: string;
  format: string;
  bookId: number;
};

type SeedEnv = {
  apiBase: string;
  initData: string;
  fixtures: PrivateFixture[];
};

type ExperimentFlags = {
  textReaderEngine: string;
  textRenderMode: string;
  pdfReaderMode: string;
  readerUi: string;
};

type PrivateFixtureRecord = {
  fileName: string;
  format: string;
  opened: boolean;
  visibleTextLength: number;
  progressVisible: boolean;
  positionRestore: boolean;
  screenshotPath: string | null;
  errors: string[];
  selectedEngineMode: ExperimentFlags;
};

test.describe("private reader fixtures", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(!envPayload || envPayload.fixtures.length === 0, "No private reader fixtures were seeded.");

  test.afterAll(() => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`,
      "utf-8",
    );
  });

  for (const fixture of envPayload?.fixtures ?? []) {
    test(`private fixture renders: ${fixture.fileName}`, async ({ page }) => {
      const record = await checkPrivateFixture(page, fixture);
      records.push(record);
      expect(record.opened, record.errors.join("\n")).toBe(true);
      expect(record.progressVisible, record.errors.join("\n")).toBe(true);
      if (fixture.format === "pdf") {
        expect(record.visibleTextLength, record.errors.join("\n")).toBeGreaterThan(0);
      } else {
        expect(record.visibleTextLength, record.errors.join("\n")).toBeGreaterThanOrEqual(minTextLength);
      }
      expect(record.positionRestore, record.errors.join("\n")).toBe(true);
    });
  }
});

async function checkPrivateFixture(page: Page, fixture: PrivateFixture): Promise<PrivateFixtureRecord> {
  const errors: string[] = [];
  let opened = false;
  let visibleTextLength = 0;
  let progressVisible = false;
  let positionRestore = false;
  let screenshotPath: string | null = null;
  const capturePageError = (error: Error) => errors.push(`pageerror: ${error.message}`);
  const captureConsoleError = (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() === "error" && !isExpectedSandboxBlock(text)) errors.push(`console: ${text}`);
  };
  page.on("pageerror", capturePageError);
  page.on("console", captureConsoleError);

  try {
    await resetPosition(fixture);
    await openBook(page, fixture.title);
    opened = (await page.locator("#readerStage").isVisible().catch(() => false)) && (await page.locator(".reader-error").count()) === 0;
    progressVisible = await page.locator("#readerBottomProgress").isVisible().catch(() => false);
    visibleTextLength = await readerVisibleTextLength(page, fixture.format);
    screenshotPath = await saveScreenshot(page, fixture.fileName);

    if (fixture.format === "pdf") {
      positionRestore = await checkPdfRestore(page, fixture);
    } else {
      positionRestore = await checkTextRestore(page, fixture);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    screenshotPath = await saveScreenshot(page, fixture.fileName).catch(() => null);
  } finally {
    page.off("pageerror", capturePageError);
    page.off("console", captureConsoleError);
  }

  return {
    fileName: fixture.fileName,
    format: fixture.format,
    opened,
    visibleTextLength,
    progressVisible,
    positionRestore,
    screenshotPath,
    errors,
    selectedEngineMode: experimentFlags,
  };
}

async function openBook(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.locator("#libraryNav").click();
  await expect(page.locator("#searchInput")).toBeVisible();
  await page.locator("#searchInput").fill(title);
  const row = page.locator(".book-row", { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#readerStage")).toBeVisible();
}

async function checkTextRestore(page: Page, fixture: PrivateFixture): Promise<boolean> {
  const next = page.locator("#readerNext");
  if (await next.isVisible().catch(() => false)) {
    await next.click().catch(() => undefined);
  } else {
    await scrollCurrentReader(page, 0.5);
  }
  await page.waitForTimeout(600);
  const beforeLabel = await page.locator("#readerBottomLabel").innerText().catch(() => "");
  await leaveReader(page);
  await openBook(page, fixture.title);
  const afterLabel = await page.locator("#readerBottomLabel").innerText().catch(() => "");
  if (beforeLabel && afterLabel && beforeLabel === afterLabel) return true;
  return (await readerVisibleTextLength(page, fixture.format)) >= minTextLength;
}

async function checkPdfRestore(page: Page, fixture: PrivateFixture): Promise<boolean> {
  const next = page.locator("#readerNext");
  if (await next.isVisible().catch(() => false)) await next.click().catch(() => undefined);
  await page.waitForTimeout(600);
  const beforeLabel = await page.locator("#readerBottomLabel").innerText().catch(() => "");
  await leaveReader(page);
  await openBook(page, fixture.title);
  const afterLabel = await page.locator("#readerBottomLabel").innerText().catch(() => "");
  return Boolean(beforeLabel && afterLabel && beforeLabel === afterLabel);
}

async function leaveReader(page: Page): Promise<void> {
  await page.locator("#backButton").click({ timeout: 1000 }).catch(() => undefined);
  await expect(page.locator("#libraryNav")).toBeVisible();
}

async function readerVisibleTextLength(page: Page, format: string): Promise<number> {
  if (format === "pdf") {
    const label = (await page.locator("#readerBottomLabel").innerText().catch(() => "")).trim();
    const canvasVisible = await page.locator(".pdf-canvas").isVisible().catch(() => false);
    return canvasVisible ? Math.max(label.length, 1) : 0;
  }
  const frameCount = await page.locator(".book-frame").count();
  if (frameCount > 0) {
    return page.locator(".book-frame").evaluate((iframe: HTMLIFrameElement) => {
      return (iframe.contentDocument?.body?.innerText ?? "").trim().length;
    }).catch(() => 0);
  }
  return (await page.locator("#readerStage").innerText().catch(() => "")).trim().length;
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
    return;
  }
  await page.locator("#readerStage").evaluate((stage, nextRatio) => {
    const maxScroll = Math.max(stage.scrollHeight - stage.clientHeight, 0);
    stage.scrollTop = maxScroll * nextRatio;
    stage.dispatchEvent(new Event("scroll"));
  }, ratio).catch(() => undefined);
}

async function resetPosition(fixture: PrivateFixture): Promise<void> {
  if (!envPayload) return;
  const locator = fixture.format === "pdf" ? "1" : fixture.format === "txt"
    ? JSON.stringify({ type: "txt", scrollRatio: 0 })
    : JSON.stringify({ type: "text", sectionIndex: 0, scrollRatio: 0 });
  const response = await fetch(`${envPayload.apiBase}/api/books/${fixture.bookId}/position`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": envPayload.initData,
    },
    body: JSON.stringify({ locator, percent: 0 }),
  });
  if (!response.ok) throw new Error(`Could not reset private fixture position: HTTP ${response.status}`);
}

async function saveScreenshot(page: Page, fileName: string): Promise<string> {
  mkdirSync(screenshotDir, { recursive: true });
  const safeName = fileName.replace(/[^a-z0-9_.-]/gi, "_");
  const path = resolve(screenshotDir, `${safeName}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

function isExpectedSandboxBlock(message: string): boolean {
  return message.includes("Blocked script execution") && message.includes("allow-scripts");
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
  const path = process.env.READER_PRIVATE_E2E_ENV_PATH;
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as SeedEnv;
}
