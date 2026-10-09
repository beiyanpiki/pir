import { test } from "node:test";
import assert from "assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createTempGitRepo, git } from "../fixtures/helpers.js";
import { ensureRepoCache, ensureFetched, materializeTask, releaseTask, prKey } from "../eval/reviewbench/run-rb.js";

function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-rb-mat-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a source history (base → head) and expose it as a local bare "mirror". */
function buildMirror(sourceRoot) {
  const source = createTempGitRepo("pir-rb-src-");
  source.write("src/app.ts", "export function run() { return 1; }\n");
  const base = source.commit("base implementation");
  source.write("src/app.ts", "export function run() { return 2; }\n");
  const head = source.commit("update implementation");
  const mirrorDir = path.join(sourceRoot, "mirror.git");
  git(source.dir, ["clone", "-q", "--bare", source.dir, mirrorDir]);
  source.cleanup();
  return { mirrorDir, base, head };
}

const fileUrl = (dir) => pathToFileURL(dir).href;

const rbEntry = (base, head) => ({
  repo: "https://github.com/example/repo",
  pr_number: 7,
  base,
  head,
  nwo: "example/repo",
});

test("repo cache initializes once, keeps remotes idempotent, and fetches on demand", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const entry = rbEntry(base, head);
    const cacheRoot = path.join(root, "cache");
    const first = ensureRepoCache(entry, cacheRoot, { remotes: { origin: fileUrl(mirrorDir), upstream: fileUrl(mirrorDir) } });
    assert.equal(path.basename(first.repoDir), "example_repo");
    assert.equal(git(first.repoDir, ["remote", "get-url", "origin"]).trim(), fileUrl(mirrorDir));
    assert.equal(git(first.repoDir, ["remote", "get-url", "upstream"]).trim(), fileUrl(mirrorDir));
    // Second call reuses the initialized repo without error.
    const second = ensureRepoCache(entry, cacheRoot, { remotes: { origin: fileUrl(mirrorDir), upstream: fileUrl(mirrorDir) } });
    assert.equal(second.repoDir, first.repoDir);

    const fetched = ensureFetched(first.repoDir, entry);
    assert.deepEqual(fetched, { fetched: true, remote: "origin" });
    assert.equal(git(first.repoDir, ["cat-file", "-e", `${head}^{commit}`]).trim(), "");
  });
});

test("fetch is skipped when both SHAs are already present, even with a dead remote", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const entry = rbEntry(base, head);
    const cacheRoot = path.join(root, "cache");
    const { repoDir } = ensureRepoCache(entry, cacheRoot, { remotes: { origin: fileUrl(mirrorDir), upstream: fileUrl(mirrorDir) } });
    assert.deepEqual(ensureFetched(repoDir, entry), { fetched: true, remote: "origin" });
    // Point origin at a dead path: the cat-file guard must skip fetching.
    git(repoDir, ["remote", "set-url", "origin", path.join(root, "does-not-exist.git")]);
    assert.deepEqual(ensureFetched(repoDir, entry), { fetched: false, remote: null });
  });
});

test("mirror failure falls back to the upstream remote", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const entry = rbEntry(base, head);
    const { repoDir } = ensureRepoCache(entry, path.join(root, "cache"), {
      remotes: { origin: path.join(root, "dead-mirror.git"), upstream: fileUrl(mirrorDir) },
    });
    const fetched = ensureFetched(repoDir, entry);
    assert.deepEqual(fetched, { fetched: true, remote: "upstream" });
    assert.equal(git(repoDir, ["cat-file", "-e", `${base}^{commit}`]).trim(), "");
  });
});

test("worktree add/remove materializes a detached per-task checkout of head", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const entry = rbEntry(base, head);
    const { repoDir } = ensureRepoCache(entry, path.join(root, "cache"), { remotes: { origin: fileUrl(mirrorDir), upstream: fileUrl(mirrorDir) } });
    ensureFetched(repoDir, entry);
    const workDir = path.join(root, "work", prKey(entry));
    mkdirSync(path.dirname(workDir), { recursive: true });
    materializeTask(repoDir, head, workDir);
    assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), head);
    assert.match(git(workDir, ["status", "--porcelain"]), /^$/); // clean detached checkout
    releaseTask(repoDir, workDir);
    assert.equal(existsSync(workDir), false);
    const remaining = git(repoDir, ["worktree", "list"]);
    assert.equal(remaining.includes(workDir), false);
    // A second materialize on the same path works (stale dirs are reclaimed).
    materializeTask(repoDir, base, workDir);
    assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), base);
    releaseTask(repoDir, workDir);
  });
});
