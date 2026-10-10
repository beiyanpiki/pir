import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempGitRepo, submitVerdictWithEvidence } from "../fixtures/helpers.js";
import { createAppContext } from "../../dist/app/context.js";
import { findIssues } from "../../dist/core/supervisor.js";
import { applyVerdict, createReviewState } from "../../dist/core/review-state.js";
import { buildIdentity } from "../../dist/findings/identity.js";
import { Budget } from "../../dist/core/budget.js";
import { findExitCode, renderFindResultText } from "../../dist/app/output.js";

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, totalTokens: 160, cost: 0.01, durationMs: 5, toolCalls: 2, repeatedToolCalls: 1 };

async function fixture() {
  const repo = createTempGitRepo();
  repo.write("src/counter.ts", "export const next = (n: number) => n + 1;\n");
  repo.commit("baseline");
  repo.write("src/counter.ts", "export const next = (n: number) => n + 2;\n");
  repo.commit("change");
  const ctx = await createAppContext(repo.dir, { noSyncIndex: true, dbPath: path.join(repo.dir, "memory.sqlite") });
  return { repo, ctx, cleanup() { ctx.memory.close(); repo.cleanup(); } };
}

function factory(reviewer, verifier, measured = false) {
  const sessions = [];
  return {
    sessions,
    async createSession(config) {
      sessions.push(config);
      return {
        async prompt(text) {
          const tools = (name) => {
            const found = config.tools.find((tool) => tool.name === name);
            assert.ok(found, `missing tool ${name}`);
            return found;
          };
          await (config.systemRole === "code reviewer" ? reviewer : verifier)(tools, text, config);
        },
        getLastAssistantText: () => "done",
        getLastAssistantError: () => undefined,
        ...(measured ? { getUsage: () => ({ ...usage }) } : {}),
        dispose() {},
      };
    },
  };
}

async function record(tools, index, severity = "P1") {
  const result = await tools("record_candidate").execute({
    title: `Defect ${index}`, claim: `Independent failure ${index}`, trigger: `input path ${index}`,
    category: "correctness", severity,
    anchors: [{ path: "src/counter.ts", startLine: 1 }],
    evidence: [{ kind: "code", path: "src/counter.ts", startLine: 1, excerpt: "n + 2" }],
  });
  assert.ok(!result.text.startsWith("ERROR"), result.text);
}

async function finish(tools, nextFocus = []) {
  const result = await tools("finish_round").execute({ summary: "Inspected counter changes", nextFocus, needsMoreRounds: nextFocus.length > 0 });
  assert.ok(!result.text.startsWith("ERROR"), result.text);
}

test("pending candidates survive a per-round verification cap without another reviewer", async () => {
  const f = await fixture();
  let reviewed = 0;
  let verified = 0;
  const sessions = factory(async (tools) => {
    reviewed++;
    for (let i = 0; i < 9; i++) await record(tools, i);
    await finish(tools);
  }, async (tools) => {
    verified++;
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "src/counter.ts:1 reaches changed arithmetic" }, "src/counter.ts");
  });
  try {
    const out = await findIssues({ ...f.ctx, factory: sessions, options: { maxRounds: 2, maxFindings: 10 } });
    assert.equal(reviewed, 1);
    assert.equal(verified, 9);
    assert.equal(out.findings.length, 9);
    assert.equal(out.pendingCandidates, 0);
    assert.equal(out.rounds[1].reviewerRan, false);
    assert.equal(out.rounds[0].pending, 1);
  } finally { f.cleanup(); }
});

test("unverified candidates are persisted separately when rounds run out", async () => {
  const f = await fixture();
  const sessions = factory(async (tools) => {
    for (let i = 0; i < 3; i++) await record(tools, i);
    await finish(tools);
  }, async (tools) => {
    await submitVerdictWithEvidence(tools, { verdict: "rejected", rationale: "The caller rules this input out" }, "src/counter.ts");
  });
  try {
    const out = await findIssues({ ...f.ctx, factory: sessions, options: { maxRounds: 1, maxVerificationsPerRound: 1 } });
    assert.equal(out.findings.length, 1);
    assert.equal(out.pendingCandidates, 2);
    assert.equal(out.pendingFindings.length, 2);
    assert.equal(f.ctx.memory.findings.list({ status: "candidate" }).length, 2);
    assert.equal(out.stoppedBecause, "max rounds reached (1)");
  } finally { f.cleanup(); }
});

