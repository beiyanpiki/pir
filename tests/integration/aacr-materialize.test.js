import { test } from "node:test";
import assert from "assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTempGitRepo, git } from "../fixtures/helpers.js";
import {
  cachedMergeBase, changedPaths, directoryBytes, ensureFetched, ensureRepoCache, errorRow, hasCommit, headFile,
  isDegradedDiffBase, materializeComment, parseMergeBase, parseOptions, parsePrUrl, pathDiff, readMaterialized,
  rememberMergeBase, writeMaterialized,
} from "../eval/aacr/materialize.js";
import { commentId } from "../eval/aacr/sample.js";
import {
  assertResumeCompatible, buildDigest, ensureFetchedAsync, materializeTask, materializeTaskAsync,
  parseOptions as runOptions, releaseTask, releaseTaskAsync, scoreRow, sha256,
} from "../eval/aacr/run-m0.js";

function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-aacr-mat-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Source history base -> head exposed as a local bare "origin" mirror. */
function buildMirror(root) {
  const source = createTempGitRepo("pir-aacr-src-");
  source.write("src/app.ts", "const a = 1;\nconst b = 2;\n");
  source.write("README.md", "hi\n");
  const base = source.commit("base");
  source.write("src/app.ts", "const a = 1;\nconst b = 3;\nconst c = 4;\n");
  const head = source.commit("head");
  const mirrorDir = path.join(root, "mirror.git");
  git(source.dir, ["clone", "-q", "--bare", source.dir, mirrorDir]);
  source.cleanup();
  return { mirrorDir, base, head };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AACR = path.join(HERE, "..", "eval", "aacr");

const sampledFor = (index, record) => ({ index, id: commentId(index, record), record });

const record = (over = {}) => ({
  pr_url: "https://github.com/example/repo/pull/7",
  pr_source_commit: "a".repeat(40), pr_target_commit: "b".repeat(40),
  path: "src/app.ts", side: "right", from_line: 2, to_line: 2,
  note: "The constant changed.", category: "Code Defect", context: "Diff Level",
  is_ai_comment: true, source_model: "GPT-5.2", label: 1, project_main_language: "TypeScript",
  pr_category: "Bug Fix", pr_change_line_count: 3, ...over,
});

test("M0 dogfood F-185: --resume refuses to mix models or CLI builds", () => {
  const summary = { model: "m-a", cli: { sha256: "a".repeat(64) } };
  assert.doesNotThrow(() => assertResumeCompatible(summary, { model: "m-a", cliSha256: "a".repeat(64) }));
  assert.doesNotThrow(() => assertResumeCompatible(undefined, { model: "m-a", cliSha256: "b".repeat(64) }));
  assert.throws(() => assertResumeCompatible(summary, { model: "m-b", cliSha256: "a".repeat(64) }), /refuses to mix models/);
  assert.throws(() => assertResumeCompatible(summary, { model: "m-a", cliSha256: "b".repeat(64) }), /refuses to mix CLI builds/);
  // A previous summary without provenance (older format) is not a mismatch.
  assert.doesNotThrow(() => assertResumeCompatible({}, { model: "m-b", cliSha256: "b".repeat(64) }));
});

test("B4: buildDigest distinguishes builds that share the CLI entry file", () => {
  temporary((root) => {
    const dist = path.join(root, "dist");
    const cliDir = path.join(dist, "cli");
    const agentDir = path.join(dist, "agents");
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(cliDir, "cli.js"), "import('../agents/verifier.js');\n");
    writeFileSync(path.join(agentDir, "verifier.js"), "export const prompt = 'v1';\n");
    const entryBefore = sha256(readFileSync(path.join(cliDir, "cli.js")));
    const before = buildDigest(dist);
    assert.match(before, /^[0-9a-f]{64}$/);
    // The dispatcher does not change; the behavior does (B4's real shape).
    writeFileSync(path.join(agentDir, "verifier.js"), "export const prompt = 'v2';\n");
    const after = buildDigest(dist);
    assert.notEqual(after, before);
    assert.equal(sha256(readFileSync(path.join(cliDir, "cli.js"))), entryBefore, "the entry file alone cannot see the change — which is why the digest exists");
    // Deterministic and order-independent across filesystem enumeration order.
    assert.equal(buildDigest(dist), after);
    // A round recorded with one build refuses to resume on the other.
    assert.throws(() => assertResumeCompatible({ model: "m", cli: { sha256: entryBefore, buildSha256: before } }, { model: "m", cliSha256: entryBefore, buildSha256: after }), /refuses to mix CLI builds/);
    assert.doesNotThrow(() => assertResumeCompatible({ model: "m", cli: { sha256: entryBefore, buildSha256: after } }, { model: "m", cliSha256: entryBefore, buildSha256: after }));
  });
});

