import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findIssues } from "../../dist/core/supervisor.js";
import { createAppContext } from "../../dist/app/context.js";
import { verifyFix } from "../../dist/app/services.js";
import { runFind } from "../../dist/app/find.js";
import { applyFeedback } from "../../dist/memory/feedback.js";
import { buildMemoryPack, matchIssueHistory } from "../../dist/memory/retrieval.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";

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
    // The real factory honors SessionConfig.transcriptFile by dumping the
    // conversation there; the fake mirrors that contract minimally so the
    // supervisor's wiring stays observable.
    const dumpTranscript = () => {
      if (!config.transcriptFile) return;
      mkdirSync(path.dirname(config.transcriptFile), { recursive: true });
      writeFileSync(
        config.transcriptFile,
        JSON.stringify({ role: config.systemRole, messages: [{ role: "user" }, { role: "assistant" }] }),
      );
    };
    const handle = {
      config,
      async prompt(text) {
        const tool = (name) => {
          const found = config.tools.find((t) => t.name === name);
          if (!found) throw new Error(`tool not found in fake session: ${name}`);
          return found;
        };
        try {
          if (config.systemRole === "code reviewer" && factory.reviewerScript) {
            await factory.reviewerScript(tool, text, config);
          } else if (config.systemRole === "finding verifier" && factory.verifierScript) {
            await factory.verifierScript(tool, text, config);
          } else if (config.systemRole === "fix verifier" && factory.verifierScript) {
            await factory.verifierScript(tool, text, config);
          }
        } finally {
          dumpTranscript();
        }
      },
      getLastAssistantText: () => "fake assistant text",
      getLastAssistantError: () => undefined,
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
      await submitVerdictWithEvidence(tool, {
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
    anchorPaths: [],
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });

  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool, promptText) => {
      assert.ok(promptText.includes("PRIOR DECISIONS"), "verifier must receive prior decisions");
      await submitVerdictWithEvidence(tool, {
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

test("findIssues: accepted-risk suppresses even when the verifier confirms the problem is real", async () => {
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
    decision: "accepted_risk",
    priority: null,
    rationale: "gateway dedupes upstream",
    scope: "symbol",
    source: "user_explicit",
    anchorPaths: ["src/pay.ts"],
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
  });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, {
        verdict: "confirmed",
        rationale: "the bug is real — and the team's accepted-risk decision still covers it",
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
    assert.equal(outcome.findings[0].status, "accepted_risk");
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
      await submitVerdictWithEvidence(tool, {
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

test("findIssues: maxFindings caps reported findings and stops the loop", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  let seenPrompt = "";
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      seenPrompt = promptText;
      for (let i = 1; i <= 3; i++) {
        await tool("record_candidate").execute({
          title: `issue ${i}`,
          claim: `claim ${i}: the quota path ${i} skips its guard`,
          trigger: `trigger ${i}`,
          category: "correctness",
          severity: "P1",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: `consumeQuota(${i})` }],
        });
      }
      await tool("finish_round").execute({ summary: "found several issues", nextFocus: [], needsMoreRounds: true });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 5, maxFindings: 2 },
    });
    // Only the first two candidates are verified and persisted; the loop
    // stops before spending a round on the third.
    assert.equal(outcome.findings.length, 2);
    assert.ok(outcome.findings.every((f) => f.status === "confirmed"));
    assert.equal(outcome.maxFindings, 2);
    assert.equal(outcome.stoppedBecause, "max findings reached (2)");
    assert.equal(outcome.rounds.length, 1);
    // The prompt frames the cap as a ceiling, never as a quota to fill.
    assert.ok(seenPrompt.includes("At most 2 findings"), "prompt states the cap");
    assert.ok(seenPrompt.includes("ceiling, not a target"), "prompt forbids quota-chasing");
    assert.ok(seenPrompt.includes("Never invent, split, or pad findings"), "prompt forbids fabrication");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: maxFindings null (#57 unlimited) reports every candidate past the default cap", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  let seenPrompt = "";
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      seenPrompt = promptText;
      // 12 candidates: over the default cap (10) and over one round's
      // verification capacity (8), so unlimited must survive both ceilings.
      for (let i = 1; i <= 12; i++) {
        await tool("record_candidate").execute({
          title: `issue ${i}`,
          claim: `claim ${i}: the quota path ${i} skips its guard`,
          trigger: `trigger ${i}`,
          category: "correctness",
          severity: "P1",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: `consumeQuota(${i})` }],
        });
      }
      await tool("finish_round").execute({ summary: "found a dozen issues", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 5, maxFindings: null },
    });
    // Every candidate is verified and persisted — the default cap of 10 was
    // explicitly removed, and the loop only stopped on completion.
    assert.equal(outcome.findings.length, 12);
    assert.ok(outcome.findings.every((f) => f.status === "confirmed"));
    assert.equal(outcome.maxFindings, null);
    assert.notEqual(outcome.stoppedBecause, "max findings reached (10)");
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
    // The prompt states the absence of a cap instead of a fake number, and
    // keeps the anti-fabrication rule.
    assert.ok(seenPrompt.includes("There is no cap on reported findings for this change"), "prompt states unlimited");
    assert.ok(seenPrompt.includes("Never invent, split, or pad findings"), "prompt forbids fabrication");
    assert.ok(!seenPrompt.includes("At most"), "no numeric ceiling is quoted");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: rejected findings do not consume the maxFindings budget", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      const round = promptText.includes("Review round 1 of") ? 1 : 2;
      await tool("record_candidate").execute({
        title: `issue ${round}`,
        claim: `claim ${round}: the quota path ${round} skips its guard`,
        trigger: `trigger ${round}`,
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
      });
      await tool("finish_round").execute({ summary: "one more to check", nextFocus: [], needsMoreRounds: true });
    },
    verifierScript: async (tool, promptText) => {
      // Round 1's candidate is rejected; round 2's is confirmed.
      const verdict = promptText.includes("claim 1:") ? "rejected" : "confirmed";
      await submitVerdictWithEvidence(tool, { verdict, rationale: "checked the code", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 5, maxFindings: 1 },
    });
    // The rejection was recorded but freed its slot, so the second candidate
    // still got verified and became the single reported finding.
    assert.equal(outcome.findings.length, 2);
    assert.equal(outcome.findings.filter((f) => f.status === "confirmed").length, 1);
    assert.equal(outcome.findings.filter((f) => f.status === "rejected").length, 1);
    assert.equal(outcome.stoppedBecause, "max findings reached (1)");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: PIR_TRANSCRIPTS=1 dumps one transcript per session under the state root", async () => {
  const repo = setupRepo();
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-transcripts-e2e-"));
  // Mirror what the server passes for its worktree flows: dbPath forced under
  // PIR_STATE_ROOT (reviewDbPath). Transcripts must follow that db, not the
  // env-var chain.
  const ctx = await createAppContext(repo.dir, {
    noSyncIndex: true,
    dbPath: path.join(stateRoot, "proj", "memory.sqlite"),
  });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced", confidence: 0.9 });
    },
  });
  const savedTranscripts = process.env.PIR_TRANSCRIPTS;
  const savedStateRoot = process.env.PIR_STATE_ROOT;
  process.env.PIR_TRANSCRIPTS = "1";
  process.env.PIR_STATE_ROOT = stateRoot;
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.ok(outcome.transcriptDir, "outcome names the transcript directory");
    assert.ok(outcome.transcriptDir.startsWith(stateRoot), "transcripts live under PIR_STATE_ROOT");
    const reviewerFile = path.join(outcome.transcriptDir, "reviewer-r1.json");
    const verifierFile = path.join(outcome.transcriptDir, "verifier-r1-F-101.json");
    assert.ok(existsSync(reviewerFile), "reviewer transcript exists");
    assert.ok(existsSync(verifierFile), "verifier transcript exists");
    assert.equal(JSON.parse(readFileSync(reviewerFile, "utf8")).role, "code reviewer");
    assert.equal(JSON.parse(readFileSync(verifierFile, "utf8")).role, "finding verifier");
  } finally {
    if (savedTranscripts === undefined) delete process.env.PIR_TRANSCRIPTS;
    else process.env.PIR_TRANSCRIPTS = savedTranscripts;
    if (savedStateRoot === undefined) delete process.env.PIR_STATE_ROOT;
    else process.env.PIR_STATE_ROOT = savedStateRoot;
    ctx.memory.close();
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("findIssues: transcripts survive worktree cleanup in serve mode (issue #7)", async () => {
  // The shared image bakes PIR_STATE_IN_PROJECT=1 for docker-exec mode; the
  // serve process inherits it. Combined with the server's explicit dbPath
  // (reviewDbPath), env-first transcript resolution used to place transcripts
  // inside the throwaway worktree — `git worktree remove --force` then deleted
  // every transcript when the review ended.
  const repo = setupRepo();
  const reposRoot = mkdtempSync(path.join(tmpdir(), "pir-issue7-repos-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pir-issue7-state-"));
  const saved = {
    PIR_REPOS_ROOT: process.env.PIR_REPOS_ROOT,
    PIR_STATE_ROOT: process.env.PIR_STATE_ROOT,
    PIR_STATE_IN_PROJECT: process.env.PIR_STATE_IN_PROJECT,
    PIR_TRANSCRIPTS: process.env.PIR_TRANSCRIPTS,
  };
  process.env.PIR_REPOS_ROOT = reposRoot;
  process.env.PIR_STATE_ROOT = stateRoot;
  process.env.PIR_STATE_IN_PROJECT = "1"; // leaked from the image, as deployed
  process.env.PIR_TRANSCRIPTS = "1";

  const { computeProjectIdentity } = await import("../../dist/memory/identity.js");
  const { materializeRegistered, reviewDbPath } = await import("../../dist/app/repos.js");
  const { projectId } = await computeProjectIdentity(repo.dir);
  const review = await materializeRegistered(repo.dir, projectId, { noFetch: true });
  const ctx = await createAppContext(review.worktree, {
    noSyncIndex: true,
    dbPath: reviewDbPath(projectId), // exactly what the server's /v1/review passes
  });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: review.worktree,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.ok(outcome.transcriptDir, "outcome names the transcript directory");
    assert.ok(
      outcome.transcriptDir.startsWith(stateRoot),
      `transcripts live under PIR_STATE_ROOT, got ${outcome.transcriptDir}`,
    );
    const reviewerFile = path.join(outcome.transcriptDir, "reviewer-r1.json");
    assert.ok(existsSync(reviewerFile), "reviewer transcript exists");

    // The end-of-review worktree cleanup that used to destroy the transcripts.
    await review.cleanup();
    assert.ok(existsSync(reviewerFile), "transcript survives worktree cleanup");
    assert.ok(!existsSync(review.worktree), "worktree really was removed");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ctx.memory.close();
    await review.cleanup();
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("findIssues: no transcript files without PIR_TRANSCRIPTS", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: reviewerRecordsCandidate,
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced", confidence: 0.9 });
    },
  });
  const savedTranscripts = process.env.PIR_TRANSCRIPTS;
  delete process.env.PIR_TRANSCRIPTS;
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 1 },
    });
    assert.equal(outcome.transcriptDir, undefined);
    assert.equal(
      factory.createdSessions.every((s) => s.config.transcriptFile === undefined),
      true,
      "sessions get no transcript file when disabled",
    );
  } finally {
    if (savedTranscripts !== undefined) process.env.PIR_TRANSCRIPTS = savedTranscripts;
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
      await submitVerdictWithEvidence(tool, {
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
        await submitVerdictWithEvidence(tool, { verdict: "uncertain", rationale: "cannot trace", confidence: 0.3 });
      },
    }),
  });
  try {
    const result = await runFind(ctx, { maxRounds: 1 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.projectId, ctx.memory.identity.projectId);
    assert.equal(typeof result.degraded, "boolean");
    assert.equal(result.maxFindings, 10, "default findings cap is 10");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: candidates beyond the verification cap are drained from the pending queue in later rounds", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const record = (tool, c) =>
    tool("record_candidate").execute({
      title: c.title,
      claim: c.claim,
      trigger: c.trigger,
      category: c.category,
      severity: c.severity,
      featureKey: c.featureKey,
      entityKey: c.entityKey,
      anchors: [{ path: "src/pay.ts", startLine: 1 }],
      evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
    });
  const ALPHA = {
    title: "alpha: retry quota consumed without remote attempt",
    claim: "retry quota is consumed without an actual remote gateway attempt",
    trigger: "gateway exception before charge",
    category: "correctness",
    severity: "P1",
    entityKey: "PaymentService.retry",
    featureKey: "payment-retry",
  };
  const BETA = {
    title: "beta: refund issued before gateway confirmation",
    claim: "refund path issues money before the gateway confirms the charge",
    trigger: "refund before confirmation",
    category: "correctness",
    severity: "P2",
    entityKey: "PaymentService.refund",
    featureKey: "payment-refund",
  };
  const verifiedTitles = [];
  let reviewerRounds = 0;
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      reviewerRounds += 1;
      await record(tool, ALPHA);
      await record(tool, BETA);
      await tool("finish_round").execute({ summary: "two candidates", nextFocus: [], needsMoreRounds: true });
    },
    verifierScript: async (tool, text) => {
      for (const c of [ALPHA, BETA]) {
        if (text.includes(c.title)) verifiedTitles.push(c.title);
      }
      await submitVerdictWithEvidence(tool, {
        verdict: "confirmed",
        rationale: "traced the path in the test double",
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
      options: { maxRounds: 2, maxVerificationsPerRound: 1 },
    });
    // Round 1 discovers both candidates but the verification cap admits only
    // ALPHA; BETA stays queued instead of being silently discarded.
    assert.equal(outcome.rounds.length, 2);
    assert.equal(outcome.rounds[0].fresh, 2);
    assert.equal(outcome.rounds[0].pending, 1);
    // Round 2 is a verification-only round: the queued BETA is drained
    // without paying for another reviewer discovery session.
    assert.equal(reviewerRounds, 1);
    assert.equal(outcome.rounds[1].reviewerRan, false);
    assert.equal(outcome.rounds[1].pending, 0);
    assert.equal(outcome.findings.length, 2);
    assert.deepEqual(verifiedTitles, [ALPHA.title, BETA.title]);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("applyVerdict: endorsed confirmed decision keeps the verifier status; suppressive decisions still suppress", async () => {
  const { applyVerdict, createReviewState } = await import("../../dist/core/review-state.js");
  const state = createReviewState("b", "h", 1);
  const candidate = (fingerprint) => ({
    identity: { fingerprint },
    title: "t",
    claim: "c",
    trigger: "tr",
    category: "correctness",
    severity: "P1",
    anchors: [],
  });
  const match = (decision) => ({
    memoryId: "m",
    decision,
    scope: "project",
    source: "user_explicit",
    claim: "c",
    rationale: "r",
  });

  const confirmed = applyVerdict(
    state,
    candidate("fp-1"),
    { verdict: "uncertain", rationale: "r", priorDecisionStillApplies: true },
    [match("confirmed")],
  );
  assert.equal(confirmed.status, "uncertain");

  const suppressed = applyVerdict(
    state,
    candidate("fp-2"),
    { verdict: "confirmed", rationale: "r", priorDecisionStillApplies: true },
    [match("accepted_risk")],
  );
  assert.equal(suppressed.status, "accepted_risk");
});

test("findIssues: min-confidence buckets low-confidence confirmed findings and computes the run verdict (Q4)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  let verdictIndex = 0;
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      for (let i = 1; i <= 2; i++) {
        await tool("record_candidate").execute({
          title: `issue ${i}`,
          claim: `claim ${i}: the quota path ${i} skips its guard`,
          trigger: `trigger ${i}`,
          category: "correctness",
          severity: "P1",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: `consumeQuota(${i})` }],
        });
      }
      await tool("finish_round").execute({ summary: "two issues", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      verdictIndex += 1;
      // First candidate below the threshold (bucketed); second exactly at the
      // threshold (not bucketed — the boundary is exclusive).
      await submitVerdictWithEvidence(tool, {
        verdict: "confirmed", rationale: "traced it", confidence: verdictIndex === 1 ? 0.4 : 0.7,
      });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { minConfidence: 0.7 },
    });
    // Bucketing only: both stay reported confirmed findings.
    assert.equal(outcome.findings.length, 2);
    assert.ok(outcome.findings.every((f) => f.status === "confirmed"));
    assert.equal(outcome.minConfidence, 0.7);
    assert.equal(outcome.lowConfidenceFindings.length, 1);
    assert.equal(outcome.lowConfidenceFindings[0].displayId, outcome.findings[0].displayId);
    // Confidence persists with the row (insert round-trip through the store).
    const repersisted = ctx.memory.findings.get(outcome.lowConfidenceFindings[0].id);
    assert.equal(repersisted.confidence, 0.4);
    assert.equal(ctx.memory.findings.get(outcome.findings[1].id).confidence, 0.7);
    // A confirmed non-style P1 makes the run verdict deterministic.
    assert.equal(outcome.runVerdict, "incorrect");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: without min-confidence nothing is bucketed and a clean run verifies correct (Q4)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("finish_round").execute({ summary: "nothing found", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: {},
    });
    assert.equal(outcome.findings.length, 0);
    assert.deepEqual(outcome.lowConfidenceFindings, []);
    assert.equal(outcome.minConfidence, 0);
    assert.equal(outcome.runVerdict, "correct");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: --verify-model routes verifier sessions to a separate model and lands on the manifest (Q5)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      // Reads the diff: a competent pass keeps C1 stage 2 out of this fixture.
      await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
      await tool("record_candidate").execute({
        title: "issue 1",
        claim: "claim 1: the quota path 1 skips its guard",
        trigger: "trigger 1",
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
      });
      await tool("finish_round").execute({ summary: "one issue", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { model: "reviewer/model", verifierModel: "verifier/model" },
    });
    const reviewers = factory.createdSessions.filter((s) => s.config.systemRole === "code reviewer");
    const verifiers = factory.createdSessions.filter((s) => s.config.systemRole === "finding verifier");
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0].config.model, "reviewer/model");
    assert.equal(verifiers.length, 1);
    assert.equal(verifiers[0].config.model, "verifier/model");
    // The run manifest records both models (Q5).
    const manifest = JSON.parse(readFileSync(path.join(outcome.transcriptDir, "run.json"), "utf8"));
    assert.equal(manifest.model, "reviewer/model");
    assert.equal(manifest.verifierModel, "verifier/model");
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: without --verify-model verifier sessions use the reviewer model (Q5 fallback)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("record_candidate").execute({
        title: "issue 1",
        claim: "claim 1: the quota path 1 skips its guard",
        trigger: "trigger 1",
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
      });
      await tool("finish_round").execute({ summary: "one issue", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { model: "reviewer/model" },
    });
    const verifiers = factory.createdSessions.filter((s) => s.config.systemRole === "finding verifier");
    assert.equal(verifiers.length, 1);
    assert.equal(verifiers[0].config.model, "reviewer/model");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: coverage ledger accumulates hunk pages and read windows across the run (C1)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      // Deliberate reads: page the raw hunk, then read the head file.
      await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
      await tool("read_code").execute({ path: "src/pay.ts", revision: "head" });
      await tool("record_candidate").execute({
        title: "issue 1",
        claim: "claim 1: the quota path 1 skips its guard",
        trigger: "trigger 1",
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
      });
      await tool("finish_round").execute({ summary: "read the diff", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: {},
    });
    assert.equal(outcome.rounds.length, 1);
    const coverage = outcome.rounds[0].coverage;
    assert.ok(coverage, "round info carries the coverage snapshot");
    assert.equal(coverage.hunksTotal, 1);
    assert.equal(coverage.hunksCovered, 1);
    assert.equal(coverage.filesTotal, 1);
    assert.equal(coverage.filesCovered, 1);
    // The run manifest carries the detailed per-file ledger.
    const manifest = JSON.parse(readFileSync(path.join(outcome.transcriptDir, "run.json"), "utf8"));
    assert.equal(manifest.changeCoverage.hunksCovered, 1);
    assert.ok(manifest.changeCoverage.files.some((f) => f.path === "src/pay.ts" && f.covered === 1 && f.total === 1));
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: a reviewer that never reads the diff reports zero coverage (C1)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("finish_round").execute({ summary: "guessed", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: {},
    });
    assert.deepEqual(outcome.rounds[0].coverage, { hunksTotal: 1, hunksCovered: 0, filesTotal: 1, filesCovered: 0 });
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: a failed run's manifest still carries the coverage ledger (dogfood F-121)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("read_code").execute({ path: "src/pay.ts", revision: "head" });
      // Never calls finish_round — the round fails and the run fails with it.
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: {} }),
      /reviewer did not call finish_round/,
    );
    const runDirs = readdirSync(path.join(repo.dir, "transcripts"));
    const manifest = JSON.parse(readFileSync(path.join(repo.dir, "transcripts", runDirs[0], "run.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    // The failed round's read lands in the ledger via ReviewerRoundError.
    assert.equal(manifest.changeCoverage.hunksTotal, 1);
    assert.equal(manifest.changeCoverage.hunksCovered, 1);
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: reviewer reads survive a failure thrown after the reviewer round (dogfood F-122)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  // Any memory.findings.touchRun call explodes: the first one lands after the
  // reviewer round succeeded, simulating a drain/persistence crash that loses
  // the round — the reviewer's reads must already be in the ledger.
  const memory = new Proxy(ctx.memory, {
    get(target, prop) {
      if (prop === "findings") {
        return new Proxy(target.findings, {
          get(t, key) {
            if (key === "touchRun") return () => { throw new Error("touchRun exploded"); };
            const value = t[key];
            return typeof value === "function" ? value.bind(t) : value;
          },
        });
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("read_code").execute({ path: "src/pay.ts", revision: "head" });
      await tool("finish_round").execute({ summary: "read it", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory, codeMap: ctx.codeMap, factory, options: {} }),
      /touchRun exploded/,
    );
    const runDirs = readdirSync(path.join(repo.dir, "transcripts"));
    const manifest = JSON.parse(readFileSync(path.join(repo.dir, "transcripts", runDirs[0], "run.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.changeCoverage.hunksCovered, 1);
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: cold memory keeps the verifier prompt free of dismissal context (M1)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const verifierPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("record_candidate").execute({
        title: "issue 1",
        claim: "claim 1: the quota path 1 skips its guard",
        trigger: "trigger 1",
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
      });
      await tool("finish_round").execute({ summary: "one issue", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool, promptText) => {
      verifierPrompts.push(promptText);
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: {} });
    assert.equal(verifierPrompts.length, 1);
    assert.ok(!verifierPrompts[0].includes("SIMILAR DISMISSED HISTORY"));
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: warm memory surfaces cross-entity dismissals in the verifier prompt (M1)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  // A dismissal recorded against the same anchor path but a different claim
  // and no fingerprint: only the M1 cross-entity channel can surface it.
  ctx.memory.issues.insert({
    featureKey: null,
    entityKey: null,
    fingerprint: null,
    category: "correctness",
    claim: "a completely different historical note about billing retries",
    trigger: "unrelated trigger",
    decision: "false_positive",
    priority: null,
    rationale: "team assessed",
    scope: "project",
    source: "user_explicit",
    createdAtCommit: null,
    validUntilCommit: null,
    stale: false,
    anchorPaths: ["src/pay.ts"],
  });
  const verifierPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      await tool("record_candidate").execute({
        title: "issue 1",
        claim: "claim 1: the quota path 1 skips its guard",
        trigger: "trigger 1",
        category: "correctness",
        severity: "P1",
        anchors: [{ path: "src/pay.ts", startLine: 1 }],
        evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
      });
      await tool("finish_round").execute({ summary: "one issue", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool, promptText) => {
      verifierPrompts.push(promptText);
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: {} });
    assert.equal(verifierPrompts.length, 1);
    assert.match(verifierPrompts[0], /SIMILAR DISMISSED HISTORY \(background signal, not a decision\): 1 earlier findings judged false_positive resemble this candidate\./);
    assert.match(verifierPrompts[0], /suppression still requires your explicit stillApplies endorsement/);
    // Observational: the finding still verifies and reports normally.
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0].status, "confirmed");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

const FORCED_ROUND_CANDIDATE = {
  title: "issue 1",
  claim: "claim 1: the quota path 1 skips its guard",
  trigger: "trigger 1",
  category: "correctness",
  severity: "P1",
  anchors: [{ path: "src/pay.ts", startLine: 1 }],
  evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota(1)" }],
};

test("findIssues: one forced coverage round points the reviewer at unread hunks (C1 stage 2)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  let reviewerRound = 0;
  const reviewerPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      reviewerRound += 1;
      reviewerPrompts.push(promptText);
      if (reviewerRound === 1) {
        // Signals completion without reading anything: coverage incomplete.
        await tool("record_candidate").execute(FORCED_ROUND_CANDIDATE);
        await tool("finish_round").execute({ summary: "done, did not read", nextFocus: [], needsMoreRounds: false });
      } else {
        // The forced round reads the hunk the focus entry points at.
        await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
        await tool("finish_round").execute({ summary: "read it now", nextFocus: [], needsMoreRounds: false });
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: {} });
    assert.equal(outcome.rounds.length, 2);
    assert.match(reviewerPrompts[1] ?? "", /Unread diff hunks: src\/pay\.ts:0/);
    assert.equal(outcome.rounds[1].coverage?.hunksCovered, 1);
    // A completed forced round is a completed review, not an incomplete one.
    assert.equal(outcome.incomplete, false);
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: no forced coverage round when coverage is complete (C1 stage 2)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const reviewerPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      reviewerPrompts.push(promptText);
      await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
      await tool("record_candidate").execute(FORCED_ROUND_CANDIDATE);
      await tool("finish_round").execute({ summary: "read and reported", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: {} });
    assert.equal(outcome.rounds.length, 1);
    assert.ok(!reviewerPrompts[0].includes("Unread diff hunks"));
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: no forced coverage round when the budget or cap is exhausted (C1 stage 2)", async () => {
  // Budget: maxRounds 1 leaves no room for a forced round.
  {
    const repo = setupRepo();
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
    const reviewerPrompts = [];
    const factory = new FakeSessionFactory({
      reviewerScript: async (tool, promptText) => {
        reviewerPrompts.push(promptText);
        await tool("finish_round").execute({ summary: "done, did not read", nextFocus: [], needsMoreRounds: false });
      },
      verifierScript: async (tool) => {
        await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
      },
    });
    try {
      const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { maxRounds: 1 } });
      assert.equal(outcome.rounds.length, 1);
      assert.ok(!reviewerPrompts[0].includes("Unread diff hunks"));
    } finally {
      ctx.memory.close();
      repo.cleanup();
    }
  }
  // Cap: the findings ceiling is already reached, so no extra round.
  {
    const repo = setupRepo();
    const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m2.sqlite") });
    const reviewerPrompts = [];
    const factory = new FakeSessionFactory({
      reviewerScript: async (tool, promptText) => {
        reviewerPrompts.push(promptText);
        await tool("record_candidate").execute(FORCED_ROUND_CANDIDATE);
        await tool("finish_round").execute({ summary: "done, did not read", nextFocus: [], needsMoreRounds: false });
      },
      verifierScript: async (tool) => {
        await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
      },
    });
    try {
      const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { maxFindings: 1 } });
      assert.equal(outcome.rounds.length, 1);
      assert.ok(!reviewerPrompts[0].includes("Unread diff hunks"));
      assert.equal(outcome.stoppedBecause, "max findings reached (1)");
    } finally {
      ctx.memory.close();
      repo.cleanup();
    }
  }
});

test("findIssues: a reviewer that still refuses cannot loop the forced round (C1 stage 2)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  let reviewerRound = 0;
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool) => {
      reviewerRound += 1;
      await tool("finish_round").execute({ summary: `still not reading (round ${reviewerRound})`, nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { maxRounds: 5 } });
    // Round 1 completes, round 2 is the single forced round, then it stops.
    assert.equal(reviewerRound, 2);
    assert.equal(outcome.rounds.length, 2);
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: no forced coverage round while a verification backlog drains (dogfood F-124)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const events = [];
  const reviewerPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      reviewerPrompts.push(promptText);
      // Three candidates against a one-per-round drain cap: the completion
      // round leaves a verification backlog that consumes the remaining
      // rounds before any reviewer round could run.
      for (let i = 1; i <= 3; i++) {
        await tool("record_candidate").execute({
          title: `issue ${i}`,
          claim: `claim ${i}: the quota path ${i} skips its guard`,
          trigger: `trigger ${i}`,
          category: "correctness",
          severity: "P1",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: `consumeQuota(${i})` }],
        });
      }
      await tool("finish_round").execute({ summary: "found several, did not read", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxVerificationsPerRound: 1 },
      onProgress: (event) => events.push(event),
    });
    assert.equal(reviewerPrompts.length, 1);
    assert.ok(reviewerPrompts.every((p) => !p.includes("Unread diff hunks")), "no focus entry is injected");
    assert.ok(!events.some((e) => e.type === "info" && /forced coverage round/.test(e.message)), "no forced-round event");
    assert.equal(outcome.rounds.length, 2);
    assert.equal(outcome.stoppedBecause, "max rounds reached (2)");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: no forced coverage round when the token budget is exhausted (dogfood F-123)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const events = [];
  const reviewerPrompts = [];
  // Inline factory: the reviewer session reports usage above maxTokens, so
  // the budget trips during the very round that would schedule the forced
  // round — the once-per-run flag and the event must never be spent.
  const factory = {
    async createSession(config) {
      return {
        config,
        async prompt(text) {
          if (config.systemRole === "code reviewer") {
            reviewerPrompts.push(text);
            const tool = (name) => config.tools.find((t) => t.name === name);
            await tool("finish_round").execute({ summary: "done, did not read", nextFocus: [], needsMoreRounds: false });
          }
        },
        getLastAssistantText: () => "fake assistant text",
        getLastAssistantError: () => undefined,
        getUsage: () => ({ inputTokens: 300, outputTokens: 250, totalTokens: 550, cost: 0.001, durationMs: 5 }),
        dispose() {},
      };
    },
  };
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 3, maxTokens: 400 },
      onProgress: (event) => events.push(event),
    });
    assert.equal(reviewerPrompts.length, 1);
    assert.ok(!reviewerPrompts[0].includes("Unread diff hunks"), "no focus entry is injected");
    assert.ok(!events.some((e) => e.type === "info" && /forced coverage round/.test(e.message)), "no forced-round event");
    assert.equal(outcome.rounds.length, 1);
    // The completion check precedes the budget check in the loop, so the run
    // reports reviewer completion; the budget guard is proven by the absence
    // of a second reviewer session above (old code would have run one).
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: forced coverage round fires once the backlog drains (dogfood F-125)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const events = [];
  let reviewerRound = 0;
  const reviewerPrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      reviewerRound += 1;
      reviewerPrompts.push(promptText);
      if (reviewerRound === 1) {
        for (let i = 1; i <= 3; i++) {
          await tool("record_candidate").execute({
            title: `issue ${i}`,
            claim: `claim ${i}: the quota path ${i} skips its guard`,
            trigger: `trigger ${i}`,
            category: "correctness",
            severity: "P1",
            anchors: [{ path: "src/pay.ts", startLine: 1 }],
            evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: `consumeQuota(${i})` }],
          });
        }
        await tool("finish_round").execute({ summary: "found several, did not read", nextFocus: [], needsMoreRounds: false });
      } else {
        await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
        await tool("finish_round").execute({ summary: "read it now", nextFocus: [], needsMoreRounds: false });
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir,
      memory: ctx.memory,
      codeMap: ctx.codeMap,
      factory,
      options: { maxRounds: 4, maxVerificationsPerRound: 1 },
      onProgress: (event) => events.push(event),
    });
    // Round 1 reviews and leaves a 3-candidate backlog (drain caps at 1);
    // rounds 2-3 drain it; the trigger fires at round 3's end — the queue
    // emptied in a drain-only round, after the completion round itself.
    assert.ok(events.some((e) => e.type === "info" && /forced coverage round/.test(e.message)), "forced round scheduled after backlog drained");
    assert.equal(reviewerPrompts.length, 2);
    assert.match(reviewerPrompts[1] ?? "", /Unread diff hunks: src\/pay\.ts:0/);
    assert.equal(outcome.rounds.length, 4);
    assert.equal(outcome.rounds[3].coverage?.hunksCovered, 1);
    assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
    assert.equal(outcome.incomplete, false);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: --angles fans out round 1, merges candidates, reassigns displayIds, aggregates (F1)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const reviewerPrompts = [];
  let active = 0;
  let peak = 0;
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      reviewerPrompts.push(promptText);
      if (promptText.includes('angle "correctness"')) {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await tool("record_candidate").execute({
          title: "quota bug", claim: "claim A: the quota path skips its guard", trigger: "gateway exception",
          category: "correctness", severity: "P1", entityKey: "Pay.retry",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
        });
        await tool("finish_round").execute({ summary: "correctness done", nextFocus: ["recheck quota"], needsMoreRounds: true });
        active -= 1;
      } else if (promptText.includes('angle "security"')) {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await tool("record_candidate").execute({
          title: "same defect seen from security", claim: "claim A: the quota path skips its guard", trigger: "gateway exception",
          category: "security", severity: "P0", entityKey: "Pay.retry",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
        });
        await tool("record_candidate").execute({
          title: "tainted input", claim: "claim B: user input reaches the gateway unchecked", trigger: "retry request",
          category: "security", severity: "P0", entityKey: "Pay.retry",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "gateway(input)" }],
        });
        await tool("finish_round").execute({ summary: "security done", nextFocus: ["audit input"], needsMoreRounds: false });
        active -= 1;
      } else {
        // Round 2 general session with the merged focus.
        await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
        await tool("finish_round").execute({ summary: "general wrap-up", nextFocus: [], needsMoreRounds: false });
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { angles: ["correctness", "security"], maxRounds: 3 },
    });
    // Round 1: two angle sessions concurrently; round 2: one general session.
    assert.equal(peak, 2, "angle sessions run in parallel");
    assert.equal(reviewerPrompts.length, 3);
    assert.match(reviewerPrompts[0], /SPECIALIZED FOCUS \(angle "(correctness|security)"/);
    assert.match(reviewerPrompts[1], /SPECIALIZED FOCUS \(angle "(correctness|security)"/);
    assert.ok(!reviewerPrompts[2].includes("SPECIALIZED FOCUS"), "later rounds stay general");
    // needsReview = any(needsMoreRounds): correctness asked for more.
    assert.equal(outcome.rounds.length, 2);
    // Cross-angle duplicate collapses: 3 recorded, 2 fresh.
    assert.equal(outcome.rounds[0].candidates, 3);
    assert.equal(outcome.rounds[0].fresh, 2);
    assert.equal(outcome.findings.length, 2);
    // Store rows carry store ids (severity-ordered, P0 first); the
    // supervisor-reassigned runtime ids (F-1xx) are unique and observable in
    // the verifier transcript names and the manifest's per-angle id maps.
    assert.deepEqual(outcome.findings.map((f) => f.displayId), ["F-1", "F-2"]);
    assert.equal(outcome.findings[0].severity, "P0");
    // Aggregation: angle-labelled summaries and the focus union reach round 2.
    const round2Prompt = reviewerPrompts[2];
    assert.ok(round2Prompt.includes("[correctness] correctness done"));
    assert.ok(round2Prompt.includes("[security] security done"));
    assert.ok(round2Prompt.includes("recheck quota") && round2Prompt.includes("audit input"));
    // Transcripts: per-angle reviewer files with the id map; verifier files
    // named by the reassigned ids.
    const files = readdirSync(outcome.transcriptDir);
    assert.ok(files.includes("reviewer-r1-correctness.json"));
    assert.ok(files.includes("reviewer-r1-security.json"));
    assert.ok(files.includes("reviewer-r2.json"));
    assert.ok(files.some((f) => /^verifier-r1-F-10[12]\.json$/.test(f)), "verifier transcripts use reassigned ids");
    // The P0 cross-angle duplicate outranks the correctness angle's P1 —
    // the more severe occurrence survives the collapse (dogfood F-135).
    const survivor = outcome.findings.find((f) => f.claim.includes("claim A"));
    assert.equal(survivor.severity, "P0");
    const manifest = JSON.parse(readFileSync(path.join(outcome.transcriptDir, "run.json"), "utf8"));
    const mapped = manifest.sessions.filter((entry) => entry.idMap !== undefined);
    assert.equal(mapped.length, 2, "both angle sessions record their id maps");
    const targets = mapped.flatMap((entry) => entry.idMap.map((m) => m.to)).sort();
    // F-101 twice is correct: the survivor maps to itself from its own
    // session, and the collapsed duplicate's session folds onto it.
    assert.deepEqual(targets, ["F-101", "F-101", "F-102"], "every candidate maps; duplicates fold onto their survivor");
    assert.ok(manifest.sessions.every((session) => session.transcriptFile === session.file), "manifest refs carry the same transcript identity as live starts");
    assert.deepEqual(new Set(mapped.flatMap((entry) => entry.findingIdMap?.map((item) => item.to) ?? [])), new Set(["F-1", "F-2"]),
      "angle transcripts link runtime ids to persisted finding ids");
    // The collapsed duplicate's map points at the SURVIVOR, keeping its
    // transcript traceable (dogfood F-137).
    const correctnessRef = manifest.sessions.find((entry) => entry.angle === "correctness");
    assert.ok(correctnessRef.idMap.length >= 1);
    for (const entry of correctnessRef.idMap) {
      assert.ok(["F-101", "F-102"].includes(entry.to), `dropped candidate maps to a surviving id (got ${entry.to})`);
    }
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: angle fan-out shrinks deterministically under a token budget (F1)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const anglePrompts = [];
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      if (promptText.includes("SPECIALIZED FOCUS")) anglePrompts.push(promptText);
      // Read the diff: keeps C1 stage 2's forced round out of this fixture.
      await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
      await tool("finish_round").execute({ summary: "nothing found", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    // Five angles requested; 300k tokens remaining allows only K=2
    // (2 x 150k allowance) — trailing angles drop in stable order.
    const events = [];
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { angles: ["correctness", "concurrency", "security", "contracts", "performance"], maxTokens: 300000 },
      onProgress: (event) => events.push(event),
    });
    assert.equal(outcome.rounds.length, 1);
    assert.equal(anglePrompts.length, 2);
    assert.match(anglePrompts[0], /angle "correctness"/);
    assert.match(anglePrompts[1], /angle "concurrency"/);
    // The shrink is logged with the dropped angle ids (dogfood F-130).
    const shrink = events.find((e) => e.type === "info" && /angle fan-out reduced by budget/.test(e.message));
    assert.ok(shrink, "shrink event emitted");
    assert.match(shrink.message, /running 2 of 5, dropped security, contracts, performance/);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: an angle session failure recovers every angle's candidates (F1)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      if (promptText.includes('angle "correctness"')) {
        await tool("record_candidate").execute({
          title: "quota bug", claim: "claim A: the quota path skips its guard", trigger: "gateway exception",
          category: "correctness", severity: "P1", entityKey: "Pay.retry",
          anchors: [{ path: "src/pay.ts", startLine: 1 }],
          evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
        });
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      } else {
        // security angle never calls finish_round → ReviewerRoundError.
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      /reviewer did not call finish_round/,
    );
    // The healthy angle's candidate survives as a recoverable pending row.
    const rows = ctx.memory.findings.list();
    assert.equal(rows.filter((row) => row.status === "candidate").length, 1);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: multiple angle failures are all named in the cause (dogfood F-131)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (_tool, promptText) => {
      // Neither angle calls finish_round; distinct failure contexts.
      if (promptText.includes('angle "correctness"')) {
        throw new Error("correctness provider exploded");
      }
      // security angle: session ends without the terminal tool.
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      (error) => {
        assert.match(error.message, /angle fan-out failures: /);
        assert.match(error.message, /\[correctness\] correctness provider exploded/);
        assert.match(error.message, /\[security\]/);
        return true;
      },
    );
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: a failed fan-out charges successful angles' usage exactly once (dogfood F-128)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = {
    async createSession(config) {
      let sessionUsage = 550;
      return {
        config,
        async prompt(text) {
          if (config.systemRole === "code reviewer") {
            const tool = (name) => config.tools.find((t) => t.name === name);
            if (text.includes('angle "correctness"')) {
              await tool("finish_round").execute({ summary: "ok angle", nextFocus: [], needsMoreRounds: false });
            } else {
              sessionUsage = 300;
              // security angle: records a candidate, then never calls
              // finish_round → fails with measured usage on its error.
              await tool("record_candidate").execute({
                title: "tainted input", claim: "claim B: user input reaches the gateway unchecked", trigger: "retry request",
                category: "security", severity: "P0",
                anchors: [{ path: "src/pay.ts", startLine: 1 }],
                evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "gateway(input)" }],
              });
            }
          }
        },
        getLastAssistantText: () => "fake",
        getLastAssistantError: () => undefined,
        getUsage: () => ({ inputTokens: sessionUsage - 50, outputTokens: 50, totalTokens: sessionUsage, cost: 0.001, durationMs: 5 }),
        dispose() {},
      };
    },
  };
  const events = [];
  const { onRunEvent } = await import("../../dist/observability/run-events.js");
  const unsubscribe = onRunEvent((event) => events.push(event));
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      /reviewer did not call finish_round/,
    );
    const runDirs = readdirSync(path.join(repo.dir, "transcripts"));
    const manifest = JSON.parse(readFileSync(path.join(repo.dir, "transcripts", runDirs[0], "run.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    // Successful angle (550) + failed angle's measured usage (300), each
    // charged exactly once — a double charge would report ~1700, a dropped
    // one ~550 (dogfood F-128, F-133).
    assert.equal(manifest.usage.totalTokens, 850);
    // Recovered candidates publish unique runtime ids even on the failure
    // path (dogfood F-134): the run-end summaries carry the reassigned ids.
    const runEnd = events.find((event) => event.kind === "run-end");
    const ids = runEnd.findings.map((f) => f.displayId).filter(Boolean);
    assert.ok(ids.length >= 1, "recovered candidates summarized");
    assert.equal(new Set(ids).size, ids.length, "runtime ids unique across parallel angles");
  } finally {
    unsubscribe();
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

// Claim wordings with tuned Jaccard similarity (0.875 within the pair,
// 0.778 across the paraphrases) so the three candidates form one defect
// group whose collapse chain exercises the id-map rewrite.
const CHAIN_WORDS = "alpha beta gamma delta epsilon zeta eta";
const chainClaimA = CHAIN_WORDS;
const chainClaimB = `${CHAIN_WORDS} theta`;
const chainClaimC = `${CHAIN_WORDS} iota`;

function chainCandidate(claim, category, severity) {
  return {
    title: claim.slice(0, 40), claim, trigger: "gateway exception",
    category, severity, entityKey: "Pay.retry",
    anchors: [{ path: "src/pay.ts", startLine: 1 }],
    evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
  };
}

test("findIssues: --angles all runs every angle under a concurrency cap (dogfood F-144)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const angleIds = [];
  let active = 0;
  let peak = 0;
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      const match = promptText.match(/angle "([a-z-]+)"/);
      if (match) {
        angleIds.push(match[1]);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
      }
      await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
      await tool("finish_round").execute({ summary: "nothing found", nextFocus: [], needsMoreRounds: false });
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    // No token budget: nothing is dropped — "all" runs all five built-ins
    // (the old code selected only 4 and logged the 5th as a fake budget cut).
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { angles: ["correctness", "concurrency", "security", "contracts", "performance"] },
    });
    assert.deepEqual(
      [...angleIds].sort(),
      ["concurrency", "contracts", "correctness", "performance", "security"],
      "every requested angle runs",
    );
    assert.ok(peak >= 2 && peak <= 4, `sessions run concurrently under the cap (peak ${peak})`);
    assert.equal(outcome.rounds.length, 1);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: a failed angle's transcript ref still records its id map (dogfood F-138)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      if (promptText.includes('angle "correctness"')) {
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "correctness", "P1"));
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      } else {
        // security angle records a candidate, then never calls finish_round.
        await tool("record_candidate").execute(chainCandidate(chainClaimB, "security", "P2"));
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      /reviewer did not call finish_round/,
    );
    const runDirs = readdirSync(path.join(repo.dir, "transcripts"));
    const manifest = JSON.parse(readFileSync(path.join(repo.dir, "transcripts", runDirs[0], "run.json"), "utf8"));
    const securityRef = manifest.sessions.find((entry) => entry.angle === "security");
    assert.ok(securityRef, "failed angle's session ref is published");
    // The failed angle's recovered candidate joined the merge and the
    // reassignment, so its ref carries the same complete map as a healthy
    // angle's (the old code attached maps for completed angles only).
    assert.ok(Array.isArray(securityRef.idMap) && securityRef.idMap.length === 1, "failed angle records its id map");
    assert.match(securityRef.idMap[0].from, /^F-1/);
    assert.match(securityRef.idMap[0].to, /^F-1/);
    assert.equal(securityRef.findingIdMap?.length, 1, "failed angle links to its persisted candidate");
    assert.match(securityRef.findingIdMap[0].to, /^F-\d+$/);
    assert.equal(securityRef.findingIdMap[0].from, securityRef.idMap[0].to);
    assert.equal(ctx.memory.findings.get(securityRef.findingIdMap[0].to)?.claim, chainClaimA);
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: fan-out failure recovery dedups with the cross-angle relaxation (dogfood F-140)", async () => {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      // Both angles file the same defect under their own category label;
      // security then fails the round.
      if (promptText.includes('angle "correctness"')) {
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "correctness", "P1"));
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      } else {
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "security", "P2"));
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      /reviewer did not call finish_round/,
    );
    // Recovery collapses the cross-angle duplicate: one candidate row, not two.
    const rows = ctx.memory.findings.list().filter((row) => row.status === "candidate");
    assert.equal(rows.length, 1, "cross-angle duplicates collapse on the recovery path too");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: id maps resolve transitively through a displaced survivor (dogfood F-139)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      if (promptText.includes('angle "correctness"')) {
        // P2 anchor wording, plus the paraphrase that only matches it.
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "correctness", "P2"));
        await tool("record_candidate").execute(chainCandidate(chainClaimC, "correctness", "P2"));
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      } else {
        // The P0 that displaces the P2 as the group's survivor.
        await tool("record_candidate").execute(chainCandidate(chainClaimB, "security", "P0"));
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { angles: ["correctness", "security"] },
    });
    // One defect group: 3 recorded, 1 fresh (the P0).
    assert.equal(outcome.rounds[0].candidates, 3);
    assert.equal(outcome.rounds[0].fresh, 1);
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0].severity, "P0");
    // The transcript id map carries RUNTIME ids (F-<round><seq>): the P0
    // survivor deterministically takes F-101.
    const survivorRuntimeId = "F-101";
    const manifest = JSON.parse(readFileSync(path.join(outcome.transcriptDir, "run.json"), "utf8"));
    const mapped = manifest.sessions.filter((entry) => entry.idMap !== undefined);
    assert.equal(mapped.length, 2);
    // Every dropped candidate's map entry — including the paraphrase whose
    // collapse chain passes through the displaced P2 representative — must
    // point at the one surviving id, never at a dropped intermediate.
    for (const entry of mapped.flatMap((ref) => ref.idMap)) {
      assert.equal(entry.to, survivorRuntimeId, `map entry ${entry.from} → ${entry.to} lands on the survivor`);
    }
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});

