import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { pinRefsToShas, UsageError } from "../../dist/cli/executor.js";
import {
  BundlePrepError,
  isBundleFreeRead,
  reportBundlePrepFailure,
  stripClientFlags,
  wantsAsyncSubmit,
  wantsBundle,
} from "../../dist/cli/remote.js";
import {
  describeTransportError,
  remoteDispatcher,
  remoteTimeoutMs,
  reportUnreachable,
  resolveRemoteTimeoutSeconds,
} from "../../dist/cli/remote-fetch.js";
import { jobStatusReporter } from "../../dist/cli/jobs.js";
import { maxFindingsFlag, minConfidenceFlag, verifierModelFlag } from "../../dist/cli/executor.js";

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

test("isBundleFreeRead: only findings list/show ship bundle-free", () => {
  for (const argv of [["findings"], ["findings", "list"], ["findings", "list", "--json"], ["findings", "show", "F-1"]]) {
    assert.equal(isBundleFreeRead(argv), true, JSON.stringify(argv));
  }
  // Everything else needs the worktree (or a write lane).
  for (const argv of [
    ["findings", "export"],
    ["audit"],
    ["memory", "status"],
    ["memory", "bootstrap"],
    ["find"],
    ["feedback", "F-1", "expected"],
    ["verify-fix", "F-1"],
  ]) {
    assert.equal(isBundleFreeRead(argv), false, JSON.stringify(argv));
  }
});

test("wantsAsyncSubmit defaults to audit only; PIR_REMOTE_ASYNC=1 extends it", () => {
  const saved = process.env.PIR_REMOTE_ASYNC;
  delete process.env.PIR_REMOTE_ASYNC;
  try {
    assert.equal(wantsAsyncSubmit(["audit", "--json"]), true);
    assert.equal(wantsAsyncSubmit(["--model", "m/x", "audit"]), true);
    assert.equal(wantsAsyncSubmit(["find"]), false);
    assert.equal(wantsAsyncSubmit(["memory", "status"]), false);
    process.env.PIR_REMOTE_ASYNC = "1";
    assert.equal(wantsAsyncSubmit(["find"]), true);
    assert.equal(wantsAsyncSubmit(["memory", "status"]), true);
  } finally {
    if (saved === undefined) delete process.env.PIR_REMOTE_ASYNC;
    else process.env.PIR_REMOTE_ASYNC = saved;
  }
});

test("stripClientFlags removes transport flags, keeps everything else", () => {
  assert.deepEqual(
    stripClientFlags(["--server", "https://x", "--token", "t", "--insecure", "jobs", "list", "--json"]),
    ["jobs", "list", "--json"],
  );
  assert.deepEqual(
    stripClientFlags(["--server=https://x", "find", "--base", "main"]),
    ["find", "--base", "main"],
  );
});


test("remote find under PIR_REMOTE_ASYNC=1 retries full history after an async needFull job (dogfood F-30)", async () => {
  const { remoteExec } = await import("../../dist/cli/remote.js");
  const { createTempGitRepo } = await import("../fixtures/helpers.js");
  const repo = createTempGitRepo("pir-needfull-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");

  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/review")) {
      const body = JSON.parse(init.body);
      posts.push(body);
      const first = posts.length === 1;
      const payload = first ? { jobId: "job-thin", status: "queued" } : { jobId: "job-full", status: "queued" };
      return {
        status: 202,
        ok: true,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }
    if (url.includes("/v1/jobs/job-thin")) {
      const payload = {
        job: {
          jobId: "job-thin", command: "find", argv: ["find"], status: "failed",
          createdAt: 1, startedAt: 1, finishedAt: 2, logTotal: 0, log: [],
          result: null,
          error: "needFull: the shipped thin bundle could not be applied; resend full history",
          clientGone: false,
        },
      };
      return { status: 200, ok: true, text: async () => JSON.stringify(payload), json: async () => payload };
    }
    if (url.includes("/v1/jobs/job-full")) {
      const payload = {
        job: {
          jobId: "job-full", command: "find", argv: ["find"], status: "completed",
          createdAt: 3, startedAt: 3, finishedAt: 4, logTotal: 0, log: [],
          result: { code: 0, output: "{\"ok\":true}\n", log: [], truncated: false },
          error: null, clientGone: false,
        },
      };
      return { status: 200, ok: true, text: async () => JSON.stringify(payload), json: async () => payload };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const savedAsync = process.env.PIR_REMOTE_ASYNC;
  process.env.PIR_REMOTE_ASYNC = "1";
  try {
    const code = await remoteExec("https://pir.invalid", ["--cwd", repo.dir, "find", "--json"], {});
    assert.equal(code, 0, "the full-history retry must relay the completed job");
    // Attempt 1: thin (base-limited) bundle, async. Attempt 2: full bundle.
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0].base, null, "first attempt ships the thin bundle");
    assert.equal(posts[0].async, true);
    assert.ok(posts[0].bundleBase64.length > 0, "thin attempt still carries a bundle");
    assert.equal(posts[1].base, null, "retry ships full history");
    assert.equal(posts[1].async, true, "retry stays async");
    assert.ok(posts[1].bundleBase64.length > posts[0].bundleBase64.length, "retry bundle must be the full one");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedAsync === undefined) delete process.env.PIR_REMOTE_ASYNC;
    else process.env.PIR_REMOTE_ASYNC = savedAsync;
    repo.cleanup();
  }
});

