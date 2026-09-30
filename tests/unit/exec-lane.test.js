import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { classifyExecLane } from "../../dist/server/server.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const DEFAULT_WS = "/srv/workspace";

async function lane(argv, workspace = DEFAULT_WS) {
  // Mirror handleExec: requests without --cwd operate on the workspace root.
  const effectiveArgv = argv.includes("--cwd") ? argv : ["--cwd", workspace, ...argv];
  return classifyExecLane(effectiveArgv, workspace);
}

test("lane: workspace-independent commands bypass the queue", async () => {
  assert.equal(await lane(["version"]), "unqueued");
  assert.equal(await lane(["version", "--json"]), "unqueued");
  assert.equal(await lane([]), "unqueued"); // bare argv prints usage
  assert.equal(await lane(["help"]), "unqueued");
  assert.equal(await lane(["models"]), "unqueued");
  assert.equal(await lane(["models", "--all", "--ids"]), "unqueued");
  assert.equal(await lane(["repos"]), "unqueued"); // default sub is list
  assert.equal(await lane(["repos", "list"]), "unqueued");
  assert.equal(await lane(["repos", "list", "--json"]), "unqueued");
});

test("lane: writers and worktree flows stay queued", async () => {
  assert.equal(await lane(["find"]), "queued");
  assert.equal(await lane(["find", "--base", "HEAD^"]), "queued");
  assert.equal(await lane(["audit"]), "queued");
  assert.equal(await lane(["memory", "bootstrap"]), "queued");
  assert.equal(await lane(["memory", "refresh"]), "queued");
  assert.equal(await lane(["memory", "sync"]), "queued");
  assert.equal(await lane(["feedback", "PIR-1", "expected"]), "queued");
  assert.equal(await lane(["remember", "project", "note", "--text", "x"]), "queued");
  assert.equal(await lane(["verify-fix", "PIR-1"]), "queued");
  assert.equal(await lane(["plugins"]), "queued");
  assert.equal(await lane(["unknown-command"]), "queued");
  // add/remove mutate the shared per-project dirs under PIR_REPOS_ROOT —
  // the same dirs bundle reviews materialize from — so they keep their
  // queue slot.
  assert.equal(await lane(["repos", "add", "https://example.com/r.git"]), "queued");
  assert.equal(await lane(["repos", "remove", "r"]), "queued");
  assert.equal(await lane(["repos", "remove", "r", "--purge"]), "queued");
});

test("lane: --repo materializes a worktree, so even reads stay queued", async () => {
  assert.equal(await lane(["memory", "status", "--repo", "demo"]), "queued");
  assert.equal(await lane(["findings", "list", "--repo=demo"]), "queued");
});

test("lane: usage errors fall through to the queued path", async () => {
  // A value flag without its value throws in parseArgs; the queued executor
  // must be the one to report it as a usage error.
  assert.equal(await lane(["find", "--base"]), "queued");
  assert.equal(await lane(["memory", "--cwd"]), "queued");
});

test("lane: reads are readonly only when the memory db already exists", async (t) => {
  const repo = createTempGitRepo("pir-lane-");
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-lane-state-"));
  const previousRoot = process.env.PIR_STATE_ROOT;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PIR_STATE_ROOT;
    else process.env.PIR_STATE_ROOT = previousRoot;
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  // First contact: no db yet — must stay queued so it gets created.
  assert.equal(await lane(["memory", "status"], repo.dir), "queued");
  assert.equal(await lane(["findings", "list"], repo.dir), "queued");
  assert.equal(await lane(["findings", "show", "PIR-1"], repo.dir), "queued");

  // A queued open creates and migrates the db...
  const { Memory } = await import("../../dist/memory/index.js");
  const memory = await Memory.open(repo.dir);
  memory.close();

  // ...after which the same reads run as WAL readers off the queue.
  assert.equal(await lane(["memory", "status"], repo.dir), "readonly");
  assert.equal(await lane(["memory"], repo.dir), "readonly"); // sub defaults to status
  assert.equal(await lane(["findings", "list"], repo.dir), "readonly");
  assert.equal(await lane(["findings", "show", "PIR-1"], repo.dir), "readonly");
  assert.equal(await lane(["findings"], repo.dir), "readonly"); // sub defaults to list
});

test("lane: --cwd escaping the workspace stays queued (executor reports it)", async (t) => {
  const repo = createTempGitRepo("pir-lane-escape-");
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-lane-state-"));
  const previousRoot = process.env.PIR_STATE_ROOT;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PIR_STATE_ROOT;
    else process.env.PIR_STATE_ROOT = previousRoot;
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });
  // A db exists for this repo, but the request's --cwd escapes the
  // workspace guard: queue it and let the executor produce the usage
  // error, exactly as before the lanes existed.
  const { Memory } = await import("../../dist/memory/index.js");
  const memory = await Memory.open(repo.dir);
  memory.close();
  assert.equal(await lane(["memory", "status", "--cwd", "/etc"], repo.dir), "queued");
});
