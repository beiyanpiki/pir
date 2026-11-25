import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../dist/server/server.js";
import { addRepo, createBundle, removeRepo, resolveRepo } from "../../dist/app/repos.js";
import { executePirCommand } from "../../dist/cli/executor.js";
import { getHeadCommit, getRemoteUrl, getRootCommit } from "../../dist/changes/git.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForJob(url, jobId) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const { job } = await (await fetch(`${url}/v1/jobs/${jobId}`)).json();
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() >= deadline) throw new Error(`job ${jobId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Park real HTTP reviews inside a scripted reviewer, after a pinned tool read. */
function sessionFactory() {
  const gates = new Map();
  const reads = new Map();
  let released = false;
  const gateFor = (head) => {
    if (!gates.has(head)) gates.set(head, { entered: deferred(), release: deferred() });
    return gates.get(head);
  };
  return {
    reads,
    waitFor: (head) => gateFor(head).entered.promise,
    release: (head) => gateFor(head).release.resolve(),
    releaseAll() {
      released = true;
      for (const gate of gates.values()) gate.release.resolve();
    },
    async createSession(config) {
      return {
        async prompt() {
          const tool = (name) => {
            const found = config.tools.find((entry) => entry.name === name);
            assert.ok(found, `scripted session exposes ${name}`);
            return found;
          };
          assert.equal(config.systemRole, "code reviewer");
          const head = await getHeadCommit(config.cwd);
          const read = await tool("read_code").execute({ path: "src/value.ts", startLine: 1, endLine: 10 });
          reads.set(head, { text: read.text, cwd: config.cwd });
          const gate = gateFor(head);
          gate.entered.resolve();
          if (!released) await gate.release.promise;
          await tool("finish_round").execute({ summary: "Read the pinned value", nextFocus: [], needsMoreRounds: false });
          if (config.transcriptFile) {
            mkdirSync(path.dirname(config.transcriptFile), { recursive: true });
            writeFileSync(config.transcriptFile, JSON.stringify({
              role: config.systemRole, messages: [{ role: "assistant", content: [{ type: "text", text: read.text }] }],
            }));
          }
        },
        getLastAssistantText: () => "",
        getLastAssistantError: () => undefined,
        dispose() {},
      };
    },
  };
}

async function sandbox(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pir-http-concurrency-"));
  const env = {
    PIR_REPOS_ROOT: path.join(root, "repos"),
    PIR_STATE_ROOT: path.join(root, "state"),
    PIR_CONFIG_DIR: path.join(root, "config"),
    PIR_CODEGRAPH: "0",
    PIR_MODEL: "test/no-network",
    PIR_TRANSCRIPTS: "1",
    PIR_MEMORY_DB: undefined,
    PIR_STATE_IN_PROJECT: undefined,
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const repo = createTempGitRepo("pir-http-concurrency-origin-");
  repo.write("src/value.ts", 'export const value = "base";\n');
  const base = repo.commit("base");
  repo.write("src/value.ts", 'export const value = "one";\n');
  const head = repo.commit("first change");
  const factory = sessionFactory();
  const requests = new Set();
  const jobIds = new Set();
  let handle;
  t.after(async () => {
    factory.releaseAll();
    await Promise.allSettled([...requests]);
    for (const jobId of jobIds) await waitForJob(handle.url, jobId);
    handle?.close();
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  handle = await startServer({
    host: "127.0.0.1", port: 0, tls: null, workspace: repo.dir,
    sessionFactory: factory, ...options,
  });
  const post = (endpoint, body) => {
    const request = fetch(`${handle.url}${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    requests.add(request);
    void request.then(({ status, body: result }) => {
      if (status === 202 && result.jobId) jobIds.add(result.jobId);
      requests.delete(request);
    }, () => requests.delete(request));
    return request;
  };
  const reviewBody = async (target = head, argv = ["find", "--json", "--base", base, "--head", target, "--max-rounds", "1"]) => ({
    remoteUrl: await getRemoteUrl(repo.dir),
    rootCommit: await getRootCommit(repo.dir),
    base,
    head: target,
    bundleBase64: (await createBundle(repo.dir, { base: null, head: target })).toString("base64"),
    argv,
  });
  return { root, repo, base, head, factory, post, reviewBody, url: handle.url };
}

test("server execution seam drives a real bundled review with a scripted reviewer", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t);
  const request = fixture.post("/v1/review", await fixture.reviewBody());
  await fixture.factory.waitFor(fixture.head);
  const read = fixture.factory.reads.get(fixture.head);
  assert.match(read.text, /"one"/);
  assert.notEqual(read.cwd, fixture.repo.dir);
  assert.ok(read.cwd.startsWith(path.join(fixture.root, "repos", "work")));
  fixture.factory.release(fixture.head);
  const { status, body } = await request;
  assert.equal(status, 200);
  assert.equal(body.code, 0, JSON.stringify(body));
  const result = JSON.parse(body.output);
  assert.equal(result.data.run.head, fixture.head);
  assert.ok(result.data.run.id);
  assert.equal(readFileSync(path.join(fixture.repo.dir, "src/value.ts"), "utf8"), 'export const value = "one";\n');
});

