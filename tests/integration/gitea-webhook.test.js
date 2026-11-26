import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { addRepo } from "../../dist/app/repos.js";
import { git } from "../../dist/changes/git.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Model-free end-to-end test of POST /v1/webhook/gitea: a scripted Gitea API
 * (fetchImpl) + a fixture runner stand in for the network and the models,
 * while everything else — HMAC verification, policy gate, registered-repo
 * fetch of refs/pull/<n>/head, throwaway worktree, real diff parsing, dedupe,
 * inline anchoring, publishing, state — runs for real.
 */

const SECRET = "test-webhook-secret-123";
const GITEA_BASE = "https://gitea.example.com";
const REPO_FULL_NAME = "beiyan/pir-demo";
const CONTEXT = "pir/review";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const APP_BASE = "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction gamma() { return 3; }\n";
const APP_WITH_BETA2 =
  "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\n";

/** Origin repo with a 3-function base and a PR head inserting beta2 at line 3. */
function originFixture(number = 1) {
  const origin = createTempGitRepo("pir-gitea-origin-");
  origin.write("src/app.ts", APP_BASE);
  const baseSha = origin.commit("base");
  origin.write("src/app.ts", APP_WITH_BETA2);
  const headSha = origin.commit("pr work");
  git(origin.dir, ["update-ref", `refs/pull/${number}/head`, headSha]);
  return { origin, baseSha, headSha };
}

/** One more commit on a PR, by default appending delta() as line 5 to PR 1. */
function pushNewHead(
  fixture,
  number = 1,
  content = "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\n",
) {
  fixture.origin.write("src/app.ts", content);
  const head = fixture.origin.commit(`pr work ${number}`);
  git(fixture.origin.dir, ["update-ref", `refs/pull/${number}/head`, head]);
  return head;
}

function findingFixtures() {
  return [
    {
      id: "uuid-1",
      displayId: "F-1",
      fingerprint: "fp-anchorable-1",
      title: "beta2 return value",
      claim: "beta2 returns 22 while callers of beta expect 2.",
      trigger: "new function beta2",
      category: "correctness",
      severity: "P2",
      status: "confirmed",
      featureKey: null,
      entityKey: null,
      anchors: [{ path: "src/app.ts", startLine: 3 }],
      evidence: [],
      memoryMatches: [],
      verifierRationale: "Read the head revision of src/app.ts.",
      rejectionGround: null,
      confidence: 0.8,
      round: 1,
      createdAt: 0,
      lineCorrected: false,
    },
    {
      id: "uuid-2",
      displayId: "F-2",
      fingerprint: "fp-demoted-2",
      title: "docs drift",
      claim: "notes.md does not mention beta2.",
      trigger: "docs consistency",
      category: "docs",
      severity: "P3",
      status: "confirmed",
      featureKey: null,
      entityKey: null,
      anchors: [{ path: "docs/notes.md", startLine: 1 }],
      evidence: [],
      memoryMatches: [],
      verifierRationale: null,
      rejectionGround: null,
      confidence: null,
      round: 1,
      createdAt: 0,
      lineCorrected: false,
    },
  ];
}

const findEnvelopeFor = (findings) => ({
  schemaVersion: 1,
  command: "find",
  project: { id: "project-id", cwd: "/worktree", head: "head" },
  data: { run: { id: "run-1" }, degraded: false, plugins: ["typescript"], findings },
});

const summarizeEnvelope = {
  schemaVersion: 1,
  command: "summarize",
  project: { id: "project-id", cwd: "/worktree", head: "head" },
  data: {
    base: "base",
    head: "head",
    stats: { files: 1, insertions: 1, deletions: 0 },
    summary: "Adds beta2 and its return path.",
    riskAreas: ["return-value shape of beta2"],
  },
};

// ---------------------------------------------------------------------------
// scripted Gitea API
// ---------------------------------------------------------------------------

const jsonResponse = (body, status = 200) =>
  new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Routing fake with real state machines for comments/reviews/statuses, so
 * call order never needs scripting. `hooks.onFirstCommentsList` (a promise)
 * parks the first issue-comments listing — used to make the superseded test's
 * interleaving deterministic.
 */
