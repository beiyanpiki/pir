import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { UsageError, executePirCommand } from "../../dist/cli/executor.js";

/**
 * ADR 0022 end to end over the real CLI: a local --detach re-executes
 * dist/cli/cli.js as a detached child, returns exit 0 once the child is
 * accepted (never after the review), and leaves a log plus a receipt whose
 * settlement carries the child's exit code. A SIGKILLed child runs no exit
 * hook, so its receipt stays unsettled - the documented way to tell a killed
 * detach from a running one.
 *
 * Model-free by construction: the detached child is made to fail its own
 * argument validation (audit --fail-on BOGUS) or to die on model resolution
 * (the SIGKILL case), so no session and no provider call happens.
 */

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");

async function pir(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PIR_NO_WIZARD: "1", ...opts.env },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** PIDs whose full command line mentions the (unique) repository path. */
function pgrep(pattern) {
  try {
    const out = execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function killMatching(pattern) {
  for (const pid of pgrep(pattern)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function detachFixture(t, prefix) {
  const repo = createTempGitRepo(prefix);
  repo.write("src/app.ts", "export const one = 1;\n");
  const head = repo.commit("change");
  const configDir = mkdtempSync(path.join(tmpdir(), prefix + "cfg-"));
  const repoDir = path.resolve(repo.dir);
  const env = { PIR_CONFIG_DIR: configDir, PIR_MEMORY_DB: path.join(configDir, "m.sqlite") };
  t.after(() => {
    killMatching(repoDir); // never leave an orphaned detached child behind
    rmSync(configDir, { recursive: true, force: true });
    repo.cleanup();
  });
  return { repo, repoDir, head, configDir, env };
}

test("local detach: the parent returns exit 0, the receipt settles with the child's code, the log holds the child's output", async (t) => {
  const { repoDir, head, configDir, env } = detachFixture(t, "pir-detach-int-");

  // The child fails its OWN validation (exit 2) after the parent accepted it:
  // no model, no session, and an exit code only the child can produce.
  const parent = await pir(["audit", "--detach", "--json", "--fail-on", "BOGUS", "--cwd", repoDir], { env });
  assert.equal(parent.code, 0, parent.stderr);
  const envelope = JSON.parse(parent.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "audit.detach");
  assert.equal(envelope.data.mode, "local");
  assert.ok(envelope.data.jobId.length === 36, "a randomUUID job id");
  assert.equal(envelope.data.logPath, path.join(configDir, "logs", envelope.data.jobId + ".log"));
  assert.ok(envelope.data.receiptPath.startsWith(path.join(configDir, "receipts") + path.sep));
  assert.equal(envelope.data.head, head, "the receipt pins the reviewed HEAD");
  assert.equal(envelope.data.base, null);
  assert.ok(envelope.data.followUp.some((line) => line.startsWith("tail -f")));
  assert.ok(envelope.data.followUp.some((line) => line.includes("pir receipts show " + envelope.data.jobId.slice(0, 8))));
  assert.ok(envelope.data.followUp.some((line) => line.startsWith("pir audit coverage --latest")));

  // The detached run is real: the receipt starts unsettled and settles with
  // the child's own exit code once the process ends.
  const unsettled = readJson(envelope.data.receiptPath);
  assert.equal(unsettled.settledAt, undefined);
  const settled = await waitFor(
    () => {
      const receipt = readJson(envelope.data.receiptPath);
      return receipt && receipt.settledAt ? receipt : null;
    },
    { what: "the receipt to settle" },
  );
  assert.equal(settled.exitCode, 2, "the child's usage error, not the parent's exit");
  assert.equal(typeof settled.settledAt, "string");
  assert.equal(settled.mode, "local");
  assert.equal(settled.origin, "local");
  assert.equal(settled.kind, "audit");
  assert.equal(settled.runId, null);
  assert.equal(settled.head, head);
  assert.equal(settled.argv.includes("--detach"), false, "the child argv is the stripped argv");

  // The log is the child's stdout/stderr, owner-only, and it stopped growing
  // because the child is gone.
  const log = readFileSync(envelope.data.logPath, "utf8");
  assert.match(log, /invalid --fail-on: BOGUS/);
  assert.equal(statSync(envelope.data.logPath).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(configDir, "logs")).mode & 0o777, 0o700);
  assert.equal(statSync(envelope.data.receiptPath).mode & 0o777, 0o600);
  assert.deepEqual(pgrep(repoDir), [], "the detached child exited");

  // `pir receipts show` recovers it locally - no jobs lane, no server.
  const shown = await pir(["receipts", "show", envelope.data.jobId.slice(0, 8)], { env });
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /tail -f '/);
  assert.match(shown.stdout, /receipts show /);
  assert.match(shown.stdout, /"exitCode": 2/);
  assert.equal(shown.stderr.includes("--server"), false);
});

test("text mode prints the human submission block, and its exit 0 still means accepted", async (t) => {
  const { repoDir, env } = detachFixture(t, "pir-detach-int-text-");
  const parent = await pir(["find", "--detach", "--fail-on", "BOGUS", "--cwd", repoDir], { env });
  assert.equal(parent.code, 0, parent.stderr);
  assert.match(parent.stdout, /detached find as local job [0-9a-f-]{36}/);
  assert.match(parent.stdout, /log: .*logs/);
  assert.match(parent.stdout, /receipt: .*receipts/);
  assert.match(parent.stdout, /exit 0 means accepted, not reviewed/);
  const match = /local job ([0-9a-f-]{36})/.exec(parent.stdout);
  assert.ok(match, "the text block names the full job id");
  const jobId = match[1];
  const receipt = await waitFor(
    () => {
      let names = [];
      try {
        names = readdirSync(path.join(env.PIR_CONFIG_DIR, "receipts"));
      } catch {
        return null;
      }
      const name = names.find((entry) => entry.includes(jobId.slice(0, 8)));
      if (!name) return null;
      const parsed = readJson(path.join(env.PIR_CONFIG_DIR, "receipts", name));
      return parsed && parsed.settledAt ? parsed : null;
    },
    { what: "the text-mode receipt to settle" },
  );
  assert.equal(receipt.exitCode, 2);
});

test("--detach refuses previews, dry runs, coverage readouts and non-review commands with exit 2", async (t) => {
  const { repoDir, configDir, env } = detachFixture(t, "pir-detach-int-reject-");
  const cases = [
    { args: ["find", "--detach", "--preview", "--cwd", repoDir], pattern: /--preview/ },
    { args: ["audit", "--detach", "--dry-run", "--cwd", repoDir], pattern: /--dry-run/ },
    { args: ["audit", "coverage", "--latest", "--detach", "--cwd", repoDir], pattern: /coverage/ },
    { args: ["models", "--ids", "--detach"], pattern: /--detach applies to/ },
  ];
  for (const { args, pattern } of cases) {
    const res = await pir(args, { env });
    assert.equal(res.code, 2, args.join(" ") + " should exit 2, got " + res.code + ": " + res.stderr);
    assert.match(res.stderr, pattern);
    assert.equal(res.stdout, "", "a refused detach prints no submission envelope");
  }
  // Nothing was accepted, so no log directory and no receipt exist.
  assert.equal(existsSync(path.join(configDir, "logs")), false);
  assert.equal(existsSync(path.join(configDir, "receipts")), false);
  assert.deepEqual(pgrep(repoDir), [], "a refused detach never spawns a child");
});

test("a SIGKILLed child leaves its receipt unsettled (skip on win32)", { skip: process.platform === "win32" }, async (t) => {
  const { repoDir, env } = detachFixture(t, "pir-detach-int-kill-");
  // A missing model makes the child fail on resolution ~2s after spawn: long
  // enough to kill it deterministically right after the parent returns.
  const parent = await pir(["audit", "--detach", "--json", "--model", "nonexistent/model", "--cwd", repoDir], { env });
  assert.equal(parent.code, 0, parent.stderr);
  const envelope = JSON.parse(parent.stdout);

  const pids = await waitFor(
    () => {
      const found = pgrep(repoDir);
      return found.length > 0 ? found : null;
    },
    { timeoutMs: 5_000, what: "the detached child to appear" },
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it may have exited between pgrep and kill */
    }
  }
  await waitFor(() => pgrep(repoDir).length === 0, { timeoutMs: 10_000, what: "the killed child to disappear" });
  // A settle hook would have run by now; a signal death runs none.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const receipt = readJson(envelope.data.receiptPath);
  assert.ok(receipt, "the receipt was written before the spawn");
  assert.equal(receipt.settledAt ?? null, null, "a killed detach stays unsettled");
  assert.equal(receipt.exitCode ?? null, null, "there is no exit code to record");
  assert.ok(existsSync(envelope.data.logPath), "the log file exists even though the run was killed");
});

test("the executor keeps rejecting an unstripped --detach: the server lane is untouched", async (t) => {
  const repo = createTempGitRepo("pir-detach-guard-");
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-detach-guard-cfg-"));
  t.after(() => {
    rmSync(configDir, { recursive: true, force: true });
    repo.cleanup();
  });
  const dbPath = path.join(configDir, "m.sqlite");
  for (const command of ["find", "audit"]) {
    await assert.rejects(
      executePirCommand([command, "--detach", "--cwd", repo.dir], { dbPath }),
      (err) => err instanceof UsageError && /--detach submits to a remote server/.test(err.message),
      command + " must still reject --detach at the executor (old clients / server lane)",
    );
  }
});
