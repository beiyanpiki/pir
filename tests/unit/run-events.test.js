import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunEventSink,
  hasRunEventListeners,
  onRunEvent,
  writeRunManifest,
} from "../../dist/observability/run-events.js";

test("bus: listeners receive events, unsubscribe stops delivery, observer errors are swallowed", () => {
  assert.equal(hasRunEventListeners(), false);
  const received = [];
  const unsubscribe = onRunEvent((event) => received.push(event));
  const unsubscribeThrowing = onRunEvent(() => {
    throw new Error("observer must not break the review");
  });
  assert.equal(hasRunEventListeners(), true);

  const sink = createRunEventSink("run-1", "project-1");
  sink.runStarted({ mode: "change", base: "b", head: "h", model: null });
  sink.runEnded({ status: "completed", stoppedBecause: "done", durationMs: 5, counts: {
    rounds: 1, candidates: 0, confirmed: 0, rejected: 0, uncertain: 0, pending: 0,
  }, findings: [] });

  unsubscribe();
  unsubscribeThrowing();
  assert.equal(hasRunEventListeners(), false);
  assert.equal(received.length, 2);
  assert.equal(received[0].kind, "run-start");
  assert.equal(received[0].runId, "run-1");
  assert.equal(received[0].projectId, "project-1");
  assert.equal(received[0].seq, 1);
  assert.equal(received[1].kind, "run-end");
  assert.ok(received[1].seq > received[0].seq, "sequence numbers increase");

  // After unsubscribe nothing is delivered.
  sink.progress({ phase: "info", message: "ignored" });
  assert.equal(received.length, 2);
});

test("session emitter reduces SDK events to deltas, blocks and tool results", () => {
  const received = [];
  const unsubscribe = onRunEvent((event) => received.push(event));
  try {
    const sink = createRunEventSink("run-2", "project-1");
    const session = sink.session({ sessionKind: "reviewer", role: "code reviewer", model: "prov/m", round: 1 });
    session.sessionStarted("the rendered prompt");

    // Streaming deltas: only thinking_delta / text_delta survive.
    session.sdkEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } });
    session.sdkEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    session.sdkEvent({ type: "message_update", assistantMessageEvent: { type: "text_start" } });

    // message_end on an assistant message yields one block per content item;
    // non-assistant messages are dropped.
    session.sdkEvent({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "full thinking" },
      { type: "text", text: "full text" },
      { type: "toolCall", id: "tc-1", name: "read_code", arguments: { path: "a.ts" } },
    ] } });
    session.sdkEvent({ type: "message_end", message: { role: "user", content: "prompt again" } });

    // Tool results are stringified and capped.
    session.sdkEvent({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "read_code", result: { lines: ["x"] }, isError: false });
    session.sdkEvent({ type: "agent_start" });
    session.sdkEvent({ type: "compaction_start", reason: "threshold" });

    session.sessionEnded(undefined, { inputTokens: 1, outputTokens: 2 });

    const kinds = received.map((event) => event.kind);
    assert.deepEqual(kinds, [
      "session-start", "session-delta", "session-delta", "session-block", "session-block", "session-block",
      "session-tool-result", "progress", "session-end",
    ]);
    const start = received[0];
    assert.equal(start.sessionKind, "reviewer");
    assert.equal(start.prompt, "the rendered prompt");
    assert.match(start.sessionId, /^reviewer-1-/);
    assert.equal(received[1].deltaType, "thinking");
    assert.equal(received[2].deltaType, "text");
    assert.deepEqual(received[3].block, { type: "thinking", text: "full thinking" });
    assert.deepEqual(received[5].block, { type: "toolCall", id: "tc-1", name: "read_code", arguments: { path: "a.ts" } });
    assert.equal(received[6].result, '{\n  "lines": [\n    "x"\n  ]\n}');
    assert.equal(received[6].truncated, false);
    assert.equal(received[7].phase, "info");
    assert.match(received[7].message, /compaction/);
    assert.equal(received[8].usage.outputTokens, 2);
  } finally {
    unsubscribe();
  }
});

test("session emitter caps oversized tool results and tombstones never-started sessions", () => {
  const received = [];
  const unsubscribe = onRunEvent((event) => received.push(event));
  try {
    const sink = createRunEventSink("run-3", "project-1");
    const session = sink.session({ sessionKind: "verifier", role: "finding verifier", displayId: "F-1" });
    session.sdkEvent({ type: "tool_execution_end", toolCallId: "tc-big", toolName: "read_code", result: "x".repeat(200 * 1024), isError: true });
    const big = received.find((event) => event.kind === "session-tool-result");
    assert.equal(big.truncated, true);
    assert.equal(big.isError, true);
    assert.ok(big.result.length < 200 * 1024);
    assert.ok(big.result.endsWith("…[truncated]"));

    // sessionEnded without sessionStarted emits a start tombstone with an empty prompt.
    session.sessionEnded("factory exploded");
    const kinds = received.map((event) => event.kind);
    assert.deepEqual(kinds, ["session-tool-result", "session-start", "session-end"]);
    assert.equal(received[1].prompt, "");
    assert.equal(received[2].error, "factory exploded");
  } finally {
    unsubscribe();
  }
});

test("writeRunManifest writes run.json next to transcripts and is a no-op without a dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pir-run-manifest-"));
  try {
    const dir = path.join(root, "transcripts", "run-9");
    writeRunManifest(dir, {
      schemaVersion: 1, runId: "run-9", projectId: "project-1", mode: "change", status: "completed",
      base: "b", head: "h", model: null, startedAt: 1, finishedAt: 2, stoppedBecause: "done",
      incomplete: false, runVerdict: "correct", maxFindings: 10, rounds: [], plugins: [], sessions: [],
      durationMs: 1, estimatedTokens: 0,
    });
    const file = path.join(dir, "run.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.runId, "run-9");
    assert.equal(parsed.schemaVersion, 1);

    // No transcript dir -> no throw, no file.
    writeRunManifest(undefined, { runId: "x" });
    assert.ok(!existsSync(path.join(root, "nope")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
