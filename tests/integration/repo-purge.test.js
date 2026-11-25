import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
