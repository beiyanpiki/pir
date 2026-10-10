import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, verifyConcurrencyFlag } from "../../dist/cli/executor.js";

test("parseArgs accepts --flag=value for value flags", () => {
  const { positional, flags } = parseArgs(["find", "--repo=demo", "--base=origin/main", "--json"]);
  assert.deepEqual(positional, ["find"]);
  assert.equal(flags.get("--repo"), "demo");
  assert.equal(flags.get("--base"), "origin/main");
  assert.equal(flags.get("--json"), true);
});

test("parseArgs parses --max-findings in both forms", () => {
  const { flags } = parseArgs(["find", "--max-findings", "5"]);
  assert.equal(flags.get("--max-findings"), "5");
  const eq = parseArgs(["find", "--max-findings=3"]);
  assert.equal(eq.flags.get("--max-findings"), "3");
});

test("parseArgs keeps values containing '=' intact", () => {
  const { flags } = parseArgs(["feedback", "F-1", "expected", "--note=a=b"]);
  assert.equal(flags.get("--note"), "a=b");
});

test("parseArgs two-token form still works and errors on missing value", () => {
  const { flags } = parseArgs(["find", "--base", "HEAD^"]);
  assert.equal(flags.get("--base"), "HEAD^");
  assert.throws(() => parseArgs(["find", "--base"]), /missing value/);
});

test("parseArgs: --flag=value on a non-value flag stays a distinct boolean flag", () => {
  const { flags } = parseArgs(["find", "--json=whatever"]);
  assert.equal(flags.get("--json=whatever"), true);
  assert.equal(flags.get("--json"), undefined);
});

test("parseArgs parses --plugins in both forms", () => {
  const { flags } = parseArgs(["find", "--plugins", "golang,react"]);
  assert.equal(flags.get("--plugins"), "golang,react");
  const eq = parseArgs(["find", "--plugins=none"]);
  assert.equal(eq.flags.get("--plugins"), "none");
});

test("verifyConcurrencyFlag: flag > PIR_VERIFY_CONCURRENCY env > undefined", () => {
  assert.equal(verifyConcurrencyFlag(parseArgs(["find"]).flags, {}), undefined);
  assert.equal(verifyConcurrencyFlag(parseArgs(["find"]).flags, { PIR_VERIFY_CONCURRENCY: "4" }), 4);
  assert.equal(
    verifyConcurrencyFlag(parseArgs(["find", "--verify-concurrency", "2"]).flags, { PIR_VERIFY_CONCURRENCY: "4" }),
    2,
    "the flag wins over the env",
  );
  assert.equal(verifyConcurrencyFlag(parseArgs(["find", "--verify-concurrency=8"]).flags, {}), 8);
});

test("verifyConcurrencyFlag rejects out-of-range and non-integer values as usage errors", () => {
  for (const bad of ["0", "-1", "9", "1.5", "abc", ""]) {
    assert.throws(
      () => verifyConcurrencyFlag(parseArgs(["find", "--verify-concurrency", bad]).flags, {}),
      new RegExp(`invalid --verify-concurrency: ${bad}`),
    );
    assert.throws(
      () => verifyConcurrencyFlag(parseArgs(["find"]).flags, { PIR_VERIFY_CONCURRENCY: bad }),
      /invalid --verify-concurrency/,
    );
  }
  // A valueless flag is a parse-level boolean; it must not silently mean 1.
  assert.throws(
    () => verifyConcurrencyFlag(new Map([["--verify-concurrency", true]]), {}),
    /a value is required/,
  );
});
