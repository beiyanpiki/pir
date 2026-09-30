import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, existsSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { startServer } from "../../dist/server/server.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/cli/cli.js");
const TOKEN = "test-token-123";

async function makeCerts(dir) {
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=pir-test",
    "-keyout", path.join(dir, "key.pem"),
    "-out", path.join(dir, "cert.pem"),
  ]);
  return { cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };
}

async function withServer(t, fn) {
  const repo = createTempGitRepo("pir-server-");
  const certDir = mkdtempSync(path.join(tmpdir(), "pir-certs-"));
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed test certs
  const certs = await makeCerts(certDir);
  const { readFileSync } = await import("node:fs");
  const handle = await startServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspace: repo.dir,
    tls: { cert: readFileSync(certs.cert, "utf8"), key: readFileSync(certs.key, "utf8") },
  });
  const port = handle.url.split(":").pop();
  const base = `https://127.0.0.1:${port}`;
  t.after(() => {
    handle.close();
    rmSync(certDir, { recursive: true, force: true });
    repo.cleanup();
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  });
  return { base, repo };
}

test("server: health endpoint and bearer auth on exec", async (t) => {
  const { base } = await withServer(t);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.tls, true);

  const unauthorized = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv: ["version"] }),
  });
  assert.equal(unauthorized.status, 401);
});

test("server: /v1/exec runs commands through the shared executor", async (t) => {
  const { base } = await withServer(t);

  const response = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["version", "--json"] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.command, "version");
  assert.match(envelope.data.version, /^\d+\.\d+\.\d+$/);
});

test("server: cwd guard rejects escapes and injects the workspace default", async (t) => {
  const { base, repo } = await withServer(t);

  // No --cwd: operates on the workspace root.
  const okResponse = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status"] }),
  });
  const ok = await okResponse.json();
  assert.equal(ok.code, 0);

  // Escape attempt: rejected with usage error semantics (code 2).
  const bad = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status", "--cwd", "/etc"] }),
  });
  const badBody = await bad.json();
  assert.equal(badBody.code, 2);
  assert.ok(badBody.log.some((l) => l.includes("--cwd must stay under")));

  // State stays inside the project (.pir/) in project-state mode.
  process.env.PIR_STATE_IN_PROJECT = "1";
  const projResponse = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv: ["memory", "status"] }),
  });
  await projResponse.json();
  assert.ok(existsSync(path.join(repo.dir, ".pir", "memory.sqlite")));
  delete process.env.PIR_STATE_IN_PROJECT;
});

test("remote CLI: pir --server relays argv, output and exit code", async (t) => {
  const { base, repo } = await withServer(t);
  const env = { ...process.env, PIR_NO_WIZARD: "1" };

  // version/config/skill are client-side; memory status relays through /v1/exec.
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI, "--server", base, "--token", TOKEN, "--insecure", "memory", "status", "--json", "--cwd", repo.dir],
    { env, encoding: "utf8" },
  );
  assert.equal(JSON.parse(stdout).command, "memory.status");

  // Wrong token -> exit 3 with a clear message.
  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI, "--server", base, "--token", "wrong", "--insecure", "memory", "status", "--cwd", repo.dir,
    ], { env, encoding: "utf8" }),
    (err) => err.code === 3,
  );
});

test("/v1/review rejects non-review commands before touching any bundle", async (t) => {
  const { base } = await withServer(t);
  // Registry management and client-side commands belong to /v1/exec (or the
  // local CLI); a valid token must not reach them through the review path.
  const forbidden = [
    ["repos", "add", "https://attacker.example/x.git"],
    ["repos", "remove", "x", "--purge"],
    ["models"],
    ["config", "set", "mode", "remote"],
    ["skill", "install"],
    ["serve"],
  ];
  for (const argv of forbidden) {
    const response = await fetch(`${base}/v1/review`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        remoteUrl: null,
        rootCommit: "0".repeat(40),
        base: null,
        head: "0".repeat(40),
        bundleBase64: "",
        argv,
      }),
    });
    assert.equal(response.status, 400, `expected rejection for: ${argv.join(" ")}`);
    const body = await response.json();
    assert.match(body.error, /not allowed on \/v1\/review/);
  }
});

