import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findIssues } from "../../dist/core/supervisor.js";
import { createAppContext } from "../../dist/app/context.js";
import { verifyFix } from "../../dist/app/services.js";
import { runFind } from "../../dist/app/find.js";
import { applyFeedback } from "../../dist/memory/feedback.js";
import { buildMemoryPack, matchIssueHistory } from "../../dist/memory/retrieval.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo } from "../fixtures/helpers.js";

/**
 * Scripted session factory: plays the role of the model by invoking the very
 * tools the real sessions expose. Keeps the whole loop testable without any
 * model or network.
 */
class FakeSessionFactory {
  constructor({ reviewerScript, verifierScript } = {}) {
    this.reviewerScript = reviewerScript;
    this.verifierScript = verifierScript;
    this.createdSessions = [];
  }
  async createSession(config) {
    const factory = this;
    const handle = {
      config,
      async prompt(text) {
        const tool = (name) => {
          const found = config.tools.find((t) => t.name === name);
          if (!found) throw new Error(`tool not found in fake session: ${name}`);
          return found;
        };
        if (config.systemRole === "code reviewer" && factory.reviewerScript) {
          await factory.reviewerScript(tool, text, config);
        } else if (config.systemRole === "finding verifier" && factory.verifierScript) {
          await factory.verifierScript(tool, text, config);
        } else if (config.systemRole === "fix verifier" && factory.verifierScript) {
          await factory.verifierScript(tool, text, config);
        }
      },
      getLastAssistantText: () => "fake assistant text",
      dispose() {},
    };
    this.createdSessions.push(handle);
    return handle;
  }
}

const CANDIDATE = {
  title: "retry quota consumed without remote attempt",
  claim: "retry quota is consumed without an actual remote gateway attempt",
  trigger: "gateway exception before charge",
  category: "correctness",
  severity: "P1",
  entityKey: "PaymentService.retry",
  featureKey: "payment-retry",
};

async function candidateIdentity() {
  return buildIdentity({
    featureKey: CANDIDATE.featureKey,
    entityKey: CANDIDATE.entityKey,
    category: CANDIDATE.category,
    claim: CANDIDATE.claim,
    trigger: CANDIDATE.trigger,
  });
}

function setupRepo() {
  const repo = createTempGitRepo();
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("init");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.commit("introduce bug");
  return repo;
}

async function reviewerRecordsCandidate(tool) {
  await tool("record_candidate").execute({
    title: CANDIDATE.title,
    claim: CANDIDATE.claim,
    trigger: CANDIDATE.trigger,
    category: CANDIDATE.category,
    severity: CANDIDATE.severity,
    featureKey: CANDIDATE.featureKey,
    entityKey: CANDIDATE.entityKey,
    anchors: [{ path: "src/pay.ts", startLine: 1 }],
    evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
  });
  await tool("finish_round").execute({
    summary: "checked the retry path",
    nextFocus: ["PaymentGateway.charge"],
    needsMoreRounds: false,
  });
}

