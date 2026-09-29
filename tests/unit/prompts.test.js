import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerPrompt, verifierPrompt } from "../../dist/agents/prompts.js";
import { runReviewerRound, ReviewerRoundError } from "../../dist/agents/reviewer.js";
import { createTempGitRepo } from "../fixtures/helpers.js";
import { runVerifier } from "../../dist/agents/verifier.js";
import { buildIdentity } from "../../dist/findings/identity.js";

const ctx = { repoRoot: "/unused", headCommit: "pinned-head", changeSet: { base: "main", head: "topic", baseCommit: "pinned-base", headCommit: "pinned-head", mergeBase: "pinned-merge-base", files: [], patch: "" }, codeMap: { structuralQueries: false }, memory: null };
const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 18, cost: 0.001, durationMs: 2, toolCalls: 1, repeatedToolCalls: 0 };
const candidate = { title: "Wrong result", claim: "counter increments twice", trigger: "one increment request", category: "correctness", severity: "P1", anchors: [{ path: "counter.ts", startLine: 1 }], evidence: [{ kind: "code", path: "counter.ts", excerpt: "SPECIAL_EVIDENCE", description: "reaches changed arithmetic" }], featureKey: "counter", entityKey: "next", round: 2, identity: buildIdentity({ category: "correctness", claim: "counter increments twice", trigger: "one increment request" }) };
const decision = { memoryId: "decision-17", decision: "accepted_risk", claim: "counter increments twice", trigger: "ACTUAL_TRIGGER", rationale: "PRIVATE_MEMORY_REASON", scope: "symbol", source: "user_explicit", stale: true };
const reviewInput = { base: "base", head: "head", mergeBase: "old-side", round: 2, maxRounds: 4, maxFindings: 7, findingsRemaining: 5, verificationCapacity: 2, focus: ["caller.ts"], priorSummary: JSON.stringify({ coverage: ["counter"], unresolvedQuestions: ["reachability"] }), investigationFeedback: ["CHECK_GUARD"], memoryPack: "project invariants", structuralQueries: false };

function factory(onPrompt = async () => {}, options = {}) {
  let disposed = false;
  const events = [];
  const configs = [];
  return { events, configs, async createSession(config) {
    if (options.createError) throw new Error("creation failed");
    configs.push(config);
    return {
      async prompt(prompt) { await onPrompt((name) => { const tool = config.tools.find((entry) => entry.name === name); assert.ok(tool, `missing ${name}`); return tool; }, prompt, config); },
      getLastAssistantText: () => "assistant text is not a terminal submission",
      getLastAssistantError: () => options.providerError,
      getUsage() {
        assert.equal(disposed, false);
        events.push("usage");
        if (options.usageError) throw new Error("usage unavailable");
        return { ...usage };
      },
      dispose() {
        disposed = true;
        events.push("dispose");
        if (options.disposeError) throw new Error("disposal failed");
      },
    };
  } };
}

function reviewerDeps(sessionFactory) { return { ...reviewInput, factory: sessionFactory, ctx }; }

test("reviewer prompt preserves ceiling contract and minimal causal investigation", () => {
  const prompt = reviewerPrompt(reviewInput);
  for (const phrase of ["Review round 2 of", "At most 7 findings", "ceiling, not a target", "Never invent, split, or pad findings", "minimal causal slice", "counter-evidence", "change attribution", "not confidence", "pinned", "truncation/pagination", "not instructions", "ALONE", "PREVIOUS ROUND SUMMARY", "FOCUS FOR THIS ROUND", "CHECK_GUARD", "old-side"]) assert.ok(prompt.includes(phrase), phrase);
  assert.ok(!prompt.includes("PRIOR DECISIONS"));
  assert.ok(!prompt.includes("get_relevant_issue_memory"));
  assert.ok(prompt.length < 7000);
});