// --- #44/#45: bundle-free error classification and fallback discipline ---

test("reportBundlePrepFailure names the local stage, never connectivity (#44)", () => {
  const msg = reportBundlePrepFailure(
    new BundlePrepError("git update-ref refs/pir/bundle-head 1234 failed: fatal: ...: Read-only file system"),
  );
  assert.match(msg, /failed to prepare the review bundle locally/);
  assert.match(msg, /local git error, not a server connectivity problem/);
  assert.match(msg, /Read-only file system/);
  assert.doesNotMatch(msg, /cannot reach/);
  assert.doesNotMatch(msg, /PIR_REMOTE_TIMEOUT/);
});

/** Capture process.stderr.write during fn; the remote client reports errors there. */
async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    return { result: await fn(), stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * Run a bundle-free `findings list` against a scripted /v1/review responder.
 * `respond(n, body)` returns { status, headers?, body } for the nth POST;
 * retry tests pass "retry-after: 0" so the bounded backoff is instant.
 */
async function withBundleFreeScenario(t, respond) {
  const { remoteExec } = await import("../../dist/cli/remote.js");
  const { createTempGitRepo } = await import("../fixtures/helpers.js");
  const repo = createTempGitRepo("pir-bfree-");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/v1/review")) {
      const body = JSON.parse(init.body);
      posts.push(body);
      const next = respond(posts.length, body);
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        headers: new Map(Object.entries(next.headers ?? {})),
        text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {})),
      };
    }
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    repo.cleanup();
  });
  const run = async () => captureStderr(() => remoteExec("https://pir.invalid", ["--cwd", repo.dir, "findings", "list", "--json"], {}));
  return { posts, run };
}

const RELAY_OK = { status: 200, body: { code: 0, output: "[]\n", log: [] } };

test("#45: 401 on a bundle-free read fails fast — no bundle resend, no retry", async (t) => {
  const { posts, run } = await withBundleFreeScenario(t, () => ({
    status: 401,
    body: { error: "missing or invalid bearer token" },
  }));
  const { result, stderr } = await run();
  assert.equal(result, 3);
  assert.equal(posts.length, 1, "auth failure must not trigger a second request");
  assert.equal(posts[0].noBundle, true);
  assert.match(stderr, /rejected the request \(401\)/);
  assert.match(stderr, /check --token/);
  assert.doesNotMatch(stderr, /resending/);
});

test("#45: 429 retries the same bundle-free request, then succeeds", async (t) => {
  const { posts, run } = await withBundleFreeScenario(
    t,
    (n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" }, body: { error: "busy" } } : RELAY_OK),
  );
  const { result, stderr } = await run();
  assert.equal(result, 0);
  assert.equal(posts.length, 2, "one bounded retry of the same request");
  for (const post of posts) {
    assert.equal(post.noBundle, true, "retry must not upgrade to a bundle");
    assert.equal(post.bundleBase64, "", "no history may be uploaded for a transient failure");
  }
  assert.match(stderr, /retrying the bundle-free request/);
});

test("#45: persistent 429 exhausts the bounded retry and surfaces the original error", async (t) => {
  const { posts, run } = await withBundleFreeScenario(t, () => ({
    status: 429,
    headers: { "retry-after": "0" },
    body: { error: "rate limited" },
  }));
  const { result, stderr } = await run();
  assert.equal(result, 3);
  assert.equal(posts.length, 3, "initial attempt plus two retries");
  assert.ok(posts.every((p) => p.noBundle === true && p.bundleBase64 === ""));
  assert.match(stderr, /server error 429/);
  assert.match(stderr, /rate limited/);
});

test("#45: 5xx on the bundle-free lane retries the same request, never converts to a bundle", async (t) => {
  const { posts, run } = await withBundleFreeScenario(t, () => ({
    status: 503,
    headers: { "retry-after": "0" },
    body: { error: "overloaded" },
  }));
  const { result, stderr } = await run();
  assert.equal(result, 3);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.noBundle === true && p.bundleBase64 === ""));
  assert.match(stderr, /server error 503/);
});

