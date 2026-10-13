import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: process.env.PIR_WEB_REPORT_DIR ?? "/tmp/pir-web-live-report", open: "never" }]],
  outputDir: process.env.PIR_WEB_ARTIFACT_DIR ?? "/tmp/pir-web-live-artifacts",
  use: {
    baseURL: `http://127.0.0.1:${process.env.PIR_WEB_TEST_PORT ?? "5174"}`,
    browserName: "chromium",
    launchOptions: process.env.PIR_WEB_BROWSER_PATH ? { executablePath: process.env.PIR_WEB_BROWSER_PATH } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -w web -- --host 127.0.0.1 --port ${process.env.PIR_WEB_TEST_PORT ?? "5174"}`,
    cwd: root,
    env: { npm_config_cache: "/tmp/pir-npm-cache" },
    url: `http://127.0.0.1:${process.env.PIR_WEB_TEST_PORT ?? "5174"}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