function fakeGitea(hooks = {}) {
  const requests = [];
  const state = {
    comments: [],
    reviews: [],
    statuses: [],
    nextCommentId: 100,
    nextReviewId: 9001,
  };
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({ url: String(url), method, body: init.body });
    // The client normalizes its base to the api/v1 root; the fake routes on
    // the bare API path either way.
    const pathname = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");

    if (pathname === "/user" && method === "GET") {
      return jsonResponse({ id: 1, login: "pirbot" });
    }
    let match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(pathname);
    if (match && method === "GET") {
      if (hooks.onFirstCommentsList) {
        const gate = hooks.onFirstCommentsList;
        hooks.onFirstCommentsList = null;
        await gate;
      }
      // Comments are per-PR on Gitea; keeping them in one list but filtering
      // by the requested issue number preserves that contract for tests that
      // exercise several PRs in one server.
      return jsonResponse(state.comments.filter((comment) => comment.number === Number(match[3])));
    }
    if (match && method === "POST") {
      const comment = { id: state.nextCommentId++, number: Number(match[3]), body: JSON.parse(init.body).body };
      state.comments.push(comment);
      return jsonResponse(comment, 201);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(pathname);
    if (match && method === "PATCH") {
      const comment = state.comments.find((c) => c.id === Number(match[3]));
      if (!comment) return jsonResponse({ message: "Not Found" }, 404);
      comment.body = JSON.parse(init.body).body;
      return jsonResponse(comment);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(pathname);
    if (match && method === "POST") {
      const review = { id: state.nextReviewId++, number: Number(match[3]), ...JSON.parse(init.body) };
      state.reviews.push(review);
      return jsonResponse(review, 201);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(pathname);
    if (match && method === "DELETE") {
      const id = Number(match[4]);
      const index = state.reviews.findIndex((r) => r.id === id);
      if (index >= 0) state.reviews.splice(index, 1);
      return jsonResponse(undefined, 204);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/statuses\/([0-9a-f]+)$/.exec(pathname);
    if (match && method === "POST") {
      state.statuses.push({ sha: match[3], ...JSON.parse(init.body) });
      return jsonResponse({});
    }
    return jsonResponse({ message: `unscripted ${method} ${pathname}` }, 500);
  };
  return { impl, requests, state };
}

// ---------------------------------------------------------------------------
// server + webhook helpers
// ---------------------------------------------------------------------------

function sandboxEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "pir-gitea-test-"));
  const keys = ["PIR_REPOS_ROOT", "PIR_STATE_ROOT", "PIR_CODEGRAPH", "PIR_MEMORY_DB", "PIR_STATE_IN_PROJECT"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PIR_REPOS_ROOT = path.join(root, "repos");
  process.env.PIR_STATE_ROOT = path.join(root, "state");
  process.env.PIR_CODEGRAPH = "0";
  delete process.env.PIR_MEMORY_DB;
  delete process.env.PIR_STATE_IN_PROJECT;
  return {
    root,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function defaultConfig() {
  return {
    url: GITEA_BASE,
    token: "bot-token",
    webhookSecret: SECRET,
    commentLanguage: "en",
    statusOnFindings: "failure",
    defaults: {
      baseBranches: ["main"],
      wipPrefixes: ["WIP:", "[WIP]", "Draft:"],
      skipLabels: ["skip-review"],
      maxFindings: 10,
      model: null,
    },
    repos: {},
  };
}

async function withGiteaServer(
  t,
  {
    config = defaultConfig(),
    runner,
    fetchHooks,
    reviewConcurrency,
    projectReviewConcurrency,
    beforeClose,
  } = {},
) {
  const { root, restore } = sandboxEnv();
  const configDir = path.join(root, "config");
  const gitea = fakeGitea(fetchHooks);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace: path.join(root, "workspace"),
    tls: null,
    gitea: { config, configDir, fetchImpl: gitea.impl, ...(runner ? { runner } : {}) },
    ...(reviewConcurrency !== undefined ? { reviewConcurrency } : {}),
    ...(projectReviewConcurrency !== undefined ? { projectReviewConcurrency } : {}),
  });
  const port = handle.url.split(":").pop();
  // Release and settle any in-flight jobs before closing the server; tests
  // that hold a runner behind a barrier pass this hook so cleanup never races
  // a state write against a deleted workspace.
  t.after(async () => {
    try {
      if (beforeClose) await beforeClose();
      const { jobs } = await (await fetch(`${handle.url}/v1/jobs`)).json();
      await Promise.all(jobs.map((job) => waitForJob(handle.url, job.jobId)));
      restore();
      rmSync(root, { recursive: true, force: true });
    } finally {
      handle.close();
    }
  });
  assert.equal(handle.giteaEnabled, GITEA_BASE);
  return { base: `http://127.0.0.1:${port}`, configDir, gitea, root };
}

async function withBareServer(t) {
  const { root, restore } = sandboxEnv();
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace: path.join(root, "workspace"),
    tls: null,
  });
  const port = handle.url.split(":").pop();
  t.after(() => {
    handle.close();
    restore();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(handle.giteaEnabled, undefined);
  return `http://127.0.0.1:${port}`;
}

function prPayload(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    action: overrides.action ?? "opened",
    number,
    pull_request: {
      title: overrides.title ?? "Add feature",
      body: null,
      ...(overrides.draft !== undefined ? { draft: overrides.draft } : {}),
      base: { ref: overrides.baseRef ?? "main", sha: overrides.baseSha },
      head: { ref: "feat/thing", sha: overrides.headSha },
      html_url: `${GITEA_BASE}/${REPO_FULL_NAME}/pulls/${number}`,
      user: { login: "dev" },
      ...(overrides.labels ? { labels: overrides.labels } : {}),
    },
    repository: {
      full_name: REPO_FULL_NAME,
      owner: { login: "beiyan" },
      name: "pir-demo",
      clone_url: overrides.cloneUrl,
    },
    sender: { login: overrides.senderLogin ?? "dev" },
  };
}

