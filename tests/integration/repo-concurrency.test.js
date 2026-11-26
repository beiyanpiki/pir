import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createTempGitRepo, git } from "../fixtures/helpers.js";

// Every child is barrier-driven over the IPC channel: the parent waits for
// each child's "ready", releases them together, and waits for explicit
// lifecycle events. No step below depends on a sleep guessing that another
// process finished.
const CHILD_SCRIPT = `
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
    send({ type: "ready" });
    await waitFor("go");
    const mode = process.env.PIR_CHILD_MODE;
    if (mode === "bundle") {
      const { readFileSync } = await import("node:fs");
      const mod = await import(process.env.PIR_REPOS_MODULE);
      const bundle = readFileSync(process.env.PIR_BUNDLE);
      const result = await mod.materializeFromBundle(bundle, JSON.parse(process.env.PIR_META));
      send({ type: "materialized", head: result.review.headCommit, worktree: result.review.worktree });
      await waitFor("cleanup");
      await result.review.cleanup();
      send({ type: "cleaned" });
    } else if (mode === "registered") {
      const mod = await import(process.env.PIR_REPOS_MODULE);
      const result = await mod.materializeRegistered(process.env.PIR_REPO_DIR, process.env.PIR_PROJECT_ID, {
        branch: process.env.PIR_BRANCH,
      });
      send({ type: "materialized", head: result.headCommit, worktree: result.worktree });
      await waitFor("cleanup");
      await result.cleanup();
      send({ type: "cleaned" });
    } else {
      throw new Error("unknown child mode " + mode);
    }
    process.exit(0);
  } catch (err) {
    send({ type: "error", message: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
})();
`;

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-race-"));
  const reposRoot = path.join(root, "repos");
  const stateRoot = path.join(root, "state");
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  const script = path.join(root, "child.mjs");
  writeFileSync(script, CHILD_SCRIPT);
  const saved = { PIR_REPOS_ROOT: process.env.PIR_REPOS_ROOT, PIR_STATE_ROOT: process.env.PIR_STATE_ROOT };
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  const children = new Set();
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, reposRoot, stateRoot, script, children };
}

