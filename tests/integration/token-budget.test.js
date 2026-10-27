import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { auditIssues, findIssues } from "../../dist/core/supervisor.js";
import { createAppContext } from "../../dist/app/context.js";
import { findExitCode } from "../../dist/app/output.js";
import { DEFAULT_FIND_REVIEWER_INPUT_TOKENS, DEFAULT_FIND_VERIFIER_INPUT_TOKENS } from "../../dist/core/budget.js";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";

/**
 * Default-budget behavior (ADR 0006), driven by scripted sessions with injected
 * usage — no model, no network. A scripted session reports whatever usage the
 * scenario needs, so crossing a 1.2M/0.8M ceiling costs nothing.
 */

const CANDIDATE = {
  title: "retry quota consumed without remote attempt",
  claim: "retry quota is consumed without an actual remote gateway attempt",
  trigger: "gateway exception before charge",
  category: "correctness",
  severity: "P1",
  entityKey: "PaymentService.retry",
  featureKey: "payment-retry",
};

/** Role-addressed injected usage: every bucket explicit, input symmetric with the ceiling's unit. */
function roleUsage(inputTokens) {
  return {
    inputTokens, outputTokens: 25_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: inputTokens + 25_000, cost: 0.1, durationMs: 5, toolCalls: 3, repeatedToolCalls: 0,
  };
}

/**
 * Scripted factory with per-role usage injection and session accounting. The
 * reviewer/verifier scripts invoke the very tools the real sessions expose.
 */
function scriptedFactory({ reviewer, verifier, usage = {} }) {
  const factory = {
    reviewerSessions: 0,
    verifierSessions: 0,
    async createSession(config) {
      const role = config.systemRole === "code reviewer" ? "reviewer" : "verifier";
      factory[role === "reviewer" ? "reviewerSessions" : "verifierSessions"] += 1;
      const injected = usage[role];
      return {
        config,
        async prompt(text) {
          const tool = (name) => {
            const found = config.tools.find((entry) => entry.name === name);
            if (!found) throw new Error(`tool not found in fake session: ${name}`);
            return found;
          };
          if (role === "reviewer") await reviewer(tool, text, config);
          else await verifier(tool, text, config);
        },
        getLastAssistantText: () => "fake assistant text",
        getLastAssistantError: () => undefined,
        ...(injected ? { getUsage: () => ({ ...injected }) } : {}),
        dispose() {},
      };
    },
  };
  return factory;
}

function setupRepo() {
  const repo = createTempGitRepo();
  repo.write("src/pay.ts", "export function retry(): void {}\n");
  repo.commit("init");
  repo.write("src/pay.ts", "export function retry(): void { consumeQuota(); }\n");
  repo.commit("introduce bug");
  return repo;
}

/** Record \`count\` distinct candidates, then hand the round back. */
async function recordCandidates(tool, count, needsMoreRounds, tag = "") {
  for (let i = 1; i <= count; i++) {
    await tool("record_candidate").execute({
      title: `${CANDIDATE.title}${tag} ${i}`,
      claim: `${CANDIDATE.claim}${tag} (${i})`,
      trigger: `${CANDIDATE.trigger}${tag} ${i}`,
      category: CANDIDATE.category,
      severity: CANDIDATE.severity,
      featureKey: CANDIDATE.featureKey,
      entityKey: `${CANDIDATE.entityKey}.${i}`,
      anchors: [{ path: "src/pay.ts", startLine: 1 }],
      evidence: [{ kind: "code", path: "src/pay.ts", startLine: 1, excerpt: "consumeQuota()" }],
    });
  }
  await tool("finish_round").execute({
    summary: `recorded ${count} candidate(s), wants another pass`,
    nextFocus: ["PaymentGateway.charge"],
    needsMoreRounds,
  });
}

const confirm = async (tool) => {
  await submitVerdictWithEvidence(tool, { verdict: "confirmed", rationale: "traced the path: consumeQuota runs before the gateway call", confidence: 0.9 });
};

async function withRepo(fn) {
  const repo = setupRepo();
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "m.sqlite") });
  try {
    return await fn(repo, ctx);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
}