async function postWebhook(
  base,
  payload,
  { secret = SECRET, event = "pull_request", eventType = "pull_request", omitEvent = false } = {},
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = await fetch(`${base}/v1/webhook/gitea`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(!omitEvent ? { "x-gitea-event": event, "x-gitea-event-type": eventType } : {}),
      "x-gitea-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function waitForJob(base, jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${base}/v1/jobs/${jobId}`);
    const { job } = await response.json();
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms (last: ${job.status})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const stateKey = `${REPO_FULL_NAME}#1`;

const readState = (configDir) => JSON.parse(readFileSync(path.join(configDir, "gitea-state.json"), "utf8"));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Fail a test that depends on a barrier being reached instead of hanging
 * forever. This is only a guard: concurrency is decided by the barrier
 * itself, never by sleeping for an arbitrary interval.
 */
async function withDeadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const commentsFor = (gitea, number) => gitea.state.comments.filter((comment) => comment.number === number);
const reviewsFor = (gitea, number) => gitea.state.reviews.filter((review) => review.number === number);
const reviewPostsFor = (gitea, number) =>
  gitea.requests.filter((request) => request.method === "POST" && request.url.endsWith(`/pulls/${number}/reviews`));
const reviewDeletesFor = (gitea, number) =>
  gitea.requests.filter((request) => request.method === "DELETE" && request.url.includes(`/pulls/${number}/reviews/`));

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("gitea webhook: happy path posts started status, inline review, done status, and state", async (t) => {
  const findings = findingFixtures();
  const runnerCalls = [];
  const runner = async (worktree, args) => {
    runnerCalls.push({ worktree, args });
    return { findEnvelope: findEnvelopeFor(findings), summarizeEnvelope };
  };
  const { base, configDir, gitea, root } = await withGiteaServer(t, { runner });
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);

  // The payload's clone_url is the origin path; the registry match is by
  // normalized URL (a local path normalizes to itself on both sides).
  const response = await postWebhook(base, prPayload({ baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: fixture.origin.dir }));
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.reason, "accepted");
  const job = await waitForJob(base, response.body.jobId);
  assert.equal(job.status, "completed");
  assert.equal(JSON.parse(job.result.output).outcome, "reviewed");

  // The runner got the throwaway worktree, the pinned range, the resolved
  // policy and the project's central db path — and the worktree is gone.
  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].worktree.startsWith(path.join(root, "repos", "work")));
  assert.equal(runnerCalls[0].args.base, fixture.baseSha);
  assert.equal(runnerCalls[0].args.head, fixture.headSha);
  assert.equal(runnerCalls[0].args.policy.maxFindings, 10);
  assert.match(runnerCalls[0].args.dbPath, /memory\.sqlite$/);
  assert.equal(existsSync(runnerCalls[0].worktree), false);

  // One status comment, created as "started" then edited to "done".
  assert.equal(gitea.state.comments.length, 1);
  const created = gitea.requests.find((r) => r.method === "POST" && r.url.endsWith("/issues/1/comments"));
  assert.ok(JSON.parse(created.body).body.includes("pir review started"));
  const finalBody = gitea.state.comments[0].body;
  assert.ok(finalBody.startsWith(`<!-- pir:status ${stateKey} v1 -->\n`));
  assert.ok(finalBody.includes("Review complete — 2 finding(s)"));
  assert.ok(finalBody.includes("| F-1 | P2 | correctness | src/app.ts:3 |"));
  assert.ok(finalBody.includes("| F-2 | P3 | docs | docs/notes.md:1 |"));

  // Commit statuses: pending then the configured statusOnFindings.
  assert.deepEqual(
    gitea.state.statuses.map((s) => ({ state: s.state, context: s.context, sha: s.sha.slice(0, 7) })),
    [
      { state: "pending", context: CONTEXT, sha: fixture.headSha.slice(0, 7) },
      { state: "failure", context: CONTEXT, sha: fixture.headSha.slice(0, 7) },
    ],
  );

  // One review, COMMENT event, with exactly the anchorable finding inline at
  // the real diff position and the demoted one in the overview table.
  assert.equal(gitea.state.reviews.length, 1);
  const review = gitea.state.reviews[0];
  assert.equal(review.event, "COMMENT");
  assert.deepEqual(
    review.comments.map((c) => ({ path: c.path, new_position: c.new_position })),
    [{ path: "src/app.ts", new_position: 3 }],
  );
  assert.ok(review.comments[0].body.includes("**P2 · correctness** — `src/app.ts:3`"));
  assert.ok(review.body.includes("pir review: #1 Add feature"));
  assert.ok(review.body.includes("1 file(s) changed, +1/-0"));
  assert.ok(review.body.includes("Plugins: typescript"));
  assert.ok(review.body.includes("## Summary"));
  assert.ok(review.body.includes("Adds beta2 and its return path."));
  assert.ok(review.body.includes("- return-value shape of beta2"));
  assert.ok(review.body.includes("docs/notes.md:1 (not on a changed line)"));
  assert.ok(review.body.trimEnd().endsWith("<!-- pir:review v1 -->"));
  assert.match(review.body, /pir v\d+\.\d+\.\d+/);

  // Durable state: head, review id, both fingerprints.
  const state = readState(configDir).prs[stateKey];
  assert.equal(state.lastHeadSha, fixture.headSha);
  assert.equal(state.reviewId, review.id);
  assert.equal(state.statusCommentId, gitea.state.comments[0].id);
  assert.deepEqual(state.lastPostedFingerprints.sort(), ["fp-anchorable-1", "fp-demoted-2"]);

  // The bot login was learned once (GET /user) and cached.
  assert.equal(gitea.requests.filter((r) => r.url.endsWith("/user")).length, 1);
});

