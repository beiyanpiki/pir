import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageError, resolveOutputFormat } from "../../dist/cli/executor.js";

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
