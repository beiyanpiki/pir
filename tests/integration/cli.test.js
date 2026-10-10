import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
// Keep the CLI away from the developer's real ~/.pir/config.json.
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-cli-cfg-"));

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PIR_CONFIG_DIR: CONFIG_DIR, PIR_NO_WIZARD: "1", ...opts.env },
  });
  return { stdout, stderr, code: 0 };
}

async function pirExpectFail(args, opts = {}) {
  try {
    await pir(args, opts);
  } catch (err) {
    return { stderr: err.stderr ?? "", stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
  throw new Error(`expected failure: pir ${args.join(" ")}`);
}

test("pir --help and version work without a repo", async () => {
  const help = await pir(["--help"]);
  assert.match(help.stdout, /pir find/);
  const version = await pir(["version"]);
  assert.match(version.stdout.trim(), /^pir \d+\.\d+\.\d+$/);
});

test("pir memory status --json returns the envelope on a git repo", async () => {
  const repo = createTempGitRepo("pir-cli-");
  try {
    const { stdout } = await pir(["memory", "status", "--json", "--cwd", repo.dir]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, "memory.status");
    assert.ok(parsed.data.projectId);
    assert.ok(parsed.data.dbPath.includes("memory.sqlite"));
  } finally {
    repo.cleanup();
  }
});

test("pir remember -> findings list round-trip on a seeded finding", async (t) => {
  const repo = createTempGitRepo("pir-cli2-");
  const dbPath = path.join(repo.dir, "m.sqlite");
  const env = { PIR_MEMORY_DB: dbPath };
  try {
    const remember = await pir(
      ["remember", "project", "invariant", "--text", "All writes must be idempotent", "--json", "--cwd", repo.dir],
      { env },
    );
    assert.equal(JSON.parse(remember.stdout).command, "remember");

    // Seed a finding through the library into the SAME db the CLI reads.
    const { Memory } = await import("../../dist/memory/index.js");
    const { buildIdentity } = await import("../../dist/findings/identity.js");
    const memory = await Memory.open(repo.dir, { dbPath });
    const identity = buildIdentity({
      featureKey: "f",
      entityKey: "E.fn",
      category: "correctness",
      claim: "claim one",
      trigger: "trigger one",
    });
    memory.findings.insert(
      {
        title: "t",
        claim: "claim one",
        trigger: "trigger one",
        category: "correctness",
        severity: "P2",
        featureKey: "f",
        entityKey: "E.fn",
        anchors: [],
        evidence: [],
        round: 1,
        identity,
        status: "confirmed",
        memoryMatches: [],
      },
      "run-1",
    );
    memory.close();

    const list = await pir(["findings", "list", "--json", "--cwd", repo.dir], { env });
    const parsedList = JSON.parse(list.stdout);
    assert.equal(parsedList.data.findings.length, 1);
    assert.equal(parsedList.data.findings[0].displayId, "F-1");

    const show = await pir(["findings", "show", "F-1", "--json", "--cwd", repo.dir], { env });
    assert.equal(JSON.parse(show.stdout).data.claim, "claim one");

    const feedback = await pir(
      ["feedback", "F-1", "expected", "--note", "intentional", "--json", "--cwd", repo.dir],
      { env },
    );
    const parsedFeedback = JSON.parse(feedback.stdout);
    assert.equal(parsedFeedback.data.newStatus, "expected");
    assert.ok(parsedFeedback.data.issueMemoryId);
  } finally {
    repo.cleanup();
  }
});

test("pir exit codes: usage error exits 2, unknown finding exits 3", async () => {
  const repo = createTempGitRepo("pir-cli3-");
  try {
    const usage = await pirExpectFail(["feedback", "F-99", "not-a-decision", "--cwd", repo.dir]);
    assert.equal(usage.code, 2);

    const runtime = await pirExpectFail(["verify-fix", "F-404", "--cwd", repo.dir]);
    assert.equal(runtime.code, 3);
  } finally {
    repo.cleanup();
  }
});

test("pir find rejects invalid numeric budgets as usage errors", async () => {
  const repo = createTempGitRepo("pir-cli-budgets-");
  try {
    for (const flag of ["--max-findings", "--max-rounds", "--max-tokens"]) {
      for (const bad of ["0", "-3", "2.5", "abc"]) {
        const usage = await pirExpectFail(["find", flag, bad, "--cwd", repo.dir]);
        assert.equal(usage.code, 2, `${flag} ${bad} must be a usage error`);
        assert.ok(usage.stderr.includes(flag));
      }
    }
  } finally {
    repo.cleanup();
  }
});

test("pir find/audit reject out-of-range --verify-concurrency before any run starts", async () => {
  const repo = createTempGitRepo("pir-cli-verifyconc-");
  try {
    for (const command of ["find", "audit"]) {
      for (const bad of ["0", "9", "abc"]) {
        const usage = await pirExpectFail([command, "--verify-concurrency", bad, "--cwd", repo.dir]);
        assert.equal(usage.code, 2, `${command} --verify-concurrency ${bad} must be a usage error`);
        assert.match(usage.stderr, /invalid --verify-concurrency/);
      }
    }
    // The env fallback obeys the same bound, and the flag wins over it.
    const envBad = await pirExpectFail(["find", "--cwd", repo.dir], { env: { PIR_VERIFY_CONCURRENCY: "12" } });
    assert.equal(envBad.code, 2);
    assert.match(envBad.stderr, /invalid --verify-concurrency: 12/);
  } finally {
    repo.cleanup();
  }
});

test("pir models lists the full pi catalog with --all", async () => {
  const json = await pir(["models", "--json", "--all"]);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.command, "models");
  assert.ok(Array.isArray(parsed.data.models) && parsed.data.models.length > 0);
  const anthropic = parsed.data.models.find((m) => m.provider === "anthropic");
  assert.ok(anthropic, "catalog contains anthropic");
  assert.equal(typeof anthropic.contextWindow, "number");
  assert.equal(typeof anthropic.maxTokens, "number");
  assert.equal(typeof anthropic.authenticated, "boolean");

  const ids = await pir(["models", "--ids", "--all", "--provider", "anthropic"]);
  const lines = ids.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => l.startsWith("anthropic/")));

  const search = await pir(["models", "--ids", "--all", "--provider", "anthropic", "claude-opus"]);
  const searched = search.stdout.trim().split("\n").filter(Boolean);
  assert.ok(searched.length > 0);
  assert.ok(searched.every((l) => l.startsWith("anthropic/") && l.includes("claude-opus")));
});

