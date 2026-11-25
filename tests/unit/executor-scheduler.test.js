import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutorScheduler } from "../../dist/server/executor-scheduler.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const review = (projectId, resourceKey) => ({ kind: "review", projectId, ...(resourceKey ? { resourceKey } : {}) });
const exclusive = (projectId) => ({ kind: "project-exclusive", projectId });
const globalExclusive = { kind: "global-exclusive" };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function hold(scheduler, scope, name, started) {
  const entered = deferred();
  const release = deferred();
  const result = scheduler.run(scope, async () => {
    started.push(name);
    entered.resolve();
    await release.promise;
    return name;
  });
  return { entered: entered.promise, release: release.resolve, result };
}

test("executor: defaults preserve serial arrival order across projects", async () => {
  const scheduler = new ExecutorScheduler();
  const started = [];
  const a = hold(scheduler, review("a"), "a", started);
  const b = hold(scheduler, review("b"), "b", started);
  await a.entered;
  assert.deepEqual(started, ["a"]);
  assert.equal(scheduler.stats().pending, 2);
  a.release();
  await b.entered;
  assert.deepEqual(started, ["a", "b"]);
  b.release();
  assert.deepEqual(await Promise.all([a.result, b.result]), ["a", "b"]);
  assert.deepEqual(scheduler.stats(), { pending: 0, oldestPendingMs: 0 });
});

test("executor: same-project reviews overlap up to the project and global limits", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 3, projectConcurrency: 2 });
  const started = [];
  const a = hold(scheduler, review("a"), "a1", started);
  const b = hold(scheduler, review("a"), "a2", started);
  const c = hold(scheduler, review("a"), "a3", started);
  const d = hold(scheduler, review("b"), "b1", started);
  const e = hold(scheduler, review("c"), "c1", started);
  await Promise.all([a.entered, b.entered, d.entered]);
  assert.deepEqual(started, ["a1", "a2", "b1"]);
  a.release();
  await c.entered;
  assert.deepEqual(started, ["a1", "a2", "b1", "a3"]);
  d.release();
  await e.entered;
  b.release();
  c.release();
  e.release();
  await Promise.all([a.result, b.result, c.result, d.result, e.result]);
  assert.equal(scheduler.stats().pending, 0);
});

test("executor: project maintenance drains earlier reviews and blocks later ones only in that project", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 3, projectConcurrency: 2 });
  const started = [];
  const a = hold(scheduler, review("a"), "a1", started);
  const b = hold(scheduler, review("a"), "a2", started);
  const maintenance = hold(scheduler, exclusive("a"), "maintenance", started);
  const late = hold(scheduler, review("a"), "a3", started);
  const other = hold(scheduler, review("b"), "b1", started);
  await Promise.all([a.entered, b.entered, other.entered]);
  a.release();
  await a.result;
  assert.deepEqual(started, ["a1", "a2", "b1"]);
  b.release();
  await maintenance.entered;
  assert.deepEqual(started, ["a1", "a2", "b1", "maintenance"]);
  maintenance.release();
  await late.entered;
  late.release();
  other.release();
  await Promise.all([b.result, maintenance.result, late.result, other.result]);
});

test("executor: maintenance cannot overtake an earlier queued review in its project", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 2, projectConcurrency: 1 });
  const started = [];
  const a = hold(scheduler, review("a"), "a1", started);
  const b = hold(scheduler, review("a"), "a2", started);
  const maintenance = hold(scheduler, exclusive("a"), "maintenance", started);
  await a.entered;
  a.release();
  await b.entered;
  assert.deepEqual(started, ["a1", "a2"]);
  b.release();
  await maintenance.entered;
  maintenance.release();
  await Promise.all([a.result, b.result, maintenance.result]);
});

test("executor: global barriers wait for every active task and cannot be overtaken", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 3, projectConcurrency: 2 });
  const started = [];
  const a = hold(scheduler, review("a"), "a", started);
  const b = hold(scheduler, review("b"), "b", started);
  const barrier = hold(scheduler, globalExclusive, "global", started);
  const c = hold(scheduler, review("c"), "c", started);
  await Promise.all([a.entered, b.entered]);
  assert.deepEqual(started, ["a", "b"]);
  a.release();
  await a.result;
  assert.deepEqual(started, ["a", "b"]);
  b.release();
  await barrier.entered;
  assert.deepEqual(started, ["a", "b", "global"]);
  barrier.release();
  await c.entered;
  c.release();
  await Promise.all([b.result, barrier.result, c.result]);
});

