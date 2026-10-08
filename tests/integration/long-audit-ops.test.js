import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { executePirCommand, UsageError } from "../../dist/cli/executor.js";
import { createAppContext } from "../../dist/app/context.js";
import { createTempGitRepo, git } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);

/**
 * PR3 (#42 batch 3) integration coverage: isolated bundle packing (#46) and
 * audit scope previews / coverage readouts (#56).
 */

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-lao-"));
  process.env.PIR_REPOS_ROOT = path.join(root, "repos");
  process.env.PIR_STATE_ROOT = path.join(root, "state");
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
}

/** Write a bundle to disk so plain git can verify it. */
async function bundleFile(bundle, prefix) {
  const file = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.bundle`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, bundle);
  return file;
}

test("#46: createBundle never writes the source repo and the bundle materializes server-side", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-lao-bundle-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.write("src/b.ts", "export const b = 2;\n");
    repo.commit("feature");
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    const refsBefore = git(repo.dir, ["for-each-ref"]).trim();
    const headBefore = head;

    const { createBundle, materializeFromBundle } = await import("../../dist/app/repos.js");
    const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
    const bundle = await createBundle(repo.dir, { base: null, head });
    assert.ok(bundle.length > 0);

    // Zero source-repo writes (#46): no transient refs survive, HEAD and the
    // ref listing are byte-identical.
    assert.equal(git(repo.dir, ["for-each-ref"]).trim(), refsBefore);
    assert.equal(git(repo.dir, ["rev-parse", "HEAD"]).trim(), headBefore);
    assert.ok(!git(repo.dir, ["for-each-ref"]).includes("refs/pir/"));

    // The bundle carries the server-facing ref and materializes to the head.
    const file = await bundleFile(bundle, "full");
    t.after(() => rmSync(file, { force: true }));
    const verify = await execFileAsync("git", ["-C", repo.dir, "bundle", "verify", file]);
    assert.match(verify.stdout, /refs\/pir\/bundle-head/);
    assert.doesNotMatch(verify.stdout, /requires this ref/, "a full bundle has no prerequisites");

    const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
    const { review } = await materializeFromBundle(bundle, { remoteUrl, rootCommit, base: null, head });
    t.after(() => review.cleanup());
    assert.equal(review.headCommit, head);
  } finally {
    repo.cleanup();
  }
});

test("#46: a thin bundle keeps the prerequisite contract (base excluded, named as prerequisite)", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-lao-thin-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("base");
    const base = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    repo.write("src/b.ts", "export const b = 2;\n");
    repo.commit("head");
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();

    const { createBundle } = await import("../../dist/app/repos.js");
    const bundle = await createBundle(repo.dir, { base, head });
    const file = await bundleFile(bundle, "thin");
    t.after(() => rmSync(file, { force: true }));
    // The thin form's whole point: history before base is NOT in the bundle,
    // base is recorded as a prerequisite the server must already have.
    const verify = await execFileAsync("git", ["-C", repo.dir, "bundle", "verify", file]);
    assert.match(verify.stdout, /requires this ref/);
    assert.ok(verify.stdout.includes(base), "the base commit is the named prerequisite");
  } finally {
    repo.cleanup();
  }
});

test("#46: concurrent createBundle calls share nothing and leave nothing behind", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-lao-conc-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("base");
    const base = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    repo.write("src/b.ts", "export const b = 2;\n");
    repo.commit("head");
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    const refsBefore = git(repo.dir, ["for-each-ref"]).trim();

    const { createBundle } = await import("../../dist/app/repos.js");
    const [full, thin] = await Promise.all([
      createBundle(repo.dir, { base: null, head }),
      createBundle(repo.dir, { base, head }),
    ]);
    assert.ok(full.length > 0);
    assert.ok(thin.length > 0);
    assert.ok(thin.length < full.length, "the thin bundle is strictly smaller");
    assert.equal(git(repo.dir, ["for-each-ref"]).trim(), refsBefore, "no transient refs after either call");
  } finally {
    repo.cleanup();
  }
});

test("#46: a linked worktree packs from the main repo's common object store", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-lao-worktree-");
  const linked = mkdtempSync(path.join(tmpdir(), "pir-lao-linked-"));
  t.after(() => {
    try {
      git(repo.dir, ["worktree", "remove", "--force", linked]);
    } catch {
      rmSync(linked, { recursive: true, force: true });
    }
    repo.cleanup();
  });
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("one");
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    git(repo.dir, ["worktree", "add", "--quiet", "--detach", linked, head]);

    // Run from the LINKED worktree: --git-common-dir must resolve to the main
    // repo's objects for the alternates line to find anything.
    const { createBundle } = await import("../../dist/app/repos.js");
    const bundle = await createBundle(linked, { base: null, head });
    const file = await bundleFile(bundle, "worktree");
    t.after(() => rmSync(file, { force: true }));
    const verify = await execFileAsync("git", ["-C", repo.dir, "bundle", "verify", file]);
    assert.match(verify.stdout, /refs\/pir\/bundle-head/);
  } finally {
    // cleanup happens in t.after
  }
});

// ---------------------------------------------------------------------------
// #56: audit --dry-run and audit coverage
// ---------------------------------------------------------------------------

function seedAuditRepo() {
  const repo = createTempGitRepo("pir-lao-dry-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.write("src/b.ts", "export const b = 2;\n");
  repo.write("assets/logo.png", "\u0000binary\u0000\n");
  repo.write("dist/generated.js", "minified\n");
  repo.commit("tree");
  return repo;
}

test("#56: audit --dry-run reports the exact plan a real audit would build, and creates no run", async (t) => {
  const repo = seedAuditRepo();
  // The db lives OUTSIDE the repo: an untracked memory.sqlite would make the
  // worktree dirty, and this test asserts the clean-tree case.
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pir-lao-db-")), "memory.sqlite");
  t.after(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  try {
    const args = ["audit", "--dry-run", "--json", "--no-sync-index", "--cwd", repo.dir, "--skip", "src/b.ts"];
    const result = await executePirCommand(args, { dbPath });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.command, "audit.dry-run");
    assert.equal(parsed.data.scopeVersion, 1);
    assert.ok(parsed.data.plannerVersion >= 1);
    assert.ok(parsed.data.files.total >= 4);
    assert.ok(parsed.data.files.reviewable >= 1);
    assert.equal(parsed.data.dirtyWorktree, false);
    assert.ok(parsed.data.note.includes("no run is created"));

    // Parity (#56): the same snapshot + planner a real audit runs must
    // produce the same counts — this is the assertion that matters.
    const { buildRepoSnapshot } = await import("../../dist/changes/snapshot.js");
    const { planAuditUnits } = await import("../../dist/core/audit-planner.js");
    const snapshot = await buildRepoSnapshot(repo.dir, "HEAD", { includePaths: [], skipGlobs: ["src/b.ts"] });
    const plan = await planAuditUnits(snapshot);
    assert.equal(parsed.data.units.total, plan.units.length);
    assert.equal(parsed.data.files.total, snapshot.entries.length);
    const excludedDist = snapshot.entries.find((entry) => entry.path === "dist/generated.js");
    assert.equal(excludedDist.selection, "excluded");
    assert.match(excludedDist.exclusionReason, /default policy/);

    // No run row was created: the preview touched no review state.
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath });
    try {
      assert.equal(ctx.memory.findings.latestRun(), null);
    } finally {
      ctx.memory.close();
    }
  } finally {
    repo.cleanup();
  }
});

test("#56: audit --dry-run --list-files enumerates every entry with its decision", async (t) => {
  const repo = seedAuditRepo();
  try {
    const result = await executePirCommand(
      ["audit", "--dry-run", "--list-files", "--json", "--no-sync-index", "--cwd", repo.dir],
      { dbPath: path.join(repo.dir, "memory.sqlite") },
    );
    assert.equal(result.code, 0);
    const list = JSON.parse(result.output).data.list;
    const byPath = new Map(list.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("src/a.ts").selection, "selected");
    assert.equal(byPath.get("src/a.ts").classification, "text");
    assert.equal(byPath.get("assets/logo.png").classification, "binary-extension");
    assert.equal(byPath.get("dist/generated.js").selection, "excluded");
    assert.match(byPath.get("dist/generated.js").reason, /default policy/);
    // Text output renders the same table for humans.
    const text = await executePirCommand(["audit", "--dry-run", "--list-files", "--no-sync-index", "--cwd", repo.dir], {
      dbPath: path.join(repo.dir, "memory.sqlite"),
    });
    assert.match(text.output, /audit dry-run: head/);
    assert.match(text.output, /units: \d+ planned/);
    assert.match(text.output, /src\/a\.ts/);
  } finally {
    repo.cleanup();
  }
});

test("#56: audit --dry-run rejects run-shaping flags it cannot honor", async (t) => {
  const repo = seedAuditRepo();
  try {
    await assert.rejects(
      executePirCommand(["audit", "--dry-run", "--max-findings", "5", "--cwd", repo.dir], {
        dbPath: path.join(repo.dir, "memory.sqlite"),
      }),
      (error) => error instanceof UsageError && /previews the scope only/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("#56: audit coverage reads the recorded ledger (--latest and --run)", async (t) => {
  const repo = seedAuditRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
  try {
    // Seed a finished audit run plus its coverage rows, exactly the way a
    // real audit persists them mid-run (#38 upsertProgress).
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath });
    const run = ctx.memory.findings.createRun({ base: null, head, mode: "audit" });
    ctx.memory.audit.upsertProgress(run.id, {
      units: [{ unitId: "u1", state: "reviewed", files: 2, attempts: 1 }],
      files: [
        { path: "src/a.ts", blobId: "b".repeat(40), state: "reviewed", rangesTotal: 2, rangesReviewed: 2 },
        { path: "src/b.ts", blobId: "c".repeat(40), state: "partial", reason: "budget stop", rangesTotal: 2, rangesReviewed: 1 },
      ],
    });
    ctx.memory.close();

    const latest = await executePirCommand(["audit", "coverage", "--latest", "--json", "--cwd", repo.dir], { dbPath });
    assert.equal(latest.code, 0);
    const parsed = JSON.parse(latest.output);
    assert.equal(parsed.command, "audit.coverage");
    assert.equal(parsed.data.run.id, run.id);
    assert.equal(parsed.data.summary.reviewed, 1);
    assert.equal(parsed.data.summary.partial, 1);
    const partial = parsed.data.files.find((file) => file.path === "src/b.ts");
    assert.equal(partial.state, "partial");
    assert.equal(partial.reason, "budget stop");
    assert.equal(partial.rangesReviewed, 1);

    // --run <id> resolves the same run; text mode renders the ledger.
    const byId = await executePirCommand(["audit", "coverage", "--run", run.id, "--cwd", repo.dir], { dbPath });
    assert.equal(byId.code, 0);
    assert.match(byId.output, /src\/b\.ts \(ranges 1\/2\) — budget stop/);

    // Wrong shapes fail fast as usage errors, unknown runs as exit 3.
    await assert.rejects(
      executePirCommand(["audit", "coverage", "--cwd", repo.dir], { dbPath }),
      (error) => error instanceof UsageError && /exactly one of/.test(error.message),
    );
    const unknown = await executePirCommand(["audit", "coverage", "--run", "00000000-0000-0000-0000-000000000000", "--cwd", repo.dir], { dbPath });
    assert.equal(unknown.code, 3);

    // A change-mode run is not an audit ledger.
    const ctx2 = await createAppContext(repo.dir, { noSyncIndex: true, dbPath });
    const changeRun = ctx2.memory.findings.createRun({ base: head, head, mode: "change" });
    ctx2.memory.close();
    await assert.rejects(
      executePirCommand(["audit", "coverage", "--run", changeRun.id, "--cwd", repo.dir], { dbPath }),
      (error) => error instanceof UsageError && /change-mode run/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("#56 (dogfood F-51): dry-run fails exactly where a real audit fails — empty and non-reviewable scopes", async (t) => {
  const repo = createTempGitRepo("pir-lao-guards-");
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pir-lao-db-")), "memory.sqlite");
  t.after(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  try {
    repo.write("assets/logo.png", "\u0000binary\u0000\n");
    repo.commit("binary-only");
    await assert.rejects(
      executePirCommand(["audit", "--dry-run", "--json", "--no-sync-index", "--cwd", repo.dir], { dbPath }),
      (error) => error instanceof UsageError && /none are reviewable text/.test(error.message),
    );
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("text");
    await assert.rejects(
      executePirCommand(["audit", "--dry-run", "--json", "--no-sync-index", "--cwd", repo.dir, "--path", "docs"], { dbPath }),
      (error) => error instanceof UsageError && /audit scope is empty/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("#46 (dogfood F-52): a sha256 source repository packs through a matching temp repo", async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "pir-lao-sha256-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet", "--object-format=sha256"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "one"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  const { createBundle } = await import("../../dist/app/repos.js");
  const bundle = await createBundle(repo, { base: null, head });
  const file = await bundleFile(bundle, "sha256");
  t.after(() => rmSync(file, { force: true }));
  const verify = await execFileAsync("git", ["-C", repo, "bundle", "verify", file]);
  assert.match(verify.stdout, /refs\/pir\/bundle-head/);
});

test("#46 (dogfood F-54): a machine defaulting to sha256 still packs a sha1 source", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-lao-sha1-");
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("one");
    const head = git(repo.dir, ["rev-parse", "HEAD"]).trim();
    assert.equal(git(repo.dir, ["rev-parse", "--show-object-format"]).trim(), "sha1");

    // Simulate a machine whose git defaults new repos to sha256 — via git's
    // env-var config, so nothing global is polluted.
    const saved = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.defaultObjectFormat";
    process.env.GIT_CONFIG_VALUE_0 = "sha256";
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { createBundle } = await import("../../dist/app/repos.js");
    const bundle = await createBundle(repo.dir, { base: null, head });
    const file = await bundleFile(bundle, "sha1-on-sha256-default");
    t.after(() => rmSync(file, { force: true }));
    const verify = await execFileAsync("git", ["-C", repo.dir, "bundle", "verify", file]);
    assert.match(verify.stdout, /refs\/pir\/bundle-head/);
  } finally {
    repo.cleanup();
  }
});
