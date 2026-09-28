import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../dist/cli/executor.js";

test("parseArgs accepts --flag=value for value flags", () => {
  const { positional, flags } = parseArgs(["find", "--repo=demo", "--base=origin/main", "--json"]);
  assert.deepEqual(positional, ["find"]);
  assert.equal(flags.get("--repo"), "demo");
  assert.equal(flags.get("--base"), "origin/main");
  assert.equal(flags.get("--json"), true);
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