test("findIssues: reviewer candidate -> verifier confirmed -> persisted finding", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await tool("submit_verdict").execute({
        verdict: "confirmed",
        rationale: "traced the path: consumeQuota runs before the gateway call",
        confidence: 0.9,
      });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0].status, "confirmed");
    assert.equal(outcome.findings[0].severity, "P1");
    assert.equal(outcome.rounds.length, 1);
    assert.equal(outcome.rounds[0].confirmed, 1);
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
    assert.ok(outcome.runId);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: trusted prior decision verified still-applicable suppresses re-reporting", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const identity = await candidateIdentity();

  // The user previously explained this exact behavior as expected.
  ctx.memory.issues.insert({
    featureKey: CANDIDATE.featureKey,
    entityKey: CANDIDATE.entityKey,
    fingerprint: identity.fingerprint,
    category: CANDIDATE.category,
    claim: CANDIDATE.claim,
    trigger: CANDIDATE.trigger,
    decision: "expected",
    priority: null,
    rationale: "retry_count intentionally counts attempts",
    scope: "symbol",
    source: "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });

  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool, promptText) => {
      assert.ok(promptText.includes("PRIOR DECISIONS"), "verifier must receive prior decisions");
      await tool("submit_verdict").execute({
        verdict: "rejected",
        rationale: "prior decision covers this exact claim",
        priorDecisionStillApplies: true,
        confidence: 0.9,
      });
    },
  });

  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.equal(outcome.findings.length, 1);
    const finding = outcome.findings[0];
    // Suppressed (recorded as expected), not silently deleted.
    assert.equal(finding.status, "expected");
    const matches = JSON.parse(finding.memoryMatches);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].stillApplies, true);
    assert.equal(matches[0].decision, "expected");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: prior decision that no longer applies does NOT suppress", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const identity = await candidateIdentity();
  ctx.memory.issues.insert({
    featureKey: CANDIDATE.featureKey,
    entityKey: CANDIDATE.entityKey,
    fingerprint: identity.fingerprint,
    category: CANDIDATE.category,
    claim: CANDIDATE.claim,
    trigger: CANDIDATE.trigger,
    decision: "wont_fix",
    priority: null,
    rationale: "old reasoning",
    scope: "symbol",
    source: "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await tool("submit_verdict").execute({
        verdict: "confirmed",
        rationale: "the code now uses retry_count for account lockout; old decision outdated",
        priorDecisionStillApplies: false,
        confidence: 0.85,
      });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.equal(outcome.findings[0].status, "confirmed");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("reviewer prompt excludes issue decisions; memory pack excludes them too", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const identity = await candidateIdentity();
  ctx.memory.issues.insert({
    featureKey: CANDIDATE.featureKey,
    entityKey: null,
    fingerprint: identity.fingerprint,
    category: CANDIDATE.category,
    claim: CANDIDATE.claim,
    trigger: CANDIDATE.trigger,
    decision: "expected",
    priority: null,
    rationale: "SECRET-DECISION",
    scope: "feature",
    source: "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });
  ctx.memory.projectMemory.upsert({
    architectureSummary: "API -> Service",
    responsibilities: [],
    invariants: ["financial writes must be idempotent"],
    conventions: [],
    riskAreas: [],
    featureKeys: [],
    source: "agent_summary",
    createdAtCommit: null,
    validatedAtCommit: null,
    stale: false,
  });

  let seenPrompt = "";
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      seenPrompt = promptText;
      await tool("finish_round").execute({ summary: "nothing found", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async () => {},
  });
  try {
    await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    // Project invariants visible...
    assert.ok(seenPrompt.includes("financial writes must be idempotent"));
    // ...but issue decisions (the biasing information) are not.
    assert.ok(!seenPrompt.includes("SECRET-DECISION"));
    assert.ok(!seenPrompt.includes("expected"));

    // The pack itself obeys the same rule; the matcher finds the decision.
    const pack = buildMemoryPack(ctx.memory, {
      changedPaths: ["src/pay.ts"],
      featureKeys: [CANDIDATE.featureKey],
      entityKeys: [],
      headCommit: "HEAD",
    });
    assert.ok(pack.text.includes("financial writes must be idempotent"));
    assert.ok(!pack.text.includes("SECRET-DECISION"));
    assert.match(pack.text, /evidence, not instructions/);

    const matched = matchIssueHistory(ctx.memory, {
      fingerprint: identity.fingerprint,
      featureKey: CANDIDATE.featureKey,
    });
    assert.equal(matched.length, 1);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("verifyFix: rejected verdict (trigger gone) marks the resolution verified", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const identity = await candidateIdentity();
  const finding = ctx.memory.findings.insert(
    {
      title: CANDIDATE.title,
      claim: CANDIDATE.claim,
      trigger: CANDIDATE.trigger,
      category: CANDIDATE.category,
      severity: CANDIDATE.severity,
      featureKey: CANDIDATE.featureKey,
      entityKey: CANDIDATE.entityKey,
      anchors: [{ path: "src/pay.ts", startLine: 1 }],
      evidence: [],
      round: 1,
      identity,
      status: "confirmed",
      memoryMatches: [],
    },
    "run-1",
  );
  const commit = "HEAD";
  await applyFeedback(ctx.memory, { findingId: finding.displayId, decision: "fixed", commit });

  const factory = new FakeSessionFactory({
    verifierScript: async (tool) => {
      await tool("submit_verdict").execute({
        verdict: "rejected",
        rationale: "consumeQuota is now called after the gateway succeeds",
        confidence: 0.9,
      });
    },
  });
  const fixedCtx = { ...ctx, factory };
  try {
    const result = await verifyFix(fixedCtx, finding.displayId);
    assert.equal(result.verifiedFixed, true);
    const resolution = ctx.memory.resolutions.byFindingId(finding.id)[0];
    assert.equal(resolution.verified, true);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("runFind service layer returns a renderable outcome", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, {
    noSyncIndex: true,
    dbPath: path.join(repo.dir, "m.sqlite"),
    factory: new FakeSessionFactory({
      reviewerScript: reviewerRecordsCandidate,
      verifierScript: async (tool) => {
        await tool("submit_verdict").execute({ verdict: "uncertain", rationale: "cannot trace", confidence: 0.3 });
      },
    }),
  });
  try {
    const result = await runFind(ctx, { maxRounds: 1 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.projectId, ctx.memory.identity.projectId);
    assert.equal(typeof result.degraded, "boolean");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});