test("/v1/review rejects an argv that is not an array of strings", async (t) => {
  const { base } = await withServer(t);
  // /v1/exec has always validated this; /v1/review must not let a number or
  // a bare string reach parseArgs as a TypeError-shaped 400.
  for (const argv of [[123], [null], "find", { 0: "find" }]) {
    const response = await fetch(`${base}/v1/review`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        remoteUrl: null,
        rootCommit: "0".repeat(40),
        base: null,
        head: "0".repeat(40),
        bundleBase64: "",
        argv,
      }),
    });
    assert.equal(response.status, 400, `expected rejection for: ${JSON.stringify(argv)}`);
    const body = await response.json();
    assert.match(body.error, /argv must be an array of strings/);
  }
});

test("/v1/review: client-pinned SHAs resolve in the bundle-materialized worktree", async (t) => {
  await withServer(t); // server handle only pins env cleanup (TLS off for tests)
  const repo = createTempGitRepo("pir-pin-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-pin-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-pin-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  repo.write("src/a.ts", "export const a = 1;\n");
  const baseCommit = repo.commit("base change");
  repo.write("src/b.ts", "export const b = 2;\n");
  const headCommit = repo.commit("head change");

  const { createBundle, materializeFromBundle } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const { buildChangeSet } = await import("../../dist/changes/change-set.js");
  const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);

  // What the client ships after pinRefsToShas: named refs replaced by SHAs.
  // First contact carries a full bundle (the thin-bundle retry needs a
  // pre-seeded server repo, exercised elsewhere).
  const bundle = await createBundle(repo.dir, { base: null, head: headCommit });
  const { review } = await materializeFromBundle(bundle, {
    remoteUrl,
    rootCommit,
    base: null,
    head: headCommit,
  });
  try {
    const changeSet = await buildChangeSet(review.worktree, baseCommit, headCommit);
    assert.ok(changeSet.files.some((f) => f.path === "src/b.ts"));
    assert.ok(!changeSet.files.some((f) => f.path === "src/a.ts"));
    // The materialized repo has no remote-tracking refs — exactly why the
    // client must pin named refs to SHAs before forwarding.
    await assert.rejects(buildChangeSet(review.worktree, "origin/main", headCommit));
  } finally {
    await review.cleanup();
  }
});

