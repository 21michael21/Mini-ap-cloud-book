import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const miniappDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(miniappDir, "..");
const args = process.argv.slice(2);
const projectArgIndex = args.indexOf("--project");
const projectEqualsArg = args.find((arg) => arg.startsWith("--project="));
const project = projectArgIndex >= 0 ? args[projectArgIndex + 1] : projectEqualsArg?.split("=", 2)[1] ?? "desktop";
const screenshots = args.includes("--screenshots");
const allEngines = args.includes("--all-engines");
const python = process.env.PYTHON || resolve(repoDir, ".venv/bin/python");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  return equals ? equals.split("=", 2)[1] : fallback;
}

function readModeConfig(overrides = {}) {
  return {
    textReaderEngine:
      overrides.textReaderEngine ??
      argValue("--text-reader-engine", process.env.VITE_TEXT_READER_ENGINE ?? process.env.VITE_READER_ENGINE ?? "custom"),
    textRenderMode: overrides.textRenderMode ?? argValue("--text-render-mode", process.env.VITE_TEXT_RENDER_MODE ?? "clean"),
    pdfReaderMode: overrides.pdfReaderMode ?? argValue("--pdf-reader-mode", process.env.VITE_PDF_READER_MODE ?? "canvas"),
    readerUi: overrides.readerUi ?? argValue("--reader-ui", process.env.VITE_READER_UI ?? "v2"),
  };
}

const allEngineMatrix = [
  { name: "custom-clean-v2", textReaderEngine: "custom", textRenderMode: "clean", pdfReaderMode: "canvas", readerUi: "v2" },
  { name: "custom-original-v2", textReaderEngine: "custom", textRenderMode: "original", pdfReaderMode: "canvas", readerUi: "v2" },
  { name: "foliate-view-clean-v2", textReaderEngine: "foliate-view", textRenderMode: "clean", pdfReaderMode: "canvas", readerUi: "v2" },
];

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: options.cwd ?? repoDir,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? "inherit",
  });
}

function runJson(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? repoDir,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function spawnProcess(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? repoDir,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`${command} exited with ${code}`);
    if (signal) console.error(`${command} exited with ${signal}`);
  });
  return child;
}

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const request = http.get(url, (response) => {
          response.resume();
          if ((response.statusCode ?? 500) < 500) resolvePromise();
          else rejectPromise(new Error(`HTTP ${response.statusCode}`));
        });
        request.on("error", rejectPromise);
        request.setTimeout(1000, () => {
          request.destroy(new Error("timeout"));
        });
      });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function stop(child) {
  if (!child.killed) child.kill("SIGTERM");
}

