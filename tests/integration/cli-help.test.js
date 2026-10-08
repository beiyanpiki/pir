import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "pir-help-cfg-"));

async function pir(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PIR_CONFIG_DIR: opts.configDir ?? CONFIG_DIR, PIR_NO_WIZARD: "1", ...opts.env },
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

function writeConfig(configDir, config) {
  writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path.join(configDir, "config.json"), 0o600);
}

// #43: --help must be answered locally, before config validation, transport,
// git or network. The remote server below is unreachable on purpose — a help
// request that tried to contact it would hang into the timeout, not exit 0.
const REMOTE = { schemaVersion: 1, mode: "remote", server: { url: "https://pir.invalid.example:8790" } };

test("#43: --help works in remote mode without contacting the server or needing a repo", async () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-help-rm-"));
  writeConfig(configDir, REMOTE);
  const emptyDir = mkdtempSync(path.join(tmpdir(), "pir-help-empty-"));
  const res = await pir(["findings", "list", "--help"], { configDir, cwd: emptyDir });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Findings options/);
  assert.equal(res.stderr, "");
});

test("#43: --help works with a corrupt config.json", async () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-help-bad-"));
  writeFileSync(path.join(configDir, "config.json"), "NOT VALID JSON");
  const res = await pir(["audit", "--help"], { configDir });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Audit options/);
  assert.equal(res.stderr, "");
});

test("#43: contextual help shows the command's section, not the whole reference", async () => {
  const find = await pir(["find", "--help"]);
  assert.match(find.stdout, /Find options:/);
  assert.doesNotMatch(find.stdout, /Audit options/);
  assert.match(find.stdout, /Exit codes:/);

  const jobs = await pir(["jobs", "--help", "--server", "https://pir.invalid.example:8790"]);
  assert.equal(jobs.code, 0);
  assert.match(jobs.stdout, /Jobs options/);
});

test("#43: an unknown command with --help still prints the full usage, exit 0", async () => {
  const res = await pir(["frobnicate", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Usage:/);
});

test("#43: --help after a value flag is that flag's value, not a help request", async () => {
  const repo = createTempGitRepo("pir-help-val-");
  try {
    // --status consumes --help: the command runs with status="--help" and
    // returns an empty page — usage text must not appear.
    const res = await pir(["findings", "list", "--status", "--help", "--json", "--cwd", repo.dir], {
      env: { PIR_MEMORY_DB: path.join(repo.dir, "m.sqlite") },
    });
    assert.equal(res.code, 0);
    assert.doesNotMatch(res.stdout, /Usage:/);
    assert.equal(JSON.parse(res.stdout).data.total, 0);
  } finally {
    repo.cleanup();
  }
});

test("#43: a parse error near --help still surfaces as a usage error, not help", async () => {
  const res = await pirExpectFail(["find", "--base"]);
  assert.equal(res.code, 2);
});
