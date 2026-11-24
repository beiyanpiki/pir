import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { UsageError, executePirCommand, helpFor, parseArgs, pinRefsToShas, resolveModelTimeoutMs } from "../../dist/cli/executor.js";
import { stripClientFlags, wantsBundle } from "../../dist/cli/remote.js";

const resolve = (...argv) => resolveModelTimeoutMs(parseArgs(argv));

test("model timeout is opt-in and accepts decimal seconds, including zero", () => {
  assert.equal(resolve("find"), undefined);
  assert.equal(resolve("find", "--model-timeout", "0"), 0);
  assert.equal(resolve("--model-timeout=700", "audit"), 700_000);
  assert.equal(resolve("summarize", "--model-timeout", "2147483"), 2_147_483_000);
  for (const argv of [["memory", "bootstrap"], ["memory", "refresh"], ["verify-fix", "F-1"], ["_verify-comment"]]) {
    assert.equal(resolve(...argv, "--model-timeout", "1"), 1_000);
  }
});

test("model timeout rejects malformed seconds and values that overflow provider timers", () => {
  for (const value of ["", "-1", "-0", "+1", "1.5", "1e3", "0x10", " 1", "1\n", "1s", "Infinity", "2147484", "9007199254740992"]) {
    assert.throws(() => resolve("find", `--model-timeout=${value}`), UsageError, JSON.stringify(value));
  }
  assert.throws(() => resolve("find", "--model-timeout"), /missing value for --model-timeout/);
  assert.throws(() => resolve("find", "--model-timeout", "--json"), /invalid --model-timeout/);
  assert.throws(() => resolve("find", "--model-timeout", "0", "--model-timeout=900"), /only be specified once/);
});

test("executor rejects model timeout on commands that do not run sessions, before opening a repository", async () => {
  for (const argv of [["find", "--preview"], ["audit", "--dry-run"], ["audit", "coverage"], ["memory", "status"], ["models"]]) {
    await assert.rejects(executePirCommand([...argv, "--model-timeout", "0", "--cwd", "/not-a-repo"]), /--model-timeout applies only/);
  }
  await assert.rejects(executePirCommand(["verify-fix", "F-1", "--model-timeout=-1", "--cwd", "/not-a-repo"]), /invalid --model-timeout/);
});

test("CLI rejects an invalid model timeout before remote submission", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../dist/cli/cli.js", import.meta.url)),
    "find", "--model-timeout", "1e3", "--server", "https://invalid.invalid",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid --model-timeout/);
  assert.equal(result.stdout, "");
});

test("model timeout survives remote argv cleanup and git ref pinning", () => {
  const bundleArgv = stripClientFlags(["--model-timeout", "0", "find", "--base", "main", "--remote-timeout=42", "--detach"]);
  assert.equal(wantsBundle(bundleArgv), true);
  const pinned = pinRefsToShas(bundleArgv, { base: "a".repeat(40), head: "b".repeat(40) });
  assert.deepEqual(pinned, ["--model-timeout", "0", "find", "--base", "a".repeat(40)]);
  assert.equal(resolve(...pinned), 0);

  const execArgv = stripClientFlags(["verify-fix", "F-1", "--repo=example", "--model-timeout=900", "--server=https://example.invalid"]);
  assert.equal(wantsBundle(execArgv), false);
  assert.deepEqual(execArgv, ["verify-fix", "F-1", "--repo=example", "--model-timeout=900"]);
  assert.equal(resolve(...execArgv), 900_000);
});

test("contextual help lists the override for model-backed commands", () => {
  for (const command of ["find", "audit", "summarize", "memory", "verify-fix"]) {
    assert.match(helpFor(command), /--model-timeout <seconds>/);
  }
  assert.doesNotMatch(helpFor("models"), /--model-timeout/);
});
