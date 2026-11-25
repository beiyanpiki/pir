import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, chmodSync, truncateSync } from "node:fs";
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

test("fetchPullRef fetches refs/pull/<n>/head into a stable ref that survives fetch --all", async (t) => {
  sandbox(t);
  const origin = createTempGitRepo("pir-pullref-origin-");
  try {
    const head1 = origin.commit("first");
    git(origin.dir, ["update-ref", "refs/pull/7/head", head1]);
    const { addRepo, fetchPullRef } = await import("../../dist/app/repos.js");
    const entry = await addRepo(origin.dir);
    const dir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);

    // New push: the origin's pull ref moves; the registered clone's fetch must follow.
    origin.write("src/next.ts", "export const next = 1;\n");
    const head2 = origin.commit("second");
    git(origin.dir, ["update-ref", "refs/pull/7/head", head2]);
    assert.equal(await fetchPullRef(dir, 7), head2);

    // The ref is a fixed local ref, not FETCH_HEAD: a concurrent plain
    // `fetch --all` (any other in-flight review) cannot overwrite it.
    await git(dir, ["fetch", "--all", "--quiet"]);
    assert.equal((await git(dir, ["rev-parse", "refs/pir/pull/7/head"])).trim(), head2);

    // A PR number the origin does not have is a loud error, not a stale ref.
    await assert.rejects(fetchPullRef(dir, 9), /refs\/pull\/9\/head/);
  } finally {
    origin.cleanup();
  }
});

test("findRegisteredRepoByUrl matches across transports and returns null for unknown repos", async (t) => {
  sandbox(t);
  const origin = createTempGitRepo("pir-byurl-origin-");
  try {
    git(origin.dir, ["remote", "add", "origin", "https://Gitea.Example.com/beiyan/Repo.git"]);
    const { addRepo, findRegisteredRepoByUrl } = await import("../../dist/app/repos.js");
    const entry = await addRepo(origin.dir);

    // Same repository, different transport spelling (case, .git, ssh form).
    const found = findRegisteredRepoByUrl("git@gitea.example.com:beiyan/Repo");
    assert.ok(found, "ssh spelling should match the https registration");
    assert.equal(found.entry.projectId, entry.projectId);
    assert.equal(found.dir, path.join(process.env.PIR_REPOS_ROOT, entry.projectId));

    // A local path registration matches the identical path (webhook payloads
    // from a local Gitea carry it as clone_url).
    const local = createTempGitRepo("pir-byurl-local-");
    try {
      const localEntry = await addRepo(local.dir);
      const localFound = findRegisteredRepoByUrl(local.dir);
      assert.ok(localFound);
      assert.equal(localFound.entry.projectId, localEntry.projectId);
    } finally {
      local.cleanup();
    }

    assert.equal(findRegisteredRepoByUrl("https://other.example.com/x/y.git"), null);
  } finally {
    origin.cleanup();
  }
});

test("a corrupt bundle cache is not rebuilt while another review worktree is live", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-heal-live-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("base");
    repo.write("src/b.ts", "export const b = 2;\n");
    const headCommit = repo.commit("head");

    const { createBundle, materializeFromBundle, projectIdFor } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const meta = { remoteUrl, rootCommit, base: null, head: headCommit };
    const bundle = await createBundle(repo.dir, { base: null, head: headCommit });

    const first = await materializeFromBundle(bundle, meta);
    try {
      const cacheDir = path.join(reposRoot, projectIdFor(remoteUrl, rootCommit));
      for (const pack of readdirSync(path.join(cacheDir, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"))) {
        const packPath = path.join(cacheDir, ".git", "objects", "pack", pack);
        chmodSync(packPath, 0o644);
        truncateSync(packPath, 100);
      }
      // A second review of the same project must not "heal" the cache by
      // deleting the repo the first review's worktree lives in.
      await assert.rejects(materializeFromBundle(bundle, meta), /refusing to rebuild corrupt bundle cache/);
      assert.ok(existsSync(cacheDir), "the shared cache survives");
      assert.equal(
        readFileSync(path.join(first.review.worktree, "src", "b.ts"), "utf8"),
        "export const b = 2;\n",
        "the live worktree is still readable",
      );
    } finally {
      await first.review.cleanup();
    }
    // Once no worktree is registered, the rebuild is allowed again.
    const healed = await materializeFromBundle(bundle, meta);
    try {
      assert.equal(healed.review.headCommit, headCommit);
    } finally {
      await healed.review.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});

test("a failed first bundle contact removes the partial cache and releases the repo lock", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-fail-clean-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    const headCommit = repo.commit("head");
    const { createBundle, materializeFromBundle, projectIdFor } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const bundle = await createBundle(repo.dir, { base: null, head: headCommit });
    const forged = "f".repeat(40);
    const cacheDir = path.join(reposRoot, projectIdFor(remoteUrl, rootCommit));

    await assert.rejects(
      materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head: forged }),
      /does not contain the claimed head/,
    );
    assert.ok(!existsSync(cacheDir), "the partial first-contact project dir was removed");
    assert.equal(existsSync(path.join(reposRoot, "work")) ? readdirSync(path.join(reposRoot, "work")).length : 0, 0, "no worktree leaked");

    // An immediate retry reaches the same, real error instead of a busy lock:
    // the failed attempt released its resource lock.
    await assert.rejects(
      materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head: forged }),
      /does not contain the claimed head/,
    );
    const ok = await materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head: headCommit });
    try {
      assert.equal(ok.review.headCommit, headCommit);
    } finally {
      await ok.review.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});