test("M0 dogfood F-181: a failed merge-base lookup is never cached, so later runs retry", () => {
  const cache = {};
  const key = "example/repo|" + "a".repeat(40) + "|" + "b".repeat(40);
  assert.equal(cachedMergeBase(cache, key), undefined, "no entry means resolve, not reuse");
  // A legacy entry that recorded the degraded base-tip pair is treated as
  // absent: the pre-fix code wrote failures exactly like successes.
  cache[key] = "a".repeat(40);
  cache[key + "|kind"] = "base-tip";
  assert.equal(cachedMergeBase(cache, key), undefined, "a base-tip entry must be re-resolved");
  // A successful resolution is reusable and round-trips through the helpers.
  rememberMergeBase(cache, key, "c".repeat(40));
  assert.equal(cachedMergeBase(cache, key), "c".repeat(40));
  assert.equal(cache[key + "|kind"], "merge-base");
  // A malformed sha is not reusable either.
  cache["example/repo|x|y"] = "not-a-sha";
  cache["example/repo|x|y|kind"] = "merge-base";
  assert.equal(cachedMergeBase(cache, "example/repo|x|y"), undefined);
});

test("M0 dogfood F-181: degraded base-tip rows are recognizable for counting", () => {
  assert.equal(isDegradedDiffBase({ material: { diffBaseKind: "base-tip" } }), true);
  assert.equal(isDegradedDiffBase({ material: { diffBaseKind: "merge-base" } }), false);
  assert.equal(isDegradedDiffBase({ material: {} }), false);
  assert.equal(isDegradedDiffBase({}), false);
});

test("repo cache initializes once and fetches exactly the requested commit", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const cacheRoot = path.join(root, "cache");
    const repoDir = ensureRepoCache(cacheRoot, "example/repo", { remote: pathToFileURL(mirrorDir).href });
    assert.equal(path.basename(repoDir), "example_repo");
    assert.equal(hasCommit(repoDir, head), false);
    assert.deepEqual(ensureFetched(repoDir, head), { fetched: true });
    assert.equal(hasCommit(repoDir, head), true);
    assert.deepEqual(ensureFetched(repoDir, head), { fetched: false });
    assert.equal(hasCommit(repoDir, base), false);
    assert.deepEqual(ensureFetched(repoDir, base), { fetched: true });
    // Idempotent cache: the same call returns the same directory.
    assert.equal(ensureRepoCache(cacheRoot, "example/repo", { remote: pathToFileURL(mirrorDir).href }), repoDir);
    assert.ok(directoryBytes(cacheRoot) > 0);
  });
});

test("changedPaths, pathDiff and headFile reconstruct the PR material", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const repoDir = ensureRepoCache(path.join(root, "cache"), "example/repo", { remote: pathToFileURL(mirrorDir).href });
    ensureFetched(repoDir, head);
    ensureFetched(repoDir, base);
    const paths = changedPaths(repoDir, base, head);
    assert.deepEqual([...paths], ["src/app.ts"]);
    const diff = pathDiff(repoDir, base, head, "src/app.ts");
    assert.match(diff.text, /\+const c = 4;/);
    assert.equal(diff.truncated, false);
    assert.equal(pathDiff(repoDir, base, head, "README.md").text, "");
    assert.equal(headFile(repoDir, head, "src/app.ts").text, "const a = 1;\nconst b = 3;\nconst c = 4;\n");
    assert.equal(headFile(repoDir, head, "missing.ts").missing, true);
    // Byte cap is enforced, not approximated.
    const capped = pathDiff(repoDir, base, head, "src/app.ts", { maxBytes: 20 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.text.length <= 20);
  });
});

