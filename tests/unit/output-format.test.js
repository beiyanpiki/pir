import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageError, resolveOutputFormat } from "../../dist/cli/executor.js";
import { machineOutputFromArgv } from "../../dist/cli/machine-output.js";

/**
 * Roadmap S6 / ADR 0020: `--format` is the one output selector for find and
 * audit, and legacy `--json` is the same choice spelled differently. The
 * resolver is pure, so the precedence (and the refusal to guess) is testable
 * without a repository or a session.
 */

const flags = (...pairs) => new Map(pairs);

test("no flag: text; --json alone: json; --format json without --json: json", () => {
  assert.equal(resolveOutputFormat(flags()), "text");
  assert.equal(resolveOutputFormat(flags(["--json", true])), "json");
  assert.equal(resolveOutputFormat(flags(["--format", "json"])), "json");
});

test("--format text and --format sarif select those formats", () => {
  assert.equal(resolveOutputFormat(flags(["--format", "text"])), "text");
  assert.equal(resolveOutputFormat(flags(["--format", "sarif"])), "sarif");
});

test("--json and a non-json --format contradict each other", () => {
  for (const format of ["text", "sarif"]) {
    assert.throws(
      () => resolveOutputFormat(flags(["--json", true], ["--format", format])),
      (error) => error instanceof UsageError && /contradicts --format/.test(error.message),
    );
  }
  // The same choice twice is not a contradiction.
  assert.equal(resolveOutputFormat(flags(["--json", true], ["--format", "json"])), "json");
});

test("unknown formats are usage errors that name the accepted set", () => {
  for (const format of ["bogus", "SARIF", "", "json,sarif"]) {
    assert.throws(
      () => resolveOutputFormat(flags(["--format", format])),
      (error) => error instanceof UsageError && /invalid --format/.test(error.message) && /text, json or sarif/.test(error.message),
    );
  }
});

/**
 * Dogfood F-17: the layers that decide before the executor runs (the first-run
 * wizard, the remote `--detach` submission envelope) need the machine-output
 * answer from argv alone, and `--format json|sarif` is machine output exactly
 * like `--json`. parseArgs is the authority: a token consumed as a value is
 * not a flag.
 */
test("machine output: --json or --format json|sarif, value-aware", () => {
  assert.equal(machineOutputFromArgv([]), false);
  assert.equal(machineOutputFromArgv(["find", "--format", "text"]), false);
  assert.equal(machineOutputFromArgv(["find", "--json"]), true);
  assert.equal(machineOutputFromArgv(["find", "--format", "json"]), true);
  assert.equal(machineOutputFromArgv(["find", "--format", "sarif"]), true);
  assert.equal(machineOutputFromArgv(["find", "--format=json"]), true);
  assert.equal(machineOutputFromArgv(["audit", "--format=sarif"]), true);
  // A --json consumed as another flag's value is that value, not a flag.
  assert.equal(machineOutputFromArgv(["find", "--background", "--json"]), false);
  // The predicate does not validate; resolveOutputFormat owns the usage error.
  assert.equal(machineOutputFromArgv(["find", "--format", "bogus"]), false);
  // ... and a malformed invocation still counts the --json it does carry, so
  // the wizard is not entered just because a later value is missing.
  assert.equal(machineOutputFromArgv(["find", "--json", "--format"]), true);
  assert.equal(machineOutputFromArgv(["find", "--format", "--json"]), false, "--json is --format's value there");
});
