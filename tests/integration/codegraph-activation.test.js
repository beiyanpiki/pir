import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { executePirCommand } from "../../dist/cli/executor.js";
import { git } from "../../dist/changes/git.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

// Fake `codegraph` CLI for the materialization flow. Unlike the adapter-level
// fixture in tests/unit/codemap.test.js (which pins the flag surface), this
// one simulates the index LIFECYCLE: `init` creates <path>/.codegraph with a
// database file, `sync` stamps the database, `status` reports initialized
// based on the database's presence. Every invocation is appended to the log
// file named by FAKE_CG_LOG so tests can assert the exact sequence.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const log = (line) => fs.appendFileSync(process.env.FAKE_CG_LOG, line + "\\n", "utf8");
const [sub, ...rest] = process.argv.slice(2);
const target = rest.filter((a) => !a.startsWith("-")).pop();
const dir = target ? path.resolve(target) : process.cwd();
const cg = path.join(dir, ".codegraph");
const db = path.join(cg, "codegraph.db");
const failSync = process.env.FAKE_CG_SYNC_FAIL === "1";
// Simulate a KILLED init (dogfood F-62): the db file appears, but the CLI
// never finishes — only outside the throwaway worktree area, so the worktree
// fallback path still succeeds.
const initPartial = process.env.FAKE_CG_INIT_PARTIAL === "1" && !dir.includes(path.sep + "work" + path.sep);
// Simulate "cannot seed here" (e.g. bundle cache with no checkout): init
// fails outside the throwaway worktree area when asked to.
const seedUnsupported = process.env.FAKE_CG_INIT_NO_SEED === "1" && !dir.includes(path.sep + "work" + path.sep);
log(sub + " " + dir);
if (sub === "init") {
  if (seedUnsupported) { process.stderr.write("error: cannot index here\\n"); process.exit(1); }
  fs.mkdirSync(cg, { recursive: true });
  if (initPartial) { fs.writeFileSync(db, "partial\\n"); process.stderr.write("killed mid-build\\n"); process.exit(1); }
  fs.writeFileSync(db, "seed\\n");
  fs.writeFileSync(path.join(cg, ".gitignore"), "*\\n!.gitignore\\n");
  process.exit(0);
}
if (sub === "sync") {
  if (failSync) { process.stderr.write("error: index corrupt\\n"); process.exit(1); }
  if (!fs.existsSync(db)) { process.stderr.write("CodeGraph not initialized in " + dir + "\\n"); process.exit(1); }
  fs.appendFileSync(db, "synced " + dir + "\\n");
  process.exit(0);
}
if (sub === "status") {
  const initialized = fs.existsSync(db);
  console.log(JSON.stringify({ initialized, version: "1.6.0", projectPath: dir, indexPath: cg, lastIndexed: initialized ? "2026-10-09T00:00:00.000Z" : null, nodeCount: initialized ? 5 : 0, edgeCount: 0, fileCount: 2, pendingChanges: 0 }));
  process.exit(0);
}
process.stderr.write("unknown command '" + sub + "'\\n");
process.exit(1);
`;

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-cg-act-"));
  const reposRoot = path.join(root, "repos");
  const stateRoot = path.join(root, "state");
  const binDir = path.join(root, "bin");
  const logFile = path.join(root, "calls.log");
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "codegraph");
  writeFileSync(script, FAKE_CLI);
  chmodSync(script, 0o755);
  writeFileSync(logFile, "");
  const saved = {
    PATH: process.env.PATH,
    PIR_REPOS_ROOT: process.env.PIR_REPOS_ROOT,
    PIR_STATE_ROOT: process.env.PIR_STATE_ROOT,
    PIR_CODEGRAPH: process.env.PIR_CODEGRAPH,
    FAKE_CG_LOG: process.env.FAKE_CG_LOG,
    FAKE_CG_SYNC_FAIL: process.env.FAKE_CG_SYNC_FAIL,
    FAKE_CG_INIT_NO_SEED: process.env.FAKE_CG_INIT_NO_SEED,
    FAKE_CG_INIT_PARTIAL: process.env.FAKE_CG_INIT_PARTIAL,
  };
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  process.env.FAKE_CG_LOG = logFile;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, reposRoot, logFile };
}

const calls = (logFile) => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);

async function registerDemo(repo) {
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("feature");
  await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
  const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
    (r) => r.name === "demo",
  );
  return path.join(process.env.PIR_REPOS_ROOT, entry.projectId);
}

test("PIR_CODEGRAPH=1: materialization seeds, copies, syncs and writes the seed back", async (t) => {
  const { logFile } = sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  const repo = createTempGitRepo("pir-cg-on-");
  try {
    const projectDir = await registerDemo(repo);
    const result = await executePirCommand(["memory", "status", "--repo", "demo", "--json"], { onLog: () => {} });
    assert.equal(result.code, 0);

    const seen = calls(logFile);
    // Seed initialized once in the persistent project dir...
    assert.ok(seen.some((l) => l.startsWith("init ") && l.endsWith(projectDir)), `init project dir missing: ${seen}`);
    // ...synced inside the throwaway worktree (not the project dir)...
    assert.ok(seen.some((l) => l.startsWith("sync ") && l.includes(path.join("repos", "work"))), `worktree sync missing: ${seen}`);
    // ...probed there, and it reported an initialized index.
    assert.ok(seen.some((l) => l.startsWith("status ") && l.includes(path.join("repos", "work"))), `worktree status missing: ${seen}`);

    // The worktree index was copied back into the seed for the next review.
    const seedDb = path.join(projectDir, ".codegraph", "codegraph.db");
    assert.ok(existsSync(seedDb), "seed database not written back");
    assert.match(readFileSync(seedDb, "utf8"), /synced/, "seed db content is not the synced one");
    // The seed's .gitignore survives next to the database.
    assert.ok(existsSync(path.join(projectDir, ".codegraph", ".gitignore")));
    // No leftover worktrees.
    const workDir = path.join(process.env.PIR_REPOS_ROOT, "work");
    assert.equal(readdirSync(workDir).length, 0);
  } finally {
    repo.cleanup();
  }
});

test("without PIR_CODEGRAPH materialization never touches the codegraph CLI", async (t) => {
  const { logFile } = sandbox(t);
  delete process.env.PIR_CODEGRAPH;
  const repo = createTempGitRepo("pir-cg-off-");
  try {
    await registerDemo(repo);
    const result = await executePirCommand(["memory", "status", "--repo", "demo", "--json"], { onLog: () => {} });
    assert.equal(result.code, 0);
    // The only codegraph call is createCodeMap's status probe; no init/sync.
    assert.deepEqual(calls(logFile).filter((l) => !l.startsWith("status ")), []);
    const workDir = path.join(process.env.PIR_REPOS_ROOT, "work");
    assert.equal(readdirSync(workDir).length, 0);
  } finally {
    repo.cleanup();
  }
});

test("activation failure strips the worktree index and the poisoned seed, review continues", async (t) => {
  const { logFile } = sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  process.env.FAKE_CG_SYNC_FAIL = "1";
  const repo = createTempGitRepo("pir-cg-fail-");
  try {
    const projectDir = await registerDemo(repo);
    const result = await executePirCommand(["memory", "status", "--repo", "demo", "--json"], { onLog: () => {} });
    // The review itself is never blocked by codegraph trouble.
    assert.equal(result.code, 0);
    // Self-healing: the poisoned seed was dropped so the next review reseeds.
    assert.ok(!existsSync(path.join(projectDir, ".codegraph")), "poisoned seed survived");
    const workDir = path.join(process.env.PIR_REPOS_ROOT, "work");
    assert.equal(readdirSync(workDir).length, 0);
    assert.ok(calls(logFile).some((l) => l.startsWith("sync ")), "sync was attempted before failing");
  } finally {
    repo.cleanup();
  }
});

test("a tracked .codegraph/.gitignore in the repo does not break activation", async (t) => {
  const { logFile } = sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  const repo = createTempGitRepo("pir-cg-tracked-");
  // Deliberately DIFFERENT from what the fake CLI's init writes: the seed's
  // copy would force-overwrite this file, and a modified tracked file is
  // invisible to the exclude-based mitigation (dogfood F-67).
  const trackedGitignore = "# project-customized\n*\n!.gitignore\n";
  try {
    // codegraph init writes a .gitignore designed to be committed; repos that
    // follow that advice check it out into every worktree as a real directory.
    repo.write(".codegraph/.gitignore", trackedGitignore);
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("with-tracked-gitignore");
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
      (r) => r.name === "demo",
    );
    const projectDir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);

    const { materializeRegistered } = await import("../../dist/app/repos.js");
    const m = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    try {
      const status = await git(m.worktree, ["status", "--porcelain"]);
      assert.equal(status.trim(), "", `worktree reported dirty: ${status}`);
      // The reviewed head's tracked content wins over the seed's copy.
      assert.equal(readFileSync(path.join(m.worktree, ".codegraph", ".gitignore"), "utf8"), trackedGitignore);
    } finally {
      await m.cleanup();
    }
    const seen = calls(logFile);
    // The db-less .codegraph the clone carries is not mistaken for a seed:
    // init runs on the project dir, the copy merges beside the tracked file,
    // and the worktree review gets a synced index.
    assert.ok(seen.some((l) => l.startsWith("init ") && l.endsWith(projectDir)), `project init missing: ${seen}`);
    assert.ok(seen.some((l) => l.startsWith("sync ") && l.includes(path.join("repos", "work"))), `worktree sync missing: ${seen}`);
    assert.ok(existsSync(path.join(projectDir, ".codegraph", "codegraph.db")), "seed db missing");
    assert.ok(existsSync(path.join(projectDir, ".codegraph", ".gitignore")), "tracked .gitignore clobbered");
    // Seeding overwrote the clone's tracked .gitignore too — restored.
    assert.equal(readFileSync(path.join(projectDir, ".codegraph", ".gitignore"), "utf8"), trackedGitignore);
    const cloneStatus = await git(projectDir, ["status", "--porcelain"]);
    assert.equal(cloneStatus.trim(), "", `clone reported dirty: ${cloneStatus}`);
  } finally {
    repo.cleanup();
  }
});

test("bundle flow: when the cache dir cannot be seeded, the worktree is initialized directly", async (t) => {
  const { logFile } = sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  // Bundle cache dirs hold no checkout; make seeding fail anywhere outside
  // the throwaway worktree area so the fallback path is exercised.
  process.env.FAKE_CG_INIT_NO_SEED = "1";
  const repo = createTempGitRepo("pir-cg-bundle-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    const head = repo.commit("head");
    const { createBundle, materializeFromBundle } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const bundle = await createBundle(repo.dir, { base: null, head });
    const { review } = await materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head });
    try {
      const seen = calls(logFile);
      // Seeding was attempted on the cache dir and failed; the worktree was
      // initialized directly instead, then synced.
      assert.ok(seen.some((l) => l.startsWith("init ") && !l.includes(`${path.sep}work${path.sep}`)), `cache-dir init attempt missing: ${seen}`);
      assert.ok(seen.some((l) => l.startsWith("init ") && l.includes(`${path.sep}work${path.sep}`)), `worktree init missing: ${seen}`);
      assert.ok(existsSync(path.join(review.worktree, ".codegraph", "codegraph.db")), "worktree index missing");
    } finally {
      await review.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});

test("activated worktree stays clean for git status (dogfood F-60)", async (t) => {
  const sandbox_ = sandbox(t);
  void sandbox_;
  process.env.PIR_CODEGRAPH = "1";
  const repo = createTempGitRepo("pir-cg-clean-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("c");
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
      (r) => r.name === "demo",
    );
    const projectDir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);
    const { materializeRegistered } = await import("../../dist/app/repos.js");
    const m = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    try {
      // The copied index (db + codegraph's self-including .gitignore) is
      // pir's own artifact: audits' isDirty() runs `git status --porcelain`
      // in this worktree and must not report it as user dirt.
      const status = await git(m.worktree, ["status", "--porcelain"]);
      assert.equal(status.trim(), "", `worktree reported dirty: ${status}`);
    } finally {
      await m.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});

test("a stale codegraph seed lock is broken, not wedged (dogfood F-61)", async (t) => {
  sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  const repo = createTempGitRepo("pir-cg-lock-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("c");
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
      (r) => r.name === "demo",
    );
    const projectDir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);
    // A holder that crashed long ago: older than the lock's staleness bound.
    const lockPath = path.join(projectDir, ".codegraph.lock");
    writeFileSync(lockPath, "crashed-holder");
    const stale = new Date(Date.now() - 16 * 60_000);
    utimesSync(lockPath, stale, stale);

    const { materializeRegistered } = await import("../../dist/app/repos.js");
    const m = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    await m.cleanup();
    // The stale lock was broken by the waiter and ours was released on exit;
    // activation succeeded against the seed.
    assert.ok(!existsSync(lockPath), "seed lock left behind");
    assert.ok(existsSync(path.join(projectDir, ".codegraph", "codegraph.db")), "seed db missing after activation");
  } finally {
    repo.cleanup();
  }
});

test("a killed init's partial seed is never trusted; the marker gates it (dogfood F-62)", async (t) => {
  const { logFile } = sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  // Seed-dir inits die mid-database; worktree inits succeed.
  process.env.FAKE_CG_INIT_PARTIAL = "1";
  const repo = createTempGitRepo("pir-cg-partial-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("c");
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
      (r) => r.name === "demo",
    );
    const projectDir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);
    const { materializeRegistered } = await import("../../dist/app/repos.js");

    const m1 = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    await m1.cleanup();
    // The partial database was never copied or synced; the worktree fallback
    // built the real index and the copy-back refreshed the seed...
    const seedDb = path.join(projectDir, ".codegraph", "codegraph.db");
    assert.ok(!readFileSync(seedDb, "utf8").includes("partial"), "partial seed content leaked into the seed");
    assert.match(readFileSync(seedDb, "utf8"), /synced/, "seed db is not the synced worktree snapshot");
    // ...and only then was the completion marker written.
    assert.ok(existsSync(path.join(projectDir, ".codegraph", "pir-seed-ok")), "seed marker missing");

    // Second review trusts the marked seed: no init anywhere, sync only.
    const before = calls(logFile).length;
    const m2 = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    await m2.cleanup();
    const fresh = calls(logFile).slice(before);
    assert.ok(!fresh.some((l) => l.startsWith("init ")), `unexpected re-init: ${fresh}`);
    assert.ok(fresh.some((l) => l.startsWith("sync ") && l.includes(path.join("repos", "work"))), `worktree sync missing: ${fresh}`);
  } finally {
    repo.cleanup();
  }
});

test("activation failure keeps a tracked .codegraph/.gitignore and the worktree clean (dogfood F-64)", async (t) => {
  sandbox(t);
  process.env.PIR_CODEGRAPH = "1";
  process.env.FAKE_CG_SYNC_FAIL = "1";
  const repo = createTempGitRepo("pir-cg-failtracked-");
  try {
    repo.write(".codegraph/.gitignore", "*\n!.gitignore\n");
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("with-tracked-gitignore");
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse((await executePirCommand(["repos", "list", "--json"])).output).data.repos.find(
      (r) => r.name === "demo",
    );
    const projectDir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);
    const { materializeRegistered } = await import("../../dist/app/repos.js");
    const m = await materializeRegistered(projectDir, entry.projectId, { noFetch: true });
    try {
      // Failure path: only pir's artifacts were stripped; the tracked file
      // survived, so the throwaway worktree is still clean for git status.
      assert.ok(existsSync(path.join(m.worktree, ".codegraph", ".gitignore")), "tracked .gitignore deleted");
      const status = await git(m.worktree, ["status", "--porcelain"]);
      assert.equal(status.trim(), "", `worktree reported dirty after failure: ${status}`);
    } finally {
      await m.cleanup();
    }
    // Seed side: the poisoned seed was dropped but the clone's tracked file
    // was restored — the persistent clone is not left with a deletion.
    assert.ok(!existsSync(path.join(projectDir, ".codegraph", "codegraph.db")), "poisoned seed db survived");
    assert.ok(existsSync(path.join(projectDir, ".codegraph", ".gitignore")), "clone's tracked .gitignore not restored");
    const cloneStatus = await git(projectDir, ["status", "--porcelain"]);
    assert.equal(cloneStatus.trim(), "", `clone reported dirty: ${cloneStatus}`);
  } finally {
    repo.cleanup();
  }
});