test("pir models without --all only lists authenticated models (or guidance)", async () => {
  const ids = await pir(["models", "--ids"]);
  const lines = ids.stdout.trim().split("\n").filter(Boolean);
  // With credentials present every line is provider/model; without any, the
  // machine-mode output is empty and the hint goes to stderr.
  assert.ok(lines.every((l) => /^[^\s/]+\/[^\s]+$/.test(l)));

  const table = await pir(["models"]);
  if (lines.length === 0) {
    assert.match(table.stdout, /No authenticated models/);
  } else {
    assert.match(table.stdout, /^provider\s+model/);
  }
});

test("pir find rejects non-positive --max-rounds/--max-tokens like --max-findings", async () => {
  const repo = createTempGitRepo();
  try {
    for (const flag of ["--max-rounds", "--max-tokens", "--max-findings"]) {
      const res = await pirExpectFail(["find", flag, "0"], { cwd: repo.dir });
      assert.equal(res.code, 2, `${flag} 0 must be a usage error`);
      assert.match(res.stderr + res.stdout, new RegExp(`invalid ${flag}`));
    }
  } finally {
    repo.cleanup();
  }
});

// --- #47: findings list pagination and completeness metadata ---

/** Seed `count` findings with heavily-shared timestamps (bulk-insert reality). */
async function seedFindings(repo, dbPath, count) {
  const { Memory } = await import("../../dist/memory/index.js");
  const { buildIdentity } = await import("../../dist/findings/identity.js");
  const memory = await Memory.open(repo.dir, { dbPath });
  for (let i = 0; i < count; i++) {
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
        status: i % 13 === 0 ? "rejected" : "confirmed",
        memoryMatches: [],
      },
      "run-seed",
    );
  }
  memory.close();
}

