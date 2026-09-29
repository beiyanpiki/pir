import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { createRecordCandidateTool, createFinishRoundTool, createSubmitVerdictTool, createVerifierMemoryTools } from "../../dist/tools/collector-tools.js";

function validCandidate() {
  return { title: "Wrong increment", claim: "Increment returns the wrong value", trigger: "Calling next once", category: "correctness", severity: "P1", anchors: [{ path: "src/next.ts", startLine: 1 }], evidence: [{ kind: "code", path: "src/next.ts", startLine: 1, excerpt: "short constructed excerpt" }] };
}

function fixture() {
  const repo = createTempGitRepo("pir-collectors-");
  repo.write("src/next.ts", "export function next(n) {\n  return n + 1;\n}\n");
  repo.write("src/unchanged.ts", "export const guard = true;\n");
  repo.write("src/deleted.ts", "export const old = true;\nexport const second = 2;\n");
  repo.write("src/empty.ts", "");
  const base = repo.commit("collector test baseline");
  repo.write("src/next.ts", "export function next(n) {\n  return n + 2;\n}\n");
  rmSync(path.join(repo.dir, "src/deleted.ts"));
  const head = repo.commit("collector test changed snapshot");
  // Working-tree text is deliberately longer and must never validate a head line.
  repo.write("src/next.ts", "working tree\nline two\nline three\nline four\n");
  repo.write("src/untracked.ts", "untracked content\n");
  const ctx = { repoRoot: repo.dir, headCommit: head, changeSet: { base, head, baseCommit: base, headCommit: head, mergeBase: base, files: [{ path: "src/next.ts", status: "modified" }, { path: "src/deleted.ts", status: "deleted" }], patch: "" }, codeMap: { structuralQueries: false }, memory: null };
  return { repo, ctx, cleanup: () => repo.cleanup() };
}

test("record_candidate validates atomically and never coerces malformed values", async () => {
  const f = fixture();
  try {
    const collector = { candidates: [] };
    const tool = createRecordCandidateTool(f.ctx, collector, 1);
    const invalid = [
      { title: "x".repeat(81) }, { title: " " }, { claim: "" }, { claim: null }, { trigger: " " },
      { category: "not-a-category" }, { severity: "P9" }, { anchors: [] }, { evidence: [] },
      { anchors: [null] }, { evidence: [null] }, { featureKey: 4 },
      { anchors: [{ path: "../outside.ts", startLine: 1 }] },
      { anchors: [{ path: "src/../src/next.ts", startLine: 1 }] },
      { anchors: [{ path: "/src/next.ts", startLine: 1 }] },
      { anchors: [{ path: "C:\\next.ts", startLine: 1 }] },
      { anchors: [{ path: "src/next.ts", startLine: 0 }] },
      { anchors: [{ path: "src/next.ts", startLine: 1.5 }] },
      { anchors: [{ path: "src/next.ts", startLine: "1" }] },
      { anchors: [{ path: "src/next.ts", startLine: 2, endLine: 1 }] },
      { anchors: [{ path: "src/next.ts", startLine: 1, endLine: 4 }] },
      { anchors: [{ path: "src/next.ts", startLine: 4 }] },
      { anchors: [{ path: "src/untracked.ts", startLine: 1 }] },
      { anchors: [{ path: "src/empty.ts", startLine: 1 }] },
      { evidence: [{ kind: "invented", description: "support" }] },
      { evidence: [{ kind: "code" }] },
      { evidence: [{ kind: "test", description: " " }] },
      { evidence: [{ kind: "code", path: "src/next.ts", startLine: 4, description: "support" }] },
      { evidence: [{ kind: "code", startLine: 1, description: "support" }] },
      { evidence: [{ kind: "code", path: "src/next.ts", endLine: 2, description: "support" }] },
      { evidence: [{ kind: "doc", path: "../outside", description: "support" }] },
    ];
    for (const patch of invalid) {
      const output = await tool.execute({ ...validCandidate(), ...patch });
      assert.match(output.text, /^ERROR:/, JSON.stringify(patch));
      assert.equal(output.terminate, undefined);
      assert.deepEqual(collector.candidates, []);
    }
    const output = await tool.execute(validCandidate());
    assert.match(output.text, /Recorded candidate F-101/);
    assert.equal(collector.candidates.length, 1);
    assert.equal(collector.candidates[0].evidence[0].excerpt, "short constructed excerpt");
    assert.equal(collector.candidates[0].identity.normalizedClaim, "increment returns the wrong value");
  } finally { f.cleanup(); }
});

