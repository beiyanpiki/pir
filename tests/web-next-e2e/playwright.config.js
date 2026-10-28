import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.PIR_WEB_NEXT_E2E_PORT ?? "5176";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: path.join(root, "test-results/web-next-report"), open: "never" }]],
  outputDir: path.join(root, "test-results/web-next-artifacts"),
  use: {
    // The workspace is mounted at /next/ while the legacy app keeps "/".
    baseURL: `http://127.0.0.1:${port}/next/`,
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
    command: `npm run dev -w web-next -- --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: { npm_config_cache: "/tmp/pir-npm-cache" },
    url: `http://127.0.0.1:${port}/next/`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});