test("materializeComment produces the intermediate JSONL row and blanks a path outside the diff", () => {
  temporary((root) => {
    const { mirrorDir, base, head } = buildMirror(root);
    const cacheRoot = path.join(root, "cache");
    const repoDir = ensureRepoCache(cacheRoot, "example/repo", { remote: pathToFileURL(mirrorDir).href });
    ensureFetched(repoDir, head);
    ensureFetched(repoDir, base);
    const inDiff = materializeComment({
      sampled: sampledFor(3, record()), repoDir, head, diffBase: base, diffBaseKind: "merge-base", cacheRoot,
    });
    assert.equal(inDiff.id, "c0003-" + commentId(3, record()).slice(6));
    assert.equal(inDiff.comment.nwo, "example/repo");
    assert.equal(inDiff.comment.pr_number, 7);
    assert.equal(inDiff.comment.label, 1);
    assert.equal(inDiff.material.head, head);
    assert.equal(inDiff.material.diffBaseKind, "merge-base");
    assert.equal(inDiff.material.pathInDiff, true);
    assert.match(inDiff.material.diff, /\+const c = 4;/);
    assert.equal(inDiff.material.headFile, "const a = 1;\nconst b = 3;\nconst c = 4;\n");
    assert.equal(inDiff.material.headFileMissing, false);
    assert.equal(inDiff.material.cache, path.join("repos", "example_repo"));
    const outside = materializeComment({
      sampled: sampledFor(4, record({ path: "docs/guide.md" })), repoDir, head, diffBase: base, diffBaseKind: "merge-base", cacheRoot,
    });
    assert.equal(outside.material.pathInDiff, false);
    assert.equal(outside.material.diff, "");
    assert.equal(outside.material.headFileMissing, true);
  });
});

test("error rows keep the run alive and name the stage", () => {
  const row = errorRow(sampledFor(9, record()), "fetch-head", new Error("upload-pack: not our ref"));
  assert.equal(row.id, commentId(9, record()));
  assert.equal(row.error.stage, "fetch-head");
  assert.match(row.error.message, /not our ref/);
  assert.equal(row.comment.label, 1);
  assert.equal(row.material, undefined);
});

test("parsePrUrl and parseMergeBase fail closed", () => {
  assert.deepEqual(parsePrUrl("https://github.com/ClickHouse/ClickHouse/pull/123"), { nwo: "ClickHouse/ClickHouse", prNumber: 123 });
  assert.throws(() => parsePrUrl("https://gitlab.com/a/b/pull/1"), /unrecognized pr_url/);
  assert.throws(() => parsePrUrl("https://github.com/a/b/pulls/1"), /unrecognized pr_url/);
  assert.equal(parseMergeBase("c".repeat(40) + "\n"), "c".repeat(40));
  assert.equal(parseMergeBase("not-a-sha"), null);
  assert.equal(parseMergeBase(""), null);
  assert.equal(parseMergeBase(undefined), null);
});

test("materialized JSONL round-trips header plus rows", () => {
  temporary((dir) => {
    const file = path.join(dir, "materialized.jsonl");
    const header = { __meta__: "aacr-bench/m0-materialized/v1", dataset: { sha256: "d".repeat(64) } };
    const rows = [{ id: "c0001-aaaaaaaa", index: 1 }, { id: "c0002-bbbbbbbb", index: 2 }];
    writeMaterialized(file, header, rows);
    const read = readMaterialized(file);
    assert.equal(read.header.__meta__, "aacr-bench/m0-materialized/v1");
    assert.deepEqual(read.rows.map((row) => row.id), ["c0001-aaaaaaaa", "c0002-bbbbbbbb"]);
    assert.deepEqual(readMaterialized(path.join(dir, "absent.jsonl")), { header: null, rows: [] });
  });
});

test("driver worktrees are detached, isolated and reclaimed", () => {
  temporary((root) => {
    const { mirrorDir, head } = buildMirror(root);
    const cacheRoot = path.join(root, "cache");
    const repoDir = ensureRepoCache(cacheRoot, "example/repo", { remote: pathToFileURL(mirrorDir).href });
    ensureFetched(repoDir, head);
    const workDir = path.join(root, "work", "c0001-aaaaaaaa");
    materializeTask(repoDir, head, workDir);
    assert.equal(git(workDir, ["rev-parse", "HEAD"]).trim(), head);
    assert.match(git(workDir, ["status", "--porcelain"]), /^$/);
    releaseTask(repoDir, workDir);
    assert.equal(existsSync(workDir), false);
  });
});

