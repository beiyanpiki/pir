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

test("wantsBundle: any /v1/review command without --repo (either form) ships a bundle", () => {
  assert.equal(wantsBundle(["find", "--json"]), true);
  assert.equal(wantsBundle(["find"]), true);
  assert.equal(wantsBundle(["audit", "--json", "--path", "src"]), true);
  assert.equal(wantsBundle(["audit"]), true);
  // The memory family needs the materialized worktree's repo context — a
  // stock serve workspace has none (issue #28).
  assert.equal(wantsBundle(["memory", "status"]), true);
  assert.equal(wantsBundle(["memory", "bootstrap", "--model", "glm"]), true);
  assert.equal(wantsBundle(["findings", "list", "--status", "open"]), true);
  assert.equal(wantsBundle(["feedback", "F-1", "expected", "--note", "x"]), true);
  assert.equal(wantsBundle(["remember", "project", "invariant", "--text", "x"]), true);
  assert.equal(wantsBundle(["verify-fix", "F-1"]), true);
  // memory sync always runs in the local process, never over the wire.
  assert.equal(wantsBundle(["memory", "sync"]), false);
  assert.equal(wantsBundle(["memory", "sync", "--dry-run"]), false);
  // --repo selects a server-side registered clone via /v1/exec.
  assert.equal(wantsBundle(["find", "--repo", "demo"]), false);
  assert.equal(wantsBundle(["find", "--repo=demo"]), false);
  assert.equal(wantsBundle(["audit", "--repo", "demo"]), false);
  assert.equal(wantsBundle(["memory", "status", "--repo", "demo"]), false);
  // Anything without a repo-context command keeps the /v1/exec route.
  assert.equal(wantsBundle(["--json"]), false);
  assert.equal(wantsBundle(["repos", "list"]), false);
  assert.equal(wantsBundle(["models"]), false);
});

test("wantsBundle: value flags before the command don't hide the command", () => {
  // The old ad-hoc scan took "glm" for the command and misrouted to /v1/exec.
  assert.equal(wantsBundle(["--model", "glm-5.3", "find", "--json"]), true);
  assert.equal(wantsBundle(["--model=glm-5.3", "find"]), true);
  // "--head" is --note's value here, not a flag; the command is feedback.
  assert.equal(wantsBundle(["--note", "--head", "feedback"]), true);
});

test("pinRefsToShas leaves a valueless --base/--head for parseArgs to reject", () => {
  // Fabricating a SHA here would turn a usage error into a silently
  // successful review of the wrong range.
  assert.deepEqual(pinRefsToShas(["find", "--base"], { base: BASE, head: HEAD }), ["find", "--base"]);
  assert.deepEqual(pinRefsToShas(["find", "--head", "--json"], { base: BASE, head: HEAD }), [
    "find",
    "--head",
    "--json",
  ]);
});
