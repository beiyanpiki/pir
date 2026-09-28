import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXIT_MODULE = path.resolve("dist/cli/exit.js");

/** Child that writes `bytes` to stdout then calls drainAndExit(7). */
function spawnDrainer(bytes) {
  const script = `import(${JSON.stringify(pathToFileURL(EXIT_MODULE).href)}).then((m) => {
    process.stdout.write("x".repeat(${bytes}));
    m.drainAndExit(7);
  });`;
  return spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

function exitOf(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    // Deliberately never read from stdout/stderr.
  });
}

test("drainAndExit flushes small writes and exits with the given code", async () => {
  const { code, signal } = await exitOf(spawnDrainer(1024), 10_000);
  assert.equal(code, 7);
  assert.equal(signal, null);
});

test("drainAndExit still exits when the stdout reader never drains the pipe", async () => {
  const start = Date.now();
  // 1MB against a never-read 64KB pipe: the write callback can never fire,
  // so only the timeout fallback can terminate the process — without it the
  // child hangs forever and this test times out.
  const { code, signal } = await exitOf(spawnDrainer(1024 * 1024), 10_000);
  assert.equal(code, 7);
  assert.equal(signal, null);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 1900, `timer fallback expected (~2s after start), exited after ${elapsed}ms`);
  assert.ok(elapsed < 9000, `timer fallback should not hang (exited after ${elapsed}ms)`);
});
