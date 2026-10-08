import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Regression tests for the audit dogfood findings (PR stack level 3).
 * Each case names the finding it pins down.
 */

test("F-2: reposRoot fails with actionable guidance when HOME is unset", async () => {
  const { reposRoot } = await import("../../dist/app/repos.js");
  const saved = { ...process.env };
  delete process.env.HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.PIR_REPOS_ROOT;
  try {
    assert.throws(() => reposRoot(), /cannot locate the repos root.*PIR_REPOS_ROOT/);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG_DATA_HOME !== undefined) process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
    if (saved.PIR_REPOS_ROOT !== undefined) process.env.PIR_REPOS_ROOT = saved.PIR_REPOS_ROOT;
  }
});

test("F-4: parseUnifiedDiff survives malformed quoted path tokens", async () => {
  const { parseUnifiedDiff } = await import("../../dist/changes/diff.js");
  // Broken C-quoting (unterminated escape) used to throw inside JSON.parse.
  const patch = [
    'diff --git "a/bad\\346" "b/bad\\346"',
    "index 1111111..2222222 100644",
    "--- a/bad",
    "+++ b/bad",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.files.length, 1);
  assert.ok(parsed.files[0].path.length > 0);
});

test("F-7: --uncommitted and an explicit --head are rejected together", async () => {
  const repo = createTempGitRepo("pir-f7-");
  try {
    const { executePirCommand, UsageError } = await import("../../dist/cli/executor.js");
    await assert.rejects(
      executePirCommand(["find", "--cwd", repo.dir, "--uncommitted", "--head", "HEAD"]),
      (error) => error instanceof UsageError && /mutually exclusive/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("F-9/F-10: degraded fileOverview never follows directory symlinks", async () => {
  const { DegradedCodeMap } = await import("../../dist/codemap/provider.js");
  const dir = mkdtempSync(path.join(tmpdir(), "pir-degraded-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "const a = 1;\n");
    // Self-referencing directory symlink: the old statSync walk recursed forever.
    symlinkSync(dir, path.join(dir, "src", "loop"));
    const map = new DegradedCodeMap(dir);
    const files = await map.fileOverview();
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/a.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-14: applyFeedback validates decision before writing anything", async () => {
  const repo = createTempGitRepo("pir-f14-");
  try {
    const { createAppContext } = await import("../../dist/app/context.js");
    const { applyFeedback } = await import("../../dist/memory/feedback.js");
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
    try {
      await assert.rejects(
        applyFeedback(ctx.memory, { findingId: "F-1", decision: "definitely-broken", commit: "0".repeat(40) }),
        /invalid decision: definitely-broken/,
      );
      // Nothing was written: no audit event, no finding row.
      assert.equal(ctx.memory.findings.listFeedbackEvents().length, 0);
      assert.equal(ctx.memory.findings.list().length, 0);
    } finally {
      ctx.memory.close();
    }
  } finally {
    repo.cleanup();
  }
});

test("F-0: the default token budget is unlimited (no cap unless --max-tokens)", async () => {
  // Pin the semantics 82505f9 established and the audit rewrite accidentally
  // regressed: no DEFAULT_MAX_TOKENS cap in the supervisor source.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/core/supervisor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DEFAULT_MAX_TOKENS/);
  assert.match(source, /options\.maxTokens === undefined \? undefined : positiveInteger/);
});

// --- batch-1 dogfood (issue #42): F-38 retry pacing, F-39 page consistency ---

test("F-38: an absent Retry-After header falls back to the designed 1s backoff, not 0s", async (t) => {
  const { remoteExec } = await import("../../dist/cli/remote.js");
  const { createTempGitRepo } = await import("../fixtures/helpers.js");
  const repo = createTempGitRepo("pir-f38-");
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/v1/review")) {
      posts += 1;
      const body = posts === 1 ? { error: "busy" } : { code: 0, output: "[]\n", log: [] };
      // No retry-after header at all — the common proxy case.
      return {
        status: posts === 1 ? 429 : 200,
        ok: posts !== 1,
        headers: new Map(),
        text: async () => JSON.stringify(body),
      };
    }
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    repo.cleanup();
  });
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await remoteExec("https://pir.invalid", ["--cwd", repo.dir, "findings", "list", "--json"], {});
    assert.equal(code, 0);
    // Number(null) === 0 must not slip through: the printed delay is the
    // designed 1s backoff, never "in 0s".
    assert.match(chunks.join(""), /retrying the bundle-free request in 1s/);
    assert.doesNotMatch(chunks.join(""), /in 0s/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("F-39: listPage reports rows and total from one statement, exact at every offset", async () => {
  const { Memory } = await import("../../dist/memory/index.js");
  const { buildIdentity } = await import("../../dist/findings/identity.js");
  const repo = createTempGitRepo("pir-f39-");
  try {
    const dbPath = path.join(repo.dir, "m.sqlite");
    const memory = await Memory.open(repo.dir, { dbPath });
    for (let i = 0; i < 7; i++) {
      memory.findings.insert(
        {
          title: `t${i}`,
          claim: `claim ${i}`,
          trigger: `trigger ${i}`,
          category: "correctness",
          severity: "P3",
          featureKey: "f",
          entityKey: "E.fn",
          anchors: [],
          evidence: [],
          round: 1,
          identity: buildIdentity({
            featureKey: "f",
            entityKey: "E.fn",
            category: "correctness",
            claim: `claim ${i}`,
            trigger: `trigger ${i}`,
          }),
          status: i < 5 ? "confirmed" : "rejected",
          memoryMatches: [],
        },
        "run-f39",
      );
    }
    const first = memory.findings.listPage({ limit: 3, offset: 0 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.total, 7, "window total is the filtered total, same snapshot");

    const filtered = memory.findings.listPage({ status: "rejected", limit: 2, offset: 0 });
    assert.equal(filtered.rows.length, 2);
    assert.equal(filtered.total, 2, "the window total follows the status filter");

    // Paged past the end: zero rows but the total stays observable.
    const beyond = memory.findings.listPage({ limit: 3, offset: 6 });
    assert.equal(beyond.rows.length, 1); // 7 % 3
    const past = memory.findings.listPage({ limit: 3, offset: 9 });
    assert.equal(past.rows.length, 0);
    assert.equal(past.total, 7);

    const empty = memory.findings.listPage({ status: "uncertain", limit: 3, offset: 0 });
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.total, 0);
    memory.close();
  } finally {
    repo.cleanup();
  }
});