test("a failed registered materialization releases the lock and leaves no worktree", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-fail-reg-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("head");
    const { addRepo, materializeRegistered } = await import("../../dist/app/repos.js");
    const entry = await addRepo(repo.dir, "demo");
    const dir = path.join(reposRoot, entry.projectId);

    await assert.rejects(
      materializeRegistered(dir, entry.projectId, { branch: "does-not-exist", noFetch: true }),
      /rev-parse/,
    );
    assert.equal(existsSync(path.join(reposRoot, "work")) ? readdirSync(path.join(reposRoot, "work")).length : 0, 0);

    const review = await materializeRegistered(dir, entry.projectId, { noFetch: true });
    await review.cleanup();
  } finally {
    repo.cleanup();
  }
});

test("cleanup still removes the worktree after the clone disappears", async (t) => {
  const { reposRoot } = sandbox(t);
  const repo = createTempGitRepo("pir-cleanup-gone-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    const headCommit = repo.commit("head");
    const { createBundle, materializeFromBundle, projectIdFor } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const bundle = await createBundle(repo.dir, { base: null, head: headCommit });
    const materialized = await materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head: headCommit });

    // A human deleting the clone must not leave cleanup to guess: the
    // worktree is dropped even though git worktree remove cannot run.
    rmSync(path.join(reposRoot, projectIdFor(remoteUrl, rootCommit)), { recursive: true, force: true });
    await materialized.review.cleanup();
    assert.ok(!existsSync(materialized.review.worktree), "the worktree directory is gone");
    assert.equal(readdirSync(path.join(reposRoot, "work")).length, 0);
  } finally {
    repo.cleanup();
  }
});

test("the Gitea pull-ref flow prepares sequentially and reviews the SHA it fetched", async (t) => {
  sandbox(t);
  const origin = createTempGitRepo("pir-pull-flow-");
  try {
    origin.write("src/who.txt", "one\n");
    const head = origin.commit("head");
    await git(origin.dir, ["update-ref", "refs/pull/7/head", head]);
    const { addRepo, fetchPullRef, materializeRegistered } = await import("../../dist/app/repos.js");
    const entry = await addRepo(origin.dir);
    const dir = path.join(process.env.PIR_REPOS_ROOT, entry.projectId);

    // fetchPullRef releases its lock before materializeRegistered takes it
    // again; a different push moving the pull ref in between must not change
    // which commit the pinned SHA reviews.
    const fetched = await fetchPullRef(dir, 7);
    assert.equal(fetched, head);
    origin.write("src/who.txt", "two\n");
    const nextHead = origin.commit("next");
    await git(origin.dir, ["update-ref", "refs/pull/7/head", nextHead]);

    const review = await materializeRegistered(dir, entry.projectId, { branch: fetched });
    try {
      assert.equal(review.headCommit, head);
      assert.equal(readFileSync(path.join(review.worktree, "src", "who.txt"), "utf8"), "one\n");
    } finally {
      await review.cleanup();
    }
    assert.equal(await fetchPullRef(dir, 7), nextHead);
  } finally {
    origin.cleanup();
  }
});
