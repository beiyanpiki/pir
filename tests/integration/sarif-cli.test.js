import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * ADR 0016 Part III at the CLI boundary: `--format` is validated before
 * any transport, bundle or session work, and the preview/readout lanes that
 * cannot express findings refuse SARIF instead of silently ignoring it.
 * Model-free: every case here fails before a model call.
 */

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-sarif-cli-"));
  const previous = {
    PIR_CONFIG_DIR: process.env.PIR_CONFIG_DIR,
    PIR_STATE_ROOT: process.env.PIR_STATE_ROOT,
    PIR_NO_WIZARD: process.env.PIR_NO_WIZARD,
  };
  process.env.PIR_CONFIG_DIR = path.join(root, "config");
  process.env.PIR_STATE_ROOT = path.join(root, "state");
  process.env.PIR_NO_WIZARD = "1";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function pir(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

test("an invalid --format is a usage error before any transport work (exit 2)", async (t) => {
  sandbox(t);
  const out = await pir(["find", "--format", "bogus", "--local"]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /invalid --format: bogus \(expected text, json or sarif\)/);
});

test("--json with a non-json --format is refused instead of picking a winner", async (t) => {
  sandbox(t);
  for (const format of ["sarif", "text"]) {
    const out = await pir(["find", "--format", format, "--json", "--local"]);
    assert.equal(out.code, 2, format);
    assert.match(out.stderr, /contradicts --format/);
  }
});

test("preview and readout lanes refuse sarif instead of ignoring it", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-sarif-guard-");
  try {
    repo.commit("change");
    const preview = await pir(["find", "--preview", "--format", "sarif", "--cwd", repo.dir, "--local"]);
    assert.equal(preview.code, 2);
    assert.match(preview.stderr, /--preview prints the selection; --format sarif applies to a review run/);
    const dryRun = await pir(["audit", "--dry-run", "--format", "sarif", "--cwd", repo.dir, "--local"]);
    assert.equal(dryRun.code, 2);
    assert.match(dryRun.stderr, /--dry-run prints a scope preview; --format sarif applies to a real audit run/);
    const coverage = await pir(["audit", "coverage", "--format", "sarif", "--latest", "--cwd", repo.dir, "--local"]);
    assert.equal(coverage.code, 2);
    assert.match(coverage.stderr, /coverage prints a recorded ledger; --format sarif applies to an audit run/);
  } finally { repo.cleanup(); }
});

test("preview lanes honor --format json exactly as --json does", async (t) => {
  sandbox(t);
  const repo = createTempGitRepo("pir-fmt-preview-");
  try {
    repo.commit("change");
    const byFormat = await pir(["find", "--preview", "--format", "json", "--cwd", repo.dir, "--local"]);
    assert.equal(byFormat.code, 0, byFormat.stderr);
    assert.equal(JSON.parse(byFormat.stdout).command, "find.preview");
    const byLegacy = await pir(["find", "--preview", "--json", "--cwd", repo.dir, "--local"]);
    assert.equal(byLegacy.code, 0, byLegacy.stderr);
    assert.equal(byFormat.stdout, byLegacy.stdout);
    const text = await pir(["find", "--preview", "--format", "text", "--cwd", repo.dir, "--local"]);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout.trimStart().startsWith("{"), false, "text preview is not JSON");
  } finally { repo.cleanup(); }
});

test("find and audit --help document the format selector", async (t) => {
  sandbox(t);
  for (const command of ["find", "audit"]) {
    const out = await pir([command, "--help"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /--format <fmt>/);
    assert.match(out.stdout, /sarif/);
  }
});
