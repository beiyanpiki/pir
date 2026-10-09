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

// #70 regression: the replay copy must not spread-apply the buffer. A long
// audit buffers >125k events (mostly tiny deltas) well under the 32 MB char
// budget; push(...events) passed each one as a call argument and V8's stack
// overflowed, killing every SSE connection with a synchronous throw. The
// event-count cap is disabled here so the copy is still exercised at a size
// real registries no longer reach.
test("subscribe: replays a 200k-event buffer without stack overflow", () => {
  const registry = new LiveRegistry({ endedRunGraceMs: 60_000, pruneIntervalMs: 60_000, maxBufferedEventsPerRun: Infinity });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x", now));
    const DELTAS = 200_000;
    for (let i = 0; i < DELTAS; i += 1) {
      emitRunEventForTest(delta("A", "s1", "x", now));
    }

    const single = registry.subscribe("A", () => {});
    assert.equal(single.replay.length, DELTAS + 2, "single-run replay returns the full buffer");
    assert.equal(single.replay[0].kind, "run-start", "replay preserves emission order");
    assert.equal(single.replay[single.replay.length - 1].kind, "session-delta");
    single.unsubscribe();

    const all = registry.subscribe(null, () => {});
    assert.equal(all.replay.length, DELTAS + 2, "all-runs replay returns the full buffer, seq-sorted");
    all.unsubscribe();
  } finally {
    registry.dispose();
  }
});

// #70 follow-up: bound the buffered event count per run — the char budget
// alone let hundreds of thousands of tiny deltas pile up, making every SSE
// replay an unbounded burst for the serve loop and the joining client.
test("event cap: oldest deltas are dropped first when a run exceeds the count cap", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 5, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(10), now));
    for (let i = 0; i < 8; i += 1) emitRunEventForTest(delta("A", "s1", `d${i}`, now));
    emitRunEventForTest(block("A", "s1", "settled", now));

    const events = registry.snapshot("A").events;
    assert.equal(events.length, 5, "buffer is capped");
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes("run-start") && kinds.includes("session-start") && kinds.includes("session-block"),
      "run structure and the authoritative block survive");
    const deltaTexts = events.filter((event) => event.kind === "session-delta").map((event) => event.text);
    assert.deepEqual(deltaTexts, ["d6", "d7"], "oldest deltas dropped first, newest kept");
  } finally {
    registry.dispose();
  }
});

test("event cap: without deltas the oldest events are trimmed from the front", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 3, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    for (let i = 0; i < 4; i += 1) emitRunEventForTest(block("A", "s1", `b${i}`, now));

    const events = registry.snapshot("A").events;
    assert.equal(events.length, 3, "buffer is capped");
    assert.deepEqual(events.map((event) => event.block.text), ["b1", "b2", "b3"], "oldest trimmed from the front");
  } finally {
    registry.dispose();
  }
});
