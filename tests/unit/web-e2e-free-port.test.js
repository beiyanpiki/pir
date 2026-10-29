import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort } from "../web-e2e/free-port.js";

const configPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../web-e2e/playwright.config.js",
);

function bindable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

/** Hold a port for the duration of a test; null when something else already does. */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve(() => new Promise((done) => server.close(done)));
    });
  });
}

test("freePort returns a port the dev server can actually bind", async () => {
  const port = freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `not a port: ${port}`);
  await bindable(port);
});

test("the config does not reuse the port a stranded dev server still holds", async () => {
  // The runner failure this guards against: an earlier run's vite server
  // survived and the next run died with "http://127.0.0.1:5174/ is already
  // used" before its first test, because the port was a fixed constant.
  const release = await holdPort(5174);
  try {
    delete process.env.PIR_WEB_E2E_PORT;
    const { default: config } = await import("../web-e2e/playwright.config.js");
    const port = Number(new URL(config.use.baseURL).port);
    assert.notEqual(port, 5174);
    // baseURL, the wait URL and the vite command must all name the same port.
    assert.equal(config.webServer.url, `http://127.0.0.1:${port}/`);
    assert.ok(config.webServer.command.includes(`--port ${port}`), config.webServer.command);
    await bindable(port);
  } finally {
    if (release) await release();
  }
});

test("re-evaluating the config keeps the port (Playwright reloads it per worker)", async () => {
  // The first version of this fix computed a fresh free port on every module
  // evaluation. Playwright re-evaluates the config in each worker process, so
  // the workers' baseURL pointed at a port the dev server never listened on and
  // CI died with net::ERR_CONNECTION_REFUSED on 13 of 15 tests.
  delete process.env.PIR_WEB_E2E_PORT;
  const url = pathToFileURL(configPath).href;
  const first = (await import(`${url}?worker=1`)).default;
  const pinned = process.env.PIR_WEB_E2E_PORT;
  const second = (await import(`${url}?worker=2`)).default;
  assert.ok(pinned, "the config must pin the port it chose for later evaluations");
  assert.equal(new URL(second.use.baseURL).port, new URL(first.use.baseURL).port);
  assert.equal(second.webServer.url, first.webServer.url);
});

test("PIR_WEB_E2E_PORT still pins the port for debugging", () => {
  const script = `import config from ${JSON.stringify(pathToFileURL(configPath).href)};
    process.stdout.write(config.use.baseURL);`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PIR_WEB_E2E_PORT: "6123" },
  });
  assert.equal(stdout, "http://127.0.0.1:6123/");
});