test("#45: explicit needFull still falls back to one bundled resend", async (t) => {
  const { posts, run } = await withBundleFreeScenario(
    t,
    (n) => (n === 1 ? { status: 200, body: { needFull: true } } : RELAY_OK),
  );
  const { result, stderr } = await run();
  assert.equal(result, 0);
  assert.equal(posts.length, 2);
  assert.ok(posts[1].bundleBase64.length > 0, "the resend carries real history");
  assert.notEqual(posts[1].noBundle, true);
  assert.match(stderr, /needs full history, resending/);
});

test("#45: a 400 refusal (pre-bundle-free server) falls back to one bundled resend", async (t) => {
  const { posts, run } = await withBundleFreeScenario(
    t,
    (n) => (n === 1 ? { status: 400, body: { error: "fatal: empty bundle" } } : RELAY_OK),
  );
  const { result, stderr } = await run();
  assert.equal(result, 0);
  assert.equal(posts.length, 2);
  assert.ok(posts[1].bundleBase64.length > 0);
  assert.match(stderr, /refused the bundle-free request, resending with bundle/);
});

test("#44: an ok response that is not JSON is a decoding-stage error, not an empty success", async (t) => {
  const { posts, run } = await withBundleFreeScenario(t, () => ({ status: 200, body: "<html>gateway error page</html>" }));
  const { result, stderr } = await run();
  assert.equal(result, 3);
  assert.equal(posts.length, 1);
  assert.match(stderr, /response-decoding stage/);
  assert.match(stderr, /not valid JSON/);
});

// ---------------------------------------------------------------------------
// PR3 (#42 batch 3): remote timeout resolution (#54), wait heartbeats (#55),
// unlimited findings parsing (#57).
// ---------------------------------------------------------------------------

test("resolveRemoteTimeoutSeconds precedence: flag > env > config > default (#54)", () => {
  const mk = (argv = [], env = {}, config = null) => resolveRemoteTimeoutSeconds({ argv, env, config });
  assert.deepEqual(mk(), { seconds: 1800, source: "default" });
  assert.deepEqual(mk(["--remote-timeout", "60"]), { seconds: 60, source: "flag" });
  assert.deepEqual(mk(["--remote-timeout=0"]), { seconds: 0, source: "flag" });
  assert.deepEqual(mk([], { PIR_REMOTE_TIMEOUT: "45" }), { seconds: 45, source: "env" });
  assert.deepEqual(mk([], {}, { server: { timeoutSeconds: 90 } }), { seconds: 90, source: "config" });
  assert.deepEqual(mk(["--remote-timeout", "7"], { PIR_REMOTE_TIMEOUT: "45" }, { server: { timeoutSeconds: 90 } }), {
    seconds: 7,
    source: "flag",
  });
  assert.deepEqual(mk([], { PIR_REMOTE_TIMEOUT: "45" }, { server: { timeoutSeconds: 90 } }), {
    seconds: 45,
    source: "env",
  });
  // Invalid values are usage errors on every level — never silent fallbacks.
  assert.throws(() => mk(["--remote-timeout", "18OO"]), UsageError);
  assert.throws(() => mk(["--remote-timeout", "-5"]), UsageError);
  assert.throws(() => mk([], { PIR_REMOTE_TIMEOUT: "soon" }), UsageError);
  assert.throws(() => mk([], {}, { server: { timeoutSeconds: 1.5 } }), UsageError);
});

test("jobStatusReporter prints on transitions and heartbeats, never invents progress (#55)", () => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const report = jobStatusReporter("job-1234567890", { heartbeatMs: 60_000 });
    const now = Date.now();
    const job = (over = {}) => ({
      jobId: "job-1234567890",
      command: "audit",
      argv: ["audit"],
      status: "running",
      createdAt: now - (2 * 60 + 13) * 60_000,
      startedAt: now - (2 * 60 + 13) * 60_000,
      finishedAt: null,
      logTotal: 1240,
      log: [],
      result: null,
      error: null,
      clientGone: false,
      ...over,
    });
    report(job()); // first observation prints
    report(job()); // same status inside the window: silent
    report(job({ logTotal: 1252 })); // still inside the window: silent
    assert.equal(lines.length, 1);
    assert.match(lines[0], /job job-1234 running for 2h13m/);
    assert.match(lines[0], /connection alive, last poll ok/);
    assert.match(lines[0], /log lines 1240/);
    assert.match(lines[0], /review progress is not observable from job polling/);

    // A state transition prints immediately, carrying the log delta since
    // the last PRINTED line (silent polls accumulate into it: 1240 -> 1264).
    report(job({ status: "completed", logTotal: 1264, finishedAt: now }));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /job job-1234 completed/);
    assert.match(lines[1], /\+24/);

    // Past the heartbeat window with no transition, the line repeats — with
    // the honest "no new lines" wording when the log did not move.
    const late = jobStatusReporter("job-1234567890", { heartbeatMs: 0 });
    late(job());
    late(job());
    assert.ok(lines.length >= 4);
    assert.match(lines[lines.length - 1], /no new lines|\+\d+/);
  } finally {
    process.stderr.write = original;
  }
});

