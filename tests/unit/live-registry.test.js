import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveRegistry } from "../../dist/server/live-registry.js";
import { emitRunEventForTest } from "../../dist/observability/run-events.js";

// Budget and grace behavior of the live buffer (F-18 regression): the caps
// are constructor-configurable so these tests run in kilobytes and
// milliseconds instead of 32 MB and 5 minutes. Timestamps must be real —
// the grace sweep compares against Date.now().

let seqCounter = 0;
const seq = () => {
  seqCounter += 1;
  return seqCounter;
};

const runStart = (runId, ts = Date.now()) => ({
  kind: "run-start", runId, projectId: "p", seq: seq(), ts,
  mode: "change", base: null, head: "h", model: null,
});
const sessionStart = (runId, sessionId, prompt, ts = Date.now()) => ({
  kind: "session-start", runId, projectId: "p", seq: seq(), ts,
  sessionId, sessionKind: "reviewer", role: "code reviewer", model: null, prompt,
});
const delta = (runId, sessionId, text, ts = Date.now()) => ({
  kind: "session-delta", runId, projectId: "p", seq: seq(), ts,
  sessionId, deltaType: "text", text,
});
const block = (runId, sessionId, text, ts = Date.now()) => ({
  kind: "session-block", runId, projectId: "p", seq: seq(), ts,
  sessionId, block: { type: "text", text },
});
const toolResult = (runId, sessionId, toolCallId, result, ts = Date.now()) => ({
  kind: "session-tool-result", runId, projectId: "p", seq: seq(), ts,
  sessionId, toolCallId, name: "read_code", isError: false, result, truncated: false,
});
const runEnd = (runId, ts = Date.now()) => ({
  kind: "run-end", runId, projectId: "p", seq: seq(), ts,
  status: "completed", stoppedBecause: "done", durationMs: 1,
  counts: { rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, pending: 0 },
  findings: [],
});

test("budget: deltas are evicted across runs, oldest activity first; blocks survive", () => {
  const registry = new LiveRegistry({ maxBufferedChars: 1200, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(50), now));
    emitRunEventForTest(delta("A", "s1", "x".repeat(700), now));
    emitRunEventForTest(block("A", "s1", "x".repeat(300), now + 100));
    // Run B pushes the total (1050 + 300) over the 1200 budget; A is the
    // older activity, so A's streaming delta is what goes.
    emitRunEventForTest(runStart("B", now + 200));
    emitRunEventForTest(sessionStart("B", "s2", "y".repeat(300), now + 200));

    const a = registry.snapshot("A");
    const kindsA = a.events.map((event) => event.kind);
    assert.ok(!kindsA.includes("session-delta"), "A's streaming delta is evicted");
    assert.ok(kindsA.includes("session-block"), "A's authoritative block survives");
    assert.ok(kindsA.includes("session-start"), "A's session structure survives");
    const b = registry.snapshot("B");
    assert.equal(b.events.filter((event) => event.kind === "session-start").length, 1, "younger run keeps its events");
  } finally {
    registry.dispose();
  }
});

test("budget: ended runs are dropped once deltas cannot free enough", () => {
  const registry = new LiveRegistry({ maxBufferedChars: 500, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(200), now));
    emitRunEventForTest(runEnd("A", now));
    // Active run B alone exceeds the budget; no deltas anywhere to evict.
    emitRunEventForTest(runStart("B", now + 100));
    emitRunEventForTest(sessionStart("B", "s2", "y".repeat(400), now + 100));

    assert.equal(registry.snapshot("A"), null, "ended run dropped (durable record is on disk)");
    assert.notEqual(registry.snapshot("B"), null, "active run retained");
  } finally {
    registry.dispose();
  }
});

test("budget: last resort trims the front of an oversized active run", () => {
  const registry = new LiveRegistry({ maxBufferedChars: 300, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(250), now));
    emitRunEventForTest(toolResult("A", "s1", "t1", "z".repeat(200), now + 50));

    const a = registry.snapshot("A");
    assert.notEqual(a, null, "run itself is never dropped while active");
    const kinds = a.events.map((event) => event.kind);
    assert.ok(!kinds.includes("session-start"), "oldest (largest) event trimmed from the front");
    assert.ok(kinds.includes("session-tool-result"), "newest event retained");
    // The registry keeps accepting events after trimming.
    emitRunEventForTest(delta("A", "s1", "fresh", now + 100));
    assert.ok(registry.snapshot("A").events.some((event) => event.kind === "session-delta"));
  } finally {
    registry.dispose();
  }
});

test("idle sweep frees ended runs without waiting for another event", async () => {
  const registry = new LiveRegistry({ endedRunGraceMs: 50, pruneIntervalMs: 20 });
  try {
    emitRunEventForTest(runStart("A"));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(200)));
    emitRunEventForTest(runEnd("A"));
    assert.notEqual(registry.snapshot("A"), null, "inside the grace window");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(registry.snapshot("A"), null, "swept by the idle timer, no further events needed");
    assert.deepEqual(registry.activeRuns(), []);
  } finally {
    registry.dispose();
  }
});
