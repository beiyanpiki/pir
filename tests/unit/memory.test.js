import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Memory } from "../../dist/memory/index.js";
import { applyFeedback } from "../../dist/memory/feedback.js";
import { rememberKnowledge } from "../../dist/memory/remember.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

async function openMemory(repo) {
  const dbPath = path.join(repo.dir, ".pir-test-memory.sqlite");
  return Memory.open(repo.dir, { dbPath });
}

function seedFinding(memory, overrides = {}) {
  const identity = buildIdentity({
    featureKey: overrides.featureKey ?? "payment-retry",
    entityKey: overrides.entityKey ?? "PaymentService.retry",
    category: "correctness",
    claim: overrides.claim ?? "retry quota consumed without a remote attempt",
    trigger: "gateway exception before charge",
  });
  return memory.findings.insert(
    {
      title: "retry quota bug",
      claim: identity.normalizedClaim,
      trigger: "gateway exception before charge",
      category: "correctness",
      severity: "P1",
      featureKey: overrides.featureKey ?? "payment-retry",
      entityKey: overrides.entityKey ?? "PaymentService.retry",
      anchors: [{ path: "src/pay.ts", startLine: 12 }],
      evidence: [{ kind: "code", path: "src/pay.ts", startLine: 12, excerpt: "quota++" }],
      round: 1,
      identity,
      status: "confirmed",
      memoryMatches: [],
    },
    "run-1",
  );
}

