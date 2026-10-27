import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { executePirCommand, UsageError } from "../../dist/cli/executor.js";

/**
 * preview: `pir find --preview` is the pure readout of the change-mode filter —
 * the same buildChangeSet + selectChangeFiles calls a real find makes, with no
 * run row, no model session and no writes.
 */

function seedRepo() {
  const repo = createTempGitRepo("pir-find-preview-");
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("init");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.write(".env", "API_TOKEN=SUPER_SECRET_VALUE\n");
  repo.write("dist/bundle.js", "const bundled = 1;\n");
  repo.commit("change with filtered files");
  return repo;
}

test("Change-mode filter: find --preview prints the selection in text without a run or a model", async () => {
  const repo = seedRepo();
  try {
    const result = await executePirCommand(["find", "--preview", "--no-sync-index", "--cwd", repo.dir], {
      dbPath: path.join(repo.dir, "memory.sqlite"),
    });
    assert.equal(result.code, 0);
    assert.match(result.output, /find preview: merge-base [0-9a-f]{7,} -> head [0-9a-f]{7,} \(3 files, \d+ changed lines\)/);
    assert.match(result.output, /requested base: HEAD\^; filter version 1 \(gates: binary -> secret -> not-included -> skip-pattern -> oversized-diff, 200000-byte diff cap\)/);
    assert.match(result.output, /files: 3 total — 1 selected, 2 excluded \(1 secret, 1 skip-pattern\)/);
    assert.match(result.output, /selected\s+modified\s+\+1\/-1\s+src\/pay\.ts/);
    assert.match(result.output, /excluded\s+added\s+\+1\/-0\s+\.env\s+\(secret path \(dotenv file\); never sent to a model\)/);
    assert.match(result.output, /excluded\s+added\s+\+1\/-0\s+dist\/bundle\.js\s+\(default policy: build output\)/);
    assert.match(result.output, /no run is created and no model is used/);
    // The secret body is never echoed, not even as an example.
    assert.doesNotMatch(result.output, /SUPER_SECRET_VALUE/);
  } finally {
    repo.cleanup();
  }
});

test("Change-mode filter: find --preview --json carries the same decision per file, plus the policy", async () => {
  const repo = seedRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  try {
    const result = await executePirCommand(["find", "--preview", "--json", "--no-sync-index", "--cwd", repo.dir], { dbPath });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, "find.preview");
    assert.equal(parsed.data.requestedBase, "HEAD^");
    assert.match(parsed.data.mergeBase, /^[0-9a-f]{40}$/);
    assert.equal(parsed.data.filter.version, 1);
    assert.equal(parsed.data.filter.maxDiffBytes, 200_000);
    assert.ok(parsed.data.filter.secretPaths.length > 0);
    assert.ok(parsed.data.filter.defaultExclusions.some((rule) => rule.glob === "node_modules/**"));
    const byPath = new Map(parsed.data.files.map((file) => [file.path, file]));
    const selected = byPath.get("src/pay.ts");
    assert.equal(selected.excluded, false);
    assert.equal(selected.gate, undefined);
    assert.equal(selected.additions, 1);
    assert.equal(selected.status, "modified");
    assert.equal(selected.language, "ts");
    const env = byPath.get(".env");
    assert.equal(env.excluded, true);
    assert.equal(env.gate, "secret");
    assert.equal(env.excludedReason, "secret path (dotenv file); never sent to a model");
    assert.equal(env.additions, 1, "churn metadata stays visible");
    const generated = byPath.get("dist/bundle.js");
    assert.equal(generated.excluded, true);
    assert.equal(generated.gate, "skip-pattern");
    assert.equal(generated.excludedReason, "default policy: build output");
    assert.deepEqual(parsed.data.counts, {
      total: 3,
      selected: 1,
      excluded: 2,
      byGate: { secret: 1, "skip-pattern": 1 },
    });
    assert.doesNotMatch(result.output, /SUPER_SECRET_VALUE/);

    // Pure run: no run row and no finding was written by either preview.
    const { Memory } = await import("../../dist/memory/index.js");
    const memory = await Memory.open(repo.dir, { dbPath });
    try {
      assert.equal(memory.store.all("SELECT id FROM review_runs WHERE project_id = ?", memory.identity.projectId).length, 0);
      assert.equal(memory.findings.count(), 0);
    } finally {
      memory.close();
    }
  } finally {
    repo.cleanup();
  }
});

test("Change-mode filter: find --preview rejects run-shaping flags instead of ignoring them", async () => {
  const repo = seedRepo();
  const dbPath = path.join(repo.dir, "memory.sqlite");
  try {
    for (const shaping of [["--max-findings", "5"], ["--max-rounds", "3"], ["--max-tokens", "1000"], ["--fail-on", "P2"], ["--model", "zai-coding-cn/glm-5.3"], ["--angles", "all"]]) {
      await assert.rejects(
        executePirCommand(["find", "--preview", ...shaping, "--cwd", repo.dir], { dbPath }),
        (error) => error instanceof UsageError && /previews the file selection only/.test(error.message),
        `find --preview ${shaping[0]} must be a usage error`,
      );
    }
  } finally {
    repo.cleanup();
  }
});