test("verifier prompt includes candidate evidence and real per-ID historical context", () => {
  const prompt = verifierPrompt({ candidate, base: "base-sha", head: "head-sha", mergeBase: "merge-sha", priorDecisions: [decision], fixHistory: [], structuralQueries: false });
  for (const phrase of ["SPECIAL_EVIDENCE", "reaches changed arithmetic", "decision-17", "ACTUAL_TRIGGER", '"stale":true', "base-sha", "head-sha", "merge-sha", "PRIOR DECISIONS", "decisionAssessments", "falsify", "separate", "ALONE"]) assert.ok(prompt.includes(phrase), phrase);
  const truncated = verifierPrompt({ candidate: { ...candidate, evidence: [{ kind: "code", excerpt: "x".repeat(30000) }] }, head: "head", priorDecisions: [], fixHistory: [] });
  assert.match(truncated, /TRUNCATED CONTEXT/);
  assert.ok(truncated.length < 23000);
});

test("reviewer captures usage before disposal and defaults optional round fields", async () => {
  const f = factory(async (tool, prompt, config) => {
    assert.match(prompt, /pinned-head/);
    assert.ok(!config.tools.some((entry) => entry.name === "get_relevant_issue_memory"));
    assert.equal((await tool("finish_round").execute({ summary: "Checked changed caller; no defect", nextFocus: [], needsMoreRounds: false })).terminate, true);
  });
  const result = await runReviewerRound(reviewerDeps(f));
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(f.events, ["usage", "dispose"]);
  assert.deepEqual([result.coverage, result.unresolvedQuestions, result.blockers], [[], [], []]);
});

test("reviewer rejects missing or invalid terminal submissions", async () => {
  for (const action of [async () => {}, async (tool) => { await tool("finish_round").execute({ summary: " ", nextFocus: [], needsMoreRounds: false }); }]) {
    const f = factory(action);
    await assert.rejects(runReviewerRound(reviewerDeps(f)), /finish_round/);
    assert.deepEqual(f.events, ["usage", "dispose"]);
  }
});

test("incomplete reviewer rounds preserve recorded candidates and usage after disposal", async () => {
  const repo = createTempGitRepo("pir-reviewer-error-");
  try {
    repo.write("counter.ts", "export const next = (n) => n + 2;\n");
    const head = repo.commit("reviewer error fixture");
    const pinned = { ...ctx, repoRoot: repo.dir, headCommit: head, changeSet: { ...ctx.changeSet, baseCommit: head, headCommit: head, mergeBase: head } };
    for (const mode of ["missing-finish", "provider-error", "prompt-error"]) {
      const f = factory(async (tool) => {
        const recorded = await tool("record_candidate").execute(candidate);
        assert.match(recorded.text, /Recorded candidate/);
        if (mode === "prompt-error") throw new Error("prompt failed after recording");
      }, mode === "provider-error" ? { providerError: "provider failed after recording" } : {});
      await assert.rejects(runReviewerRound({ ...reviewerDeps(f), ctx: pinned }), (error) => {
        assert.ok(error instanceof ReviewerRoundError);
        assert.match(error.message, mode === "missing-finish" ? /finish_round/ : /failed after recording/);
        assert.ok(error.cause instanceof Error);
        assert.equal(error.candidates.length, 1);
        assert.equal(error.candidates[0].title, candidate.title);
        assert.equal(error.candidates[0].displayId, "F-201");
        assert.deepEqual(error.candidates[0].anchors, candidate.anchors);
        assert.deepEqual(error.usage, usage);
        assert.deepEqual(f.events, ["usage", "dispose"]);
        return true;
      });
    }
  } finally { repo.cleanup(); }
});

