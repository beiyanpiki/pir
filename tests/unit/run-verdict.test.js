import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerdict, computeRunVerdict, createReviewState } from "../../dist/core/review-state.js";
import { renderAuditResultText, renderFindResultText } from "../../dist/app/output.js";
import { buildIdentity } from "../../dist/findings/identity.js";

// Minimal VerifiedFinding: computeRunVerdict only reads status/severity/category.
function finding(overrides = {}) {
  return { status: "confirmed", severity: "P2", category: "correctness", ...overrides };
}

function stateWith(findings) {
  const state = createReviewState("base", "head", 2);
  state.verified.push(...findings);
  return state;
}

test("computeRunVerdict truth table (Q4)", () => {
  assert.equal(computeRunVerdict(stateWith([])), "correct");
  // rejections and decision-suppressed findings are not reported and cannot move the verdict
  assert.equal(computeRunVerdict(stateWith([finding({ status: "rejected" })])), "correct");
  assert.equal(computeRunVerdict(stateWith([finding({ status: "false_positive" })])), "correct");
  assert.equal(computeRunVerdict(stateWith([finding({ status: "wont_fix" })])), "correct");
  // uncertain with nothing confirmed → needs-review
  assert.equal(computeRunVerdict(stateWith([finding({ status: "uncertain" })])), "needs-review");
  assert.equal(
    computeRunVerdict(stateWith([finding({ status: "rejected" }), finding({ status: "uncertain" })])),
    "needs-review",
  );
  // confirmed but nothing at P0/P1 → correct-with-findings
  assert.equal(computeRunVerdict(stateWith([finding({})])), "correct-with-findings");
  assert.equal(computeRunVerdict(stateWith([finding({ severity: "P3" })])), "correct-with-findings");
  // any confirmed non-style P0/P1 → incorrect
  assert.equal(computeRunVerdict(stateWith([finding({ severity: "P0" })])), "incorrect");
  assert.equal(computeRunVerdict(stateWith([finding({ severity: "P1" })])), "incorrect");
  assert.equal(
    computeRunVerdict(stateWith([finding({ severity: "P3" }), finding({ severity: "P1", confidence: 0.4 })])),
    "incorrect",
  );
  // style never flips incorrect, even at P0 (verdict ignores style, mirroring Codex)
  assert.equal(computeRunVerdict(stateWith([finding({ severity: "P0", category: "style" })])), "correct-with-findings");
});

function candidate() {
  const identity = buildIdentity({
    featureKey: "f",
    entityKey: "E.fn",
    category: "correctness",
    claim: "claim one",
    trigger: "trigger one",
  });
  return {
    title: "t",
    claim: "claim one",
    trigger: "trigger one",
    category: "correctness",
    severity: "P1",
    anchors: [],
    evidence: [],
    round: 1,
    identity,
  };
}

test("applyVerdict copies the verdict's confidence onto the verified finding (Q4)", () => {
  const state = createReviewState("base", "head", 2);
  const finding = applyVerdict(state, candidate(), { verdict: "confirmed", rationale: "real", confidence: 0.82 }, []);
  assert.equal(finding.confidence, 0.82);
  // fallback verdicts carry confidence 0 (verifier.ts) and flow through the same path
  const fallback = applyVerdict(createReviewState("base", "head", 2), candidate(), { verdict: "uncertain", rationale: "no session", confidence: 0, uncertaintyReason: "provider-error" }, []);
  assert.equal(fallback.confidence, 0);
});

// Minimal FindingView for the renderer tests.
function view(overrides = {}) {
  return {
    id: "id-1",
    displayId: "F-1",
    title: "t",
    claim: "c",
    trigger: "tr",
    category: "correctness",
    severity: "P1",
    status: "confirmed",
    featureKey: null,
    entityKey: null,
    anchors: [],
    evidence: [],
    memoryMatches: [],
    verifierRationale: null,
    confidence: null,
    round: 1,
    createdAt: 1,
    ...overrides,
  };
}

test("renderFindResultText renders the run verdict and the low-confidence split (Q4)", () => {
  const high = view({ displayId: "F-1", title: "high" });
  const low = view({ displayId: "F-2", title: "low", confidence: 0.4 });

  // Without the option the output is exactly the historical shape.
  const plain = renderFindResultText({
    degraded: false,
    rounds: [],
    findings: [high],
    stoppedBecause: "reviewer signaled completion",
  });
  assert.ok(!plain.includes("run verdict:"));
  assert.ok(!plain.includes("Low-confidence"));
  assert.match(plain, /Findings \(1\):/);

  const split = renderFindResultText({
    degraded: false,
    rounds: [],
    findings: [high, low],
    stoppedBecause: "reviewer signaled completion",
    runVerdict: "incorrect",
    minConfidence: 0.7,
    lowConfidenceFindings: [low],
  });
  assert.match(split, /run verdict: incorrect/);
  assert.match(split, /Findings \(1\):/);
  const mainSection = split.slice(split.indexOf("Findings (1):"), split.indexOf("Low-confidence"));
  assert.ok(mainSection.includes("F-1") && !mainSection.includes("F-2"), "low-confidence finding not in the main section");
  assert.match(split, /Low-confidence \(verifier confidence below 0\.7\) \(1\):/);
  assert.match(split, /F-2 \[P1\/confirmed\] low/);

  // Everything below the threshold: no empty main section, only the split.
  const allLow = renderFindResultText({
    degraded: false,
    rounds: [],
    findings: [low],
    stoppedBecause: "done",
    runVerdict: "correct-with-findings",
    minConfidence: 0.7,
    lowConfidenceFindings: [low],
  });
  assert.ok(!allLow.includes("Findings (0)"));
  assert.ok(!allLow.includes("No confirmed findings."));
  assert.match(allLow, /Low-confidence \(verifier confidence below 0\.7\) \(1\):/);
});

test("renderAuditResultText renders the same split (Q4)", () => {
  const coverage = {
    filesTotal: 1, filesInScope: 1, filesReviewed: 1, filesPartial: 0,
    filesUnreviewed: 0, filesBlocked: 0, filesFailed: 0, filesExcluded: 0,
    filesNotSelected: 0, batchesTotal: 1, batchesCompleted: 1,
  };
  const low = view({ displayId: "F-9", title: "audit low", confidence: 0.2 });
  const text = renderAuditResultText({
    degraded: false,
    dirtyWorktree: false,
    coverage,
    findings: [low],
    stoppedBecause: "audit discovery complete",
    incomplete: false,
    incompleteReasons: [],
    runVerdict: "correct-with-findings",
    minConfidence: 0.5,
    lowConfidenceFindings: [low],
  });
  assert.match(text, /run verdict: correct-with-findings/);
  assert.match(text, /Low-confidence \(verifier confidence below 0\.5\) \(1\):/);
  assert.match(text, /F-9 \[P1\/confirmed\] audit low/);
});