test("findIssues: the default reviewer ceiling starts no new round but verifies the pending backlog (default budget)", async () => {
  const savedTranscripts = process.env.PIR_TRANSCRIPTS;
  process.env.PIR_TRANSCRIPTS = "1";
  try {
    await withRepo(async (repo, ctx) => {
      const factory = scriptedFactory({
        usage: {
          reviewer: roleUsage(DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000),
          verifier: roleUsage(10_000),
        },
        reviewer: async (tool) => { await recordCandidates(tool, 2, true); },
        verifier: confirm,
      });
      const outcome = await findIssues({
        repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
        options: { maxRounds: 3 },
      });

      // (a) The budget stop starts no new reviewer round, although the
      // reviewer asked for one and maxRounds would allow two more.
      assert.equal(factory.reviewerSessions, 1);
      // (b) Grace: every already-pending candidate still goes through the drain.
      assert.equal(factory.verifierSessions, 2);
      assert.equal(outcome.pendingCandidates, 0);
      assert.equal(outcome.findings.length, 2);
      assert.ok(outcome.findings.every((row) => row.status === "confirmed"));

      // The stop names the ceiling that was hit, not a generic round limit.
      assert.match(outcome.stoppedBecause, /reviewer token budget exhausted/);
      assert.deepEqual(outcome.budgetStop, { kind: "reviewer-tokens", reason: outcome.stoppedBecause });
      assert.ok(outcome.usage.inputTokens >= DEFAULT_FIND_REVIEWER_INPUT_TOKENS);

      // Un-reviewed work still reports incomplete and the exit-code
      // contract is untouched (0 without --fail-on, 1 on a reported P1, 3 for
      // incomplete work under a gate).
      assert.equal(outcome.incomplete, true);
      assert.equal(findExitCode(outcome.findings, "none", outcome.incomplete), 0);
      assert.equal(findExitCode(outcome.findings, "P1", outcome.incomplete), 1);
      assert.equal(findExitCode([], "P1", outcome.incomplete), 3);

      // (c) The persisted run record and the run manifest both record the stop.
      const run = ctx.memory.findings.runById(outcome.runId);
      assert.equal(run.status, "incomplete");
      assert.match(run.notes, /reviewer token budget exhausted/);
      const manifest = JSON.parse(readFileSync(path.join(outcome.transcriptDir, "run.json"), "utf8"));
      assert.equal(manifest.status, "incomplete");
      assert.equal(manifest.incomplete, true);
      assert.match(manifest.stoppedBecause, /reviewer token budget exhausted/);
      assert.deepEqual(manifest.budgetStop, { kind: "reviewer-tokens", reason: outcome.stoppedBecause });
      assert.ok(manifest.usage.inputTokens >= DEFAULT_FIND_REVIEWER_INPUT_TOKENS);
    });
  } finally {
    if (savedTranscripts === undefined) delete process.env.PIR_TRANSCRIPTS;
    else process.env.PIR_TRANSCRIPTS = savedTranscripts;
  }
});

test("findIssues: the verifier ceiling does not cut the pending backlog short (default budget; grace)", async () => {
  await withRepo(async (repo, ctx) => {
    const factory = scriptedFactory({
      usage: {
        reviewer: roleUsage(50_000),
        verifier: roleUsage(DEFAULT_FIND_VERIFIER_INPUT_TOKENS + 100_000),
      },
      reviewer: async (tool) => { await recordCandidates(tool, 3, true); },
      verifier: confirm,
    });
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { maxRounds: 3 },
    });

    // The first verdict already crosses the verifier ceiling; the grace still
    // drains the two candidates behind it before the run stops.
    assert.equal(factory.verifierSessions, 3);
    assert.equal(outcome.pendingCandidates, 0);
    assert.equal(factory.reviewerSessions, 1, "no new reviewer round after the verifier ceiling");
    assert.match(outcome.stoppedBecause, /verifier token budget exhausted/);
    assert.equal(outcome.budgetStop.kind, "verifier-tokens");
    assert.equal(outcome.incomplete, true);
  });
});