test("gitea webhook: re-review with identical findings reposts nothing and notes the unchanged count", async (t) => {
  const findings = findingFixtures();
  const runner = async () => ({ findEnvelope: findEnvelopeFor(findings), summarizeEnvelope });
  const { base, configDir, gitea } = await withGiteaServer(t, { runner });
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);

  const first = await postWebhook(base, prPayload({ baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: fixture.origin.dir }));
  assert.equal(first.status, 202);
  await waitForJob(base, first.body.jobId);
  assert.equal(gitea.state.reviews.length, 1);
  const firstReviewId = gitea.state.reviews[0].id;

  const head2 = pushNewHead(fixture);
  const second = await postWebhook(
    base,
    prPayload({ baseSha: fixture.baseSha, headSha: head2, cloneUrl: fixture.origin.dir, action: "synchronized" }),
    { event: "pull_request_sync", eventType: "pull_request_sync" },
  );
  assert.equal(second.status, 202);
  const job = await waitForJob(base, second.body.jobId);
  assert.equal(JSON.parse(job.result.output).outcome, "reviewed");

  // The previous review was deleted; the new one has no inline comments and
  // notes the unchanged findings instead.
  assert.equal(gitea.state.reviews.length, 1);
  const review = gitea.state.reviews[0];
  assert.notEqual(review.id, firstReviewId);
  assert.deepEqual(review.comments, []);
  assert.ok(review.body.includes("2 previously-reported finding(s) unchanged — not reposted"));
  assert.ok(gitea.requests.some((r) => r.method === "DELETE" && r.url.endsWith(`/reviews/${firstReviewId}`)));

  // Statuses on the new head: pending + the configured on-findings state
  // (unchanged findings still count as present).
  const onHead2 = gitea.state.statuses.filter((s) => s.sha === head2).map((s) => s.state);
  assert.deepEqual(onHead2, ["pending", "failure"]);

  const state = readState(configDir).prs[stateKey];
  assert.equal(state.lastHeadSha, head2);
  assert.equal(state.reviewId, review.id);
});

