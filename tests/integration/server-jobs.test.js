import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const TOKEN = "test-token-123";

/**
 * #38 contract: long reviews must be deliverable (async jobs + pickup) and
 * observable (bundle-free reads that skip the serial queue, results retained
 * for clients that disconnect mid-wait).
 */
async function withServer(t) {
  const repo = createTempGitRepo("pir-jobs-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-jobs-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-jobs-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  const handle = await startServer({ host: "127.0.0.1", port: 0, token: TOKEN, workspace: repo.dir, tls: null });
  t.after(() => {
    handle.close();
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });
  return { base: handle.url, repo, stateRoot };
}

async function buildReviewBody(repo, argv, extra = {}) {
  const { createBundle } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl, getHeadCommit } = await import("../../dist/changes/git.js");
  const head = await getHeadCommit(repo.dir);
  const [remoteUrl, rootCommit] = await Promise.all([getRemoteUrl(repo.dir), getRootCommit(repo.dir)]);
  const bundle = await createBundle(repo.dir, { base: null, head });
  return {
    remoteUrl,
    rootCommit,
    base: null,
    head,
    bundleBase64: bundle.toString("base64"),
    argv,
    ...extra,
  };
}

async function postReview(base, body) {
  return fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function getJob(base, jobId) {
  const response = await fetch(`${base}/v1/jobs/${jobId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).job;
}

async function waitForTerminal(base, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(base, jobId);
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms (status: ${job.status})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("jobs: GET /v1/jobs requires the bearer token", async (t) => {
  const { base } = await withServer(t);
  const unauthorized = await fetch(`${base}/v1/jobs`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(authorized.status, 200);
  assert.deepEqual((await authorized.json()).jobs, []);
});

test("jobs: sync /v1/review responses carry their jobId for later pickup", async (t) => {
  const { base, repo } = await withServer(t);
  const response = await postReview(base, await buildReviewBody(repo, ["memory", "status", "--json"]));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 0);
  assert.ok(payload.jobId, "sync responses must include jobId");
  const job = await getJob(base, payload.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.result.code, 0);
  assert.equal(job.result.output, payload.output);
});

test("jobs: async submit answers 202 immediately and the result is fetchable by id", async (t) => {
  const { base, repo } = await withServer(t);
  const body = await buildReviewBody(repo, ["memory", "status", "--json"], { async: true });
  const response = await postReview(base, body);
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.ok(accepted.jobId);
  assert.equal(accepted.status, "queued");

  const job = await waitForTerminal(base, accepted.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.result.code, 0);
  const envelope = JSON.parse(job.result.output);
  assert.equal(envelope.command, "memory.status");
  // Same server, same project db as the sync flow would have used.
  assert.ok(envelope.data.dbPath.startsWith(path.join(process.env.PIR_STATE_ROOT, envelope.data.projectId)));
});

test("jobs: a failed async job reports its error instead of vanishing", async (t) => {
  const { base, repo } = await withServer(t);
  // A head that looks like a commit id but is not in the bundle: the
  // materialization contract fails loudly.
  const body = await buildReviewBody(repo, ["memory", "status"]);
  body.head = "f".repeat(40);
  const response = await postReview(base, { ...body, async: true });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  const job = await waitForTerminal(base, jobId);
  assert.equal(job.status, "failed");
  assert.match(job.error, /bundle does not contain the claimed head/);
});

test("jobs: a sync needFull settles its job instead of leaving it running forever (dogfood F-29)", async (t) => {
  const { base, repo } = await withServer(t);
  // First contact + a thin (base-limited) bundle the server cannot apply:
  // the sync response is needFull, and the job behind it must settle — an
  // unsettled "running" record would never evict (registry growth) and would
  // lie about server activity in `pir jobs list`.
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("second");
  const { createBundle } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl, getHeadCommit } = await import("../../dist/changes/git.js");
  const head = await getHeadCommit(repo.dir);
  const baseCommit = (await import("node:child_process")).execSync("git rev-parse HEAD^", { cwd: repo.dir, encoding: "utf8" }).trim();
  const bundle = await createBundle(repo.dir, { base: baseCommit, head });
  const response = await postReview(base, {
    remoteUrl: await getRemoteUrl(repo.dir),
    rootCommit: await getRootCommit(repo.dir),
    base: baseCommit,
    head,
    bundleBase64: bundle.toString("base64"),
    argv: ["find", "--json"],
  });
  assert.equal((await response.json()).needFull, true);

  const listed = await (await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(listed.jobs.length, 1, "the needFull attempt is a job");
  const job = listed.jobs[0];
  assert.equal(job.status, "failed", "needFull attempts settle (never stuck at running)");
  assert.match(job.error, /^needFull:/);
  assert.notEqual(job.finishedAt, null);
});

test("jobs: the list endpoint is a summary projection; single-job views carry the payload (dogfood F-31)", async (t) => {
  const { base, repo } = await withServer(t);
  const body = await buildReviewBody(repo, ["memory", "status", "--json"], { async: true });
  const { jobId } = await (await postReview(base, body)).json();
  await waitForTerminal(base, jobId);

  const listed = await (await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(listed.jobs.length, 1);
  const summary = listed.jobs[0];
  // A listing must never ship every job's retained output/log (up to 100
  // settled jobs x 32 MB).
  assert.equal("result" in summary, false);
  assert.equal("log" in summary, false);
  assert.equal(summary.jobId, jobId);
  assert.equal(summary.status, "completed");
  assert.equal(typeof summary.logTotal, "number");

  const full = await getJob(base, jobId);
  assert.ok(Array.isArray(full.log));
  assert.equal(full.result.code, 0);
  assert.ok(full.result.output.length > 0);
});

test("jobs: async usage errors keep the code-2 + usage-text contract (dogfood F-32)", async (t) => {
  const { base, repo } = await withServer(t);
  // audit --base is a usage error; the async lane must surface it as a
  // COMPLETED job with code 2 and the usage text on the log channel —
  // exactly what the sync path relays — not a runtime failure.
  const body = await buildReviewBody(repo, ["audit", "--base", "HEAD^", "--json"]);
  const response = await postReview(base, { ...body, async: true });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  const job = await waitForTerminal(base, jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.result.code, 2);
  assert.ok(job.result.log.some((line) => line.includes("audit has no comparison base")));
  assert.ok(job.result.log.some((line) => line.includes("pir — pi-based code review")));

  // End to end: the remote client exits 2 (usage), not 3.
  const err = await execFileAsync(
    process.execPath,
    [path.resolve("dist/cli/cli.js"), "--server", base, "--token", TOKEN, "--insecure", "audit", "--base", "HEAD^", "--json", "--cwd", repo.dir],
    { env: { ...process.env, PIR_NO_WIZARD: "1" }, encoding: "utf8" },
  ).catch((failure) => failure);
  assert.equal(err.code, 2, "async usage errors must exit 2, not 3");
  assert.equal(err.stdout, "");
  assert.match(err.stderr, /audit has no comparison base/);
});

test("jobs: unknown job ids 404 with the restart explanation", async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(`${base}/v1/jobs/00000000-0000-0000-0000-000000000000`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /unknown job/);
});

test("review read lane: findings list skips the queue and the bundle on the fast path", async (t) => {
  const { base, repo } = await withServer(t);
  // First contact: no db yet -> needFull, the client would resend bundled.
  const firstBody = await buildReviewBody(repo, ["findings", "list", "--json"]);
  const first = await postReview(base, {
    remoteUrl: firstBody.remoteUrl,
    rootCommit: firstBody.rootCommit,
    head: firstBody.head,
    bundleBase64: "",
    argv: ["findings", "list", "--json"],
    noBundle: true,
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).needFull, true);

  // Bundled run creates the db (the queued materialize path, unchanged).
  const created = await postReview(base, firstBody);
  assert.equal((await created.json()).code, 0);

  // From now on the bundle-free read is served off the queue: an async
  // memory-status job holds the serial queue while findings list answers.
  for (let attempt = 0; attempt < 3; attempt++) {
    const jobBody = await buildReviewBody(repo, ["memory", "status", "--json"], { async: true });
    const jobResponse = await postReview(base, jobBody);
    const { jobId } = await jobResponse.json();

    const readStart = Date.now();
    const read = await postReview(base, {
      remoteUrl: firstBody.remoteUrl,
      rootCommit: firstBody.rootCommit,
      head: firstBody.head,
      bundleBase64: "",
      argv: ["findings", "list", "--json"],
      noBundle: true,
    });
    const readMs = Date.now() - readStart;
    const payload = await read.json();
    assert.equal(read.status, 200);
    assert.equal(payload.code, 0, "bundle-free read must be served");
    assert.equal(payload.needFull, undefined);
    const envelope = JSON.parse(payload.output);
    assert.equal(envelope.command, "findings.list");
    assert.deepEqual(envelope.data.findings, []);

    const job = await getJob(base, jobId);
    if (job.status !== "completed") {
      // The whole point of #38 fix (2): the read answered while the queued
      // job was still in flight, in well under the job's own runtime.
      assert.ok(readMs < 5000, `read took ${readMs}ms — it queued behind the job`);
      await waitForTerminal(base, jobId);
      return;
    }
    // The job beat the read on a fast machine: retry the race.
  }
  assert.fail("read never observed running concurrently with the queued job in 3 attempts");
});

test("review read lane: noBundle is refused for commands that need the worktree", async (t) => {
  const { base, repo } = await withServer(t);
  const body = await buildReviewBody(repo, ["memory", "status"]);
  const response = await postReview(base, {
    remoteUrl: body.remoteUrl,
    rootCommit: body.rootCommit,
    head: body.head,
    bundleBase64: "",
    argv: ["memory", "status"],
    noBundle: true,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /noBundle is only accepted for findings/);
});

test("jobs: a sync client that disconnects mid-wait leaves a fetchable result", async (t) => {
  const { base, repo } = await withServer(t);
  const body = await buildReviewBody(repo, ["memory", "status", "--json"]);
  const controller = new AbortController();
  const request = fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  // Abort the moment the server has REGISTERED the job: the body is fully
  // uploaded (the job is created after readBody) and the response provably
  // hasn't been sent (sync responses only go out after the job settles) —
  // the #32/#38 signature of a client that gave up waiting, without racing
  // a fixed timer against machine-speed task completion.
  const registered = Date.now() + 15000;
  for (;;) {
    const listed = await (await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    if (listed.jobs.length > 0 || Date.now() > registered) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await assert.rejects(request, (err) => err.name === "AbortError");

  const deadline = Date.now() + 15000;
  let job;
  for (;;) {
    const listed = await (await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    job = listed.jobs.find((candidate) => candidate.clientGone === true);
    if (job || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(job, "the disconnected request's job must appear in the registry");
  const settled = await waitForTerminal(base, job.jobId);
  assert.equal(settled.status, "completed");
  assert.equal(settled.clientGone, true);
  // The result the dead socket never received is still here.
  assert.equal(JSON.parse(settled.result.output).command, "memory.status");
});

test("CLI: PIR_REMOTE_ASYNC=1 submits via the job path and relays the result", async (t) => {
  const { base, repo } = await withServer(t);
  const env = { ...process.env, PIR_NO_WIZARD: "1", PIR_REMOTE_ASYNC: "1" };
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [CLI, "--server", base, "--token", TOKEN, "--insecure", "memory", "status", "--json", "--cwd", repo.dir],
    { env, encoding: "utf8" },
  );
  assert.match(stderr, /accepted as job/, "the client must announce the job id it will poll");
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.command, "memory.status");
  assert.equal(typeof envelope.data.projectId, "string");
});

test("CLI: pir jobs list shows the registry", async (t) => {
  const { base, repo } = await withServer(t);
  // One job to look at.
  const body = await buildReviewBody(repo, ["memory", "status", "--json"], { async: true });
  const { jobId } = await (await postReview(base, body)).json();
  await waitForTerminal(base, jobId);

  const env = { ...process.env, PIR_NO_WIZARD: "1" };
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI, "--server", base, "--token", TOKEN, "--insecure", "jobs", "list"],
    { env, encoding: "utf8" },
  );
  assert.match(stdout, /job +command +status/);
  assert.match(stdout, new RegExp(jobId.slice(0, 8)));
  assert.match(stdout, /completed/);

  // jobs status (json) carries the record.
  const { stdout: statusJson } = await execFileAsync(
    process.execPath,
    [CLI, "--server", base, "--token", TOKEN, "--insecure", "jobs", "status", "--json", jobId.slice(0, 8)],
    { env, encoding: "utf8" },
  );
  const status = JSON.parse(statusJson);
  assert.equal(status.command, "jobs.status");
  assert.equal(status.data.job.jobId, jobId);

  // jobs fetch relays the retained output.
  const { stdout: fetched } = await execFileAsync(
    process.execPath,
    [CLI, "--server", base, "--token", TOKEN, "--insecure", "jobs", "fetch", jobId.slice(0, 8)],
    { env, encoding: "utf8" },
  );
  assert.equal(JSON.parse(fetched).command, "memory.status");

  // Local mode without a server is a usage error, not a crash. Isolate the
  // config dir: a developer machine may carry ~/.pir/config.json in remote
  // mode, which would turn this into a real request.
  const configDir = mkdtempSync(path.join(tmpdir(), "pir-jobs-config-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "jobs", "list"], {
      env: { ...env, PIR_CONFIG_DIR: configDir, PIR_MODE: "local" },
      encoding: "utf8",
    }),
    (err) => err.code === 2 && /needs a remote server/.test(err.stderr),
  );
});