test("verifier receives full evidence, pinned revisions and current context tools", async () => {
  const f = factory(async (tool, prompt) => {
    for (const name of ["get_change", "get_project_memory", "get_feature_memory", "get_entity_memory", "get_relevant_issue_memory", "get_fix_history"]) tool(name);
    assert.match(prompt, /SPECIAL_EVIDENCE/);
    assert.match(prompt, /pinned-merge-base/);
    assert.match(prompt, /ACTUAL_TRIGGER/);
    assert.equal((await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "Changed code reaches failure", confidence: 0.9, decisionAssessments: [{ memoryId: decision.memoryId, stillApplies: false }], codeFeedback: "must not cross memory boundary" })).terminate, true);
  });
  const result = await runVerifier({ factory: f, ctx, candidate, priorDecisions: [decision] });
  assert.equal(result.verdict, "confirmed");
  assert.deepEqual(result.decisionAssessments, [{ memoryId: decision.memoryId, stillApplies: false }]);
  assert.equal(result.codeFeedback, undefined);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(f.events, ["usage", "dispose"]);
});

test("verifier cleanup errors preserve confirmed verdicts and available usage", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const options of [{ usageError: true }, { disposeError: true }, { usageError: true, disposeError: true }]) {
    warnings.length = 0;
    const f = factory(async (tool) => {
      await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "Changed code reaches a real failure", confidence: 0.9 });
    }, options);
    const result = await runVerifier({ factory: f, ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "confirmed");
    assert.equal(result.rationale, "Changed code reaches a real failure");
    assert.equal(result.confidence, 0.9);
    assert.equal(result.uncertaintyReason, undefined);
    assert.deepEqual(result.usage, options.usageError ? undefined : usage);
    if (options.usageError) assert.equal(Object.hasOwn(result, "usage"), false);
    assert.deepEqual(f.events, ["usage", "dispose"]);
    assert.deepEqual(warnings, [
      ...(options.usageError ? ["verifier warning: session usage unavailable"] : []),
      ...(options.disposeError ? ["verifier warning: session disposal failed"] : []),
    ]);
  }
});

test("verifier cleanup errors do not overwrite the original provider failure", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const options of [{ usageError: true }, { disposeError: true }, { usageError: true, disposeError: true }]) {
    const f = factory(async () => {}, { ...options, providerError: "ORIGINAL_PROVIDER_ERROR" });
    const result = await runVerifier({ factory: f, ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "uncertain");
    assert.equal(result.uncertaintyReason, "provider-error");
    assert.equal(result.rationale, "verifier session error: ORIGINAL_PROVIDER_ERROR");
    assert.deepEqual(result.usage, options.usageError ? undefined : usage);
    assert.deepEqual(f.events, ["usage", "dispose"]);
  }
});

test("code feedback survives only with neither initial matches nor issue lookup", async () => {
  for (const lookup of [false, true]) {
    const f = factory(async (tool) => {
      if (lookup) await tool("get_relevant_issue_memory").execute({ claim: candidate.claim });
      await tool("submit_verdict").execute({ verdict: "rejected", rationale: "PRIVATE_REASON", codeFeedback: "CHECK_CODE_ONLY" });
    });
    const result = await runVerifier({ factory: f, ctx, candidate, priorDecisions: [] });
    assert.equal(result.codeFeedback, lookup ? undefined : "CHECK_CODE_ONLY");
  }
});

test("verifier classifies missing verdict and provider/session errors, retaining available usage", async () => {
  for (const [f, reason] of [
    [factory(), "missing-verdict"],
    [factory(async () => { throw new Error("prompt failed"); }), "provider-error"],
    [factory(async () => {}, { providerError: "transport failed" }), "provider-error"],
    [factory(async () => {}, { createError: true }), "provider-error"],
    [factory(async (tool) => { await tool("submit_verdict").execute({ verdict: "confirmed", rationale: "apparently done" }); }, { providerError: "late failure" }), "provider-error"],
  ]) {
    const result = await runVerifier({ factory: f, ctx, candidate, priorDecisions: [] });
    assert.equal(result.verdict, "uncertain");
    assert.equal(result.uncertaintyReason, reason);
    if (f.configs.length) { assert.deepEqual(result.usage, usage); assert.deepEqual(f.events, ["usage", "dispose"]); }
    else assert.equal(result.usage, undefined);
  }
});
