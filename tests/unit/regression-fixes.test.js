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
