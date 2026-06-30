import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const python = process.env.PYTHON || resolve(repoDir, ".venv/bin/python");

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
}
process.exit(exitCode);
