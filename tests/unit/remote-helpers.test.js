import { test } from "node:test";
import assert from "node:assert/strict";
import { pinRefsToShas } from "../../dist/cli/executor.js";
import { wantsBundle } from "../../dist/cli/remote.js";

const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD = "9999999999999999999999999999999999999999";

test("pinRefsToShas rewrites two-token --base/--head values to resolved SHAs", () => {
  assert.deepEqual(
    pinRefsToShas(["find", "--base", "origin/main", "--json"], { base: BASE, head: HEAD }),
    ["find", "--base", BASE, "--json"],
  );
  assert.deepEqual(
    pinRefsToShas(["--head", "feature-x", "find"], { base: null, head: HEAD }),
    ["--head", HEAD, "find"],
  );
});

test("pinRefsToShas rewrites --flag=value forms", () => {
  assert.deepEqual(
    pinRefsToShas(["find", "--base=origin/main"], { base: BASE, head: HEAD }),
    ["find", `--base=${BASE}`],
  );
  assert.deepEqual(
    pinRefsToShas(["find", "--head=feature-x", "--json"], { base: null, head: HEAD }),
    ["find", `--head=${HEAD}`, "--json"],
  );
});

test("pinRefsToShas leaves unrelated flags and absent refs untouched", () => {
  assert.deepEqual(
    pinRefsToShas(["find", "--json", "--model", "glm-5.3"], { base: BASE, head: HEAD }),
    ["find", "--json", "--model", "glm-5.3"],
  );
  // No --base/--head in the argv: nothing to pin (single-commit repos send
  // no --base at all).
  assert.deepEqual(pinRefsToShas(["find", "--json"], { base: null, head: HEAD }), ["find", "--json"]);
});

test("pinRefsToShas never touches --base/--head appearing as another flag's value", () => {
  // A note/model value that literally says "--head" must survive verbatim.
  assert.deepEqual(
    pinRefsToShas(["feedback", "F-1", "expected", "--note", "--head", "--json"], { base: BASE, head: HEAD }),
    ["feedback", "F-1", "expected", "--note", "--head", "--json"],
  );
  assert.deepEqual(
    pinRefsToShas(["find", "--model", "--base", "--json"], { base: BASE, head: HEAD }),
    ["find", "--model", "--base", "--json"],
  );
  // Eq-form values of other flags are equally untouched.
  assert.deepEqual(
    pinRefsToShas(["find", "--note=--head"], { base: null, head: HEAD }),
    ["find", "--note=--head"],
  );
});

test("wantsBundle: only a find without --repo (either form) ships a bundle", () => {
  assert.equal(wantsBundle(["find", "--json"]), true);
  assert.equal(wantsBundle(["find"]), true);
  assert.equal(wantsBundle(["find", "--repo", "demo"]), false);
  assert.equal(wantsBundle(["find", "--repo=demo"]), false);
  assert.equal(wantsBundle(["memory", "status"]), false);
  assert.equal(wantsBundle(["--json"]), false);
});
