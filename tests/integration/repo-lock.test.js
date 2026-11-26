import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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

test("an unprovable owner (foreign host or unreadable record) is never broken on age", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-lock-unprovable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync, readFileSync, writeFileSync, utimesSync } = await import("node:fs");
  const lockPath = path.join(root, "locks", "resource.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");

  // This pid is dead on this host, but the record claims another host:
  // liveness cannot be proved, so the lock must not be stolen.
  const foreign = JSON.stringify({
    token: "foreign-token",
    pid: 999_999,
    host: "another-host.invalid",
    procStart: "1",
    acquiredAt: 0,
  });
  writeFileSync(lockPath, foreign);
  const ancient = new Date(Date.now() - 24 * 60 * 60_000);
  utimesSync(lockPath, ancient, ancient);
  await assert.rejects(
    withResourceLock(lockPath, { waitMs: 150, pollMs: 10, busyError: "lock busy" }, async () => "never"),
    /lock busy/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), foreign, "the foreign lock survives");

  // A record that cannot be parsed proves nothing either.
  writeFileSync(lockPath, "{ torn");
  await assert.rejects(
    withResourceLock(lockPath, { waitMs: 150, pollMs: 10, busyError: "lock busy" }, async () => "never"),
    /lock busy/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), "{ torn", "the unreadable lock survives");
});

