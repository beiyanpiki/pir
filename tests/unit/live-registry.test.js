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
const delta = (runId, sessionId, text, ts = Date.now(), deltaType = "text") => ({
  kind: "session-delta", runId, projectId: "p", seq: seq(), ts,
  sessionId, deltaType, text,
});
const sessionEnd = (runId, sessionId, ts = Date.now()) => ({
  kind: "session-end", runId, projectId: "p", seq: seq(), ts, sessionId,
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
// Delta-heavy runs (the #70 shape) are bounded losslessly: consecutive
// same-session/same-type deltas coalesce into cumulative-text events, so a
// joining client still receives every character of streamed text.
test("event cap: coalescing bounds delta-heavy buffers without losing text", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 10, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(10), now));
    const emitted = [];
    for (let i = 0; i < 20; i += 1) {
      const text = `d${i}`;
      emitted.push(text);
      emitRunEventForTest(delta("A", "s1", text, now));
    }
    emitRunEventForTest(block("A", "s1", "settled", now));

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 11, "buffer stays capped");
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes("run-start") && kinds.includes("session-start") && kinds.includes("session-block"),
      "run structure and the authoritative block survive");
    const deltaTexts = events.filter((event) => event.kind === "session-delta").map((event) => event.text);
    assert.equal(deltaTexts.join(""), emitted.join(""), "coalesced replay carries every streamed character");
    const lastDelta = events.filter((event) => event.kind === "session-delta").pop();
    assert.equal(lastDelta.text, "d19", "the newest raw tail keeps its own event");
  } finally {
    registry.dispose();
  }
});

// Sessions stream sequentially (the supervisor awaits one session at a
// time), so a session's deltas arrive as streaks: a text run, a thinking
// run, a text run... Coalescing must merge within a streak only — never
// across types — and preserve every character. (cap 10, batch 5: the pass
// triggers once the buffer passes cap+batch = 15.)
test("event cap: coalescing merges per streak, never across types", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 10, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x", now));
    const streak = (prefix, type, n) => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, type]);
    for (const [text, type] of [
      ...streak("a", "text", 4), ...streak("b", "thinking", 4),
      ...streak("c", "text", 4), ...streak("d", "thinking", 4),
    ]) {
      emitRunEventForTest(delta("A", "s1", text, now, type));
    }

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 16, "buffer stays within the cap window");
    const deltas = events.filter((event) => event.kind === "session-delta");
    assert.deepEqual(deltas.map((event) => event.text),
      ["a0a1a2a3", "b0b1b2b3", "c0c1c2c3", "d0d1", "d2", "d3"],
      "the streaks before the last pass coalesce; the post-pass tail stays raw");
    assert.deepEqual(deltas.map((event) => event.deltaType),
      ["text", "thinking", "text", "thinking", "thinking", "thinking"],
      "thinking never bleeds into text streaks or vice versa");
    assert.deepEqual(deltas.map((event) => event.cumulative === true),
      [true, true, true, true, false, false],
      "coalesced events are marked cumulative; raw tail events are not");
    assert.equal(deltas.map((event) => event.text).join(""), "a0a1a2a3b0b1b2b3c0c1c2c3d0d1d2d3", "every character preserved");
  } finally {
    registry.dispose();
  }
});

// When deltas cannot satisfy the cap (tool-heavy runs), the oldest
// non-structural events go — but never the foldable skeleton: losing a
// session-end would pin that session as "running" forever on a joining
// client, since terminal state is only derived from the event stream.
test("event cap: without deltas the oldest non-structural events go, skeleton survives", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 5, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(10), now));
    for (let i = 0; i < 6; i += 1) emitRunEventForTest(block("A", "s1", `b${i}`, now));
    emitRunEventForTest(sessionEnd("A", "s1", now));
    emitRunEventForTest(runEnd("A", now));

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 8, "buffer stays near the cap");
    assert.deepEqual(events.map((event) => event.kind),
      ["run-start", "session-start", "session-block", "session-end", "run-end"],
      "skeleton incl. terminal events survives; only the oldest blocks erode");
  } finally {
    registry.dispose();
  }
});