test("findIssues: a backlog larger than one drain cap is still fully verified (default budget; dogfood F-178)", async () => {
  await withRepo(async (repo, ctx) => {
    const factory = scriptedFactory({
      usage: {
        reviewer: roleUsage(DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000),
        verifier: roleUsage(10_000),
      },
      reviewer: async (tool) => { await recordCandidates(tool, 5, true); },
      verifier: confirm,
    });
    const outcome = await findIssues({
      repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
      options: { maxRounds: 2, maxVerificationsPerRound: 2 },
    });

    // The ceiling is hit in round 1; the drain's per-round cap leaves 3 of the
    // 5 candidates queued. The graceful stop must defer and keep draining
    // (rounds grow past maxRounds) until every candidate is verified, then
    // report the ceiling — not the round limit — as the reason.
    assert.equal(factory.reviewerSessions, 1, "no new reviewer round");
    assert.equal(factory.verifierSessions, 5, "every pending candidate reached a verifier");
    assert.equal(outcome.pendingCandidates, 0);
    assert.equal(outcome.findings.length, 5);
    assert.ok(outcome.rounds.length > 2, "drain-only rounds continued past maxRounds");
    assert.match(outcome.stoppedBecause, /reviewer token budget exhausted/);
    assert.equal(outcome.budgetStop.kind, "reviewer-tokens");
    assert.equal(outcome.incomplete, true);
  });
});

test("findIssues: an explicit --max-tokens replaces the default ceilings; unlimited removes them (default budget)", async () => {
  for (const [label, maxTokens] of [["an explicit whole-run ceiling", 10_000_000], ["the unlimited opt-out", null]]) {
    await withRepo(async (repo, ctx) => {
      let rounds = 0;
      const factory = scriptedFactory({
        usage: {
          reviewer: roleUsage(DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000),
          verifier: roleUsage(10_000),
        },
        reviewer: async (tool) => {
          rounds += 1;
          // Read the changed hunk: an unread diff would schedule the forced
          // coverage round and confound "no new round" with "one more round".
          await tool("get_change").execute({ path: "src/pay.ts", hunkIndex: 0 });
          await recordCandidates(tool, 1, rounds < 2, ` r${rounds}`);
        },
        verifier: confirm,
      });
      const outcome = await findIssues({
        repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory,
        options: { maxRounds: 3, maxTokens },
      });

      assert.equal(factory.reviewerSessions, 2, `${label}: the default reviewer ceiling must not apply`);
      assert.equal(outcome.budgetStop, null);
      assert.equal(outcome.stoppedBecause, "reviewer signaled completion");
    });
  }
});

test("auditIssues: audit keeps the pre-budget semantics — no default token ceiling", async () => {
  const repo = createTempGitRepo("pir-audit-b3-");
  repo.write("src/a/util.ts", "export const id = (x) => x;\n");
  repo.write("src/b/calc.ts", "export const add = (a, b) => a + b;\n");
  repo.commit("code");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  // Same shape as the find scenario: a reviewer session far above the find
  // default must not stop or truncate an audit.
  const factory = scriptedFactory({
    usage: { reviewer: roleUsage(DEFAULT_FIND_REVIEWER_INPUT_TOKENS * 2 + 1), verifier: roleUsage(10_000) },
    reviewer: async (tool, prompt) => {
      const owned = [...prompt.matchAll(/^- (\S+) \((?:from line \d+ to end|lines \d+-\d+)\)$/gm)].map((match) => match[1]);
      for (const file of owned) await tool("read_code").execute({ path: file });
      await tool("finish_round").execute({ summary: `covered ${owned.join(", ")}`, nextFocus: [], needsMoreRounds: false });
    },
    verifier: confirm,
  });
  try {
    const outcome = await auditIssues({ repoRoot: repo.dir, memory: ctx.memory, codeMap: ctx.codeMap, factory });
    assert.equal(factory.reviewerSessions, 2, "every planned unit still runs");
    assert.equal(outcome.stoppedBecause, "audit discovery complete");
    assert.equal(outcome.budgetStop, null);
    assert.equal(outcome.incomplete, false);
    assert.equal(outcome.coverage.filesReviewed, 2);
  } finally {
    ctx.memory.close();
    repo.cleanup();
  }
});