test("findIssues: a failed fan-out's id maps carry no dangling targets (dogfood F-147)", async () => {
  const savedEnv = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  const factory = new FakeSessionFactory({
    reviewerScript: async (tool, promptText) => {
      if (promptText.includes('angle "correctness"')) {
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "correctness", "P1"));
        await tool("finish_round").execute({ summary: "done", nextFocus: [], needsMoreRounds: false });
      } else {
        // Same defect filed by the security angle, which then fails the round.
        await tool("record_candidate").execute(chainCandidate(chainClaimA, "security", "P2"));
      }
    },
    verifierScript: async (tool) => {
      await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
    },
  });
  try {
    await assert.rejects(
      findIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory, options: { angles: ["correctness", "security"] } }),
      /reviewer did not call finish_round/,
    );
    assert.equal(ctx.memory.findings.list().filter((row) => row.status === "candidate").length, 1, "the cross-angle duplicate collapsed at recovery");
    const runDirs = readdirSync(path.join(repo.dir, "transcripts"));
    const manifest = JSON.parse(readFileSync(path.join(repo.dir, "transcripts", runDirs[0], "run.json"), "utf8"));
    const mapped = manifest.sessions.filter((entry) => entry.idMap !== undefined);
    assert.equal(mapped.length, 2, "both angles publish their maps");
    // Only one candidate persisted: the P1 survivor, whose runtime id is
    // deterministically F-101 (severity-ordered reassignment). Every map
    // entry must land on it — never on the dropped duplicate's own
    // reassigned id, which persists nothing (the old failure path published
    // exactly that dangling base-map target).
    for (const entry of mapped.flatMap((ref) => ref.idMap)) {
      assert.equal(entry.to, "F-101", `map entry ${entry.from} → ${entry.to} lands on the persisted survivor`);
    }
  } finally {
    process.env.PIR_TRANSCRIPTS = savedEnv;
    ctx.memory.close();
    repo.cleanup();
  }
});