test("verification prioritizes severity without treating the findings cap as a target", async () => {
  const f = await fixture();
  let seen = "";
  const sessions = factory(async (tools) => {
    await record(tools, 1, "P3");
    await record(tools, 2, "P0");
    await finish(tools);
  }, async (tools, prompt) => {
    seen = prompt;
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "Reachable data loss" }, "src/counter.ts");
  });
  try {
    const out = await findIssues({ ...f.ctx, factory: sessions, options: { maxFindings: 1 } });
    assert.match(seen, /Independent failure 2/);
    assert.equal(out.pendingCandidates, 1);
    assert.equal(out.findings[0].severity, "P0");
  } finally { f.cleanup(); }
});

test("concrete follow-up continues after a candidate-free first round", async () => {
  const f = await fixture();
  let rounds = 0;
  const sessions = factory(async (tools, prompt) => {
    rounds++;
    if (rounds === 1) await finish(tools, ["src/counter.ts: does the new arithmetic violate its caller contract?"]);
    else {
      assert.match(prompt, /caller contract/);
      await record(tools, 1);
      await finish(tools);
    }
  }, async (tools) => {
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "Caller requires one increment" }, "src/counter.ts");
  });
  try {
    const out = await findIssues({ ...f.ctx, factory: sessions, options: { maxRounds: 2 } });
    assert.equal(rounds, 2);
    assert.equal(out.findings.length, 1);
  } finally { f.cleanup(); }
});

test("reviewer receives code feedback, not a verifier rationale", async () => {
  const f = await fixture();
  let rounds = 0;
  const sessions = factory(async (tools, prompt) => {
    rounds++;
    if (rounds === 1) {
      await record(tools, 1);
      await finish(tools, ["check caller.ts"]);
    } else {
      assert.match(prompt, /CODE_ONLY_GUARD/);
      assert.ok(!prompt.includes("PRIVATE_VERIFIER_REASON"));
      await finish(tools);
    }
  }, async (tools) => {
    await submitVerdictWithEvidence(tools, { verdict: "rejected", rationale: "PRIVATE_VERIFIER_REASON", codeFeedback: "CODE_ONLY_GUARD: caller.ts validates this input" }, "src/counter.ts");
  });
  try {
    await findIssues({ ...f.ctx, factory: sessions, options: { maxRounds: 2 } });
    assert.equal(rounds, 2);
  } finally { f.cleanup(); }
});

test("missing finish_round fails rather than producing a clean review", async () => {
  const f = await fixture();
  try {
    await assert.rejects(findIssues({ ...f.ctx, factory: factory(async () => {}, async () => {}) }), /finish_round/);
  } finally { f.cleanup(); }
});

test("recorded candidates survive a reviewer missing finish_round", async () => {
  const f = await fixture();
  try {
    await assert.rejects(findIssues({ ...f.ctx, factory: factory(async (tools) => { await record(tools, 1); }, async () => {}) }), /finish_round/);
    const pending = f.ctx.memory.findings.list({ status: "candidate" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].claim, "Independent failure 1");
  } finally { f.cleanup(); }
});

test("an exhausted budget cannot pass a configured review gate", async () => {
  const f = await fixture();
  let verified = 0;
  try {
    const out = await findIssues({ ...f.ctx, options: { maxTokens: 100 }, factory: factory(async (tools) => {
      await record(tools, 1); await finish(tools);
    }, async () => { verified++; }, true) });
    assert.equal(verified, 0);
    assert.equal(out.incomplete, true);
    assert.equal(out.pendingCandidates, 1);
    assert.equal(findExitCode([], "P1", out.incomplete), 3);
    assert.equal(findExitCode([], "none", out.incomplete), 0);
    assert.equal(findExitCode([{ status: "confirmed", severity: "P1" }], "P1", true), 1);
    assert.match(renderFindResultText({ degraded: false, rounds: out.rounds, findings: [], stoppedBecause: out.stoppedBecause, pendingCandidates: 1, incomplete: true }), /not a clean review/);
  } finally { f.cleanup(); }
});

