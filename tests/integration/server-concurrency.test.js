import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../dist/server/server.js";
import { addRepo, createBundle, projectIdFor, removeRepo, resolveRepo } from "../../dist/app/repos.js";
import { executePirCommand } from "../../dist/cli/executor.js";
import { getHeadCommit, getRemoteUrl, getRootCommit } from "../../dist/changes/git.js";
import { emptySnapshot } from "../../dist/memory/sync.js";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";
import { onRunEvent } from "../../dist/observability/run-events.js";
import { createTempGitRepo, git, submitVerdictWithEvidence } from "../fixtures/helpers.js";

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
function sessionFactory({ findings = false } = {}) {
  const gates = new Map();
  const reads = new Map();
  const failures = new Set();
  let released = false;
  const gateFor = (head) => {
    if (!gates.has(head)) gates.set(head, { entered: deferred(), release: deferred() });
    return gates.get(head);
  };
  return {
    reads,
    waitFor: (head) => gateFor(head).entered.promise,
    release: (head) => gateFor(head).release.resolve(),
    fail: (head) => failures.add(head),
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
          const head = await getHeadCommit(config.cwd);
          const read = await tool("read_code").execute({ path: "src/value.ts", startLine: 1, endLine: 10 });
          if (config.systemRole === "finding verifier") {
            await submitVerdictWithEvidence(tool, {
              verdict: "confirmed", rationale: "The pinned value demonstrates this scripted regression", confidence: 0.9,
            }, "src/value.ts");
          } else {
            assert.equal(config.systemRole, "code reviewer");
            reads.set(head, { text: read.text, cwd: config.cwd });
            const gate = gateFor(head);
            gate.entered.resolve();
            if (!released) await gate.release.promise;
            if (failures.has(head)) throw new Error("scripted reviewer failure");
            if (findings) {
              await tool("record_candidate").execute({
                title: `Value regression at ${head.slice(0, 8)}`,
                claim: `The changed exported value breaks its consumer contract at revision ${head}`,
                trigger: `reading the changed value at revision ${head}`,
                category: "correctness", severity: "P2", featureKey: "value", entityKey: "value",
                anchors: [{ path: "src/value.ts", startLine: 1 }],
                evidence: [{ kind: "code", path: "src/value.ts", startLine: 1, excerpt: readFileSync(path.join(config.cwd, "src/value.ts"), "utf8").trim() }],
              });
            }
            await tool("finish_round").execute({ summary: "Read the pinned value", nextFocus: [], needsMoreRounds: false });
          }
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

async function sandbox(t, options = {}, factoryOptions = {}) {
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
  const factory = sessionFactory(factoryOptions);
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
  const fixture = await sandbox(t, { reviewConcurrency: 2, projectReviewConcurrency: 2 }, { findings: true });
  git(fixture.repo.dir, ["remote", "add", "origin", "https://example.invalid/shared-project.git"]);
  const events = [];
  t.after(onRunEvent((event) => events.push(event)));
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  // Legacy non-SHA metadata forces each materialization to resolve its own imported bundle ref; first-contact origin initialization is shared too.
  const first = fixture.post("/v1/review", { ...await fixture.reviewBody(fixture.head), head: "HEAD" });
  const second = fixture.post("/v1/review", { ...await fixture.reviewBody(head2, ["audit", "--json"]), head: "HEAD" });
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
  const findings = envelopes.map(({ data }) => {
    assert.equal(data.findings.length, 1);
    assert.equal(data.findings[0].status, "confirmed");
    return data.findings[0];
  });
  assert.notEqual(findings[0].id, findings[1].id);
  assert.notEqual(findings[0].displayId, findings[1].displayId);
  const store = SqliteStore.open(path.join(fixture.root, "state", envelopes[0].project.id, "memory.sqlite"), { readOnly: true });
  try {
    for (let index = 0; index < envelopes.length; index++) {
      const id = envelopes[index].data.run.id;
      assert.deepEqual(store.all("SELECT id FROM findings WHERE run_id = ?", id).map((row) => row.id), [findings[index].id]);
      assert.ok(store.all("SELECT id FROM finding_evidence WHERE finding_id = ?", findings[index].id).length > 0);
      const ownEvents = events.filter((event) => event.runId === id);
      assert.equal(ownEvents[0].kind, "run-start");
      assert.equal(ownEvents[0].head, index === 0 ? fixture.head : head2);
      assert.equal(ownEvents.at(-1).kind, "run-end");
      assert.ok(ownEvents.some((event) => event.kind === "session-start" && event.sessionKind === "verifier"));
      assert.ok(ownEvents.every((event, at) => at === 0 || event.seq > ownEvents[at - 1].seq));
    }
    assert.deepEqual(store.all("SELECT DISTINCT run_id FROM audit_file_coverage").map((row) => row.run_id), [envelopes[1].data.run.id]);
  } finally {
    store.close();
  }
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

test("a project at its review limit does not block a different project's bundled review", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t, { reviewConcurrency: 2, projectReviewConcurrency: 1 });
  git(fixture.repo.dir, ["remote", "add", "origin", "https://example.invalid/first.git"]);
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  const other = createTempGitRepo("pir-http-other-project-");
  t.after(() => other.cleanup());
  git(other.dir, ["remote", "add", "origin", "https://example.invalid/other.git"]);
  other.write("src/value.ts", 'export const value = "other-base";\n');
  const otherBase = other.commit("other base");
  other.write("src/value.ts", 'export const value = "other-project";\n');
  const otherHead = other.commit("other head");
  const first = fixture.post("/v1/review", await fixture.reviewBody());
  await fixture.factory.waitFor(fixture.head);
  const second = await fixture.post("/v1/review", { ...await fixture.reviewBody(head2), async: true });
  assert.equal(second.status, 202);
  const unrelated = fixture.post("/v1/review", {
    remoteUrl: await getRemoteUrl(other.dir), rootCommit: await getRootCommit(other.dir),
    base: otherBase, head: otherHead,
    bundleBase64: (await createBundle(other.dir, { base: null, head: otherHead })).toString("base64"),
    argv: ["find", "--json", "--base", otherBase, "--head", otherHead, "--max-rounds", "1"],
  });
  await fixture.factory.waitFor(otherHead);
  const { job } = await (await fetch(`${fixture.url}/v1/jobs/${second.body.jobId}`)).json();
  assert.equal(job.status, "queued");
  assert.equal(fixture.factory.reads.has(head2), false);
  assert.match(fixture.factory.reads.get(otherHead).text, /other-project/);
  fixture.factory.releaseAll();
  const results = await Promise.all([first, unrelated]);
  for (const result of results) assert.equal(result.body.code, 0, JSON.stringify(result));
  assert.notEqual(JSON.parse(results[0].body.output).project.id, JSON.parse(results[1].body.output).project.id);
  assert.equal((await waitForJob(fixture.url, second.body.jobId)).result.code, 0);
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

test("same-project memory sync waits for a review while another project's sync and read lane still answer", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t, { reviewConcurrency: 3, projectReviewConcurrency: 2 });
  const body = await fixture.reviewBody();
  const reviewing = fixture.post("/v1/review", body);
  await fixture.factory.waitFor(fixture.head);
  const projectId = projectIdFor(body.remoteUrl, body.rootCommit);
  let synced = false;
  const syncing = fixture.post("/v1/memory/sync", {
    projectId, rootCommit: body.rootCommit, remoteUrl: null, normalizedRemote: null,
    snapshot: emptySnapshot(projectId), dryRun: true,
  }).then((result) => { synced = true; return result; });
  const deadline = Date.now() + 10000;
  while ((await (await fetch(`${fixture.url}/health`)).json()).executor.pending !== 2) {
    if (Date.now() > deadline) throw new Error("same-project sync did not wait behind its active review");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const otherRoot = "f".repeat(40);
  const otherId = projectIdFor(null, otherRoot);
  const other = await fixture.post("/v1/memory/sync", {
    projectId: otherId, rootCommit: otherRoot, normalizedRemote: null,
    snapshot: emptySnapshot(otherId), dryRun: true,
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.merged.projectId, otherId);
  const read = await fixture.post("/v1/review", {
    ...body, bundleBase64: "", noBundle: true, argv: ["findings", "list", "--json"],
  });
  assert.equal(read.body.code, 0);
  assert.equal(synced, false, "same-project sync must not finish while its review is parked");
  fixture.factory.releaseAll();
  assert.equal((await reviewing).body.code, 0);
  assert.equal((await syncing).status, 200);
});

test("a failed review does not release another run's state or leak its execution capacity", { timeout: 30000 }, async (t) => {
  const fixture = await sandbox(t, { reviewConcurrency: 2, projectReviewConcurrency: 2 });
  fixture.repo.write("src/value.ts", 'export const value = "two";\n');
  const head2 = fixture.repo.commit("second change");
  fixture.factory.fail(fixture.head);
  const failing = fixture.post("/v1/review", await fixture.reviewBody());
  const healthy = fixture.post("/v1/review", await fixture.reviewBody(head2));
  await Promise.all([fixture.factory.waitFor(fixture.head), fixture.factory.waitFor(head2)]);
  fixture.factory.release(fixture.head);
  const failed = await failing;
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /scripted reviewer failure/);
  const { jobs } = await (await fetch(`${fixture.url}/v1/jobs`)).json();
  assert.equal(jobs.filter((job) => job.status === "failed").length, 1);
  assert.equal(jobs.filter((job) => job.status === "running").length, 1);
  fixture.repo.write("src/value.ts", 'export const value = "three";\n');
  const head3 = fixture.repo.commit("third change");
  const followup = fixture.post("/v1/review", await fixture.reviewBody(head3));
  await fixture.factory.waitFor(head3);
  assert.match(fixture.factory.reads.get(head2).text, /"two"/);
  assert.match(fixture.factory.reads.get(head3).text, /"three"/);
  fixture.factory.releaseAll();
  assert.equal((await healthy).body.code, 0);
  assert.equal((await followup).body.code, 0);
  assert.deepEqual(readdirSync(path.join(fixture.root, "repos", "work")), []);
});
