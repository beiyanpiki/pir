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
