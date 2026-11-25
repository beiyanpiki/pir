import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  let handle;
  t.after(async () => {
    factory.releaseAll();
    await Promise.allSettled([...requests]);
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
    void request.then(() => requests.delete(request), () => requests.delete(request));
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
