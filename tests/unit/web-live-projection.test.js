import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLiveRunProjection,
  reduceLiveRunProjection,
  mergeSessionIdentities,
  sessionIdentity,
} from "../../web/src/live-projection.ts";

const base = { runId: "r1", projectId: "p", seq: 1, ts: 10 };

test("live projection keeps SSE connection state independent from execution", () => {
  let state = createLiveRunProjection("r1");
  state = reduceLiveRunProjection(state, { type: "event", event: { ...base, kind: "run-start", mode: "change", base: "b", head: "h", model: null } });
  state = reduceLiveRunProjection(state, { type: "connection", state: "open" });
  state = reduceLiveRunProjection(state, { type: "connection", state: "error" });
  assert.equal(state.executionState, "running");
  assert.equal(state.connectionState, "error");
});

test("run-end is authoritative for counts and terminal state", () => {
  let state = createLiveRunProjection("r1");
  state = reduceLiveRunProjection(state, { type: "event", event: { ...base, seq: 2, kind: "run-start", mode: "audit", base: null, head: "h", model: "m" } });
  state = reduceLiveRunProjection(state, { type: "event", event: { ...base, seq: 3, kind: "run-end", status: "incomplete", stoppedBecause: "budget", durationMs: 20, counts: { rounds: 2, candidates: 3, confirmed: 1, rejected: 1, uncertain: 1, pending: 0 }, findings: [] } });
  assert.equal(state.executionState, "incomplete");
  assert.equal(state.counts.confirmed, 1);
  assert.equal(state.end.stoppedBecause, "budget");
});

test("session identity merges live transcript basename with archived file", () => {
  const live = { sessionId: "reviewer-1-r1", sessionKind: "reviewer", role: "reviewer", model: null, prompt: "p", startedAt: 1, endedAt: 2, items: [], transcriptFile: "/state/p/transcripts/r1/reviewer-r1.json" };
  const persisted = { file: "reviewer-r1.json", sessionKind: "reviewer" };
  assert.equal(sessionIdentity(live), "persisted:reviewer-r1.json");
  assert.equal(mergeSessionIdentities([live], [persisted]).length, 1);
});

test("REST calibration enriches live sessions and cannot revive a terminal run", () => {
  let state = createLiveRunProjection("r1");
  state = reduceLiveRunProjection(state, { type: "event", event: { ...base, kind: "session-start", sessionId: "s", sessionKind: "verifier", role: "v", model: null, prompt: "p" } });
  state = reduceLiveRunProjection(state, { type: "event", event: { ...base, seq: 2, kind: "run-end", status: "failed", stoppedBecause: "error", durationMs: 20, counts: { rounds: 2, candidates: 3, confirmed: 1, rejected: 1, uncertain: 1, pending: 0 }, findings: [] } });
  state = reduceLiveRunProjection(state, { type: "detail", detail: { run: { runId: "r1", status: "running", finishedAt: null, rounds: 1 }, manifest: null, live: { end: null, lastEventAt: 5, sessions: [{ sessionId: "s", sessionKind: "verifier", transcriptFile: "s.json", round: 1, endedAt: 6 }] } } });
  assert.equal(state.executionState, "failed");
  assert.equal(state.sessions[0].transcriptFile, "s.json");
  assert.equal(state.sessions[0].endedAt, 6);
  assert.equal(state.lastSeq, 2);
});

test("runtime identity reconciliation gives stream and rail the same durable anchor", async () => {
  const { sessionAnchor, workflowSessions } = await import("../../web/src/live-projection.ts");
  const start = { ...base, kind: "session-start", sessionId: "s", sessionKind: "verifier", role: "v", model: null, prompt: "p", displayId: "F-1" };
  const ref = { file: "v.json", sessionId: "s", sessionKind: "verifier", displayId: "F-1", findingIdMap: [{ from: "F-1", to: "F-201" }] };
  const identities = mergeSessionIdentities([start], [ref, ref]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].key, "persisted:v.json");
  const workflow = workflowSessions([start, { ...base, seq: 2, kind: "session-end", sessionId: "s", error: "oops" }], [ref]);
  assert.equal(workflow.length, 1);
  assert.equal(workflow[0].status, "failed");
  assert.equal(workflow[0].label, "F-201");
  assert.deepEqual(workflow[0].findingIds, ["F-201"]);
  assert.ok(workflow[0].aliases.includes("runtime:s"));
  assert.notEqual(sessionAnchor("persisted:a.b.json"), sessionAnchor("persisted:a-b.json"));
});

test("angle collector IDs resolve through runtime IDs to durable findings", async () => {
  const { workflowSessions } = await import("../../web/src/live-projection.ts");
  const result = workflowSessions(null, [{ file: "reviewer.json", sessionKind: "reviewer", angle: "correctness", idMap: [{ from: "F-1", to: "F-3" }], findingIdMap: [{ from: "F-3", to: "F-99" }] }]);
  assert.deepEqual(result[0].findingMappings, [{ from: "F-1", to: "F-99" }]);
  assert.deepEqual(workflowSessions([{ ...base, kind: "session-start", sessionId: "s", sessionKind: "verifier", role: "v", model: null, prompt: "p", displayId: "F-1" }], [])[0].findingIds, []);
});