test("async driver helpers match the sync ones and overlap instead of blocking the loop", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-aacr-async-"));
  try {
    const { mirrorDir, head } = buildMirror(root);
    const repoDir = ensureRepoCache(path.join(root, "cache"), "example/repo", { remote: pathToFileURL(mirrorDir).href });
    assert.deepEqual(await ensureFetchedAsync(repoDir, head), { fetched: true });
    assert.deepEqual(await ensureFetchedAsync(repoDir, head), { fetched: false });
    // Two checkouts of the same commit in parallel: both land clean at head.
    const dirs = [path.join(root, "work", "a"), path.join(root, "work", "b")];
    const ticks = [];
    const timer = setInterval(() => ticks.push(1), 1);
    try {
      await Promise.all(dirs.map((dir) => materializeTaskAsync(repoDir, head, dir)));
    } finally {
      clearInterval(timer);
    }
    for (const dir of dirs) {
      assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), head);
      assert.match(git(dir, ["status", "--porcelain"]), /^$/);
    }
    // The event loop kept running while git worked: a sync execFile would have
    // blocked every timer until the checkouts finished.
    assert.ok(ticks.length > 0, "no timer tick during two async checkouts — git is still blocking the loop");
    await Promise.all(dirs.map((dir) => releaseTaskAsync(repoDir, dir)));
    for (const dir of dirs) assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("driver scoreRow carries labels, buckets and the CLI result", () => {
  const task = { id: "c0001-aaaaaaaa", index: 1, comment: record(), material: { head: "b".repeat(40), diffBase: "a".repeat(40) } };
  const ok = scoreRow(task, "verifier", { ok: true, wallTimeMs: 12, data: {
    decision: "kill", verdict: "rejected", confidence: 0.8, head: task.material.head, diffBase: task.material.diffBase,
    diffBaseKind: "merge-base", pathInDiff: true, usage: { totalTokens: 10 }, model: "m",
  } });
  assert.equal(ok.status, "ok");
  assert.equal(ok.label, 1);
  assert.equal(ok.decision, "kill");
  assert.equal(ok.buckets.source_model, "GPT-5.2");
  assert.equal(ok.buckets.category, "Code Defect");
  assert.equal(ok.buckets.is_ai_comment, true);
  assert.equal(ok.usage.totalTokens, 10);
  const failed = scoreRow(task, "ocr", { ok: false, wallTimeMs: 5, error: "CLI exited 3", stderr: "boom" });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "CLI exited 3");
  assert.equal(failed.decision, undefined);
  assert.equal(failed.stderrTail, "boom");
  // A human comment without a source model is still bucketed (R3).
  const human = scoreRow({ ...task, comment: record({ is_ai_comment: false, source_model: "" }) }, "verifier", { ok: true, wallTimeMs: 1, data: { decision: "keep" } });
  assert.equal(human.buckets.source_model, "human");
});

test("both option parsers validate numeric flags and the arms list", () => {
  const materializeOptions = parseOptions(["--limit", "5", "--seed", "7", "--out", "dataset/x.jsonl"], {});
  assert.equal(materializeOptions.limit, 5);
  assert.equal(materializeOptions.seed, 7);
  assert.ok(path.isAbsolute(materializeOptions.out));
  assert.throws(() => parseOptions(["--limit", "0"], {}), /limit must be a positive integer/);
  assert.throws(() => parseOptions(["--seed", "-1"], {}), /seed must be a non-negative integer/);
  assert.throws(() => parseOptions(["--out"], {}), /missing value/);
  const runOpts = runOptions(["--arms", "verifier", "--concurrency", "3"], {});
  assert.deepEqual(runOpts.arms, ["verifier"]);
  assert.equal(runOpts.concurrency, 3);
  assert.throws(() => runOptions(["--arms", "judge"], {}), /unknown arm/);
  assert.throws(() => runOptions(["--concurrency", "0"], {}), /concurrency must be a positive integer/);
  assert.throws(() => runOptions(["--only"], {}), /missing value/);
});

test("PIR_EVAL gate: materialize and run-m0 skip without doing anything", () => {
  for (const script of ["materialize.js", "run-m0.js"]) {
    const file = path.join(AACR, script);
    const result = spawnSync(process.execPath, [file, "--json"], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
    const help = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8", env: { ...process.env, PIR_EVAL: "0" } });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /PIR_EVAL=1 node tests\/eval\/aacr\//);
  }
});
