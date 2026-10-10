import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Memory } from "../../dist/memory/index.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

const QUERY = {
  category: "correctness",
  anchorPaths: ["src/pay.ts"],
  normalizedClaim: "retry quota consumed without remote attempt",
};

function seedIssue(memory, overrides = {}) {
  return memory.issues.insert({
    featureKey: "payment-retry",
    entityKey: "PaymentService.retry",
    fingerprint: `fp-${Math.random().toString(36).slice(2)}`,
    category: "correctness",
    claim: "retry quota consumed without a remote attempt",
    trigger: "gateway exception before charge",
    decision: "false_positive",
    priority: null,
    rationale: "team assessed this pattern as intentional",
    scope: "project",
    source: "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
    anchorPaths: ["src/pay.ts"],
    ...overrides,
  });
}

async function openMemory(repo) {
  return Memory.open(repo.dir, { dbPath: path.join(repo.dir, ".pir-test-memory.sqlite") });
}

test("similarDismissed: suppressive decisions only; confirmed is not a dismissal", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    seedIssue(memory, { decision: "confirmed" });
    seedIssue(memory, { decision: "expected", entityKey: "Other.fn" });
    seedIssue(memory, { decision: "false_positive" });
    seedIssue(memory, { decision: "accepted_risk", entityKey: "Other.fn" });
    seedIssue(memory, { decision: "wont_fix", entityKey: "Other.fn" });
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 4);
    assert.ok(result.samples.every((sample) => sample.decision !== "confirmed"));
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("similarDismissed: category mismatch is excluded", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    seedIssue(memory, { category: "style" });
    seedIssue(memory, { category: "  Correctness " });
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 1);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("similarDismissed: shared anchor path matches regardless of claim overlap", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    seedIssue(memory, { claim: "something entirely different about billing invoices", anchorPaths: ["src/pay.ts"] });
    seedIssue(memory, { claim: "something entirely different about billing invoices", anchorPaths: ["src/other.ts"] });
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 1);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("similarDismissed: overlap threshold edges — 0.5 included, 1/3 excluded, minOverlap raises the bar", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    // Query has 6 tokens; claimOverlap = |∩| / min(|A|,|B|).
    // "retry gateway": ∩={retry}, min(2,6)=2 → exactly 0.5 → included by default.
    const half = seedIssue(memory, { claim: "retry gateway", anchorPaths: ["src/unrelated.ts"] });
    // "retry alpha beta": ∩={retry}, min(3,6)=3 → 1/3 → excluded by default.
    const third = seedIssue(memory, { claim: "retry alpha beta", anchorPaths: ["src/unrelated.ts"] });
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 1);
    assert.equal(result.samples[0].id, half.id);
    assert.ok(Math.abs(result.samples[0].overlap - 0.5) < 1e-9);
    const tight = memory.issues.similarDismissed(QUERY, { minOverlap: 0.6 });
    assert.equal(tight.count, 0);
    assert.ok(third);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("similarDismissed: stale entries are counted and flagged, not excluded", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    seedIssue(memory, { stale: true, decision: "wont_fix" });
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 1);
    assert.equal(result.samples[0].stale, true);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("similarDismissed: samples capped at 3 (default) with the highest overlap first", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    // Overlap 1.0 (identical claim).
    const strongest = seedIssue(memory, { claim: "retry quota consumed without remote attempt", anchorPaths: ["src/unrelated.ts"], entityKey: "Other.fn" });
    // Overlap 0.5 each (2-token claim sharing "retry" with the 6-token query).
    for (const token of ["x1", "x2", "x3", "x4"]) {
      seedIssue(memory, { claim: `retry ${token}`, anchorPaths: ["src/unrelated.ts"], entityKey: "Other.fn" });
    }
    const result = memory.issues.similarDismissed(QUERY);
    assert.equal(result.count, 5);
    assert.equal(result.samples.length, 3);
    assert.equal(result.samples[0].id, strongest.id);
    assert.ok(result.samples[0].overlap > result.samples[1].overlap);
  } finally {
    memory.close();
    repo.cleanup();
  }
});