test("executor: one hosted PR serializes publication while other PRs in the project overlap", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 3, projectConcurrency: 3 });
  const started = [];
  const a = hold(scheduler, review("a", "owner/repo#1"), "pr1-old", started);
  const b = hold(scheduler, review("a", "owner/repo#1"), "pr1-new", started);
  const c = hold(scheduler, review("a", "owner/repo#2"), "pr2", started);
  const d = hold(scheduler, review("b", "owner/repo#1"), "other-project", started);
  await Promise.all([a.entered, c.entered, d.entered]);
  assert.deepEqual(started, ["pr1-old", "pr2", "other-project"]);
  a.release();
  await b.entered;
  b.release();
  c.release();
  d.release();
  await Promise.all([a.result, b.result, c.result, d.result]);
});

test("executor: a global barrier also waits for earlier work blocked by a project limit", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 2, projectConcurrency: 1 });
  const started = [];
  const a = hold(scheduler, review("a"), "a1", started);
  const queued = hold(scheduler, review("a"), "a2", started);
  const barrier = hold(scheduler, globalExclusive, "global", started);
  const late = hold(scheduler, review("b"), "b", started);
  await a.entered;
  assert.deepEqual(started, ["a1"]);
  a.release();
  await queued.entered;
  assert.deepEqual(started, ["a1", "a2"]);
  queued.release();
  await barrier.entered;
  assert.deepEqual(started, ["a1", "a2", "global"]);
  barrier.release();
  await late.entered;
  late.release();
  await Promise.all([a.result, queued.result, barrier.result, late.result]);
});

test("executor: synchronous throws and rejected tasks release both slots and barriers", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 2, projectConcurrency: 2 });
  const sync = scheduler.run(globalExclusive, () => { throw new Error("sync failure"); });
  const async = scheduler.run(exclusive("a"), async () => { throw new Error("async failure"); });
  const next = scheduler.run(review("a"), () => "ok");
  await Promise.all([
    assert.rejects(sync, /sync failure/),
    assert.rejects(async, /async failure/),
  ]);
  assert.equal(await next, "ok");
  assert.deepEqual(scheduler.stats(), { pending: 0, oldestPendingMs: 0 });
});

test("executor: admission reserves slots before callbacks and cannot be bypassed by reentrant submissions", async () => {
  const scheduler = new ExecutorScheduler();
  const started = [];
  let nested;
  const first = scheduler.run(review("a"), () => {
    started.push("first");
    nested = scheduler.run(review("c"), () => { started.push("nested"); });
  });
  const second = scheduler.run(review("b"), () => { started.push("second"); });
  await Promise.all([first, second]);
  await nested;
  assert.deepEqual(started, ["first", "second", "nested"]);
});

test("executor: queued scopes are owned copies, unaffected by caller mutation", async () => {
  const scheduler = new ExecutorScheduler({ concurrency: 2, projectConcurrency: 1 });
  const started = [];
  const a = hold(scheduler, review("a"), "a", started);
  const scope = review("a");
  const b = hold(scheduler, scope, "b", started);
  scope.projectId = "b";
  await a.entered;
  await turn();
  assert.deepEqual(started, ["a"]);
  a.release();
  await b.entered;
  b.release();
  await Promise.all([a.result, b.result]);
});

test("executor: rejects invalid capacities and incomplete scopes before admission", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ExecutorScheduler({ concurrency: value }), RangeError);
    assert.throws(() => new ExecutorScheduler({ projectConcurrency: value }), RangeError);
  }
  const scheduler = new ExecutorScheduler();
  for (const scope of [review(""), exclusive(""), { kind: "unknown" }, { kind: "review", projectId: "a", resourceKey: "" }]) {
    assert.throws(() => scheduler.run(scope, () => {}), RangeError);
  }
  assert.equal(scheduler.stats().pending, 0);
});