test("gitea webhook: different PRs in one project run concurrently and keep separate state, comments and reviews", async (t) => {
  const findings = findingFixtures();
  const entered = [];
  const bothEntered = deferred();
  const release = deferred();
  const jobIds = [];
  let base;
  const runner = async (_worktree, args) => {
    entered.push(args.head);
    if (entered.length === 2) bothEntered.resolve();
    await release.promise;
    return { findEnvelope: findEnvelopeFor(findings), summarizeEnvelope };
  };
  const server = await withGiteaServer(t, {
    runner,
    reviewConcurrency: 2,
    projectReviewConcurrency: 2,
    beforeClose: async () => {
      release.resolve();
      await Promise.allSettled(jobIds.map((id) => waitForJob(base, id, 10000)));
    },
  });
  base = server.base;
  const { configDir, gitea } = server;
  const fixture = originFixture(1);
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);

  // A second PR in the SAME registered project: distinct head, distinct
  // resource key, so the two orchestrations must be admitted together.
  const head2 = pushNewHead(
    fixture,
    2,
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction epsilon() { return 5; }\n",
  );

  const first = await postWebhook(
    base,
    prPayload({ number: 1, baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: fixture.origin.dir }),
  );
  assert.equal(first.status, 202);
  jobIds.push(first.body.jobId);
  const second = await postWebhook(
    base,
    prPayload({ number: 2, baseSha: fixture.baseSha, headSha: head2, cloneUrl: fixture.origin.dir, title: "Second PR" }),
  );
  assert.equal(second.status, 202);
  jobIds.push(second.body.jobId);

  // Neither runner is released: reaching two entries proves the scheduler
  // admitted both PRs, not that they merely finished one after the other.
  await withDeadline(bothEntered.promise, 20000, "both PR runners should enter before either is released");
  assert.deepEqual(new Set(entered), new Set([fixture.headSha, head2]));
  release.resolve();

  const [job1, job2] = await Promise.all([waitForJob(base, first.body.jobId), waitForJob(base, second.body.jobId)]);
  assert.equal(JSON.parse(job1.result.output).outcome, "reviewed");
  assert.equal(JSON.parse(job2.result.output).outcome, "reviewed");

  const key1 = `${REPO_FULL_NAME}#1`;
  const key2 = `${REPO_FULL_NAME}#2`;
  const prs = readState(configDir).prs;
  assert.deepEqual(Object.keys(prs).sort(), [key1, key2].sort());
  assert.equal(prs[key1].lastHeadSha, fixture.headSha);
  assert.equal(prs[key2].lastHeadSha, head2);

  const comments1 = commentsFor(gitea, 1);
  const comments2 = commentsFor(gitea, 2);
  assert.equal(comments1.length, 1);
  assert.equal(comments2.length, 1);
  assert.ok(comments1[0].body.startsWith(`<!-- pir:status ${key1} v1 -->`));
  assert.ok(comments2[0].body.startsWith(`<!-- pir:status ${key2} v1 -->`));
  assert.equal(prs[key1].statusCommentId, comments1[0].id);
  assert.equal(prs[key2].statusCommentId, comments2[0].id);

  const reviews1 = reviewsFor(gitea, 1);
  const reviews2 = reviewsFor(gitea, 2);
  assert.equal(reviews1.length, 1);
  assert.equal(reviews2.length, 1);
  assert.ok(reviews1[0].body.includes("pir review: #1"));
  assert.ok(reviews2[0].body.includes("pir review: #2 Second PR"));
  assert.equal(prs[key1].reviewId, reviews1[0].id);
  assert.equal(prs[key2].reviewId, reviews2[0].id);

  for (const [sha, number] of [
    [fixture.headSha, 1],
    [head2, 2],
  ]) {
    assert.deepEqual(
      gitea.state.statuses.filter((status) => status.sha === sha).map((status) => status.state),
      ["pending", "failure"],
      `statuses for PR #${number}`,
    );
  }
});