test("an unreadable lock path behaves as held, not vanished", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-lock-unreadable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import("node:fs");
  const lockPath = path.join(root, "locks", "resource.lock");
  // A directory at the lock path cannot be read as an owner, but it is also
  // not proof of death: a waiter must time out with the busy error rather
  // than throwing EISDIR or spinning on a "vanished" lock.
  mkdirSync(lockPath, { recursive: true });
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");
  await assert.rejects(
    withResourceLock(lockPath, { waitMs: 150, pollMs: 10, busyError: "lock busy" }, async () => "never"),
    /lock busy/,
  );
  assert.ok(existsSync(lockPath), "the unreadable path is left untouched");
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

function lockSandbox(t, prefix = "pir-repo-lock-case-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "resource.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  return { root, lockPath, breakPath: `${lockPath}.break` };
}

// pid 999_999 is not alive here, so this record is provably dead on this host.
const deadRecord = (token) =>
  JSON.stringify({ token, pid: 999_999, host: hostname(), procStart: "1", acquiredAt: 0 });

const liveRecord = (token) =>
  JSON.stringify({ token, pid: process.pid, host: hostname(), procStart: null, acquiredAt: Date.now() });

function lineReader(stream) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  return {
    next(timeoutMs = 20_000) {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for child line")), timeoutMs);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

test("a dead main lock with a dead leftover .break is refused, not auto-reclaimed", async (t) => {
  const { lockPath, breakPath } = lockSandbox(t);
  const mainRaw = deadRecord("dead-main");
  const breakRaw = deadRecord("dead-breaker");
  writeFileSync(lockPath, mainRaw);
  writeFileSync(breakPath, breakRaw);
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");

  await assert.rejects(
    withResourceLock(lockPath, { waitMs: 5_000, busyError: "lock busy" }, async () => "never"),
    (err) =>
      err.message.includes(breakPath) &&
      /stop any related pir processes/.test(err.message) &&
      /\.break file by hand/.test(err.message),
  );
  // Conservative: both records stay for the operator; nothing was guessed away.
  assert.equal(readFileSync(lockPath, "utf8"), mainRaw);
  assert.equal(readFileSync(breakPath, "utf8"), breakRaw);
});

test("a dead main lock with no breaker is still recovered automatically", async (t) => {
  const { lockPath, breakPath } = lockSandbox(t);
  writeFileSync(lockPath, deadRecord("dead-main"));
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");
  const value = await withResourceLock(lockPath, { waitMs: 5_000, busyError: "lock busy" }, async () => "recovered");
  assert.equal(value, "recovered");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(breakPath), false);
});

const LIVE_BREAK_ATTEMPTER_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const breakPath = path.resolve(process.env.PIR_BREAK_PATH);
const realRead = fs.readFileSync;
let attempts = 0;
fs.readFileSync = (target, ...rest) => {
  if (typeof target === "string" && path.resolve(target) === breakPath) {
    attempts += 1;
    // Barrier: the second read proves the first dead-main break attempt
    // returned without touching the live breaker's file.
    if (attempts === 2) fs.writeSync(1, "SECOND_BREAK_ATTEMPT\\n");
  }
  return realRead.call(fs, target, ...rest);
};
syncBuiltinESMExports();

const { withResourceLock } = await import(process.env.PIR_LOCK_MODULE);
// Deliberately never resolves here: the deferred F-4 behaviour retries a
// dead main behind a live breaker without consulting the wait deadline.
void withResourceLock(process.env.PIR_LOCK_PATH, { waitMs: 100, pollMs: 5 }, async () => {});
`;

test("a live breaker's .break is never deleted by a reclaimer", async (t) => {
  const { root, lockPath, breakPath } = lockSandbox(t, "pir-repo-lock-livebreak-");
  const mainRaw = deadRecord("dead-main");
  const breakRaw = liveRecord("live-breaker");
  writeFileSync(lockPath, mainRaw);
  writeFileSync(breakPath, breakRaw);
  const script = path.join(root, "live-break-attempter.mjs");
  writeFileSync(script, LIVE_BREAK_ATTEMPTER_SCRIPT);

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PIR_LOCK_PATH: lockPath,
      PIR_BREAK_PATH: breakPath,
      PIR_LOCK_MODULE: pathToFileURL(path.resolve("dist/app/repo-lock.js")).href,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const stdout = lineReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

  assert.equal(await stdout.next(), "SECOND_BREAK_ATTEMPT", `child did not retry: ${stderr}`);
  // Two full break attempts happened; the live breaker's file and the dead
  // main record are both untouched.
  assert.equal(readFileSync(breakPath, "utf8"), breakRaw);
  assert.equal(readFileSync(lockPath, "utf8"), mainRaw);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
});

const PAUSED_BREAKER_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const lockPath = path.resolve(process.env.PIR_LOCK_PATH);
const realRm = fs.rmSync;
fs.rmSync = (target, options) => {
  const resolved = typeof target === "string" ? path.resolve(target) : target;
  if (resolved === lockPath) {
    realRm.call(fs, target, options);
    fs.writeSync(1, "MAIN_REMOVED\\n");
    // Barrier: hold the break mutex and pause after deleting the dead main
    // lock, exactly before the breaker would re-try the main lock.
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    return undefined;
  }
  return realRm.call(fs, target, options);
};
syncBuiltinESMExports();

const { withResourceLock } = await import(process.env.PIR_LOCK_MODULE);
try {
  await withResourceLock(lockPath, { waitMs: 500, pollMs: 10, busyError: "lock busy" }, async () => {
    fs.writeSync(1, "ACQUIRED\\n");
  });
  fs.writeSync(1, "DONE\\n");
} catch (err) {
  fs.writeSync(1, "ERROR " + err.message + "\\n");
}
process.exit(0);
`;

test("a breaker that removed a dead main never deletes the main a waiter acquired meanwhile", async (t) => {
  const { root, lockPath, breakPath } = lockSandbox(t, "pir-repo-lock-aba-");
  writeFileSync(lockPath, deadRecord("dead-main"));
  const script = path.join(root, "paused-breaker.mjs");
  writeFileSync(script, PAUSED_BREAKER_SCRIPT);

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PIR_LOCK_PATH: lockPath,
      PIR_LOCK_MODULE: pathToFileURL(path.resolve("dist/app/repo-lock.js")).href,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const stdout = lineReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

  // The breaker holds the break mutex and has just removed the dead main lock.
  assert.equal(await stdout.next(), "MAIN_REMOVED");
  assert.equal(existsSync(lockPath), false);
  assert.ok(existsSync(breakPath), "the breaker holds its break mutex across the barrier");

  // A normal waiter legitimately takes the now-free main lock.
  const { withResourceLock } = await import("../../dist/app/repo-lock.js");
  let releaseHolder;
  let acquiredHolder;
  const holderAcquired = new Promise((resolve) => (acquiredHolder = resolve));
  const holder = withResourceLock(lockPath, { waitMs: 5_000, pollMs: 10 }, async () => {
    acquiredHolder();
    await new Promise((resolve) => (releaseHolder = resolve));
  });
  await holderAcquired;
  const holderRaw = readFileSync(lockPath, "utf8");

  // Let the paused breaker continue: it must observe the live new owner and
  // time out, never deleting the main lock it did not create.
  child.stdin.write("\n");
  const outcome = await stdout.next();
  assert.match(outcome, /^ERROR lock busy/, `unexpected breaker outcome: ${outcome} ${stderr}`);
  assert.equal(readFileSync(lockPath, "utf8"), holderRaw, "the waiter's live main lock survived the breaker");

  releaseHolder();
  await holder;
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(existsSync(lockPath), false);
});
