import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { executePirCommand } from "../../dist/cli/executor.js";
import { createWorkingTreeSnapshot, git } from "../../dist/changes/git.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repos-test-"));
  const reposRoot = path.join(root, "repos");
  const stateRoot = path.join(root, "state");
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, reposRoot, stateRoot };
}

test("repos add/list/remove against a local checkout", async (t) => {
  const { stateRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-reg-");
  try {
    const add = await executePirCommand(["repos", "add", repo.dir, "--name", "demo", "--json"]);
    const entry = JSON.parse(add.output).data;
    assert.equal(entry.name, "demo");
    assert.match(entry.projectId, /^[0-9a-f]{64}$/);

    const list = await executePirCommand(["repos", "list", "--json"]);
    assert.ok(JSON.parse(list.output).data.repos.some((r) => r.name === "demo"));

    const remove = await executePirCommand(["repos", "remove", "demo", "--purge", "--json"]);
    assert.equal(JSON.parse(remove.output).data.name, "demo");
    void stateRoot;
  } finally {
    repo.cleanup();
  }
});

test("--repo materializes a worktree and keeps state under PIR_STATE_ROOT", async (t) => {
  const { stateRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-wt-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("feature");
  try {
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo"]);

    const status = await executePirCommand(["memory", "status", "--repo", "demo", "--json"], {
      onLog: () => {},
    });
    assert.equal(status.code, 0);
    const data = JSON.parse(status.output).data;
    assert.match(data.dbPath, new RegExp(`^${stateRoot}/[0-9a-f]{64}/memory\\.sqlite$`));
    assert.ok(existsSync(data.dbPath));
    assert.equal(data.headCommit, (await git(repo.dir, ["rev-parse", "HEAD"])).trim());

    // Worktree must be cleaned up after the command.
    const workDir = path.join(process.env.PIR_REPOS_ROOT, "work");
    const leftovers = existsSync(workDir) ? readdirSync(workDir) : [];
    assert.equal(leftovers.length, 0);

    // Branch pinning resolves the given ref.
    const pinned = await executePirCommand(["memory", "status", "--repo", "demo", "--branch", "main", "--json"], {
      onLog: () => {},
    });
    assert.equal(pinned.code, 0);
  } finally {
    repo.cleanup();
  }
});

test("createWorkingTreeSnapshot captures tracked + untracked without touching user state", async (t) => {
  const repo = createTempGitRepo("pir-snap-");
  try {
    repo.write("tracked.txt", "committed\n");
    repo.commit("base");

    const before = await git(repo.dir, ["status", "--porcelain"]);
    assert.equal(before.trim(), "");

    // Dirty the tree: modify tracked + add untracked.
    repo.write("tracked.txt", "modified\n");
    repo.write("untracked-new.ts", "export const fresh = 1;\n");

    const snapshot = await createWorkingTreeSnapshot(repo.dir);
    assert.match(snapshot, /^[0-9a-f]{40}$/);

    // User state untouched: still dirty the same way, HEAD unchanged.
    const status = await git(repo.dir, ["status", "--porcelain"]);
    assert.ok(status.includes("M"));
    assert.ok(status.includes("??"));
    const head = (await git(repo.dir, ["rev-parse", "HEAD"])).trim();
    const parent = (await git(repo.dir, ["rev-parse", `${snapshot}^`])).trim();
    assert.equal(parent, head);

    // Snapshot tree contains the untracked file.
    const tree = (await git(repo.dir, ["rev-parse", `${snapshot}^{tree}`])).trim();
    void tree;
    const ls = await git(repo.dir, ["ls-tree", "-r", "--name-only", snapshot]);
    assert.ok(ls.includes("untracked-new.ts"));
    assert.ok(ls.includes("tracked.txt"));

    // Clean tree -> snapshot == HEAD.
    repo.write("tracked.txt", "committed\n");
    rmSync(path.join(repo.dir, "untracked-new.ts"));
    assert.equal(await createWorkingTreeSnapshot(repo.dir), head);
  } finally {
    repo.cleanup();
  }
});

test("PIR_STATE_ROOT centralizes memory by projectId", async () => {
  const repo = createTempGitRepo("pir-state-");
  const root = mkdtempSync(path.join(tmpdir(), "pir-state-root-"));
  const prevRoot = process.env.PIR_STATE_ROOT;
  const prevProject = process.env.PIR_STATE_IN_PROJECT;
  process.env.PIR_STATE_ROOT = root;
  delete process.env.PIR_STATE_IN_PROJECT;
  try {
    const { Memory } = await import("../../dist/memory/index.js");
    const { computeProjectIdentity } = await import("../../dist/memory/identity.js");
    const memory = await Memory.open(repo.dir);
    try {
      const identity = await computeProjectIdentity(repo.dir);
      assert.equal(memory.store.dbPath, path.join(root, identity.projectId, "memory.sqlite"));
    } finally {
      memory.close();
    }
  } finally {
    if (prevRoot === undefined) delete process.env.PIR_STATE_ROOT;
    else process.env.PIR_STATE_ROOT = prevRoot;
    if (prevProject) process.env.PIR_STATE_IN_PROJECT = prevProject;
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