test("five-layer memory: write/read/update/invalidate/history", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("src/pay.ts", "export const x = 1;");
    const commit = repo.commit("init");

    // project layer
    memory.projectMemory.upsert({
      architectureSummary: "API -> Service -> Repo",
      responsibilities: ["payments"],
      invariants: ["ledger entries are append-only"],
      conventions: [],
      riskAreas: [],
      featureKeys: ["payment-retry"],
      source: "agent_summary",
      createdAtCommit: commit,
      validatedAtCommit: commit,
      stale: false,
    });
    const project = memory.projectMemory.get();
    assert.equal(project.invariants[0], "ledger entries are append-only");

    // feature layer
    memory.features.upsert({
      key: "payment-retry",
      name: "Payment Retry",
      summary: "retries failed payments",
      responsibilities: [],
      invariants: ["retries consume quota per attempt"],
      entryPoints: ["POST /payment/:id/retry"],
      dependencies: [],
      relatedFeatureKeys: [],
      source: "agent_summary",
      confidence: 0.6,
      createdAtCommit: commit,
      validatedAtCommit: commit,
      stale: false,
    });
    assert.equal(memory.features.get("payment-retry").name, "Payment Retry");

    // entity layer
    memory.entities.upsert({
      symbolKey: "PaymentService.retry",
      qualifiedName: "PaymentService.retry",
      kind: "method",
      path: "src/pay.ts",
      signature: "retry(id: string): Promise<void>",
      responsibilities: ["coordinates one retry attempt"],
      invariants: [],
      notes: [],
      featureKeys: ["payment-retry"],
      source: "agent_summary",
      signatureHash: null,
      bodyHash: "abc",
      lastSeenCommit: commit,
      stale: false,
    });
    assert.equal(memory.entities.byPaths(["src/pay.ts"]).length, 1);

    // issue layer
    memory.issues.insert({
      featureKey: "payment-retry",
      entityKey: "PaymentService.retry",
      fingerprint: "fp-1",
      category: "correctness",
      claim: "quota claim",
      trigger: "t",
      decision: "expected",
      priority: null,
      rationale: "user said intentional",
      scope: "symbol",
      source: "user_explicit",
      createdAtCommit: commit,
      validUntilCommit: null,
      stale: false,
    });
    assert.equal(memory.issues.byFingerprint("fp-1").length, 1);
    assert.equal(memory.issues.suppressionEvidence(memory.issues.byFingerprint("fp-1")).length, 1);

    // findings layer
    const row = seedFinding(memory);
    assert.equal(row.displayId, "F-1");
    const second = seedFinding(memory, { claim: "another issue", entityKey: "Other.fn" });
    assert.equal(second.displayId, "F-2");
    assert.ok(memory.findings.get("F-1"));
    assert.equal(memory.findings.evidence(row.id).length, 1);

    // version history (append-only audit)
    const versions = memory.store.all(
      "SELECT * FROM memory_versions WHERE memory_type = 'feature' ORDER BY version",
    );
    assert.ok(versions.length >= 1);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("applyFeedback: expected -> issue memory + status update + audit event", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("src/pay.ts", "x");
    const commit = repo.commit("init");
    const finding = seedFinding(memory);

    const result = await applyFeedback(memory, {
      findingId: finding.displayId,
      decision: "expected",
      note: "retry_count counts attempts, not successes",
      commit,
    });
    assert.equal(result.newStatus, "expected");
    assert.ok(result.issueMemoryId);

    const updated = memory.findings.get(finding.displayId);
    assert.equal(updated.status, "expected");

    const events = memory.findings.listFeedbackEvents(finding.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "mark_expected");

    const issues = memory.issues.byFingerprint(finding.fingerprint);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].decision, "expected");
    assert.equal(issues[0].source, "user_explicit");
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("applyFeedback: fixed -> unverified resolution, then verify marks it", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("src/pay.ts", "x");
    const commit = repo.commit("init");
    const finding = seedFinding(memory);
    await applyFeedback(memory, { findingId: finding.displayId, decision: "fixed", commit });

    const resolutions = memory.resolutions.byFindingId(finding.id);
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].verified, 0 || false);

    memory.resolutions.markVerified(resolutions[0].id, commit, commit);
    assert.equal(memory.resolutions.byFindingId(finding.id)[0].verified, true);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("agent_summary decisions never act as suppression evidence", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("a.ts", "x");
    const commit = repo.commit("init");
    memory.issues.insert({
      featureKey: null,
      entityKey: "Foo.bar",
      fingerprint: "fp-agent",
      category: "correctness",
      claim: "c",
      trigger: "t",
      decision: "wont_fix",
      priority: null,
      rationale: "agent decided",
      scope: "symbol",
      source: "agent_summary",
      createdAtCommit: commit,
      validUntilCommit: null,
      stale: false,
    });
    const matches = memory.issues.byEntity("Foo.bar");
    assert.equal(matches.length, 1);
    assert.equal(memory.issues.suppressionEvidence(matches).length, 0);
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("rememberKnowledge writes user_explicit memory at each scope", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("a.ts", "x");
    const commit = repo.commit("init");

    rememberKnowledge(memory, {
      scope: "project",
      kind: "invariant",
      text: "All financial write paths must be idempotent",
      commit,
    });
    rememberKnowledge(memory, {
      scope: "feature",
      target: "payment-retry",
      kind: "invariant",
      text: "Each retry attempt consumes quota before remote execution",
      commit,
    });
    rememberKnowledge(memory, {
      scope: "symbol",
      target: "PaymentService.retry",
      kind: "note",
      text: "gateway calls always count as attempts",
      commit,
    });

    assert.ok(memory.projectMemory.get().invariants.includes("All financial write paths must be idempotent"));
    assert.ok(memory.features.get("payment-retry").invariants.includes("Each retry attempt consumes quota before remote execution"));
    const entity = memory.entities.get("PaymentService.retry");
    assert.equal(entity.source, "user_explicit");
    assert.ok(entity.notes.includes("gateway calls always count as attempts"));
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("matchIssueHistory: fuzzy claim fallback catches reworded duplicates across key drift", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    const { matchIssueHistory } = await import("../../dist/memory/retrieval.js");
    const { buildIdentity } = await import("../../dist/findings/identity.js");

    // First run: reviewer supplied a feature key.
    const first = buildIdentity({
      featureKey: "payment-idempotency",
      entityKey: undefined,
      category: "correctness",
      claim: "The change removes the missing-key check and the duplicate-charge rejection, so charging twice returns ok both times",
      trigger: "repeated idempotency key",
    });
    memory.issues.insert({
      featureKey: "payment-idempotency",
      entityKey: null,
      fingerprint: first.fingerprint,
      category: "correctness",
      claim: "The change removes the missing-key check and the duplicate-charge rejection, so charging twice returns ok both times",
      trigger: "repeated idempotency key",
      decision: "accepted_risk",
      priority: null,
      rationale: "gateway dedupes upstream",
      scope: "feature",
      source: "user_explicit",
      anchorPaths: ["payment.ts"],
      createdAtCommit: null,
      validUntilCommit: null,
      stale: false,
    });

    // Second run: different fingerprint, no keys at all, and a drifted
    // category (correctness -> regression), as real reviewers do.
    const second = buildIdentity({
      featureKey: undefined,
      entityKey: undefined,
      category: "regression",
      claim: "The change removes the missing-key check and the duplicate-charge check, so repeated keyless charge calls always return ok",
      trigger: "keyless charge call",
    });
    const matched = matchIssueHistory(memory, {
      fingerprint: second.fingerprint,
      normalizedClaim: second.normalizedClaim,
      category: "regression",
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].decision, "accepted_risk");

    // Unrelated claims must not match — neither by wording...
    const other = buildIdentity({
      category: "regression",
      claim: "ledger entries are appended without balancing the books at month end",
      trigger: "cron",
    });
    assert.equal(
      matchIssueHistory(memory, { fingerprint: other.fingerprint, normalizedClaim: other.normalizedClaim, category: "regression" }).length,
      0,
    );
    // ...nor via path corroboration from a different file.
    assert.equal(
      matchIssueHistory(memory, {
        fingerprint: other.fingerprint,
        normalizedClaim: other.normalizedClaim,
        anchorPaths: ["src/ledger.ts"],
      }).length,
      0,
    );

    // Heavily reworded claim (overlap in the 0.35-0.6 band): matches ONLY
    // when the anchors point at the same file (path corroboration).
    const reworded = buildIdentity({
      category: "regression",
      claim: "guard for duplicate charges removed so the same key can be charged twice",
      trigger: "any second call",
    });
    assert.equal(
      matchIssueHistory(memory, {
        fingerprint: reworded.fingerprint,
        normalizedClaim: reworded.normalizedClaim,
        anchorPaths: ["payment.ts"],
      }).length,
      1,
    );
    assert.equal(
      matchIssueHistory(memory, {
        fingerprint: reworded.fingerprint,
        normalizedClaim: reworded.normalizedClaim,
        anchorPaths: ["src/checkout.ts"],
      }).length,
      0,
    );
  } finally {
    memory.close();
    repo.cleanup();
  }
});

