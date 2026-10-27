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

test("B4: a change-mode rejection must name its ground, and unknown wording normalizes to other", async () => {
  const rejected = { verdict: "rejected", rationale: "The caller guards this path at src/next.ts:2", confidence: 0.8 };
  const required = createSubmitVerdictTool({}, undefined, undefined, { requireRejectionGround: true });
  const missing = await required.execute(rejected);
  assert.match(missing.text, /rejectionGround is required/);
  assert.match(missing.text, /no-such-code, contradicted-by-code/, "the error lists the vocabulary so a retry can comply");
  // A vocabulary miss is recorded, never a dead session: the ground is normalized.
  const unknown = {};
  assert.equal((await createSubmitVerdictTool(unknown, undefined, undefined, { requireRejectionGround: true }).execute({ ...rejected, rejectionGround: "because I said so" })).terminate, true);
  assert.equal(unknown.verdict.rejectionGround, "other");
  const canonical = {};
  await createSubmitVerdictTool(canonical, undefined, undefined, { requireRejectionGround: true }).execute({ ...rejected, rejectionGround: "  Guarded " });
  assert.equal(canonical.verdict.rejectionGround, "guarded");
  // An empty ground is malformed, not "other".
  assert.match((await required.execute({ ...rejected, rejectionGround: "   " })).text, /nonempty/);
  // Non-rejected verdicts keep today's contract and carry no ground.
  const confirmed = {};
  await createSubmitVerdictTool(confirmed, undefined, undefined, { requireRejectionGround: true }).execute({ verdict: "confirmed", rationale: "Failure reachable from src/next.ts:2" });
  assert.equal(confirmed.verdict.rejectionGround, undefined);
  // Audit mode has no attribution grounds: the requirement stays off.
  const audit = {};
  assert.equal((await createSubmitVerdictTool(audit).execute(rejected)).terminate, true);
  assert.equal(audit.verdict.rejectionGround, undefined);
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
// ---------------------------------------------------------------------------
// B2: snippet-anchored location correction
// ---------------------------------------------------------------------------

/**
 * 25-line head file with a distinctive 3-line target block at lines 10-12 and
 * one line (3 and 20) repeated twice so excerpt ambiguity is real.
 */
function driftFixture() {
  const repo = createTempGitRepo("pir-drift-");
  const lines = Array.from({ length: 25 }, (_, index) => `const filler${index + 1} = ${index + 1};`);
  lines[2] = "const duplicate = true;";
  lines[19] = "const duplicate = true;";
  lines[9] = "function computeTotal(items) {";
  lines[10] = "  const total = items.reduce((sum, item) => sum + item.price, 1);";
  lines[11] = "  return total * rate;";
  repo.write("src/total.ts", `${lines.join("\n")}\n`);
  const base = repo.commit("drift baseline");
  lines[10] = "  const total = items.reduce((sum, item) => sum + item.price, 0);";
  repo.write("src/total.ts", `${lines.join("\n")}\n`);
  const head = repo.commit("drift changed snapshot");
  const ctx = { repoRoot: repo.dir, headCommit: head, changeSet: { base, head, baseCommit: base, headCommit: head, mergeBase: base, files: [{ path: "src/total.ts", status: "modified" }], patch: "" }, codeMap: { structuralQueries: false }, memory: null };
  return {
    repo, ctx,
    target: { path: "src/total.ts", startLine: 10, endLine: 12 },
    excerpt: ["function computeTotal(items) {", "  const total = items.reduce((sum, item) => sum + item.price, 0);", "  return total * rate;"].join("\n"),
    cleanup: () => repo.cleanup(),
  };
}

function driftCandidate(drift, excerpt) {
  return {
    title: "Rate applied too late",
    claim: "The running total ignores the per-item rate",
    trigger: "Calling computeTotal once",
    category: "correctness",
    severity: "P1",
    anchors: [{ path: "src/total.ts", startLine: 10 + drift, endLine: 12 + drift, ...(excerpt === undefined ? {} : { excerpt }) }],
    evidence: [{ kind: "code", path: "src/total.ts", startLine: 11, excerpt: "sum + item.price" }],
  };
}

test("excerpt locate corrects ±5-line drift on every fixture and keeps the original range (B2)", async () => {
  const f = driftFixture();
  try {
    const corrections = [];
    const collector = { candidates: [], onLineCorrected: (correction) => corrections.push(correction) };
    const tool = createRecordCandidateTool(f.ctx, collector, 1);
    const drifts = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    let corrected = 0;
    for (const drift of drifts) {
      const output = await tool.execute(driftCandidate(drift, f.excerpt));
      assert.ok(!output.text.startsWith("ERROR"), `drift ${drift}: ${output.text}`);
      const anchor = collector.candidates.at(-1).anchors[0];
      assert.equal(anchor.startLine, f.target.startLine, `drift ${drift}`);
      assert.equal(anchor.endLine, f.target.endLine, `drift ${drift}`);
      assert.equal(anchor.lineCorrected, true, `drift ${drift}`);
      assert.equal(anchor.originalStartLine, f.target.startLine + drift, `drift ${drift}`);
      assert.equal(anchor.originalEndLine, f.target.endLine + drift, `drift ${drift}`);
      assert.equal(anchor.excerpt, f.excerpt, `drift ${drift}`);
      if (anchor.lineCorrected) corrected += 1;
    }
    // A1: correction success rate over the ±5-line drift fixtures (11/11).
    assert.equal(`${corrected}/${drifts.length}`, "11/11");
    assert.equal(corrections.length, drifts.length);
    assert.deepEqual(corrections[0], {
      displayId: "F-101", path: "src/total.ts",
      originalStartLine: 5, originalEndLine: 7, startLine: 10, endLine: 12,
    });

    // Drift past EOF is still corrected: a present excerpt decides the range,
    // so the model's numbers are kept as original* without a bounds check.
    const far = await tool.execute(driftCandidate(20, f.excerpt));
    assert.ok(!far.text.startsWith("ERROR"), far.text);
    const farAnchor = collector.candidates.at(-1).anchors[0];
    assert.deepEqual([farAnchor.startLine, farAnchor.endLine, farAnchor.originalStartLine], [10, 12, 30]);

    // A single-line excerpt collapses to startLine with no endLine/originalEndLine.
    const single = await tool.execute({ ...driftCandidate(4, undefined), anchors: [{ path: f.target.path, startLine: 16, excerpt: "  return total * rate;" }] });
    assert.ok(!single.text.startsWith("ERROR"), single.text);
    const singleAnchor = collector.candidates.at(-1).anchors[0];
    assert.deepEqual(Object.keys(singleAnchor), ["path", "startLine", "excerpt", "lineCorrected", "originalStartLine"]);
    assert.equal(singleAnchor.startLine, 12);
    assert.equal(singleAnchor.originalStartLine, 16);
  } finally { f.cleanup(); }
});

test("an unlocatable excerpt is a tool-boundary error: zero hits, multiple hits, no partial record (B2)", async () => {
  const f = driftFixture();
  try {
    const corrections = [];
    const collector = { candidates: [], onLineCorrected: (correction) => corrections.push(correction) };
    const tool = createRecordCandidateTool(f.ctx, collector, 2);

    const none = await tool.execute(driftCandidate(0, "const nowhere = true;"));
    assert.match(none.text, /^ERROR:/);
    assert.match(none.text, /was not found in src\/total\.ts/);
    const multiple = await tool.execute(driftCandidate(0, "const duplicate = true;"));
    assert.match(multiple.text, /^ERROR:/);
    assert.match(multiple.text, /matches 2 locations in src\/total\.ts/);

    // One bad anchor rejects the whole candidate, even when a later anchor
    // would have located (and even though the first never mutated anything).
    const mixed = await tool.execute({
      ...driftCandidate(0, f.excerpt),
      anchors: [{ path: f.target.path, startLine: 10, endLine: 12, excerpt: "const nowhere = true;" }, { path: f.target.path, startLine: 10, endLine: 12, excerpt: f.excerpt }],
    });
    assert.match(mixed.text, /^ERROR:/);
    assert.deepEqual(collector.candidates, []);
    assert.deepEqual(corrections, [], "a rejected submission reports no correction");
  } finally { f.cleanup(); }
});

test("no-excerpt anchors are byte-identical: output, anchor keys and events (B2)", async () => {
  const f = driftFixture();
  try {
    const corrections = [];
    const collector = { candidates: [], onLineCorrected: (correction) => corrections.push(correction) };
    const tool = createRecordCandidateTool(f.ctx, collector, 3);
    const output = await tool.execute(driftCandidate(0, undefined));
    assert.equal(output.text, "Recorded candidate F-301: Rate applied too late");
    assert.equal(output.terminate, undefined);
    const candidate = collector.candidates[0];
    // Pre-B2 anchor shape: same keys, same order, same JSON.
    assert.deepEqual(Object.keys(candidate.anchors[0]), ["path", "startLine", "endLine"]);
    assert.equal(JSON.stringify(candidate.anchors), '[{"path":"src/total.ts","startLine":10,"endLine":12}]');
    assert.deepEqual(corrections, []);
  } finally { f.cleanup(); }
});

test("record_candidate flags an exact duplicate of prior-round knowledge without suppressing it (S5/ADR-0014)", async () => {
  const f = fixture();
  try {
    const first = { candidates: [] };
    const original = { ...validCandidate(), severity: "P2" };
    assert.equal((await createRecordCandidateTool(f.ctx, first, 1).execute(original)).text, "Recorded candidate F-101: Wrong increment");
    const known = first.candidates;

    const second = { candidates: [], known };
    const tool = createRecordCandidateTool(f.ctx, second, 2);
    const upgraded = await tool.execute({ ...validCandidate(), severity: "P0" });
    assert.equal(upgraded.duplicateOf, "F-101");
    assert.equal(upgraded.terminate, undefined);
    assert.equal(upgraded.text, [
      "Recorded candidate F-201: Wrong increment",
      "Accepted and recorded for deduplication. It overlaps an existing finding (F-101) by fingerprint. If it is materially different, state the difference in the claim/trigger. Do not resubmit the same finding.",
    ].join("\n"));
    // Visibility only: the candidate is stored exactly as submitted (severity
    // included) and prior-round knowledge stays a read-only baseline.
    assert.equal(second.candidates.length, 1);
    assert.equal(second.candidates[0].severity, "P0");
    assert.equal(second.candidates[0].displayId, "F-201");
    assert.deepEqual(known.map((entry) => entry.displayId), ["F-101"]);

    // A distinct defect still gets the pre-S5 result, byte for byte.
    const distinct = await tool.execute({ ...validCandidate(), title: "Guard is inverted", claim: "The guard rejects valid input", trigger: "Calling next with a zero" });
    assert.equal(distinct.text, "Recorded candidate F-202: Guard is inverted");
    assert.equal(distinct.duplicateOf, undefined);

    // A candidate rejected by validation reports no hint and mutates nothing.
    const before = second.candidates.length;
    const invalid = await tool.execute({ ...validCandidate(), anchors: [{ path: "../outside.ts", startLine: 1 }] });
    assert.match(invalid.text, /^ERROR:/);
    assert.equal(invalid.duplicateOf, undefined);
    assert.equal(second.candidates.length, before);
  } finally { f.cleanup(); }
});

test("the duplicate hint covers entity+claim near-duplicates and honors the strict prior-round gates (S5/ADR-0014)", async () => {
  const f = fixture();
  const entityKey = "src/next.ts::next";
  const claim = "the running total ignores the per item rate in the shared compute path";
  try {
    const first = { candidates: [] };
    await createRecordCandidateTool(f.ctx, first, 1).execute({ ...validCandidate(), claim, entityKey });
    const known = first.candidates;

    // Same entityKey and category, one extra word: fingerprints differ,
    // claim similarity is above the dedup threshold.
    const near = { candidates: [], known };
    const output = await createRecordCandidateTool(f.ctx, near, 2).execute({ ...validCandidate(), claim: `${claim} always`, entityKey });
    assert.equal(output.duplicateOf, "F-101");
    assert.match(output.text, /overlaps an existing finding \(F-101\) by claim similarity/);

    // The strict rule survives three ways: a different category, a different
    // entity, and no entity at all are each not a hint baseline match.
    const otherCategory = { candidates: [], known };
    const category = await createRecordCandidateTool(f.ctx, otherCategory, 2).execute({ ...validCandidate(), claim: `${claim} always`, entityKey, category: "security" });
    assert.equal(category.duplicateOf, undefined);
    assert.equal(category.text, "Recorded candidate F-201: Wrong increment");
    const otherEntity = { candidates: [], known };
    const entity = await createRecordCandidateTool(f.ctx, otherEntity, 2).execute({ ...validCandidate(), claim: `${claim} always`, entityKey: "src/other.ts::next" });
    assert.equal(entity.duplicateOf, undefined);
    const noEntity = { candidates: [], known };
    const anon = await createRecordCandidateTool(f.ctx, noEntity, 2).execute({ ...validCandidate(), claim: `${claim} always` });
    assert.equal(anon.duplicateOf, undefined);
  } finally { f.cleanup(); }
});

test("parallel angle sessions never see each other's same-round candidates (S5/ADR-0014)", async () => {
  const f = fixture();
  try {
    const known = [];
    const angleA = { candidates: [], known };
    const angleB = { candidates: [], known };
    const first = await createRecordCandidateTool(f.ctx, angleA, 1).execute(validCandidate());
    assert.equal(first.duplicateOf, undefined);
    // B re-records the same defect: same-round peers stay supervisor-only, so
    // the hint cannot fire and the session-local id is unchanged.
    const peer = await createRecordCandidateTool(f.ctx, angleB, 1).execute(validCandidate());
    assert.equal(peer.duplicateOf, undefined);
    assert.equal(peer.text, "Recorded candidate F-101: Wrong increment");
    // A does see its own earlier candidate.
    const own = await createRecordCandidateTool(f.ctx, angleA, 1).execute(validCandidate());
    assert.equal(own.duplicateOf, "F-101");
    assert.match(own.text, /Accepted and recorded for deduplication/);
    assert.equal(known.length, 0, "the shared knowledge baseline is never written by a session");
  } finally { f.cleanup(); }
});

