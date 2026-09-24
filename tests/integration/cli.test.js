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