function startChild(sandboxState, env) {
  const child = fork(sandboxState.script, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const queue = [];
  const waiters = [];
  let stderr = "";
  let exited = null;
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
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
      waiter.reject(new Error(`child exited (${code}/${signal}) while waiting; stderr: ${stderr.trim()}`));
    }
  });
  sandboxState.children.add(child);
  return {
    child,
    next(predicate, timeoutMs = 30_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (exited) {
        return Promise.reject(new Error(`child already exited (${exited.code}/${exited.signal}); stderr: ${stderr.trim()}`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for child event")), timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    async exit() {
      if (!exited) await new Promise((resolve) => child.once("exit", resolve));
      return exited;
    },
    stderr: () => stderr,
  };
}

const reposModule = () => pathToFileURL(path.resolve("dist/app/repos.js")).href;

test("two processes materialize different heads of the same new bundle project at once", async (t) => {
  const state = sandbox(t);
  const repo = createTempGitRepo("pir-race-bundle-");
  try {
    repo.write("src/base.txt", "base\n");
    const base = repo.commit("base");
    repo.write("src/who.txt", "one\n");
    const headOne = repo.commit("one");

    const { createBundle, projectIdFor } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const bundleOne = await createBundle(repo.dir, { base: null, head: headOne });

    // A second head from the same base; both are full bundles for the same
    // project identity.
    git(repo.dir, ["reset", "--hard", base]);
    repo.write("src/who.txt", "two\n");
    const headTwo = repo.commit("two");
    const bundleTwo = await createBundle(repo.dir, { base: null, head: headTwo });

    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const bundleFileOne = path.join(state.root, "one.bundle");
    const bundleFileTwo = path.join(state.root, "two.bundle");
    writeFileSync(bundleFileOne, bundleOne);
    writeFileSync(bundleFileTwo, bundleTwo);

    // Legacy non-SHA head: the server must review the head its OWN bundle
    // packed, from refs/pir/last-bundle — a shared ref two concurrent first
    // contacts would otherwise overwrite between fetch and read.
    const meta = { remoteUrl, rootCommit, base: null, head: "HEAD" };
    const first = startChild(state, {
      PIR_CHILD_MODE: "bundle",
      PIR_REPOS_MODULE: reposModule(),
      PIR_BUNDLE: bundleFileOne,
      PIR_META: JSON.stringify(meta),
    });
    const second = startChild(state, {
      PIR_CHILD_MODE: "bundle",
      PIR_REPOS_MODULE: reposModule(),
      PIR_BUNDLE: bundleFileTwo,
      PIR_META: JSON.stringify(meta),
    });

    await first.next((m) => m.type === "ready");
    await second.next((m) => m.type === "ready");
    first.child.send("go");
    second.child.send("go");

    const one = await first.next((m) => m.type === "materialized" || m.type === "error");
    const two = await second.next((m) => m.type === "materialized" || m.type === "error");
    assert.equal(one.type, "materialized", `first failed: ${one.message ?? ""} ${first.stderr()}`);
    assert.equal(two.type, "materialized", `second failed: ${two.message ?? ""} ${second.stderr()}`);
    assert.equal(one.head, headOne, "first child reviewed the other bundle's head");
    assert.equal(two.head, headTwo, "second child reviewed the other bundle's head");
    assert.notEqual(one.worktree, two.worktree);

    // Both worktrees are fully usable while the other is open.
    assert.equal(readFileSync(path.join(one.worktree, "src", "who.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(two.worktree, "src", "who.txt"), "utf8"), "two\n");
    assert.equal(readFileSync(path.join(one.worktree, "src", "base.txt"), "utf8"), "base\n");

    first.child.send("cleanup");
    second.child.send("cleanup");
    assert.equal((await first.next((m) => m.type === "cleaned" || m.type === "error")).type, "cleaned");
    assert.equal((await second.next((m) => m.type === "cleaned" || m.type === "error")).type, "cleaned");
    assert.deepEqual(await first.exit(), { code: 0, signal: null });
    assert.deepEqual(await second.exit(), { code: 0, signal: null });

    // The shared per-project state is coherent after both finishes.
    const cacheDir = path.join(state.reposRoot, projectIdFor(remoteUrl, rootCommit));
    assert.ok(existsSync(cacheDir));
    assert.equal((await git(cacheDir, ["rev-parse", "--verify", "refs/pir/last-bundle^{commit}"])).trim().length, 40);
    assert.equal(readdirSync(path.join(state.reposRoot, "work")).length, 0, "worktrees cleaned up");
    const lockDir = path.join(state.reposRoot, ".locks");
    assert.equal(existsSync(lockDir) ? readdirSync(lockDir).filter((f) => f.endsWith(".lock")).length : 0, 0);
  } finally {
    repo.cleanup();
  }
});

test("two processes materialize different heads of the same registered clone at once", async (t) => {
  const state = sandbox(t);
  const origin = createTempGitRepo("pir-race-registered-");
  try {
    origin.write("src/who.txt", "one\n");
    const headOne = origin.commit("one");
    origin.write("src/who.txt", "two\n");
    const headTwo = origin.commit("two");

    const { addRepo } = await import("../../dist/app/repos.js");
    const entry = await addRepo(origin.dir, "demo");
    const repoDir = path.join(state.reposRoot, entry.projectId);

    const env = {
      PIR_CHILD_MODE: "registered",
      PIR_REPOS_MODULE: reposModule(),
      PIR_REPO_DIR: repoDir,
      PIR_PROJECT_ID: entry.projectId,
    };
    const first = startChild(state, { ...env, PIR_BRANCH: headOne });
    const second = startChild(state, { ...env, PIR_BRANCH: headTwo });
    await first.next((m) => m.type === "ready");
    await second.next((m) => m.type === "ready");
    first.child.send("go");
    second.child.send("go");

    const one = await first.next((m) => m.type === "materialized" || m.type === "error");
    const two = await second.next((m) => m.type === "materialized" || m.type === "error");
    assert.equal(one.type, "materialized", `first failed: ${one.message ?? ""} ${first.stderr()}`);
    assert.equal(two.type, "materialized", `second failed: ${two.message ?? ""} ${second.stderr()}`);
    assert.equal(one.head, headOne);
    assert.equal(two.head, headTwo);
    assert.equal(readFileSync(path.join(one.worktree, "src", "who.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(two.worktree, "src", "who.txt"), "utf8"), "two\n");

    first.child.send("cleanup");
    second.child.send("cleanup");
    assert.equal((await first.next((m) => m.type === "cleaned" || m.type === "error")).type, "cleaned");
    assert.equal((await second.next((m) => m.type === "cleaned" || m.type === "error")).type, "cleaned");
    assert.deepEqual(await first.exit(), { code: 0, signal: null });
    assert.deepEqual(await second.exit(), { code: 0, signal: null });
    assert.equal(readdirSync(path.join(state.reposRoot, "work")).length, 0);
  } finally {
    origin.cleanup();
  }
});