async function runOne(modeConfig, runName, allowFailure = false) {
  run(python, ["dev/generate_reader_fixtures.py"]);
  const envPayload = JSON.parse(runJson(python, ["dev/seed_e2e_reader.py", "--json"]));
  const backendEnv = {
    BOT_TOKEN: envPayload.botToken,
    DATABASE_URL: envPayload.databaseUrl,
    FILE_CACHE_DIR: envPayload.fileCacheDir,
    COVER_CACHE_DIR: envPayload.coverCacheDir,
    WEBAPP_URL: envPayload.webappUrl,
    BACKEND_PUBLIC_URL: envPayload.apiBase,
    INITDATA_MAX_AGE_SECONDS: "86400",
  };
  const viteEnv = {
    VITE_API_BASE: envPayload.apiBase,
    VITE_DEV_INIT_DATA: envPayload.initData,
    VITE_TEXT_READER_ENGINE: modeConfig.textReaderEngine,
    VITE_TEXT_RENDER_MODE: modeConfig.textRenderMode,
    VITE_PDF_READER_MODE: modeConfig.pdfReaderMode,
    VITE_READER_UI: modeConfig.readerUi,
  };

  const backend = spawnProcess(
    python,
    ["-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "18080"],
    { cwd: repoDir, env: backendEnv },
  );
  const vite = spawnProcess(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "15173"],
    { cwd: miniappDir, env: viteEnv },
  );

  let exitCode = 0;
  const reportPath = resolve(repoDir, "reports/reader-experiments", `${timestamp}-${runName}.json`);
  try {
    await waitFor(`${envPayload.apiBase}/health`);
    await waitFor(envPayload.webappUrl);
  const playwrightBin = resolve(miniappDir, "node_modules/.bin/playwright");
  if (!existsSync(playwrightBin)) {
    throw new Error("Playwright is not installed. Run `cd miniapp && npm install` first.");
  }
  const testArgs = ["test", "-c", "e2e/reader.playwright.config.ts"];
  if (project) testArgs.push("--project", project);
  const result = spawn(playwrightBin, testArgs, {
    cwd: miniappDir,
    env: {
      ...process.env,
      READER_E2E_BASE_URL: envPayload.webappUrl,
      READER_E2E_API_BASE: envPayload.apiBase,
      READER_E2E_ENV_PATH: resolve(repoDir, "dev/reader_e2e_env.json"),
      READER_E2E_SCREENSHOTS: screenshots ? "1" : "",
      READER_E2E_REPORT_PATH: reportPath,
      READER_E2E_RUN_NAME: runName,
      READER_E2E_FLAGS_JSON: JSON.stringify(modeConfig),
    },
    stdio: "inherit",
  });
  exitCode = await new Promise((resolvePromise) => {
    result.on("exit", (code) => resolvePromise(code ?? 1));
  });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      console.error("Install a local browser once with: cd miniapp && npx playwright install chromium");
    }
    exitCode = 1;
  } finally {
    stop(vite);
    stop(backend);
  }

  if (exitCode !== 0) {
    const envText = readFileSync(resolve(repoDir, "dev/reader_e2e_env.json"), "utf-8");
    console.error(`Reader e2e failed. Seed env was:\n${envText}`);
    if (!allowFailure) return exitCode;
  }
  console.log(`Reader experiment report: ${reportPath}`);
  return allowFailure ? 0 : exitCode;
}

function hasPrivateFixtures() {
  const privateDir = resolve(repoDir, "dev/reader_fixtures/private");
  if (!existsSync(privateDir)) return false;
  return readdirSync(privateDir, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name !== "README.md");
}

function runPrivateOne(modeConfig, runName, allowFailure = false) {
  const args = [
    "run",
    "e2e:reader:private",
    "--",
    `--text-reader-engine=${modeConfig.textReaderEngine}`,
    `--text-render-mode=${modeConfig.textRenderMode}`,
    `--pdf-reader-mode=${modeConfig.pdfReaderMode}`,
    `--reader-ui=${modeConfig.readerUi}`,
  ];
  try {
    run("npm", args, {
      cwd: miniappDir,
      env: {
        READER_PRIVATE_REPORT_SUFFIX: runName,
      },
    });
    return 0;
  } catch (error) {
    if (!allowFailure) throw error;
    return 0;
  }
}

let finalExitCode = 0;
if (allEngines) {
  const privateFixturesPresent = hasPrivateFixtures();
  for (const mode of allEngineMatrix) {
    console.log(`\n=== Reader experiment: ${mode.name} ===`);
    const code = await runOne(mode, mode.name, mode.textReaderEngine !== "custom");
    if (code !== 0) finalExitCode = code;
    if (privateFixturesPresent) {
      console.log(`\n=== Private reader fixtures: ${mode.name} ===`);
      const privateCode = runPrivateOne(mode, mode.name, mode.textReaderEngine !== "custom");
      if (privateCode !== 0) finalExitCode = privateCode;
    }
  }
} else {
  const config = readModeConfig();
  const runName = `${config.textReaderEngine}-${config.textRenderMode}-${config.pdfReaderMode}-${config.readerUi}`;
  finalExitCode = await runOne(config, runName);
}
process.exit(finalExitCode);