test("anchors may target unchanged files and explicit deleted-file merge-base locations", async () => {
  const f = fixture();
  try {
    const collector = { candidates: [] };
    const tool = createRecordCandidateTool(f.ctx, collector, 2);
    const unchanged = await tool.execute({ ...validCandidate(), anchors: [{ path: "src/unchanged.ts", startLine: 1 }] });
    assert.ok(!unchanged.text.startsWith("ERROR"), unchanged.text);
    const deleted = await tool.execute({ ...validCandidate(), anchors: [{ path: "src/deleted.ts", startLine: 2 }], evidence: [{ kind: "diff", path: "src/deleted.ts", startLine: 1, endLine: 2, description: "Deleting the old contract breaks its caller" }] });
    assert.ok(!deleted.text.startsWith("ERROR"), deleted.text);
    const note = collector.candidates[1].evidence.find((e) => e.description?.includes("Entirely deleted file"));
    assert.match(note.description, /use merge-base/);
    assert.ok(note.description.includes(f.ctx.changeSet.mergeBase));
    const before = structuredClone(collector.candidates);
    const bad = await tool.execute({ ...validCandidate(), anchors: [{ path: "src/deleted.ts", startLine: 3 }] });
    assert.match(bad.text, /^ERROR:/);
    assert.deepEqual(collector.candidates, before);
    const noDeletion = createRecordCandidateTool({ ...f.ctx, changeSet: { ...f.ctx.changeSet, files: [] } }, { candidates: [] }, 1);
    assert.match((await noDeletion.execute({ ...validCandidate(), anchors: [{ path: "src/deleted.ts", startLine: 1 }] })).text, /^ERROR:/);
  } finally { f.cleanup(); }
});

test("finish_round validates before mutation and defaults optional structured summaries", async () => {
  const outcome = { summary: "", nextFocus: [], needsMoreRounds: false, submitted: false };
  const tool = createFinishRoundTool(outcome);
  const valid = { summary: "Inspected changed arithmetic and callers", nextFocus: [], needsMoreRounds: false };
  for (const patch of [{ summary: " " }, { summary: undefined }, { nextFocus: "caller.ts" }, { nextFocus: [" " ] }, { needsMoreRounds: "false" }, { coverage: [2] }, { blockers: null }, { unresolvedQuestions: [""] }]) {
    assert.match((await tool.execute({ ...valid, ...patch })).text, /^ERROR:/);
    assert.deepEqual(outcome, { summary: "", nextFocus: [], needsMoreRounds: false, submitted: false });
  }
  assert.equal((await tool.execute(valid)).terminate, true);
  assert.deepEqual(outcome, { ...valid, submitted: true, coverage: [], unresolvedQuestions: [], blockers: [] });
  assert.match((await tool.execute(valid)).text, /^ERROR:/);
  const another = { summary: "", nextFocus: [], needsMoreRounds: false, submitted: false };
  await createFinishRoundTool(another).execute({ ...valid, needsMoreRounds: true, coverage: ["counter.ts"], unresolvedQuestions: ["caller reachability"], blockers: ["missing generated caller"] });
  assert.equal(another.needsMoreRounds, true);
  assert.deepEqual(another.coverage, ["counter.ts"]);
});