test("real usage aggregates once and stops before another verifier session", async () => {
  const f = await fixture();
  let verified = 0;
  const sessions = factory(async (tools) => {
    await record(tools, 1);
    await record(tools, 2);
    await finish(tools);
  }, async (tools) => {
    verified++;
    await submitVerdictWithEvidence(tools, { verdict: "confirmed", rationale: "confirmed" }, "src/counter.ts");
  }, true);
  try {
    const out = await findIssues({ ...f.ctx, factory: sessions, options: { maxTokens: 300 } });
    assert.equal(verified, 1);
    assert.equal(out.usage.totalTokens, 320);
    assert.equal(out.usage.cost, 0.02);
    assert.equal(out.estimatedTokens, 320);
    assert.equal(out.usageComplete, true);
    assert.equal(out.pendingCandidates, 1);
    assert.match(out.stoppedBecause, /token budget exhausted/);
  } finally { f.cleanup(); }
});

test("missing verdict is explicitly counted as an infrastructure uncertainty", async () => {
  const f = await fixture();
  try {
    const out = await findIssues({ ...f.ctx, factory: factory(async (tools) => { await record(tools, 1); await finish(tools); }, async () => {}) });
    assert.equal(out.findings[0].status, "uncertain");
    assert.equal(out.verificationErrors, 1);
    assert.equal(out.uncertaintyReasons["missing-verdict"], 1);
    assert.equal(out.usage, undefined);
    assert.equal(out.usageComplete, false);
  } finally { f.cleanup(); }
});

function candidate() {
  return { title: "failure", claim: "failure", trigger: "input", category: "correctness", severity: "P1", anchors: [], evidence: [], round: 1, identity: buildIdentity({ category: "correctness", claim: "failure", trigger: "input" }) };
}
const decisions = [
  { memoryId: "old", decision: "wont_fix", source: "user_explicit", scope: "symbol", claim: "old claim" },
  { memoryId: "current", decision: "accepted_risk", source: "user_explicit", scope: "symbol", claim: "current claim" },
];

test("historical applicability is per decision ID, not broadcast to all matches", () => {
  const state = createReviewState("base", "head", 2);
  const finding = applyVerdict(state, candidate(), { verdict: "confirmed", rationale: "real", confidence: 1, decisionAssessments: [
    { memoryId: "old", stillApplies: false }, { memoryId: "current", stillApplies: true },
  ] }, decisions);
  assert.equal(finding.status, "accepted_risk");
  assert.equal(finding.memoryMatches[0].stillApplies, false);
  assert.equal(finding.memoryMatches[1].stillApplies, true);
});

test("legacy blanket applicability cannot suppress multiple matched decisions", () => {
  const finding = applyVerdict(createReviewState("base", "head", 2), candidate(), { verdict: "confirmed", rationale: "real", confidence: 1, priorDecisionStillApplies: true }, decisions);
  assert.equal(finding.status, "confirmed");
  assert.ok(finding.memoryMatches.every((m) => !m.checkedByVerifier));
});

test("partial usage is labelled incomplete and estimated text is not added to measured usage", () => {
  const budget = new Budget({ maxRounds: 2, maxTokens: 1000 });
  budget.chargeSession(usage, "not double counted");
  budget.chargeSession(undefined, "12345678");
  assert.equal(budget.tokenEstimate, 162);
  assert.equal(budget.usage.totalTokens, 160);
  assert.equal(budget.usageComplete, false);
});

test("undefined maxTokens means unlimited: spend alone never exhausts the budget", () => {
  const budget = new Budget({ maxRounds: 2 });
  budget.chargeText("x".repeat(4_000_000));
  assert.equal(budget.exhausted(), null);
  assert.equal(budget.tokenEstimate, 1_000_000);

  const capped = new Budget({ maxRounds: 2, maxTokens: 10 });
  capped.chargeText("x".repeat(100)); // 25 estimated tokens >= cap of 10
  assert.match(capped.exhausted(), /token budget exhausted/);
});
