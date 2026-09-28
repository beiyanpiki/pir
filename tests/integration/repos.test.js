import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { executePirCommand } from "../../dist/cli/executor.js";
import { createWorkingTreeSnapshot, git } from "../../dist/changes/git.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-repos-test-"));
  const reposRoot = path.join(root, "repos");
  const stateRoot = path.join(root, "state");
  mkdirSync(reposRoot, { recursive: true }); // pir creates it lazily on first use
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

test("corrupt repos.json is a loud error and is never overwritten", async (t) => {
  const { reposRoot } = sandbox(t);
  const registry = path.join(reposRoot, "repos.json");
  writeFileSync(registry, "{ not json\n");
  await assert.rejects(
    executePirCommand(["repos", "list", "--json"]),
    (err) => err.message.includes("cannot read repo registry") && err.message.includes("refusing to overwrite"),
  );
  // The corrupt file must survive untouched — no silent wipe.
  assert.equal(readFileSync(registry, "utf8"), "{ not json\n");
});

test("a non-object repos.json root is rejected too", async (t) => {
  const { reposRoot } = sandbox(t);
  writeFileSync(path.join(reposRoot, "repos.json"), '["not", "an", "object"]\n');
  await assert.rejects(
    executePirCommand(["repos", "list", "--json"]),
    (err) => err.message.includes("cannot read repo registry"),
  );
});

test("a stale registry lock is broken so registrations still work", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-lock-");
  try {
    const lockPath = path.join(reposRoot, "repos.json.lock");
    writeFileSync(lockPath, "");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const add = await executePirCommand(["repos", "add", repo.dir, "--name", "stale", "--json"]);
    assert.equal(add.code, 0);
    assert.ok(!existsSync(lockPath), "the lock we created was cleaned up, not left behind");
    const list = await executePirCommand(["repos", "list", "--json"]);
    assert.ok(JSON.parse(list.output).data.repos.some((r) => r.name === "stale"));
  } finally {
    repo.cleanup();
  }
});

test("concurrent repos add from separate processes keeps every entry", async (t) => {
  const { reposRoot, stateRoot } = sandbox(t);
  const repoA = createTempGitRepo("pir-race-a-");
  const repoB = createTempGitRepo("pir-race-b-");
  try {
    const env = { ...process.env, PIR_REPOS_ROOT: reposRoot, PIR_STATE_ROOT: stateRoot, PIR_NO_WIZARD: "1" };
    // --local keeps the child CLIs away from any configured remote server.
    await Promise.all([
      execFileAsync(process.execPath, [CLI, "--local", "repos", "add", repoA.dir, "--name", "alpha"], {
        encoding: "utf8",
        env,
      }),
      execFileAsync(process.execPath, [CLI, "--local", "repos", "add", repoB.dir, "--name", "beta"], {
        encoding: "utf8",
        env,
      }),
    ]);
    const list = await executePirCommand(["repos", "list", "--json"]);
    const names = JSON.parse(list.output).data.repos.map((r) => r.name);
    assert.ok(names.includes("alpha"), `alpha lost: ${JSON.stringify(names)}`);
    assert.ok(names.includes("beta"), `beta lost: ${JSON.stringify(names)}`);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});

test("--repo also accepts the --repo=name form", async (t) => {
  const { stateRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-eqform-");
  try {
    await executePirCommand(["repos", "add", repo.dir, "--name", "demo"]);
    const status = await executePirCommand(["memory", "status", "--repo=demo", "--json"], { onLog: () => {} });
    assert.equal(status.code, 0);
    assert.match(JSON.parse(status.output).data.dbPath, new RegExp(`^${stateRoot}/[0-9a-f]{64}/memory\\.sqlite$`));
  } finally {
    repo.cleanup();
  }
});

test("unregistered --repo spec keys memory under the computed sha projectId", async (t) => {
  const { reposRoot, stateRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-fallback-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");
  try {
    // A server-side clone exists at the sha-keyed dir (e.g. created by a
    // prior bundle flow) but the spec was never registered by name.
    const { projectIdFor } = await import("../../dist/app/repos.js");
    const rootCommit = (await git(repo.dir, ["rev-list", "--max-parents=0", "HEAD"])).trim();
    const id = projectIdFor(null, rootCommit);
    await git(reposRoot, ["clone", "--quiet", repo.dir, path.join(reposRoot, id)]);

    const status = await executePirCommand(["memory", "status", "--repo", rootCommit, "--json"], {
      onLog: () => {},
    });
    assert.equal(status.code, 0);
    const data = JSON.parse(status.output).data;
    assert.equal(data.dbPath, path.join(stateRoot, id, "memory.sqlite"));
    assert.match(id, /^[0-9a-f]{64}$/);
  } finally {
    repo.cleanup();
  }
});

test("a claimed SHA missing from the bundle is a loud error, not a silent fallback", async (t) => {
  sandbox(t); // env-scoped PIR_REPOS_ROOT/PIR_STATE_ROOT for materializeFromBundle
  const repo = createTempGitRepo("pir-headmismatch-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    const headCommit = repo.commit("head");
    const { createBundle, materializeFromBundle } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const bundle = await createBundle(repo.dir, { base: null, head: headCommit });
    // Well-formed but never packed: a genuine client/bundle mismatch must
    // not quietly review whatever the bundle happened to contain.
    const forged = "f".repeat(40);
    await assert.rejects(
      materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head: forged }),
      (err) => err.message.includes("does not contain the claimed head"),
    );
  } finally {
    repo.cleanup();
  }
});

test("a live foreign lock is never deleted by a failed acquisition", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-foreignlock-");
  try {
    const lockPath = path.join(reposRoot, "repos.json.lock");
    writeFileSync(lockPath, "owned-by-someone-else");
    await assert.rejects(
      executePirCommand(["repos", "add", repo.dir, "--name", "foreign", "--json"]),
      (err) => err.message.includes("repo registry lock busy"),
    );
    // Fresh and not ours: the timed-out acquisition must leave it untouched
    // for its real owner — deleting it would let a third process race in.
    assert.equal(readFileSync(lockPath, "utf8"), "owned-by-someone-else");
  } finally {
    repo.cleanup();
  }
});
