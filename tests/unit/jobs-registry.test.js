import { test } from "node:test";
import assert from "node:assert/strict";
import { JobRegistry } from "../../dist/server/jobs.js";

test("JobRegistry: queued -> running -> completed carries the result for pickup", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "audit", argv: ["audit", "--json"] });
  assert.equal(registry.get(job.jobId).status, "queued");
  assert.equal(registry.list().length, 1);

  job.start();
  job.progress("unit u1 attempt 1/2");
  job.progress("unit u1: 3 new candidates");
  const mid = registry.get(job.jobId);
  assert.equal(mid.status, "running");
  assert.equal(mid.startedAt !== null, true);
  assert.deepEqual(mid.log, ["unit u1 attempt 1/2", "unit u1: 3 new candidates"]);
  assert.equal(mid.logTotal, 2);

  job.finish({ code: 0, output: "result-json\n", log: ["unit u1 attempt 1/2", "unit u1: 3 new candidates"] });
  const done = registry.get(job.jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.result.code, 0);
  assert.equal(done.result.output, "result-json\n");
  assert.equal(done.result.truncated, false);
  assert.equal(done.finishedAt !== null, true);
});

test("JobRegistry: failed jobs keep their error and still settle", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "find", argv: ["find"] });
  job.start();
  job.fail("boom");
  const record = registry.get(job.jobId);
  assert.equal(record.status, "failed");
  assert.equal(record.error, "boom");
  assert.equal(record.result, null);
});

test("JobRegistry: progress log is a bounded recent window", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "audit", argv: ["audit"] });
  job.start();
  for (let i = 0; i < 2500; i++) job.progress(`line ${i}`);
  const record = registry.get(job.jobId);
  assert.equal(record.log.length, 2000);
  assert.equal(record.logTotal, 2500);
  // The most recent lines survive; the oldest are dropped first.
  assert.equal(record.log[record.log.length - 1], "line 2499");
  assert.equal(record.log[0], "line 500");
});

test("JobRegistry: oversize results are truncated and flagged", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "audit", argv: ["audit"] });
  job.start();
  const huge = "x".repeat(33 * 1024 * 1024);
  job.finish({ code: 0, output: huge, log: [] });
  const record = registry.get(job.jobId);
  assert.equal(record.result.truncated, true);
  assert.equal(record.result.output.length, 32 * 1024 * 1024);
});

test("JobRegistry: old completed jobs evict, active ones never", () => {
  const registry = new JobRegistry();
  const active = registry.create({ command: "audit", argv: ["audit"] });
  active.start();
  for (let i = 0; i < 110; i++) {
    const job = registry.create({ command: "find", argv: ["find"] });
    job.start();
    job.finish({ code: 0, output: "", log: [] });
  }
  const ids = new Set(registry.list().map((record) => record.jobId));
  assert.equal(ids.has(active.jobId), true);
  // 110 completed + 1 active = 111; the cap keeps 100 completed + the active.
  assert.equal(registry.list().length, 101);
});

test("JobRegistry: clientGone marks a sync request whose delivery was lost", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "find", argv: ["find"] });
  job.start();
  job.markClientGone();
  job.finish({ code: 0, output: "kept\n", log: [] });
  const record = registry.get(job.jobId);
  assert.equal(record.clientGone, true);
  // The whole point (#38): the result survives the dead client.
  assert.equal(record.result.output, "kept\n");
});

test("JobRegistry: get returns copies — callers cannot mutate registry state", () => {
  const registry = new JobRegistry();
  const job = registry.create({ command: "audit", argv: ["audit"] });
  const copy = registry.get(job.jobId);
  copy.log.push("forged");
  copy.status = "completed";
  const again = registry.get(job.jobId);
  assert.deepEqual(again.log, []);
  assert.equal(again.status, "queued");
});

test("pollJobToEnd: streams every line exactly once across a sliding log window", async () => {
  const { pollJobToEnd } = await import("../../dist/cli/jobs.js");
  const registry = new JobRegistry();
  const job = registry.create({ command: "audit", argv: ["audit"] });
  job.start();
  for (let i = 0; i < 2500; i++) job.progress(`line ${i}`);

  // Poll snapshots of the 2000-line retained window; between poll 1 and 2
  // the run emits 100 more lines, sliding the window forward. The client
  // must print each line exactly once — no re-prints, no gaps.
  const seen = [];
  let polls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    polls += 1;
    if (polls === 2) for (let i = 2500; i < 2600; i++) job.progress(`line ${i}`);
    const current = registry.get(job.jobId);
    if (polls === 3) {
      job.finish({ code: 0, output: "done\n", log: current.log });
      return { status: 200, ok: true, json: async () => ({ job: registry.get(job.jobId) }) };
    }
    return { status: 200, ok: true, json: async () => ({ job: current }) };
  };
  try {
    const final = await pollJobToEnd(job.jobId, {
      url: "https://pir.invalid",
      intervalMs: 1,
      onLog: (lines) => seen.push(...lines),
    });
    assert.equal(final.status, "completed");
    assert.equal(polls, 3);
    // Poll 1 printed the whole window (lines 500..2499); poll 2 printed
    // exactly the 100 new lines; poll 3 nothing. All distinct.
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 2100);
    assert.equal(seen[0], "line 500");
    assert.equal(seen[seen.length - 1], "line 2599");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
