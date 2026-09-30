import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { pinRefsToShas, UsageError } from "../../dist/cli/executor.js";
import { wantsBundle } from "../../dist/cli/remote.js";
import { describeTransportError, remoteDispatcher, remoteTimeoutMs, reportUnreachable } from "../../dist/cli/remote-fetch.js";

const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD = "9999999999999999999999999999999999999999";

/** Run fn with PIR_REMOTE_TIMEOUT overridden; tests must not leak env state. */
function withRemoteTimeout(value, fn) {
  const saved = process.env.PIR_REMOTE_TIMEOUT;
  if (value === undefined) delete process.env.PIR_REMOTE_TIMEOUT;
  else process.env.PIR_REMOTE_TIMEOUT = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PIR_REMOTE_TIMEOUT;
    else process.env.PIR_REMOTE_TIMEOUT = saved;
  }
}

/** The #32 signature: fetch failed on the surface, the truth on err.cause. */
function headersTimeoutError() {
  const cause = new Error("Headers Timeout Error");
  cause.code = "UND_ERR_HEADERS_TIMEOUT";
  const err = new TypeError("fetch failed");
  err.cause = cause;
  return err;
}

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

test("wantsBundle: a find or audit without --repo (either form) ships a bundle", () => {
  assert.equal(wantsBundle(["find", "--json"]), true);
  assert.equal(wantsBundle(["find"]), true);
  assert.equal(wantsBundle(["audit", "--json", "--path", "src"]), true);
  assert.equal(wantsBundle(["audit"]), true);
  assert.equal(wantsBundle(["find", "--repo", "demo"]), false);
  assert.equal(wantsBundle(["find", "--repo=demo"]), false);
  assert.equal(wantsBundle(["audit", "--repo", "demo"]), false);
  assert.equal(wantsBundle(["memory", "status"]), false);
  assert.equal(wantsBundle(["--json"]), false);
});

test("wantsBundle: value flags before the command don't hide a find", () => {
  // The old ad-hoc scan took "glm" for the command and misrouted to /v1/exec.
  assert.equal(wantsBundle(["--model", "glm-5.3", "find", "--json"]), true);
  assert.equal(wantsBundle(["--model=glm-5.3", "find"]), true);
  assert.equal(wantsBundle(["--note", "--head", "feedback"]), false);
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

// --- remote-fetch: PIR_REMOTE_TIMEOUT, dispatcher cache, error reporting (#32) ---

test("remoteTimeoutMs: default 30 minutes; PIR_REMOTE_TIMEOUT is seconds; 0 disables", () => {
  withRemoteTimeout(undefined, () => assert.equal(remoteTimeoutMs(), 30 * 60_000));
  withRemoteTimeout("600", () => assert.equal(remoteTimeoutMs(), 600_000));
  withRemoteTimeout("0", () => assert.equal(remoteTimeoutMs(), 0));
});

test("remoteTimeoutMs: non-decimal values are usage errors, not silent fallbacks", () => {
  for (const bad of ["abc", "-1", "1.5", " ", "1e3", "1800s"]) {
    withRemoteTimeout(bad, () => assert.throws(() => remoteTimeoutMs(), UsageError, `expected ${JSON.stringify(bad)} rejected`));
  }
});

test("remoteDispatcher: cached per timeout value, rebuilt when PIR_REMOTE_TIMEOUT changes", () => {
  withRemoteTimeout(undefined, () => {
    const a = remoteDispatcher();
    assert.equal(remoteDispatcher(), a);
    process.env.PIR_REMOTE_TIMEOUT = "2";
    assert.notEqual(remoteDispatcher(), a);
    assert.equal(remoteDispatcher(), remoteDispatcher());
  });
});

test("describeTransportError: unwraps err.cause code and message", () => {
  assert.equal(describeTransportError(headersTimeoutError()), "fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)");
  const noCode = new TypeError("fetch failed");
  noCode.cause = new Error("connect ECONNREFUSED 127.0.0.1:8790");
  assert.equal(describeTransportError(noCode), "fetch failed (connect ECONNREFUSED 127.0.0.1:8790)");
  const bareCause = new TypeError("fetch failed");
  bareCause.cause = { code: "ECONNRESET" };
  assert.equal(describeTransportError(bareCause), "fetch failed (ECONNRESET)");
  assert.equal(describeTransportError(new Error("socket hang up")), "socket hang up");
  assert.equal(describeTransportError("not an error"), "not an error");
});

test("reportUnreachable: timeout causes get a PIR_REMOTE_TIMEOUT hint; others do not", () => {
  withRemoteTimeout("25", () => {
    const timedOut = reportUnreachable("https://pir.example", headersTimeoutError());
    assert.match(timedOut, /pir: cannot reach https:\/\/pir\.example: fetch failed \(UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error\)/);
    assert.match(timedOut, /within 25s/);
    assert.match(timedOut, /PIR_REMOTE_TIMEOUT/);
  });
  const reset = new TypeError("fetch failed");
  reset.cause = { code: "ECONNRESET" };
  assert.doesNotMatch(reportUnreachable("https://pir.example", reset), /PIR_REMOTE_TIMEOUT/);
});
