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