test("a server-resolved registry snapshot survives alias removal without changing its execution target", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t);
  const registered = await addRepo(fixture.repo.dir, "original");
  const target = resolveRepo("original");
  await removeRepo("original", false);
  fixture.factory.releaseAll();
  const result = await executePirCommand([
    "find", "--repo", "original", "--json", "--base", fixture.base, "--head", fixture.head, "--max-rounds", "1",
  ], { registeredRepo: target, factory: fixture.factory });
  assert.equal(result.code, 0, result.output);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.project.id, registered.projectId);
  assert.equal(envelope.data.run.head, fixture.head);
  assert.deepEqual(readdirSync(path.join(fixture.root, "repos", "work")), []);
});

test("registered execution cleans its worktree when database initialization fails", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t);
  await addRepo(fixture.repo.dir, "original");
  const badDb = path.join(fixture.root, "not-a-database.sqlite");
  writeFileSync(badDb, "this is not a SQLite database");
  await assert.rejects(executePirCommand([
    "find", "--repo", "original", "--base", fixture.base, "--head", fixture.head,
  ], { dbPath: badDb, factory: fixture.factory }), /not a database/);
  assert.deepEqual(readdirSync(path.join(fixture.root, "repos", "work")), []);
});

test("bundle find and audit of one project overlap with isolated heads, runs, and transcripts", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t, { reviewConcurrency: 2, projectReviewConcurrency: 2 });
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  const first = fixture.post("/v1/review", await fixture.reviewBody(fixture.head));
  const second = fixture.post("/v1/review", await fixture.reviewBody(head2, ["audit", "--json"]));
  await Promise.all([fixture.factory.waitFor(fixture.head), fixture.factory.waitFor(head2)]);
  const firstRead = fixture.factory.reads.get(fixture.head);
  const secondRead = fixture.factory.reads.get(head2);
  assert.match(firstRead.text, /"one"/);
  assert.doesNotMatch(firstRead.text, /"two"/);
  assert.match(secondRead.text, /"two"/);
  assert.notEqual(firstRead.cwd, secondRead.cwd);
  fixture.factory.releaseAll();
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.body.code, 0, JSON.stringify(result));
  const envelopes = results.map((result) => JSON.parse(result.body.output));
  assert.equal(envelopes[0].project.id, envelopes[1].project.id);
  assert.notEqual(envelopes[0].data.run.id, envelopes[1].data.run.id);
  const transcripts = envelopes.map(({ data }) => readdirSync(data.run.transcriptDir)
    .filter((file) => file !== "run.json")
    .map((file) => readFileSync(path.join(data.run.transcriptDir, file), "utf8")).join("\n"));
  assert.match(transcripts[0], /one/);
  assert.doesNotMatch(transcripts[0], /two/);
  assert.match(transcripts[1], /two/);
  assert.deepEqual(readdirSync(path.join(fixture.root, "repos", "work")), []);
});

test("registered reviews of different heads share project capacity rather than a global serial queue", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t, { reviewConcurrency: 2, projectReviewConcurrency: 2 });
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  await addRepo(fixture.repo.dir, "original");
  const argv = (head) => [
    "find", "--repo", "original", "--branch", head, "--base", fixture.base, "--head", head, "--json", "--max-rounds", "1",
  ];
  const first = fixture.post("/v1/exec", { argv: argv(fixture.head) });
  const second = fixture.post("/v1/exec", { argv: argv(head2) });
  await Promise.all([fixture.factory.waitFor(fixture.head), fixture.factory.waitFor(head2)]);
  assert.match(fixture.factory.reads.get(fixture.head).text, /"one"/);
  assert.match(fixture.factory.reads.get(head2).text, /"two"/);
  fixture.factory.releaseAll();
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.body.code, 0, JSON.stringify(result));
  const envelopes = results.map((result) => JSON.parse(result.body.output));
  assert.equal(envelopes[0].project.id, envelopes[1].project.id);
  assert.notEqual(envelopes[0].data.run.id, envelopes[1].data.run.id);
});

test("bundle ingress refuses a registered-repo override before creating a job", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t);
  for (const repoFlag of [["--repo", "other"], ["--repo=other"]]) {
    const response = await fixture.post("/v1/review", await fixture.reviewBody(fixture.head, ["find", ...repoFlag]));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /--repo.*not accepted.*\/v1\/exec/);
  }
  assert.deepEqual((await (await fetch(`${fixture.url}/v1/jobs`)).json()).jobs, []);
});

test("default server admission still queues a second review until the first settles", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t);
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  const first = fixture.post("/v1/review", await fixture.reviewBody(fixture.head));
  await fixture.factory.waitFor(fixture.head);
  const accepted = await fixture.post("/v1/review", { ...await fixture.reviewBody(head2), async: true });
  assert.equal(accepted.status, 202);
  const { job } = await (await fetch(`${fixture.url}/v1/jobs/${accepted.body.jobId}`)).json();
  assert.equal(job.status, "queued");
  const { executor } = await (await fetch(`${fixture.url}/health`)).json();
  assert.equal(executor.pending, 2);
  fixture.factory.release(fixture.head);
  await fixture.factory.waitFor(head2);
  fixture.factory.releaseAll();
  assert.equal((await first).body.code, 0);
});
