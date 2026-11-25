import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createTempGitRepo } from "../fixtures/helpers.js";

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repo-purge-"));
  const reposRoot = path.join(root, "repos");
  const stateRoot = path.join(root, "state");
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, reposRoot, stateRoot };
}

test("purge refuses while a review worktree is live and keeps the registration", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-purge-live-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("head");
    const { addRepo, listRepos, materializeRegistered, removeRepo } = await import("../../dist/app/repos.js");
    const entry = await addRepo(repo.dir, "demo");
    const dir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);

    const review = await materializeRegistered(dir, entry.projectId, { noFetch: true });
    try {
      await assert.rejects(removeRepo("demo", true), /linked worktrees .* still registered/);
      assert.ok(existsSync(dir), "the clone survives a refused purge");
      assert.ok(listRepos().some((r) => r.name === "demo"), "the registration survives a failed purge");
      assert.equal(readFileSync(path.join(review.worktree, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    } finally {
      await review.cleanup();
    }

    const removed = await removeRepo("demo", true);
    assert.equal(removed.name, "demo");
    assert.ok(!existsSync(dir));
    assert.ok(!listRepos().some((r) => r.name === "demo"));
  } finally {
    repo.cleanup();
  }
});

test("purge never unregisters a newer registration that reused the name", async (t) => {
  const { reposRoot } = sandbox(t);
  const oldRepo = createTempGitRepo("pir-purge-old-");
  const newRepo = createTempGitRepo("pir-purge-new-");
  try {
    const { addRepo, listRepos, removeRepo } = await import("../../dist/app/repos.js");
    const oldEntry = await addRepo(oldRepo.dir, "demo");
    const oldDir = path.join(reposRoot, oldEntry.projectId);
    const lockName = `repo-${createHash("sha256").update(path.resolve(oldDir)).digest("hex")}.lock`;
    const lockPath = path.join(reposRoot, ".locks", lockName);

    // Hold the old project's preparation lock so the purge resolves the old
    // entry and then blocks before unregistering — the deterministic window a
    // concurrent add needs to rebind the name to another project.
    const { withResourceLock } = await import("../../dist/app/repo-lock.js");
    let releaseHolder;
    let acquiredHolder;
    const holderAcquired = new Promise((resolve) => (acquiredHolder = resolve));
    const holding = withResourceLock(lockPath, { waitMs: 10_000 }, async () => {
      acquiredHolder();
      await new Promise((resolve) => (releaseHolder = resolve));
    });
    await holderAcquired;

    const purge = removeRepo("demo", true);
    await new Promise((resolve) => setImmediate(resolve));
    const newEntry = await addRepo(newRepo.dir, "demo");
    assert.notEqual(newEntry.projectId, oldEntry.projectId, "the name now points at another project");

    releaseHolder();
    await holding;
    const removed = await purge;
    assert.equal(removed.projectId, oldEntry.projectId);

    const demo = listRepos().find((r) => r.name === "demo");
    assert.ok(demo, "the newer registration must survive the old project's purge");
    assert.equal(demo.projectId, newEntry.projectId);
    assert.ok(!existsSync(oldDir), "the old clone was purged");
    assert.ok(existsSync(path.join(reposRoot, newEntry.projectId)), "the new clone is untouched");
  } finally {
    oldRepo.cleanup();
    newRepo.cleanup();
  }
});

test("cleanup never rejects when the repo lock is held and still drops the worktree", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-cleanup-busy-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("head");
    const { addRepo, materializeRegistered } = await import("../../dist/app/repos.js");
    const entry = await addRepo(repo.dir, "demo");
    const dir = path.join(reposRoot, entry.projectId);
    const review = await materializeRegistered(dir, entry.projectId, { noFetch: true });

    const lockName = `repo-${createHash("sha256").update(path.resolve(dir)).digest("hex")}.lock`;
    const lockPath = path.join(reposRoot, ".locks", lockName);
    const { withResourceLock } = await import("../../dist/app/repo-lock.js");
    let releaseHolder;
    let acquiredHolder;
    const holderAcquired = new Promise((resolve) => (acquiredHolder = resolve));
    const holding = withResourceLock(lockPath, { waitMs: 20_000 }, async () => {
      acquiredHolder();
      await new Promise((resolve) => (releaseHolder = resolve));
    });
    await holderAcquired;

    // Cleanup runs after a completed review (the server/Gitea/CLI callers run
    // it in a finally): a busy preparation must not fail the review's result
    // or leak the worktree, so it gives up on the lock quickly and still
    // removes the checkout.
    const started = Date.now();
    await review.cleanup();
    assert.ok(Date.now() - started < 15_000, "cleanup did not wait out the preparation budget");
    assert.ok(!existsSync(review.worktree), "the worktree was removed without the lock");
    const admins = path.join(dir, ".git", "worktrees");
    assert.deepEqual(existsSync(admins) ? readdirSync(admins) : [], [], "no admin entry leaks");

    releaseHolder();
    await holding;
  } finally {
    repo.cleanup();
  }
});
