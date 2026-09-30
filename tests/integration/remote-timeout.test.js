import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

/**
 * #32: pir serve answers only once the enqueued task settles, and undici's
 * default headersTimeout (300 s) used to kill the client first with a bare
 * "fetch failed". These tests drive the real CLI against stub servers whose
 * header delay is controlled by the test, with PIR_REMOTE_TIMEOUT shrunk so
 * the whole thing runs in seconds.
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

test("remote: headers wait beyond PIR_REMOTE_TIMEOUT exits 3 naming the undici cause, not bare fetch failed", async (t) => {
  // The enqueued server task never settles: no status, no headers, ever.
  const server = http.createServer(() => {});
  await listen(server);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const failure = await execFileAsync(process.execPath, [CLI, "models", "--ids", "--server", base], {
    env: { ...process.env, PIR_REMOTE_TIMEOUT: "1" },
  }).then(
    () => assert.fail("expected the CLI to fail"),
    (err) => err,
  );
  assert.equal(failure.code, 3);
  assert.match(failure.stderr, /pir: cannot reach/);
  assert.match(failure.stderr, /UND_ERR_HEADERS_TIMEOUT/);
  assert.match(failure.stderr, /PIR_REMOTE_TIMEOUT/);
});

test("remote: a slow-headers server within PIR_REMOTE_TIMEOUT completes instead of dying at undici's 300 s default", async (t) => {
  // Headers arrive after 500 ms — slower than a tight timeout, well within
  // the raised one. Before #32's fix this path could not be configured at all.
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, output: "", log: [] }));
    }, 500);
  });
  await listen(server);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const { stdout } = await execFileAsync(process.execPath, [CLI, "models", "--ids", "--server", base], {
    env: { ...process.env, PIR_REMOTE_TIMEOUT: "30" },
  });
  assert.equal(stdout, "");
});
