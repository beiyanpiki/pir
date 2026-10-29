import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freePort } from "./free-port.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Per-run port by default: a stranded dev server from an earlier run must not
// fail this one before its first test. PIR_WEB_E2E_PORT pins it for debugging.
//
// Pinning the environment too is load-bearing: Playwright re-evaluates this file
// in every worker process, and a bare freePort() would hand each worker a
// different port than the one the dev server listens on — the suite then dies on
// net::ERR_CONNECTION_REFUSED. Workers inherit this process's environment, so
// one pin is enough.
const port = process.env.PIR_WEB_E2E_PORT ?? String(freePort());
process.env.PIR_WEB_E2E_PORT = port;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: path.join(root, "test-results/web-report"), open: "never" }]],
  outputDir: path.join(root, "test-results/web-artifacts"),
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      // Shared /dev/shm is tiny in containers and on some CI runners; Chromium
      // crashes to a blank renderer without this.
      args: ["--disable-dev-shm-usage"],
      ...(process.env.PIR_PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PIR_PLAYWRIGHT_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: `npm run dev -w web -- --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: { npm_config_cache: "/tmp/pir-npm-cache" },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    // The command goes through npm, which spawns vite as its child. SIGKILL
    // (the default) can orphan that child and leave the server behind; SIGTERM
    // lets npm shut it down first, which is what keeps a shared runner clean.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 90_000,
  },
});