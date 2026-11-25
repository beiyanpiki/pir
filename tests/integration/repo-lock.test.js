import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Child holds the resource lock until the parent asks it to release; the
// barrier is the IPC "locked" message, never a sleep.
const HOLDER_SCRIPT = `
const send = (message) => process.send(message);
const waitFor = (wanted) =>
  new Promise((resolve) => {
    const listener = (message) => {
      if (message !== wanted) return;
      process.removeListener("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
(async () => {
  try {
    const { withResourceLock } = await import(process.env.PIR_LOCK_MODULE);
    send({ type: "ready" });
    await waitFor("go");
    await withResourceLock(process.env.PIR_LOCK_PATH, { waitMs: 5_000 }, async () => {
      send({ type: "locked" });
      await waitFor("release");
    });
    send({ type: "released" });
    process.exit(0);
  } catch (err) {
    send({ type: "error", message: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
})();
`;

function startHolder(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-lock-"));
  const script = path.join(root, "holder.mjs");
  writeFileSync(script, HOLDER_SCRIPT);
  const lockPath = path.join(root, "locks", "resource.lock");
  const child = fork(script, {
    env: {
      ...process.env,
      PIR_LOCK_MODULE: pathToFileURL(path.resolve("dist/app/repo-lock.js")).href,
      PIR_LOCK_PATH: lockPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  const queue = [];
  const waiters = [];
  let exited = null;
  child.on("message", (message) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`holder exited (${code}/${signal}) while waiting`));
    }
  });
  return {
    lockPath,
    child,
    next(predicate, timeoutMs = 20_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (exited) return Promise.reject(new Error(`holder already exited (${exited.code}/${exited.signal})`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for holder event")), timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    async exit() {
      if (!exited) await new Promise((resolve) => child.once("exit", resolve));
      return exited;
    },
  };
}

test("a live lock owner is never broken; a dead owner is recovered without waiting out a timeout", async (t) => {
  const holder = startHolder(t);
  await holder.next((m) => m.type === "ready");
  holder.child.send("go");
  assert.equal((await holder.next((m) => m.type === "locked" || m.type === "error")).type, "locked");

  const { withResourceLock } = await import("../../dist/app/repo-lock.js");
  // A waiter times out while the owner is alive, and must leave the owner's
  // lock untouched — deleting it would let a third process race in.
  await assert.rejects(
    withResourceLock(holder.lockPath, { waitMs: 150, pollMs: 10, busyError: "lock busy" }, async () => "never"),
    /lock busy/,
  );
  assert.ok(existsSync(holder.lockPath), "the live owner's lock file survives a timed-out waiter");

  // Owner liveness (pid gone), not a stale-time guess, frees the lock.
  holder.child.kill("SIGKILL");
  assert.equal((await holder.exit()).signal, "SIGKILL");
  const value = await withResourceLock(holder.lockPath, { waitMs: 5_000, busyError: "lock busy" }, async () => "acquired");
  assert.equal(value, "acquired");
  assert.equal(existsSync(holder.lockPath), false, "the recovering owner released the lock");
});

test("the lock holder releases the lock on a throwing critical section", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-lock-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "resource.lock");
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");
  await assert.rejects(
    withResourceLock(lockPath, { waitMs: 1_000 }, async () => {
      throw new Error("critical section failed");
    }),
    /critical section failed/,
  );
  assert.equal(existsSync(lockPath), false, "the failed holder released its lock");
  assert.equal(
    await withResourceLock(lockPath, { waitMs: 1_000 }, async () => "next owner"),
    "next owner",
  );
});
