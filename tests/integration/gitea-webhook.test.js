import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

/** Origin repo with a 3-function base and a PR head inserting beta2 at line 3. */
function originFixture() {
  const origin = createTempGitRepo("pir-gitea-origin-");
  origin.write("src/app.ts", "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction gamma() { return 3; }\n");
  const baseSha = origin.commit("base");
  origin.write(
    "src/app.ts",
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\n",
  );
  const headSha = origin.commit("pr work");
  git(origin.dir, ["update-ref", "refs/pull/1/head", headSha]);
  return { origin, baseSha, headSha };
}

/** One more commit on the PR: appends delta() as line 5. */
function pushNewHead(fixture) {
  fixture.origin.write(
    "src/app.ts",
    "function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction beta2() { return 22; }\nfunction gamma() { return 3; }\nfunction delta() { return 4; }\n",
  );
  const head = fixture.origin.commit("pr work 2");
  git(fixture.origin.dir, ["update-ref", "refs/pull/1/head", head]);
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
    const pathname = new URL(String(url)).pathname;

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
      return jsonResponse(state.comments);
    }
    if (match && method === "POST") {
      const comment = { id: state.nextCommentId++, body: JSON.parse(init.body).body };
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
      const review = { id: state.nextReviewId++, ...JSON.parse(init.body) };
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

function sandboxEnv(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-gitea-test-"));
  process.env.PIR_REPOS_ROOT = path.join(root, "repos");
  process.env.PIR_STATE_ROOT = path.join(root, "state");
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
  });
  return root;
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

async function withGiteaServer(t, { config = defaultConfig(), runner, fetchHooks } = {}) {
  const root = sandboxEnv(t);
  const configDir = path.join(root, "config");
  const gitea = fakeGitea(fetchHooks);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace: path.join(root, "workspace"),
    tls: null,
    gitea: { config, configDir, fetchImpl: gitea.impl, ...(runner ? { runner } : {}) },
  });
  const port = handle.url.split(":").pop();
  t.after(() => handle.close());
  assert.equal(handle.giteaEnabled, GITEA_BASE);
  return { base: `http://127.0.0.1:${port}`, configDir, gitea, root };
}

async function withBareServer(t) {
  const root = sandboxEnv(t);
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace: path.join(root, "workspace"),
    tls: null,
  });
  const port = handle.url.split(":").pop();
  t.after(() => handle.close());
  assert.equal(handle.giteaEnabled, undefined);
  return `http://127.0.0.1:${port}`;
}

function prPayload(overrides = {}) {
  return {
    action: overrides.action ?? "opened",
    number: 1,
    pull_request: {
      title: overrides.title ?? "Add feature",
      body: null,
      ...(overrides.draft !== undefined ? { draft: overrides.draft } : {}),
      base: { ref: overrides.baseRef ?? "main", sha: overrides.baseSha },
      head: { ref: "feat/thing", sha: overrides.headSha },
      html_url: `${GITEA_BASE}/${REPO_FULL_NAME}/pulls/1`,
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
  const { base, gitea } = await withGiteaServer(t, { runner, fetchHooks: { onFirstCommentsList: hold } });
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