test("freshness: hash mismatch marks entity stale, deletion invalidates", async () => {
  const repo = createTempGitRepo();
  const memory = await openMemory(repo);
  try {
    repo.write("src/pay.ts", "export const x = 1;");
    const c1 = repo.commit("init");
    memory.entities.upsert({
      symbolKey: "S",
      qualifiedName: "S",
      kind: "function",
      path: "src/pay.ts",
      signature: null,
      responsibilities: [],
      invariants: [],
      notes: [],
      featureKeys: [],
      source: "agent_summary",
      signatureHash: null,
      bodyHash: "oldhash",
      lastSeenCommit: c1,
      stale: false,
    });

    repo.write("src/pay.ts", "export const x = 2;");
    const c2 = repo.commit("change");
    const { hashFilesAtCommit, classifyFreshness } = await import("../../dist/memory/freshness.js");
    const hashes = await hashFilesAtCommit(repo.dir, c2, ["src/pay.ts"]);
    const marked = memory.entities.markStaleWhereHashMismatch(c2, hashes);
    assert.equal(marked, 1);
    assert.equal(memory.entities.get("S").stale, true);

    assert.equal(classifyFreshness({ storedHash: "a", currentHash: "a", fileExists: true }), "fresh");
    assert.equal(classifyFreshness({ storedHash: "a", currentHash: "b", fileExists: true }), "stale");
    assert.equal(classifyFreshness({ storedHash: "a", currentHash: null, fileExists: false }), "invalid");
  } finally {
    memory.close();
    repo.cleanup();
  }
});