test("maxFindingsFlag: positive int, literal unlimited -> null, garbage rejected (#57)", () => {
  assert.equal(maxFindingsFlag(new Map()), undefined);
  assert.equal(maxFindingsFlag(new Map([["--max-findings", "10"]])), 10);
  assert.equal(maxFindingsFlag(new Map([["--max-findings", "unlimited"]])), null);
  assert.equal(maxFindingsFlag(new Map([["--max-findings", "UNLIMITED"]])), null);
  assert.equal(maxFindingsFlag(new Map([["--max-findings", " Unlimited "]])), null);
  assert.throws(() => maxFindingsFlag(new Map([["--max-findings", "0"]])), UsageError);
  assert.throws(() => maxFindingsFlag(new Map([["--max-findings", "-3"]])), UsageError);
  assert.throws(() => maxFindingsFlag(new Map([["--max-findings", "many"]])), UsageError);
  assert.throws(() => maxFindingsFlag(new Map([["--max-findings", true]])), UsageError);
});

test("minConfidenceFlag: flag > PIR_MIN_CONFIDENCE env, bounded 0-1 (Q4)", () => {
  assert.equal(minConfidenceFlag(new Map()), undefined);
  assert.equal(minConfidenceFlag(new Map([["--min-confidence", "0.7"]])), 0.7);
  assert.equal(minConfidenceFlag(new Map([["--min-confidence", "0"]])), 0);
  assert.equal(minConfidenceFlag(new Map([["--min-confidence", "1"]])), 1);
  assert.equal(minConfidenceFlag(new Map(), { PIR_MIN_CONFIDENCE: "0.55" }), 0.55);
  // flag wins over env
  assert.equal(minConfidenceFlag(new Map([["--min-confidence", "0.2"]]), { PIR_MIN_CONFIDENCE: "0.55" }), 0.2);
  assert.throws(() => minConfidenceFlag(new Map([["--min-confidence", "-0.1"]])), UsageError);
  assert.throws(() => minConfidenceFlag(new Map([["--min-confidence", "1.1"]])), UsageError);
  assert.throws(() => minConfidenceFlag(new Map([["--min-confidence", "high"]])), UsageError);
  assert.throws(() => minConfidenceFlag(new Map([["--min-confidence", true]])), UsageError);
});

test("verifierModelFlag: flag > PIR_VERIFIER_MODEL env, non-empty id (Q5)", () => {
  assert.equal(verifierModelFlag(new Map()), undefined);
  assert.equal(verifierModelFlag(new Map([["--verify-model", "prov/model:max"]])), "prov/model:max");
  assert.equal(verifierModelFlag(new Map(), { PIR_VERIFIER_MODEL: "prov/other" }), "prov/other");
  assert.equal(verifierModelFlag(new Map([["--verify-model", " a/b "]])), "a/b");
  // flag wins over env
  assert.equal(verifierModelFlag(new Map([["--verify-model", "a/b"]]), { PIR_VERIFIER_MODEL: "c/d" }), "a/b");
  assert.throws(() => verifierModelFlag(new Map([["--verify-model", true]])), UsageError);
  assert.throws(() => verifierModelFlag(new Map([["--verify-model", "   "]])), UsageError);
  assert.throws(() => verifierModelFlag(new Map(), { PIR_VERIFIER_MODEL: "" }), UsageError);
});

test("stripClientFlags removes --detach and --remote-timeout before forwarding (#53/#54)", () => {
  assert.deepEqual(
    stripClientFlags(["find", "--detach", "--remote-timeout", "60", "--json"]),
    ["find", "--json"],
  );
  assert.deepEqual(stripClientFlags(["audit", "--detach", "--remote-timeout=0"]), ["audit"]);
  assert.deepEqual(stripClientFlags(["find", "--json"]), ["find", "--json"]);
});

test("--detach cannot ride the registered-repo lane (#53, dogfood F-49)", async () => {
  const { remoteExec } = await import("../../dist/cli/remote.js");
  // Validation fires before any network IO, so a dead port is fine.
  await assert.rejects(
    remoteExec("http://127.0.0.1:9", ["find", "--detach", "--repo", "demo", "--json"], {}),
    (error) => error instanceof UsageError && /cannot be combined with --repo/.test(error.message),
  );
});
