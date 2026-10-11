import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentity } from "../../dist/findings/identity.js";
import { deduplicateCandidates } from "../../dist/findings/dedup.js";

function candidate(claim, opts = {}) {
  return {
    title: claim.slice(0, 40),
    claim,
    trigger: opts.trigger ?? "t",
    category: opts.category ?? "correctness",
    severity: "P2",
    entityKey: opts.entityKey ?? "PaymentService.retry",
    anchors: [],
    evidence: [],
    round: 1,
    identity: buildIdentity({
      featureKey: opts.featureKey ?? "payment-retry",
      entityKey: opts.entityKey ?? "PaymentService.retry",
      category: opts.category ?? "correctness",
      claim,
      trigger: opts.trigger ?? "t",
    }),
  };
}

test("exact fingerprint duplicates collapse", () => {
  const a = candidate("quota consumed without remote attempt");
  const b = candidate("quota consumed without remote attempt");
  const result = deduplicateCandidates([a, b]);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("near-duplicate rewording collapses within same entity/category", () => {
  const a = candidate("retry quota is consumed without an actual remote gateway attempt");
  const b = candidate("retry quota consumed without an actual remote gateway attempt", { trigger: "different trigger" });
  const result = deduplicateCandidates([a, b]);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("different entities do not collapse", () => {
  const a = candidate("retry quota is consumed without an actual remote gateway attempt");
  const b = candidate("retry quota is consumed without an actual remote gateway attempt", {
    entityKey: "RetryCoordinator.execute",
  });
  const result = deduplicateCandidates([a, b]);
  assert.equal(result.fresh.length, 2);
});

test("known findings from previous rounds dedup against new ones", () => {
  const known = [candidate("same problem here")];
  const again = candidate("same problem here");
  const result = deduplicateCandidates([again], known);
  assert.equal(result.fresh.length, 0);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].of, known[0]);
});

test("cross-angle near-duplicates collapse across category labels; knowledge stays strict (dogfood F-132)", () => {
  const base = { title: "t", claim: "quota consumed without attempt", trigger: "gateway exception", anchors: [], evidence: [], round: 1 };
  const a = { ...base, category: "concurrency", severity: "P1", entityKey: "Pay.retry", identity: buildIdentity({ featureKey: "pay", entityKey: "Pay.retry", category: "concurrency", claim: base.claim, trigger: base.trigger }) };
  const b = { ...base, category: "performance", severity: "P2", entityKey: "Pay.retry", identity: buildIdentity({ featureKey: "pay", entityKey: "Pay.retry", category: "performance", claim: base.claim, trigger: base.trigger }) };
  // Default (single-session) semantics: different categories are different findings.
  const strict = deduplicateCandidates([a, b]);
  assert.equal(strict.fresh.length, 2);
  // Cross-angle fan-out: parallel sessions label the same defect with their
  // own category — same entity + near-identical claim collapses.
  const relaxed = deduplicateCandidates([a, b], [], { crossAngle: true });
  assert.equal(relaxed.fresh.length, 1);
  assert.equal(relaxed.duplicates.length, 1);
  // Against prior-round knowledge the gate stays strict even in fan-out mode.
  const prior = deduplicateCandidates([a], [], { crossAngle: true });
  const against = deduplicateCandidates([b], prior.fresh, { crossAngle: true });
  assert.equal(against.fresh.length, 1);
});

test("cross-angle collapse keeps the more severe occurrence (dogfood F-135)", () => {
  const make = (category, severity) => ({
    title: "t", claim: "quota consumed without attempt", trigger: "gateway exception",
    category, severity, entityKey: "Pay.retry", anchors: [], evidence: [], round: 1,
    identity: buildIdentity({ featureKey: "pay", entityKey: "Pay.retry", category, claim: "quota consumed without attempt", trigger: "gateway exception" }),
  });
  const p2 = make("concurrency", "P2");
  const p0 = make("performance", "P0");
  const result = deduplicateCandidates([p2, p0], [], { crossAngle: true });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].severity, "P0", "the more severe occurrence survives");
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].candidate.severity, "P2");
});