test("gitea webhook: a newer head accepted during the model run makes the old run stand down before publishing", async (t) => {
  const findings = findingFixtures();
  const enteredHeads = [];
  const oldEntered = deferred();
  const releaseOld = deferred();
  let oldHead;
  const jobIds = [];
  let base;
  const runner = async (_worktree, args) => {
    enteredHeads.push(args.head);
    if (args.head === oldHead) {
      oldEntered.resolve();
      await releaseOld.promise;
    }
    return { findEnvelope: findEnvelopeFor(findings), summarizeEnvelope };
  };
  const server = await withGiteaServer(t, {
    runner,
    reviewConcurrency: 3,
    projectReviewConcurrency: 3,
    beforeClose: async () => {
      releaseOld.resolve();
      await Promise.allSettled(jobIds.map((id) => waitForJob(base, id, 10000)));
    },
  });
  base = server.base;
  const { configDir, gitea } = server;
  const fixture = originFixture(7);
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);

  const headA = fixture.headSha;
  const baseline = await postWebhook(
    base,
    prPayload({ number: 7, baseSha: fixture.baseSha, headSha: headA, cloneUrl: fixture.origin.dir }),
  );
  assert.equal(baseline.status, 202);
  jobIds.push(baseline.body.jobId);
  assert.equal(JSON.parse((await waitForJob(base, baseline.body.jobId)).result.output).outcome, "reviewed");
  const reviewA = reviewsFor(gitea, 7)[0];
  assert.ok(reviewA);

  // The old run is parked inside its model call on head B.
  oldHead = pushNewHead(
    fixture,
    7,
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\n",
  );
  const older = await postWebhook(
    base,
    prPayload({ number: 7, baseSha: fixture.baseSha, headSha: oldHead, cloneUrl: fixture.origin.dir, action: "synchronized", title: "Head B" }),
    { event: "pull_request_sync", eventType: "pull_request_sync" },
  );
  assert.equal(older.status, 202);
  jobIds.push(older.body.jobId);
  await withDeadline(oldEntered.promise, 20000, "the old head's runner should be parked");

  // Head C is accepted while B's model call is still running. It must queue
  // behind the same PR; the canary PR D proves the scheduler kept draining.
  const newHead = pushNewHead(
    fixture,
    7,
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\nfunction epsilon() { return 5; }\n",
  );
  const newer = await postWebhook(
    base,
    prPayload({ number: 7, baseSha: fixture.baseSha, headSha: newHead, cloneUrl: fixture.origin.dir, action: "synchronized", title: "Head C" }),
    { event: "pull_request_sync", eventType: "pull_request_sync" },
  );
  assert.equal(newer.status, 202);
  jobIds.push(newer.body.jobId);

  const canaryHead = pushNewHead(
    fixture,
    8,
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\nfunction zeta() { return 6; }\n",
  );
  const canary = await postWebhook(
    base,
    prPayload({ number: 8, baseSha: fixture.baseSha, headSha: canaryHead, cloneUrl: fixture.origin.dir, title: "Canary PR" }),
  );
  assert.equal(canary.status, 202);
  jobIds.push(canary.body.jobId);
  assert.equal(JSON.parse((await waitForJob(base, canary.body.jobId)).result.output).outcome, "reviewed");

  // The scheduler moved on to the canary while B was blocked, yet C (same PR,
  // different head) still has not entered its runner and nothing was published
  // for B beyond its already-posted started status.
  assert.equal(enteredHeads.includes(newHead), false);
  assert.equal(reviewsFor(gitea, 7).length, 1);
  assert.equal(reviewPostsFor(gitea, 7).length, 1);
  assert.equal(reviewDeletesFor(gitea, 7).length, 0);

  releaseOld.resolve();
  const [oldJob, newJob] = await Promise.all([waitForJob(base, older.body.jobId), waitForJob(base, newer.body.jobId)]);
  assert.equal(JSON.parse(oldJob.result.output).outcome, "superseded");
  assert.equal(JSON.parse(newJob.result.output).outcome, "reviewed");

  // The old run did not delete the baseline review or post a review for B;
  // only the new head's run published after deleting the baseline.
  assert.equal(reviewPostsFor(gitea, 7).length, 2);
  assert.equal(reviewDeletesFor(gitea, 7).length, 1);
  assert.ok(reviewDeletesFor(gitea, 7)[0].url.endsWith(`/reviews/${reviewA.id}`));
  const finalReview = reviewsFor(gitea, 7)[0];
  assert.ok(finalReview.body.includes(newHead.slice(0, 7)));
  assert.ok(!finalReview.body.includes(oldHead.slice(0, 7)));

  const prs = readState(configDir).prs;
  const key = `${REPO_FULL_NAME}#7`;
  assert.equal(prs[key].lastHeadSha, newHead);
  assert.equal(prs[key].reviewId, finalReview.id);
  // B only ever reached the pending state; C owns the terminal status.
  assert.deepEqual(
    gitea.state.statuses.filter((status) => status.sha === oldHead).map((status) => status.state),
    ["pending"],
  );
  assert.deepEqual(
    gitea.state.statuses.filter((status) => status.sha === newHead).map((status) => status.state),
    ["pending", "failure"],
  );
});