// A run at the cap must not pay a full-buffer eviction pass on every
// arriving event: unbatched eviction is O(cap) per event (O(n²) over a long
// run). The batch keeps it amortized O(1) — bounded wall time for 60k
// events at a 20k cap (the unbatched version takes orders of magnitude
// longer and blows this bound).
test("event cap: eviction at the cap is amortized, not per-event full passes", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 20_000, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x", now));
    const started = process.hrtime.bigint();
    for (let i = 0; i < 60_000; i += 1) emitRunEventForTest(delta("A", "s1", "x", now));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 20_001, "buffer stays capped");
    assert.ok(elapsedMs < 5_000, `60k events at a 20k cap buffer in ${Math.round(elapsedMs)}ms, not per-event full passes`);
  } finally {
    registry.dispose();
  }
});

// F-73 shape: a buffer sitting exactly at the cap whose tail is a
// mergeable streaming streak. A naive per-overage trigger pays an O(cap)
// coalesce pass on EVERY streak delta (the pass absorbs the overage, no
// eviction runs, the next delta re-triggers). The cap+batch trigger window
// keeps passes batched.
test("event cap: a streaming streak over an atom-heavy buffer stays amortized", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 20_000, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x", now));
    const started = process.hrtime.bigint();
    // 19997 alternating-type atoms: no two consecutive deltas can merge, and
    // with run-start/session-start the buffer holds exactly 19999 events —
    // one below the cap, nothing triggered yet.
    for (let i = 0; i < 19_997; i += 1) {
      emitRunEventForTest(delta("A", "s1", "x", now, i % 2 === 0 ? "text" : "thinking"));
    }
    // The streak: same type as the last atom (i=19996 is text), so every
    // pass coalesces the tail and lands back at exactly the cap.
    for (let i = 0; i < 40_000; i += 1) emitRunEventForTest(delta("A", "s1", "y", now));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 21_025, "buffer stays within the cap window");
    assert.ok(elapsedMs < 5_000, `60k events buffer in ${Math.round(elapsedMs)}ms, not a full pass per streak delta`);
  } finally {
    registry.dispose();
  }
});

// F-81: on a tool-heavy run past the cap, the delta eviction pass could
// reach the trailing streaming run and drop it wholesale mid-streak; the
// re-coalesced tail then started past what live clients already held, so a
// reconnect duplicated (or dropped) the overlap. The trailing delta run is
// the stream in flight and is never evicted — blocks erode instead.
test("event cap: the in-flight streaming tail is never evicted", () => {
  const registry = new LiveRegistry({ maxBufferedEventsPerRun: 10, endedRunGraceMs: 60_000, pruneIntervalMs: 60_000 });
  try {
    const now = Date.now();
    emitRunEventForTest(runStart("A", now));
    emitRunEventForTest(sessionStart("A", "s1", "x".repeat(10), now));
    for (let i = 0; i < 8; i += 1) emitRunEventForTest(block("A", "s1", `b${i}`, now));
    // Alternating delta types: nothing coalesces, and the whole delta tail
    // is one contiguous in-flight run behind the 16-event trigger.
    for (const [text, type] of [["t0", "text"], ["k0", "thinking"], ["t1", "text"], ["k1", "thinking"], ["t2", "text"], ["k2", "thinking"]]) {
      emitRunEventForTest(delta("A", "s1", text, now, type));
    }

    const events = registry.snapshot("A").events;
    assert.ok(events.length <= 16, "buffer stays within the cap window");
    assert.deepEqual(events.map((event) => event.kind),
      ["run-start", "session-start", "session-delta", "session-delta", "session-delta", "session-delta", "session-delta", "session-delta"],
      "skeleton and every in-flight delta survive; blocks eroded instead");
    assert.deepEqual(events.filter((event) => event.kind === "session-delta").map((event) => event.text),
      ["t0", "k0", "t1", "k1", "t2", "k2"], "no mid-stream delta is lost or reordered");
  } finally {
    registry.dispose();
  }
});
