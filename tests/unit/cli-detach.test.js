import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detachChildArgv, localDetach, resolveDetachInvocation } from "../../dist/cli/detach.js";
import { UsageError } from "../../dist/cli/executor.js";
import { buildLocalReceipt, receiptRecoveryCommands, settleLocalReceipt } from "../../dist/cli/receipts.js";

/**
 * ADR 0022: local --detach is opt-in for find/audit, re-executes this CLI with
 * one --detach removed, writes an owner-only log and a receipt before the
 * spawn, and reports acceptance (exit 0) rather than review success. The child
 * settles the receipt from its exit hook; a killed child runs no hook and
 * leaves it unsettled.
 */

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const LOG_NAME = JOB_ID + ".log";

function tempConfig(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-detach-unit-"));
  const previous = process.env.PIR_CONFIG_DIR;
  process.env.PIR_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PIR_CONFIG_DIR;
    else process.env.PIR_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function receiptFiles(configDir) {
  try {
    return readdirSync(path.join(configDir, "receipts")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** A spawn stand-in that reports success or failure the way node's spawn does. */
function fakeSpawn(outcome) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    child.pid = 4242;
    process.nextTick(() => child.emit(outcome, outcome === "error" ? new Error("ENOENT: no such file or directory") : undefined));
    return child;
  };
  fn.calls = calls;
  return fn;
}

function detachArgs(overrides = {}) {
  return {
    argv: ["find", "--detach", "--json"],
    cwd: process.cwd(),
    env: { ...process.env },
    emit: () => {},
    log: () => {},
    jobId: JOB_ID,
    execPath: "/usr/bin/node",
    scriptPath: "/app/dist/cli/cli.js",
    ...overrides,
  };
}

test("detachChildArgv removes exactly one --detach token and keeps every other argument in order", () => {
  assert.deepEqual(detachChildArgv(["find", "--detach", "--json", "--cwd", "/repo"]), ["find", "--json", "--cwd", "/repo"]);
  assert.deepEqual(detachChildArgv(["--detach", "audit", "--max-tokens", "10"]), ["audit", "--max-tokens", "10"]);
  assert.deepEqual(detachChildArgv(["find", "--detach", "--detach"]), ["find", "--detach"], "one token, not every occurrence");
  assert.deepEqual(detachChildArgv(["find", "--json"]), ["find", "--json"], "an argv without --detach is unchanged");
});

test("lanes that produce no run are usage errors, with a message naming the reason", () => {
  const cwd = process.cwd();
  const rejected = (argv, pattern) => {
    assert.throws(
      () => resolveDetachInvocation(argv, cwd),
      (err) => err instanceof UsageError && pattern.test(err.message),
      "expected a UsageError matching " + pattern + " for: " + argv.join(" "),
    );
  };
  rejected(["find", "--detach", "--preview"], /--preview/);
  rejected(["audit", "--detach", "--dry-run"], /--dry-run/);
  rejected(["audit", "coverage", "--latest", "--detach"], /coverage/);
  rejected(["models", "--ids", "--detach"], /--detach applies to/);
  rejected(["--detach"], /--detach applies to/);
  rejected(["find", "--detach", "--detach"], /more than once/);
  // The accepted lanes still resolve.
  assert.equal(resolveDetachInvocation(["find", "--detach"], cwd).command, "find");
  assert.equal(resolveDetachInvocation(["audit", "--detach", "--json"], cwd).json, true);
  assert.equal(resolveDetachInvocation(["audit", "--detach", "--format", "json"], cwd).json, true);
  assert.equal(resolveDetachInvocation(["find", "--detach"], cwd).json, false);
});

test("localDetach creates the 0700 log dir, the 0600 log, the receipt and the JSON envelope", async (t) => {
  const configDir = tempConfig(t);
  const spawnFn = fakeSpawn("spawn");
  let stdout = "";
  // A temp directory, not the worktree: outside a repository the receipt's
  // head is empty, which is one of the documented shapes.
  const code = await localDetach(detachArgs({ spawnFn, cwd: configDir, emit: (text) => (stdout += text) }));
  assert.equal(code, 0);

  // The child is this CLI, not a shell and not a different entry point.
  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];
  assert.equal(call.command, "/usr/bin/node");
  assert.deepEqual(call.args, ["/app/dist/cli/cli.js", "find", "--json"], "--detach never reaches the child");
  assert.equal(call.options.detached, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio.length, 3);
  assert.equal(call.options.stdio[0], "ignore");
  assert.equal(typeof call.options.stdio[1], "number");
  assert.equal(call.options.stdio[2], call.options.stdio[1]);
  assert.equal(call.options.env.PIR_LOCAL_JOB_ID, JOB_ID);
  assert.equal(call.options.env.PIR_NO_WIZARD, "1");

  const envelope = JSON.parse(stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "find.detach");
  assert.equal(envelope.data.jobId, JOB_ID);
  assert.equal(envelope.data.mode, "local");
  assert.equal(envelope.data.logPath, path.join(configDir, "logs", LOG_NAME));
  assert.equal(envelope.data.head, "", "outside a repository the receipt head is empty");
  assert.ok(path.basename(envelope.data.receiptPath).endsWith("-" + JOB_ID.slice(0, 8) + ".json"));
  assert.ok(envelope.data.followUp.some((line) => line.startsWith("tail -f")));
  assert.ok(envelope.data.followUp.some((line) => line.includes("receipts show " + JOB_ID.slice(0, 8))));

  // The log and its directory are owner-only.
  assert.equal(statSync(path.join(configDir, "logs")).mode & 0o777, 0o700);
  assert.equal(statSync(envelope.data.logPath).mode & 0o777, 0o600);

  // The receipt exists before the child runs, is credential-free and carries
  // no run id; settlement is the child's job.
  const receipt = JSON.parse(readFileSync(envelope.data.receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "find");
  assert.equal(receipt.origin, "local");
  assert.equal(receipt.mode, "local");
  assert.equal(receipt.jobId, JOB_ID);
  assert.equal(receipt.projectId, null);
  assert.equal(receipt.runId, null);
  assert.equal(receipt.logPath, envelope.data.logPath);
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.settledAt, undefined, "an unsettled receipt has no settledAt");
  assert.deepEqual(receipt.argv, ["find", "--json"], "the receipt records the stripped, sanitized argv");
  assert.equal(statSync(envelope.data.receiptPath).mode & 0o777, 0o600);
});

test("the receipt never records credentials", async (t) => {
  tempConfig(t);
  let stdout = "";
  const code = await localDetach(
    detachArgs({
      argv: ["audit", "--detach", "--json", "--token", "SECRET-TOKEN", "--viewer-token=SECRET-VIEWER", "--background", "internal migration plan"],
      spawnFn: fakeSpawn("spawn"),
      emit: (text) => (stdout += text),
    }),
  );
  assert.equal(code, 0);
  const receipt = JSON.parse(readFileSync(JSON.parse(stdout).data.receiptPath, "utf8"));
  const raw = JSON.stringify(receipt);
  assert.equal(raw.includes("SECRET-TOKEN"), false);
  assert.equal(raw.includes("SECRET-VIEWER"), false);
  assert.equal(raw.includes("internal migration plan"), false);
});

test("text mode prints a human submission block whose exit 0 means accepted", async (t) => {
  tempConfig(t);
  let stdout = "";
  const code = await localDetach(detachArgs({ argv: ["audit", "--detach"], spawnFn: fakeSpawn("spawn"), emit: (text) => (stdout += text) }));
  assert.equal(code, 0);
  assert.ok(stdout.includes("detached audit as local job " + JOB_ID), stdout);
  assert.match(stdout, /log: .*logs/u);
  assert.match(stdout, /receipt: /);
  assert.match(stdout, /exit 0 means accepted, not reviewed/);
});

test("a spawn that emits 'error' returns 3, reports it and leaves no receipt", async (t) => {
  const configDir = tempConfig(t);
  const messages = [];
  const code = await localDetach(detachArgs({ spawnFn: fakeSpawn("error"), log: (m) => messages.push(m) }));
  assert.equal(code, 3);
  assert.match(messages.join("\n"), /could not start the detached find run: ENOENT/);
  assert.deepEqual(receiptFiles(configDir), [], "no receipt may describe a run that never started");
});

test("a spawn that throws synchronously returns 3 and leaves no receipt", async (t) => {
  const configDir = tempConfig(t);
  const messages = [];
  const code = await localDetach(
    detachArgs({
      spawnFn: () => {
        throw new Error("EPERM: operation not permitted");
      },
      log: (m) => messages.push(m),
    }),
  );
  assert.equal(code, 3);
  assert.match(messages.join("\n"), /EPERM/);
  assert.deepEqual(receiptFiles(configDir), []);
});

test("an uncreatable log path returns 3 before any receipt exists", async (t) => {
  const configDir = tempConfig(t);
  // A regular file where the logs directory belongs: mkdir fails, and the
  // invocation must stop before writing a receipt that describes no run.
  writeFileSync(path.join(configDir, "logs"), "not a directory\n");
  const messages = [];
  const code = await localDetach(detachArgs({ spawnFn: fakeSpawn("spawn"), log: (m) => messages.push(m) }));
  assert.equal(code, 3);
  assert.match(messages.join("\n"), /cannot create the detached run's log/);
  assert.deepEqual(receiptFiles(configDir), []);
});

test("settleLocalReceipt records the child's exit code and never touches a remote receipt", async (t) => {
  const configDir = tempConfig(t);
  const receiptsDir = path.join(configDir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const local = buildLocalReceipt({ kind: "audit", jobId: JOB_ID, head: "a".repeat(40), argv: ["audit"], logPath: path.join(configDir, "logs", LOG_NAME) });
  const localFile = path.join(receiptsDir, "local.json");
  writeFileSync(localFile, JSON.stringify(local));
  const remote = {
    ...buildLocalReceipt({ kind: "find", jobId: "99999999-8888-4777-8666-555555555555", head: "", argv: ["find"], logPath: "" }),
    mode: "async",
    origin: "https://pir.example",
  };
  delete remote.logPath;
  delete remote.exitCode;
  const remoteFile = path.join(receiptsDir, "remote.json");
  writeFileSync(remoteFile, JSON.stringify(remote));

  settleLocalReceipt(JOB_ID, 2);
  const settled = JSON.parse(readFileSync(localFile, "utf8"));
  assert.equal(settled.exitCode, 2);
  assert.equal(typeof settled.settledAt, "string");
  const untouched = JSON.parse(readFileSync(remoteFile, "utf8"));
  assert.equal(untouched.settledAt, undefined);
  assert.equal(untouched.exitCode, undefined);

  settleLocalReceipt("does-not-exist", 0); // a missing receipt is a no-op
});

test("receiptRecoveryCommands prints the local follow-up set, never the remote job lane", () => {
  const base = {
    head: "a".repeat(40),
    argv: ["audit"],
    logPath: "/home/op/.pir/logs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.log",
  };
  const auditReceipt = buildLocalReceipt({ kind: "audit", jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ...base });
  const commands = receiptRecoveryCommands(auditReceipt);
  assert.match(commands[0], /^tail -f '/);
  assert.ok(commands[0].includes(auditReceipt.logPath), "the log path is quoted verbatim");
  assert.equal(commands[1], "pir receipts show aaaaaaaa    # the child's exit code, once it settled");
  assert.ok(commands.some((line) => line.startsWith("pir audit coverage --latest")));
  assert.ok(commands.some((line) => line.startsWith("pir findings list")));
  assert.equal(commands.some((line) => line.includes("--server")), false, "a local receipt never suggests a server command");
  assert.equal(commands.some((line) => line.includes("jobs wait")), false);

  const findCommands = receiptRecoveryCommands(buildLocalReceipt({ kind: "find", jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ...base }));
  assert.equal(findCommands.some((line) => line.includes("audit coverage")), false);
});
