// Shared API fixtures for the review workspace browser suite.

export const projectA = "a".repeat(64);
export const projectB = "b".repeat(64);
export const runA = "11111111-2222-3333-4444-555555555555";
export const runB = "99999999-2222-3333-4444-555555555555";
export const liveRun = "22222222-3333-4444-5555-666666666666";

export const projects = [
  { projectId: projectA, name: "Project A", remote: "github.com/example/a", runsTotal: 2, lastRunAt: 1, lastRunStatus: "completed", openFindings: 1, namedInRegistry: true },
  { projectId: projectB, name: "Project B", remote: null, runsTotal: 1, lastRunAt: 1, lastRunStatus: "completed", openFindings: 0, namedInRegistry: true },
];

export function run(overrides = {}) {
  return {
    runId: runA, mode: "change", base: "c".repeat(40), head: "d".repeat(40),
    startedAt: 1, finishedAt: 2, status: "completed", rounds: 1, candidates: 2,
    confirmed: 1, rejected: 1, uncertain: 0, notes: null, model: "fixture/model",
    durationMs: 1, totalTokens: 10, cost: 0.01, transcriptsAvailable: true,
    verifierModel: "fixture/verifier", runVerdict: "incorrect", incomplete: false,
    stoppedBecause: "reviewer signaled completion", lastUpdatedAt: 2,
    ...overrides,
  };
}

export function finding(overrides = {}) {
  return {
    id: "f1", displayId: "F-101", title: "Switch reuses the previous transcript",
    claim: "The transcript is keyed by file name alone.", category: "state isolation",
    severity: "P1", status: "confirmed", round: 1, createdAt: 1, evidenceCount: 1,
    confidence: 0.9, ...overrides,
  };
}

export function findingDetail(overrides = {}) {
  return {
    ...finding(),
    trigger: "Open run A, then run B.",
    featureKey: null, entityKey: null,
    anchors: [{ path: "web/src/x.ts", startLine: 10, endLine: 12, excerpt: "const x = 1;" }],
    evidence: [{ kind: "code", path: "web/src/x.ts", startLine: 10, excerpt: "const x = 1;" }],
    memoryMatches: [],
    verifierRationale: "Reproduced against two runs with the same session file name.",
    relatedSessions: [{ sessionKey: "reviewer-r1.json", relation: "candidate", originalDisplayId: "F-101" }],
    ...overrides,
  };
}

export function detail(runId, extra = {}) {
  return {
    run: run({ runId }),
    findings: { items: [finding()], total: 1 },
    manifest: null,
    sessions: [
      { file: "reviewer-r1.json", sessionKind: "reviewer", round: 1, angle: "navigation" },
      { file: "verifier-r1-F-101.json", sessionKind: "verifier", round: 1, displayId: "F-101" },
    ],
    transcriptsAvailable: true,
    ...extra,
  };
}

export function transcript(label) {
  return {
    role: "code reviewer", model: "fixture/model", startedAt: "2026-10-28T00:00:00Z", endedAt: "2026-10-28T00:04:18Z",
    prompt: `Review prompt ${label}`,
    usage: { totalTokens: 24_100, cost: 0.12, durationMs: 258_000 },
    messages: [
      { role: "user", content: `Review prompt ${label}`, timestamp: 1 },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Start with the session identity and route key." },
        { type: "text", text: `Inspecting the workspace for ${label}.` },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "web/src/session.ts" } },
      ], model: "fixture/model", timestamp: 2 },
      { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "export const session = true" }], isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: `SESSION BODY ${label}` }], model: "fixture/model", timestamp: 4 },
    ],
  };
}