test("materializeFromBundle rebuilds a corrupt bundle-cache repo from a full bundle", async (t) => {
  const repo = createTempGitRepo("pir-heal-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-heal-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-heal-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("base change");
  repo.write("src/b.ts", "export const b = 2;\n");
  const headCommit = repo.commit("head change");

  const { createBundle, materializeFromBundle, projectIdFor } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
  const meta = { remoteUrl, rootCommit, base: null, head: headCommit };
  const bundle = await createBundle(repo.dir, { base: null, head: headCommit });

  // First contact populates the per-project bundle cache.
  const first = await materializeFromBundle(bundle, meta);
  await first.review.cleanup();

  // The incident failure mode: an interrupted gc/repack across a container
  // redeploy leaves packfiles that no longer match their index — refs survive
  // while their objects are unreadable, so every subsequent fetch fails.
  const cacheDir = path.join(reposRoot, projectIdFor(remoteUrl, rootCommit));
  for (const pack of readdirSync(path.join(cacheDir, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"))) {
    const packPath = path.join(cacheDir, ".git", "objects", "pack", pack);
    chmodSync(packPath, 0o644);
    truncateSync(packPath, 100);
  }

  const healed = await materializeFromBundle(bundle, meta);
  try {
    assert.equal(healed.review.headCommit, headCommit);
    assert.ok(existsSync(path.join(cacheDir, ".git", "objects")), "cache repo was rebuilt, not left headless");
  } finally {
    await healed.review.cleanup();
  }
});

test("materializeFromBundle never wipes a project dir that backs a registered repo", async (t) => {
  const repo = createTempGitRepo("pir-keepreg-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-keepreg-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-keepreg-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("base change");
  repo.write("src/b.ts", "export const b = 2;\n");
  const headCommit = repo.commit("head change");

  const { createBundle, materializeFromBundle, projectIdFor } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
  const meta = { remoteUrl, rootCommit, base: null, head: headCommit };
  const bundle = await createBundle(repo.dir, { base: null, head: headCommit });

  const first = await materializeFromBundle(bundle, meta);
  await first.review.cleanup();

  const projectId = projectIdFor(remoteUrl, rootCommit);
  // Same projectId as the bundle cache: the registered clone must win.
  writeFileSync(
    path.join(reposRoot, "repos.json"),
    JSON.stringify({ demo: { name: "demo", url: remoteUrl, projectId, addedAt: Date.now() } }),
  );
  const cacheDir = path.join(reposRoot, projectId);
  const packsBefore = readdirSync(path.join(cacheDir, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"));
  for (const pack of packsBefore) {
    chmodSync(path.join(cacheDir, ".git", "objects", "pack", pack), 0o644);
    truncateSync(path.join(cacheDir, ".git", "objects", "pack", pack), 100);
  }

  await assert.rejects(materializeFromBundle(bundle, meta));
  assert.ok(existsSync(cacheDir), "registered project dir must survive a failed full-bundle fetch");
  const packsAfter = readdirSync(path.join(cacheDir, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"));
  assert.deepEqual(packsAfter, packsBefore, "and it must not be silently rebuilt either");
});

test("/v1/review tolerates older clients that forward raw refs (head + argv)", async (t) => {
  const { base } = await withServer(t);
  const repo = createTempGitRepo("pir-oldclient-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-oldc-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-oldc-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  repo.write("src/a.ts", "export const a = 1;\n");
  const baseCommit = repo.commit("base change");
  repo.write("src/b.ts", "export const b = 2;\n");
  const headCommit = repo.commit("head change");

  const { createBundle } = await import("../../dist/app/repos.js");
  const { getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [rootCommit, remoteUrl] = await Promise.all([getRootCommit(repo.dir), getRemoteUrl(repo.dir)]);
  // What a pre-fix client ships: meta.head and the argv keep raw refs; only
  // the bundle (packed under refs/pir/bundle-head) knows the real commit.
  const bundle = await createBundle(repo.dir, { base: null, head: headCommit });

  const response = await fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      remoteUrl,
      rootCommit,
      base: baseCommit,
      head: "origin/feat/page-optimize",
      bundleBase64: bundle.toString("base64"),
      argv: ["memory", "status", "--json", "--base", "origin/feat/page-optimize", "--head", "HEAD"],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 0, JSON.stringify(payload));
  const data = JSON.parse(payload.output).data;
  // The materialized head fell back to the commit the client actually packed…
  assert.equal(data.headCommit, headCommit);
  // …and memory keyed under the project's sha directory.
  assert.match(data.dbPath, new RegExp(`^${stateRoot}/[0-9a-f]{64}/memory\\.sqlite$`));
});

test("/v1/review strips the --cwd=path form too", async (t) => {
  const { base } = await withServer(t);
  const repo = createTempGitRepo("pir-cwdscrub-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-cwdscrub-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-cwdscrub-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  });

  const { createBundle } = await import("../../dist/app/repos.js");
  const { getHeadCommit, getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [head, rootCommit, remoteUrl] = await Promise.all([
    getHeadCommit(repo.dir),
    getRootCommit(repo.dir),
    getRemoteUrl(repo.dir),
  ]);
  const bundle = await createBundle(repo.dir, { base: null, head });

  const response = await fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      remoteUrl,
      rootCommit,
      base: null,
      head,
      bundleBase64: bundle.toString("base64"),
      // A --cwd pointing outside the worktree must be ignored, not honored
      // (and not reject the request via the cwdGuard).
      argv: ["memory", "status", "--json", "--cwd=/etc"],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 0, JSON.stringify(payload));
  assert.equal(JSON.parse(payload.output).data.headCommit, head);
});

test("/v1/review materializes a client bundle into a worktree (unpushed code path)", async (t) => {
  const { base } = await withServer(t);
  const repo = createTempGitRepo("pir-bundle-src-");
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-bundle-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-bundle-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  // Simulate an unpushed commit: it only ever exists in the client repo.
  repo.write("src/unpushed.ts", "export const neverPushed = true;\n");
  repo.commit("unpushed work");
  const { createBundle } = await import("../../dist/app/repos.js");
  const { getHeadCommit, getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [head, rootCommit, remoteUrl] = await Promise.all([
    getHeadCommit(repo.dir),
    getRootCommit(repo.dir),
    getRemoteUrl(repo.dir),
  ]);
  const bundle = await createBundle(repo.dir, { base: null, head });

  const response = await fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      remoteUrl,
      rootCommit,
      base: null,
      head,
      bundleBase64: bundle.toString("base64"),
      argv: ["memory", "status", "--json"],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 0);
  const envelopeBody = JSON.parse(payload.output);
  // The materialized worktree saw the unpushed commit...
  assert.equal(envelopeBody.data.headCommit, head);
  // ...and memory landed in the centralized state root for this project.
  assert.match(envelopeBody.data.dbPath, new RegExp(`^${stateRoot}/[0-9a-f]{64}/memory\\.sqlite$`));
  assert.ok(existsSync(envelopeBody.data.dbPath));
  repo.cleanup();
});

// ---------------------------------------------------------------------------
// Executor scheduling lanes (issue #31): a long review must not hang light
// commands; /health makes the queue visible.
// ---------------------------------------------------------------------------

async function postExec(base, argv) {
  const response = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ argv }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

test("/health reports executor queue stats (issue #31)", async (t) => {
  const { base } = await withServer(t);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  // Nothing in flight: the queue is observable and empty.
  assert.deepEqual(health.executor, { pending: 0, oldestPendingMs: 0 });
});

test("light commands answer while a /v1/review holds the queue (issue #31)", async (t) => {
  const { base } = await withServer(t);
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-lane-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-lane-state-"));
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  t.after(() => {
    delete process.env.PIR_REPOS_ROOT;
    delete process.env.PIR_STATE_ROOT;
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  // First contact: the workspace has no memory db yet, so memory status
  // takes the queued lane, creates the db, and reports it.
  const first = await postExec(base, ["memory", "status", "--json"]);
  assert.equal(first.code, 0, JSON.stringify(first));
  const firstStatus = JSON.parse(first.output).data;
  assert.ok(existsSync(firstStatus.dbPath), "first memory status creates the workspace db");

  // A review with real git work: 80 commits of distinct content, so
  // materialize + status + worktree cleanup hold the queue for a while.
  const reviewRepo = createTempGitRepo("pir-lane-review-");
  for (let i = 0; i < 80; i++) {
    reviewRepo.write(`src/mod${i}.ts`, `// module ${i}\n` + `export const v${i} = ${i};\n`.repeat(30));
    reviewRepo.commit(`commit ${i}`);
  }
  const { createBundle } = await import("../../dist/app/repos.js");
  const { getHeadCommit, getRootCommit, getRemoteUrl } = await import("../../dist/changes/git.js");
  const [head, rootCommit, remoteUrl] = await Promise.all([
    getHeadCommit(reviewRepo.dir),
    getRootCommit(reviewRepo.dir),
    getRemoteUrl(reviewRepo.dir),
  ]);
  const bundle = await createBundle(reviewRepo.dir, { base: null, head });
  const postReview = () =>
    fetch(`${base}/v1/review`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        remoteUrl,
        rootCommit,
        base: null,
        head,
        bundleBase64: bundle.toString("base64"),
        argv: ["memory", "status", "--json"],
      }),
    }).then((response) => response.json());

  // Two back-to-back reviews keep the queue busy long enough to observe.
  // The no-op catch keeps an early assertion failure from also producing an
  // unhandled rejection when the server closes under the in-flight reviews.
  const reviews = Promise.all([postReview(), postReview()]);
  reviews.catch(() => {});

  // Wait until a review actually occupies the queue — /health sees it.
  const deadline = Date.now() + 15_000;
  let occupied = false;
  while (Date.now() < deadline) {
    const health = await (await fetch(`${base}/health`)).json();
    if (health.executor.pending >= 1) {
      occupied = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(occupied, "the review should occupy the executor queue (health.executor.pending)");

  // The commands from the issue: all of them answer while the reviews are
  // still holding the queue...
  const fast = await Promise.all([
    postExec(base, ["version", "--json"]),
    postExec(base, ["repos", "list"]),
    postExec(base, ["memory", "status", "--json"]),
    postExec(base, ["findings", "list", "--json"]),
  ]);

  // ...and the queue is still busy afterwards — proof the fast commands
  // did not wait behind the reviews.
  const healthAfter = await (await fetch(`${base}/health`)).json();
  assert.ok(
    healthAfter.executor.pending >= 1,
    "reviews must still be in the queue after the light commands answered",
  );
  for (const result of fast) {
    assert.equal(result.code, 0, JSON.stringify(result));
  }

  // The off-queue memory status read the same db the first (queued) one created.
  const fastStatus = JSON.parse(fast[2].output).data;
  assert.equal(fastStatus.projectId, firstStatus.projectId);
  assert.equal(fastStatus.dbPath, firstStatus.dbPath);

  const payloads = await reviews;
  for (const payload of payloads) {
    assert.equal(payload.code, 0, JSON.stringify(payload));
  }
  reviewRepo.cleanup();
});
