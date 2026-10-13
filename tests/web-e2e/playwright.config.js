import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "test-results/web-report", open: "never" }]],
  outputDir: "test-results/web-artifacts",
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    launchOptions: { executablePath: "/usr/bin/google-chrome" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -w web -- --host 127.0.0.1 --port 5174",
    cwd: root,
    env: { npm_config_cache: "/tmp/pir-npm-cache" },
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
