import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Budget,
  DEFAULT_FIND_REVIEWER_INPUT_TOKENS,
  DEFAULT_FIND_VERIFIER_INPUT_TOKENS,
  inputTokensOf,
} from "../../dist/core/budget.js";

const usage = (over = {}) => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
  cost: 0, durationMs: 1, toolCalls: 0, repeatedToolCalls: 0, ...over,
});

test("Default budget: the documented find ceilings are 1.2M reviewer + 0.8M verifier input tokens", () => {
  // Pinned on purpose: these constants may only be tightened after checking
  // the end-to-end benchmark's per-PR token distribution, recorded as an ADR 0006
  // amendment — not by an incidental edit.
  assert.equal(DEFAULT_FIND_REVIEWER_INPUT_TOKENS, 1_200_000);
  assert.equal(DEFAULT_FIND_VERIFIER_INPUT_TOKENS, 800_000);
});

test("Default budget accounting: prompt-side spend sums uncached input + cache reads + cache writes, per role", () => {
  assert.equal(inputTokensOf(usage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 })), 60);
  assert.equal(inputTokensOf(usage({ inputTokens: 5 })), 5, "partial usage must not poison the sum with NaN");

  const budget = new Budget({ maxRounds: 2 });
  budget.chargeSession(usage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 500, totalTokens: 560 }), "reviewer");
  assert.equal(budget.reviewerInputTokens, 60);
  assert.equal(budget.inputTokenEstimate, 60);
  assert.equal(budget.verifierInputTokens, 0);
  assert.equal(budget.tokenEstimate, 560, "the whole-run counter keeps the measured-total semantics");
});

test("Default budget: the reviewer ceiling is graceful — exhausted() names it, hardExhausted() ignores it", () => {
  const budget = new Budget({ maxRounds: 3, reviewerTokens: DEFAULT_FIND_REVIEWER_INPUT_TOKENS, verifierTokens: DEFAULT_FIND_VERIFIER_INPUT_TOKENS });
  budget.chargeSession(usage({ inputTokens: DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000, totalTokens: DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000 }), "reviewer");

  const hit = budget.ceilingHit();
  assert.equal(hit.kind, "reviewer-tokens");
  assert.equal(hit.reason, `reviewer token budget exhausted (${DEFAULT_FIND_REVIEWER_INPUT_TOKENS + 50_000} of ${DEFAULT_FIND_REVIEWER_INPUT_TOKENS} input tokens)`);
  assert.equal(budget.exhausted(), hit.reason);
  assert.equal(budget.hardExhausted(), null, "the pending verification drain must not stop on a default ceiling");
});

test("Default budget: the verifier ceiling is named distinctly and is equally graceful", () => {
  const budget = new Budget({ maxRounds: 3, reviewerTokens: DEFAULT_FIND_REVIEWER_INPUT_TOKENS, verifierTokens: DEFAULT_FIND_VERIFIER_INPUT_TOKENS });
  budget.chargeSession(usage({ inputTokens: DEFAULT_FIND_VERIFIER_INPUT_TOKENS + 1, totalTokens: DEFAULT_FIND_VERIFIER_INPUT_TOKENS + 1 }), "verifier");

  assert.equal(budget.ceilingHit().kind, "verifier-tokens");
  assert.match(budget.exhausted(), /verifier token budget exhausted \(800001 of 800000 input tokens\)/);
  assert.equal(budget.hardExhausted(), null);
});

test("Default budget: gracefulExhausted() reports the default ceilings only, never a hard one", () => {
  const grace = new Budget({ maxRounds: 3, reviewerTokens: 100 });
  grace.chargeSession(usage({ inputTokens: 120, totalTokens: 120 }), "reviewer");
  assert.match(grace.gracefulExhausted(), /reviewer token budget exhausted/);
  assert.equal(grace.hardExhausted(), null);

  const hard = new Budget({ maxRounds: 3, maxTokens: 100, reviewerTokens: 100_000 });
  hard.chargeSession(usage({ inputTokens: 150, totalTokens: 150 }), "reviewer");
  assert.equal(hard.gracefulExhausted(), null, "a hard ceiling reports first and never defers");
  assert.match(hard.hardExhausted(), /token budget exhausted/);

  const none = new Budget({ maxRounds: 3, verifierTokens: 100 });
  assert.equal(none.gracefulExhausted(), null, "configured but unreached is not exhausted");
});

test("Default budget: an explicit maxTokens ceiling stays hard and keeps the measured-total accounting", () => {
  const budget = new Budget({ maxRounds: 3, maxTokens: 100 });
  budget.chargeSession(usage({ inputTokens: 90, outputTokens: 20, totalTokens: 110 }), "verifier");

  assert.equal(budget.verifierInputTokens, 90);
  assert.equal(budget.ceilingHit().kind, "tokens");
  assert.match(budget.hardExhausted(), /token budget exhausted \(110 tokens\)/, "an explicit ceiling still refuses new verifier admissions");
});

test("Default budget: a budget with no ceilings is unlimited — spend alone never exhausts it (audit's shape)", () => {
  const budget = new Budget({ maxRounds: Number.MAX_SAFE_INTEGER });
  budget.chargeSession(usage({ inputTokens: 50_000_000, totalTokens: 50_000_000 }), "reviewer");
  budget.chargeSession(usage({ inputTokens: 50_000_000, totalTokens: 50_000_000 }), "verifier");
  assert.equal(budget.exhausted(), null);
  assert.equal(budget.hardExhausted(), null);
});

test("Default budget: role-less charges count toward the whole-run totals only", () => {
  const budget = new Budget({ maxRounds: 2, reviewerTokens: 100, verifierTokens: 100 });
  budget.chargeSession(usage({ inputTokens: 200, totalTokens: 200 }));
  assert.equal(budget.reviewerInputTokens, 0);
  assert.equal(budget.verifierInputTokens, 0);
  assert.equal(budget.inputTokenEstimate, 200);
  assert.equal(budget.exhausted(), null);
});

test("Default budget: estimated fallback spend is attributed to the charging role and marks usage incomplete", () => {
  const budget = new Budget({ maxRounds: 2, reviewerTokens: 100 });
  budget.chargeSession(undefined, "reviewer", "x".repeat(400)); // 4 chars/token -> 100 estimated tokens
  assert.equal(budget.reviewerInputTokens, 100);
  assert.equal(budget.usageComplete, false);
  assert.equal(budget.ceilingHit().kind, "reviewer-tokens");
});

test("Default budget: the wall clock stays a hard ceiling (the grace covers token ceilings only)", async () => {
  const budget = new Budget({ maxRounds: 3, maxWallClockMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(budget.ceilingHit().kind, "wall-clock");
  assert.match(budget.hardExhausted(), /wall-clock budget exhausted/);
});
