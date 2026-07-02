type PerfEntry = {
  name: string;
  startTime: number;
  duration: number;
};

type PerfSummary = {
  entries: PerfEntry[];
  latest: PerfEntry[];
  byName: Array<{
    name: string;
    count: number;
    avgMs: number;
    maxMs: number;
    lastMs: number;
  }>;
};

const MAX_ENTRIES = 240;
const OVERLAY_ID = "perfOverlay";
const marks = new Map<string, number>();
const entries: PerfEntry[] = [];
let overlayFrame = 0;
let globalHookInstalled = false;

export function mark(name: string): number {
  const now = performance.now();
  marks.set(name, now);
  try {
    performance.mark(name);
  } catch {
    // Browser performance marks are best-effort; the in-memory map is authoritative.
  }
  scheduleOverlayUpdate();
  return now;
}

export function measure(name: string, start: string, end: string): number | null {
  const startTime = marks.get(start);
  const endTime = marks.get(end);
  if (startTime === undefined || endTime === undefined) return null;
  const duration = Math.max(0, endTime - startTime);
  entries.push({ name, startTime, duration });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  try {
    performance.measure(name, start, end);
  } catch {
    // Native performance.measure may reject duplicate/missing marks across browsers.
  }
  scheduleOverlayUpdate();
  return duration;
}

export async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = `${name}_start`;
  const end = `${name}_end`;
  mark(start);
  try {
    return await fn();
  } finally {
    mark(end);
    measure(name, start, end);
  }
}

export function reportPerfSummary(): PerfSummary {
  const summary = buildSummary();
  if (isPerfEnabled()) {
    console.table(
      summary.byName.map((entry) => ({
        name: entry.name,
        count: entry.count,
        avgMs: entry.avgMs.toFixed(1),
        maxMs: entry.maxMs.toFixed(1),
        lastMs: entry.lastMs.toFixed(1),
      })),
    );
    updateOverlay(summary);
  }
  return summary;
}

function isPerfEnabled(): boolean {
  try {
    return (
      window.localStorage.getItem("telegram-library-debug-perf") === "1" ||
      new URLSearchParams(window.location.search).get("debugPerf") === "1"
    );
  } catch {
    return false;
  }
}

function buildSummary(): PerfSummary {
  const groups = new Map<string, PerfEntry[]>();
  entries.forEach((entry) => {
    const group = groups.get(entry.name) ?? [];
    group.push(entry);
    groups.set(entry.name, group);
  });
  return {
    entries: [...entries],
    latest: entries.slice(-12),
    byName: [...groups.entries()]
      .map(([name, group]) => {
        const total = group.reduce((sum, entry) => sum + entry.duration, 0);
        const last = group[group.length - 1]!;
        return {
          name,
          count: group.length,
          avgMs: total / group.length,
          maxMs: Math.max(...group.map((entry) => entry.duration)),
          lastMs: last.duration,
        };
      })
      .sort((left, right) => right.lastMs - left.lastMs),
  };
}

function scheduleOverlayUpdate(): void {
  if (!isPerfEnabled()) return;
  installGlobalHook();
  if (overlayFrame) return;
  overlayFrame = window.requestAnimationFrame(() => {
    overlayFrame = 0;
    updateOverlay(buildSummary());
  });
}

function updateOverlay(summary: PerfSummary): void {
  if (!isPerfEnabled() || !document.body) return;
  const overlay = ensureOverlay();
  const rows = summary.latest
    .map((entry) => `${entry.name.padEnd(28).slice(0, 28)} ${entry.duration.toFixed(0).padStart(5)}ms`)
    .join("\n");
  overlay.querySelector<HTMLElement>("[data-perf-rows]")!.textContent = rows || "Waiting for timings...";
}

function ensureOverlay(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) return existing;
  const overlay = document.createElement("aside");
  overlay.id = OVERLAY_ID;
  overlay.className = "perf-overlay";
  overlay.setAttribute("aria-label", "Performance debug timings");

  const title = document.createElement("strong");
  title.textContent = "Perf";
  const rows = document.createElement("pre");
  rows.dataset.perfRows = "true";
  overlay.append(title, rows);
  document.body.append(overlay);
  return overlay;
}

function installGlobalHook(): void {
  if (globalHookInstalled) return;
  globalHookInstalled = true;
  Object.defineProperty(window, "TelegramLibraryPerf", {
    configurable: true,
    value: {
      reportPerfSummary,
      entries: () => [...entries],
    },
  });
}