test("submit_verdict rejects invalid confidence, rationale, enums and assessments atomically", async () => {
  const collector = {};
  const tool = createSubmitVerdictTool(collector, ["known", "second"]);
  const valid = { verdict: "confirmed", rationale: "Current changed path reaches a failure", confidence: 0.9 };
  for (const patch of [
    { verdict: "maybe" }, { rationale: " " }, { rationale: 1 },
    ...[NaN, Infinity, -0.1, 1.1, "0.7", null].map((confidence) => ({ confidence })),
    { decisionAssessments: [{ memoryId: "unknown", stillApplies: true }] },
    { decisionAssessments: [{ memoryId: "known", stillApplies: true }, { memoryId: "known", stillApplies: false }] },
    { decisionAssessments: [{ memoryId: "known", stillApplies: "false" }] },
    { decisionAssessments: [{ memoryId: "known", stillApplies: true, rationale: " " }] },
    { decisionAssessments: {} }, { priorDecisionStillApplies: true },
    { codeFeedback: "x".repeat(2001) }, { codeFeedback: " " },
    { uncertaintyReason: "unknown" }, { uncertaintyReason: "tool-limit" },
  ]) {
    assert.match((await tool.execute({ ...valid, ...patch })).text, /^ERROR:/);
    assert.deepEqual(collector, {});
  }
  const assessments = [{ memoryId: "known", stillApplies: false }, { memoryId: "second", stillApplies: true, rationale: "Exact trigger unchanged" }];
  assert.equal((await tool.execute({ ...valid, decisionAssessments: assessments })).terminate, true);
  assert.deepEqual(collector.verdict.decisionAssessments, assessments);
  assert.match((await tool.execute(valid)).text, /^ERROR:/);
});

test("single-ID legacy boolean is compatible but cannot conflict or suppress unknown history", async () => {
  const collector = {};
  const tool = createSubmitVerdictTool(collector, ["known"]);
  const valid = { verdict: "confirmed", rationale: "Real defect but historically accepted" };
  assert.match((await tool.execute({ ...valid, priorDecisionStillApplies: "false" })).text, /^ERROR:/);
  assert.match((await tool.execute({ ...valid, priorDecisionStillApplies: true, decisionAssessments: [{ memoryId: "known", stillApplies: false }] })).text, /^ERROR:/);
  assert.deepEqual(collector, {});
  assert.equal((await tool.execute({ ...valid, priorDecisionStillApplies: true })).terminate, true);
  assert.deepEqual(collector.verdict.decisionAssessments, [{ memoryId: "known", stillApplies: true }]);
  for (const ids of [undefined, []]) {
    const fixCollector = {};
    const fixTool = createSubmitVerdictTool(fixCollector, ids);
    assert.match((await fixTool.execute({ ...valid, priorDecisionStillApplies: false })).text, /^ERROR:/);
    assert.match((await fixTool.execute({ ...valid, decisionAssessments: [{ memoryId: "known", stillApplies: true }] })).text, /^ERROR:/);
    assert.equal((await fixTool.execute({ verdict: "rejected", rationale: "Original trigger no longer reproduces" })).terminate, true);
    assert.equal(fixCollector.verdict.confidence, 0.7);
  }
});

test("uncertain verdict uses classified reason and caps code-only feedback", async () => {
  const collector = {};
  await createSubmitVerdictTool(collector).execute({ verdict: "uncertain", rationale: "Caller not available", confidence: 0, codeFeedback: "x".repeat(2000) });
  assert.equal(collector.verdict.uncertaintyReason, "missing-evidence");
  assert.equal(collector.verdict.codeFeedback.length, 2000);
  const limited = {};
  await createSubmitVerdictTool(limited).execute({ verdict: "uncertain", rationale: "Read limit reached", uncertaintyReason: "tool-limit" });
  assert.equal(limited.verdict.uncertaintyReason, "tool-limit");
});

test("issue-memory lookup uses claim matching and preserves IDs, triggers and staleness", async () => {
  const relevant = { id: "issue-7", decision: "accepted_risk", scope: "symbol", source: "user_explicit", entityKey: "next", category: "correctness", claim: "increment returns the wrong value", trigger: "one call", rationale: "team rationale", stale: true, anchorPaths: ["src/next.ts"] };
  const unrelated = { ...relevant, id: "issue-8", claim: "socket authentication token expires", trigger: "expired token", anchorPaths: ["src/auth.ts"] };
  const memory = { issues: { byFingerprint: () => [], matchingScope: () => [relevant, unrelated], recent: () => [relevant, unrelated] } };
  const tool = createVerifierMemoryTools({ memory }).find((entry) => entry.name === "get_relevant_issue_memory");
  const result = await tool.execute({ claim: relevant.claim, category: "correctness", entityKey: "next" });
  const entries = result.text.split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].memoryId, relevant.id);
  assert.equal(entries[0].trigger, relevant.trigger);
  assert.equal(entries[0].stale, true);
  assert.ok(!(await tool.execute({ claim: "unrelated graphics polygon rendering" })).text.includes("issue-7"));
  assert.match((await tool.execute({})).text, /^ERROR:/);
});