test("gitea webhook: concurrent webhooks for the same head never overlap runners and keep dedupe semantics", async (t) => {
  const findings = findingFixtures();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const callsByHead = new Map();
  let activeForHead = 0;
  let maxActiveForHead = 0;
  let firstCall = true;
  let sameHead;
  const jobIds = [];
  let base;
  const runner = async (_worktree, args) => {
    callsByHead.set(args.head, (callsByHead.get(args.head) ?? 0) + 1);
    if (args.head === sameHead) {
      activeForHead++;
      maxActiveForHead = Math.max(maxActiveForHead, activeForHead);
      try {
        if (firstCall) {
          firstCall = false;
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return { findEnvelope: findEnvelopeFor(findings), summarizeEnvelope };
      } finally {
        activeForHead--;
      }
    }
    return { findEnvelope: findEnvelopeFor(findings), summarizeEnvelope };
  };
  const server = await withGiteaServer(t, {
    runner,
    reviewConcurrency: 3,
    projectReviewConcurrency: 3,
    beforeClose: async () => {
      releaseFirst.resolve();
      await Promise.allSettled(jobIds.map((id) => waitForJob(base, id, 10000)));
    },
  });
  base = server.base;
  const { configDir, gitea } = server;
  const fixture = originFixture(11);
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);
  sameHead = fixture.headSha;

  const payload = prPayload({ number: 11, baseSha: fixture.baseSha, headSha: sameHead, cloneUrl: fixture.origin.dir });
  const first = await postWebhook(base, payload);
  assert.equal(first.status, 202);
  jobIds.push(first.body.jobId);
  await withDeadline(firstEntered.promise, 20000, "the first same-head runner should be parked");

  const second = await postWebhook(base, payload);
  assert.equal(second.status, 202);
  jobIds.push(second.body.jobId);

  // A different-PR canary run proves the queue was pumped while the same-PR
  // job stayed blocked behind its resource key.
  const canaryHead = pushNewHead(
    fixture,
    12,
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\nfunction zeta() { return 6; }\n",
  );
  const canary = await postWebhook(
    base,
    prPayload({ number: 12, baseSha: fixture.baseSha, headSha: canaryHead, cloneUrl: fixture.origin.dir, title: "Canary PR" }),
  );
  assert.equal(canary.status, 202);
  jobIds.push(canary.body.jobId);
  assert.equal(JSON.parse((await waitForJob(base, canary.body.jobId)).result.output).outcome, "reviewed");

  assert.equal(callsByHead.get(sameHead), 1);
  assert.equal(maxActiveForHead, 1);
  assert.equal(reviewsFor(gitea, 11).length, 0);

  releaseFirst.resolve();
  const [job1, job2] = await Promise.all([waitForJob(base, first.body.jobId), waitForJob(base, second.body.jobId)]);
  assert.equal(JSON.parse(job1.result.output).outcome, "reviewed");
  assert.equal(JSON.parse(job2.result.output).outcome, "reviewed");

  // Both ran, but never at the same time; the second replaced the first and
  // reused the unchanged fingerprints exactly like the existing re-review path.
  assert.equal(callsByHead.get(sameHead), 2);
  assert.equal(maxActiveForHead, 1);
  assert.equal(reviewPostsFor(gitea, 11).length, 2);
  assert.equal(reviewDeletesFor(gitea, 11).length, 1);
  const finalReview = reviewsFor(gitea, 11)[0];
  assert.ok(finalReview.body.includes("previously-reported finding(s) unchanged — not reposted"));
  const prs = readState(configDir).prs;
  assert.equal(prs[`${REPO_FULL_NAME}#11`].lastHeadSha, sameHead);
  assert.equal(prs[`${REPO_FULL_NAME}#11`].reviewId, finalReview.id);
});

test("gitea webhook: policy rejections answer 200 with the reason code and create no job", async (t) => {
  const runner = async () => assert.fail("runner must not be called for rejected webhooks");
  const { base, gitea } = await withGiteaServer(t, { runner });
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);
  const ok = (overrides = {}) => prPayload({ baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: fixture.origin.dir, ...overrides });

  const cases = [
    ["wip:", ok({ title: "WIP: Add feature" })],
    ["wip:", ok({ draft: true })],
    ["base-branch:", ok({ baseRef: "dev" })],
    ["skip-label:", ok({ labels: [{ name: "skip-review" }] })],
    ["unwatched-action:", ok({ action: "edited", title: "WIP: still going" })],
    ["bot-sender:", ok({ senderLogin: "pirbot" })],
  ];
  for (const [code, payload] of cases) {
    const response = await postWebhook(base, payload);
    assert.equal(response.status, 200);
    assert.equal(response.body.accepted, false);
    assert.ok(response.body.reason.startsWith(code), `reason "${response.body.reason}" should start with ${code}`);
  }

  // Non-PR events are skipped cheaply with the bare code.
  const push = await postWebhook(base, { ref: "refs/heads/main", after: fixture.headSha }, { event: "push" });
  assert.equal(push.status, 200);
  assert.deepEqual(push.body, { accepted: false, reason: "unwatched-event" });

  // Nothing above created a job or touched the PR.
  const jobs = await (await fetch(`${base}/v1/jobs`)).json();
  assert.equal(jobs.jobs.length, 0);
  assert.equal(gitea.state.comments.length, 0);
  assert.equal(gitea.state.reviews.length, 0);
  assert.equal(gitea.state.statuses.length, 0);
});