test("#47: findings list defaults to a 100-row page but reports total/hasMore/nextOffset", async () => {
  const repo = createTempGitRepo("pir-cli-page-");
  const env = { PIR_MEMORY_DB: path.join(repo.dir, "m.sqlite") };
  try {
    await seedFindings(repo, env.PIR_MEMORY_DB, 130);
    const res = await pir(["findings", "list", "--json", "--cwd", repo.dir], { env });
    const page = JSON.parse(res.stdout).data;
    assert.equal(page.findings.length, 100);
    assert.equal(page.total, 130);
    assert.equal(page.returned, 100);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 100);
    // Text mode flags the partial page instead of staying silent.
    const text = await pir(["findings", "list", "--cwd", repo.dir], { env });
    assert.match(text.stderr, /showing 100 of 130/);
    assert.match(text.stderr, /--all/);
  } finally {
    repo.cleanup();
  }
});

test("#47: --all returns every row; --status filters rows and total alike", async () => {
  const repo = createTempGitRepo("pir-cli-all-");
  const env = { PIR_MEMORY_DB: path.join(repo.dir, "m.sqlite") };
  try {
    await seedFindings(repo, env.PIR_MEMORY_DB, 130);
    const all = await pir(["findings", "list", "--all", "--json", "--cwd", repo.dir], { env });
    const page = JSON.parse(all.stdout).data;
    assert.equal(page.findings.length, 130);
    assert.equal(page.total, 130);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, null);
    assert.equal(new Set(page.findings.map((f) => f.displayId)).size, 130, "no duplicates");

    const rejected = await pir(["findings", "list", "--status", "rejected", "--all", "--json", "--cwd", repo.dir], { env });
    const rejectedPage = JSON.parse(rejected.stdout).data;
    assert.equal(rejectedPage.total, 10); // 130 / 13
    assert.ok(rejectedPage.findings.every((f) => f.status === "rejected"));
  } finally {
    repo.cleanup();
  }
});

test("#47: offset paging walks the whole set with no drops or duplicates across a shared timestamp", async () => {
  const repo = createTempGitRepo("pir-cli-off-");
  const env = { PIR_MEMORY_DB: path.join(repo.dir, "m.sqlite") };
  try {
    await seedFindings(repo, env.PIR_MEMORY_DB, 130);
    const seen = [];
    for (const [limit, offset] of [[60, 0], [60, 60], [60, 120]]) {
      const res = await pir(
        ["findings", "list", "--limit", String(limit), "--offset", String(offset), "--json", "--cwd", repo.dir],
        { env },
      );
      const page = JSON.parse(res.stdout).data;
      assert.equal(page.findings.length, Math.min(limit, Math.max(130 - offset, 0)));
      seen.push(...page.findings.map((f) => f.displayId));
    }
    assert.equal(seen.length, 130);
    assert.equal(new Set(seen).size, 130, "offset pages must not drop or duplicate rows");
    // Deterministic ordering: the same query twice yields the same sequence.
    const a = await pir(["findings", "list", "--limit", "5", "--json", "--cwd", repo.dir], { env });
    const b = await pir(["findings", "list", "--limit", "5", "--json", "--cwd", repo.dir], { env });
    assert.deepEqual(
      JSON.parse(a.stdout).data.findings.map((f) => f.displayId),
      JSON.parse(b.stdout).data.findings.map((f) => f.displayId),
    );
  } finally {
    repo.cleanup();
  }
});

test("#47: --all refuses --limit/--offset; --offset 0 is valid", async () => {
  const repo = createTempGitRepo("pir-cli-mix-");
  try {
    const res = await pirExpectFail(["findings", "list", "--all", "--limit", "5", "--cwd", repo.dir]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--all cannot be combined/);
    const zero = await pir(["findings", "list", "--offset", "0", "--json", "--cwd", repo.dir], {
      env: { PIR_MEMORY_DB: path.join(repo.dir, "m.sqlite") },
    });
    assert.equal(JSON.parse(zero.stdout).data.total, 0);
  } finally {
    repo.cleanup();
  }
});
