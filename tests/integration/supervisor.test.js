import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    anchorPaths: [],
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
      await tool("submit_verdict").execute({
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
      await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "traced it", confidence: 0.9 });
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
        evidence: [],
      });
      await tool("finish_round").execute({ summary: "one more to check", nextFocus: [], needsMoreRounds: true });
    },
    verifierScript: async (tool, promptText) => {
      // Round 1's candidate is rejected; round 2's is confirmed.
      const verdict = promptText.includes("claim 1:") ? "rejected" : "confirmed";
      await tool("submit_verdict").execute({ verdict, rationale: "checked the code", confidence: 0.9 });
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
      await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "traced", confidence: 0.9 });
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
      await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "traced", confidence: 0.9 });
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
      await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "traced", confidence: 0.9 });
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
    assert.equal(result.maxFindings, 10, "default findings cap is 10");
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});