test("gitea webhook: 401 bad signature, 400 malformed body or missing event header, 503 without config", async (t) => {
  const bare = await withBareServer(t);
  const unconfigured = await postWebhook(bare, { action: "opened" });
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(unconfigured.body, { error: "gitea integration not configured" });

  const { base } = await withGiteaServer(t, {});
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());

  const badSignature = await postWebhook(base, prPayload({ baseSha: "a".repeat(40), headSha: "b".repeat(40), cloneUrl: fixture.origin.dir }), { secret: "wrong-secret" });
  assert.equal(badSignature.status, 401);
  assert.deepEqual(badSignature.body, { error: "invalid or missing webhook signature" });

  const malformed = await postWebhook(base, "{{{not json");
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /not valid JSON/);

  const noEvent = await postWebhook(base, "{}", { omitEvent: true });
  assert.equal(noEvent.status, 400);
  assert.match(noEvent.body.error, /x-gitea-event/);
});

test("gitea webhook: a superseded run stands down without posting a review for the old head", async (t) => {
  const findings = findingFixtures();
  const runner = async () => ({ findEnvelope: findEnvelopeFor(findings), summarizeEnvelope });
  // Hold the FIRST job inside its started-status step (the first issue
  // comments listing) until the second webhook has registered the newer
  // head — making the superseded window deterministic instead of a race.
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const { base, gitea } = await withGiteaServer(t, {
    runner, fetchHooks: { onFirstCommentsList: hold }, beforeClose: () => releaseHold(),
  });
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());
  await addRepo(fixture.origin.dir);

  const first = await postWebhook(base, prPayload({ baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: fixture.origin.dir }));
  assert.equal(first.status, 202);

  // The older job is now parked in listIssueComments; push a newer head and
  // accept the newer webhook before letting it continue.
  const head2 = pushNewHead(fixture);
  const second = await postWebhook(base, prPayload({ baseSha: fixture.baseSha, headSha: head2, cloneUrl: fixture.origin.dir }), {
    event: "pull_request_sync",
    eventType: "pull_request_sync",
  });
  assert.equal(second.status, 202);
  releaseHold();

  const job1 = await waitForJob(base, first.body.jobId);
  const job2 = await waitForJob(base, second.body.jobId);
  assert.equal(JSON.parse(job1.result.output).outcome, "superseded");
  assert.equal(JSON.parse(job2.result.output).outcome, "reviewed");

  // Exactly one review exists and it is for the NEWER head only.
  assert.equal(gitea.state.reviews.length, 1);
  assert.ok(gitea.state.reviews[0].body.includes(head2.slice(0, 7)));
  assert.ok(!gitea.state.reviews[0].body.includes(fixture.headSha.slice(0, 7)));
});

test("gitea webhook: an unregistered clone_url fails the job with register guidance on the PR", async (t) => {
  const runner = async () => assert.fail("runner must not be called for an unregistered repo");
  const { base, gitea } = await withGiteaServer(t, { runner });
  const fixture = originFixture();
  t.after(() => fixture.origin.cleanup());

  const response = await postWebhook(base, prPayload({ baseSha: fixture.baseSha, headSha: fixture.headSha, cloneUrl: "/nowhere/registered" }));
  assert.equal(response.status, 202);
  const job = await waitForJob(base, response.body.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.error, /not registered/);

  // The PR was not left silent: started comment edited to the failed body
  // with the register guidance, and an error commit status on the head.
  assert.equal(gitea.state.comments.length, 1);
  assert.ok(gitea.state.comments[0].body.includes("Review failed"));
  assert.ok(gitea.state.comments[0].body.includes("repos add"));
  assert.deepEqual(
    gitea.state.statuses.map((s) => s.state),
    ["pending", "error"],
  );
  assert.equal(gitea.state.reviews.length, 0);
});
