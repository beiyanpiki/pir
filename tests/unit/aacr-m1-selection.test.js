import { test } from "node:test";
import assert from "assert/strict";

import { fixtureDigest } from "../eval/aacr/fixtures/build-fixture.js";
import {
  assertJudgeCompatible, assertSelectionCompatible, effectiveJudgeLimits, effectiveRunLimits,
  effectiveSelectionLimits, parseOptions, seededOrder, selectFixtureRows,
} from "../eval/aacr/m1/run-aacr.js";

const row = (id) => ({ instance_id: id, repo: "example/repo", reference_comments: [] });
const rows = Array.from({ length: 12 }, (_, index) => row("example__repo@" + String(index).padStart(7, "0")));
const ids = (selected) => selected.map((entry) => entry.instance_id);

test("seededOrder is the verifier-benchmark sample's PRNG and Fisher-Yates loop", () => {
  assert.deepEqual(ids(seededOrder(rows, 42)), ids(seededOrder(rows, 42)), "same seed, same order");
  assert.deepEqual(seededOrder(rows, undefined), rows, "no seed keeps the fixture order");
  assert.notDeepEqual(ids(seededOrder(rows, 42)), ids(seededOrder(rows, 43)), "a different seed selects a different order");
  assert.deepEqual([...ids(seededOrder(rows, 42))].sort(), [...ids(rows)].sort(), "a shuffle is a permutation, never a subset");
  assert.throws(() => seededOrder(rows, -1), /seed must be a non-negative integer/);
  assert.throws(() => seededOrder(rows, 1.5), /seed must be a non-negative integer/);
  assert.throws(() => seededOrder("nope", 1), /rows must be an array/);
});

test("selectFixtureRows: filter, seeded shuffle, then limit", () => {
  const limited = selectFixtureRows(rows, { limit: 50, seed: 42 });
  assert.equal(limited.length, 12, "a limit above the population selects the whole permutation");
  assert.deepEqual(ids(selectFixtureRows(rows, { limit: 5, seed: 42 })), ids(seededOrder(rows, 42)).slice(0, 5));
  assert.deepEqual(ids(selectFixtureRows(rows, { limit: 5 })), ids(rows).slice(0, 5), "no seed keeps the pre-change-protocol fixture-order limit");
  assert.deepEqual(
    ids(selectFixtureRows(rows, { only: ids(rows).slice(2, 8), limit: 3, seed: 7 })),
    ids(seededOrder(rows.slice(2, 8), 7)).slice(0, 3),
    "--only filters before the seeded order",
  );
  assert.throws(() => selectFixtureRows(rows, { only: ["missing@1234567"] }), /--only ids not in the fixture/);
  assert.throws(() => selectFixtureRows("nope", {}), /rows must be an array/);
});

test("the selection digest is stable, order-sensitive and distinguishes subsets", () => {
  const a = selectFixtureRows(rows, { limit: 5, seed: 42 });
  const b = selectFixtureRows(rows, { limit: 5, seed: 42 });
  assert.equal(fixtureDigest(a), fixtureDigest(b));
  assert.notEqual(fixtureDigest(a), fixtureDigest(selectFixtureRows(rows, { limit: 5, seed: 43 })));
  assert.match(fixtureDigest(a), /^[0-9a-f]{64}$/);
});

test("assertSelectionCompatible: seeds and instance sets are provenance pins", () => {
  const selected = selectFixtureRows(rows, { limit: 5, seed: 42 });
  const recorded = { limits: { seed: 42 }, fixture: { instanceSetDigest: fixtureDigest(selected) } };
  assert.doesNotThrow(() => assertSelectionCompatible(recorded, { selected, seed: 42 }));
  assert.doesNotThrow(() => assertSelectionCompatible(recorded, { selected, judgeOnly: true }), "judge-only replays the recorded subset");
  assert.throws(() => assertSelectionCompatible(recorded, { selected, seed: 43 }), /refuses to mix seeds/);
  assert.throws(
    () => assertSelectionCompatible(recorded, { selected: selectFixtureRows(rows, { limit: 6, seed: 42 }), seed: 42 }),
    /refuses to change the selected instance set/,
  );
  assert.doesNotThrow(() => assertSelectionCompatible({ limits: {} }, { selected }), "a pre-change-protocol round (no recorded seed) resumes without one");
  assert.throws(() => assertSelectionCompatible({ limits: {} }, { selected, seed: 42 }), /round was recorded with no seed/);
});

test("effectiveSelectionLimits: a judge-only pass keeps the round's population pin (dogfood F-1)", () => {
  const normal = effectiveSelectionLimits(parseOptions(["--limit", "50", "--seed", "42"], {}));
  assert.deepEqual(normal, { limit: 50, seed: 42, only: [] });
  assert.deepEqual(effectiveSelectionLimits(parseOptions([], {})), { limit: null, seed: null, only: [] });
  const judgeOnly = effectiveSelectionLimits(
    parseOptions(["--round", "r", "--resume", "--judge-only", "--judge", "real"], {}),
    { limit: 50, seed: 42, only: ["a@1111111"] },
  );
  assert.deepEqual(judgeOnly, { limit: 50, seed: 42, only: ["a@1111111"] }, "the recorded triple survives the rewrite");
  assert.throws(() => effectiveSelectionLimits({ judgeOnly: true }, null), /recorded selection/);
});

test("effectiveRunLimits: a judge-only pass keeps the reviewer pass's run limits", () => {
  const recorded = { limits: { concurrency: 6, maxRounds: 2, maxTokens: "unlimited", maxFindings: "unlimited", timeoutMs: 7200000, cache: "/cache" } };
  const judgeOnly = effectiveRunLimits(parseOptions(["--resume", "--judge-only", "--judge", "real"], {}), recorded);
  assert.deepEqual(judgeOnly, { concurrency: 6, maxRounds: 2, maxTokens: "unlimited", maxFindings: "unlimited", timeoutMs: 7200000, cache: "/cache" });
  const fresh = effectiveRunLimits(parseOptions(["--concurrency", "4", "--timeout", "600000"], {}), null);
  assert.equal(fresh.concurrency, 4);
  assert.equal(fresh.timeoutMs, 600000);
  assert.equal(fresh.maxTokens, "unlimited");
});

test("effectiveJudgeLimits: skipping a judge pass never erases the recorded identity (dogfood F-4)", () => {
  const judged = { limits: { judge: "real", judgeModel: "glm-5.3", judgeTimeoutMs: 10800000, evalRounds: 3, judgeFrameworkCommit: "a".repeat(40) } };
  const off = effectiveJudgeLimits(parseOptions([], {}), judged, null, {});
  assert.deepEqual(off, { judge: "real", judgeModel: "glm-5.3", judgeTimeoutMs: 10800000, evalRounds: 3, judgeFrameworkCommit: "a".repeat(40) });
  const fresh = effectiveJudgeLimits(parseOptions([], {}), null, null, {});
  assert.deepEqual(fresh, { judge: "off", judgeModel: null, judgeTimeoutMs: null, evalRounds: 1, judgeFrameworkCommit: null });
  const real = effectiveJudgeLimits(
    parseOptions(["--judge", "real", "--eval-rounds", "3"], {}), null, { commit: "b".repeat(40) },
    { JUDGE_MODEL: "glm-5.3", PIR_AACR_JUDGE_TIMEOUT_MS: "900000" },
  );
  assert.deepEqual(real, { judge: "real", judgeModel: "glm-5.3", judgeTimeoutMs: 900000, evalRounds: 3, judgeFrameworkCommit: "b".repeat(40) });
});

test("assertJudgeCompatible: real-judge identity is a refusal, not a footnote (dogfood F-4)", () => {
  const pin = "a".repeat(40);
  const recorded = { limits: { judge: "real", judgeModel: "glm-5.3", evalRounds: 3, judgeFrameworkCommit: pin } };
  const same = { judge: "real", judgeModel: "glm-5.3", evalRounds: 3, judgeFrameworkCommit: pin, judging: true };
  assert.doesNotThrow(() => assertJudgeCompatible(recorded, same));
  assert.doesNotThrow(() => assertJudgeCompatible(recorded, { ...same, judging: false }), "not re-judging: nothing to compare");
  assert.throws(() => assertJudgeCompatible(recorded, { ...same, judgeModel: "other-model" }), /refuses to mix judge model/);
  assert.throws(() => assertJudgeCompatible(recorded, { ...same, evalRounds: 1 }), /refuses to mix eval-rounds/);
  assert.throws(() => assertJudgeCompatible(recorded, { ...same, judgeFrameworkCommit: "b".repeat(40) }), /refuses to mix judge framework commit/);
  assert.throws(() => assertJudgeCompatible(recorded, { ...same, judge: "mock" }), /refuses to replace a real-judge round with a mock re-judge/);
  assert.doesNotThrow(() => assertJudgeCompatible({ limits: { judge: "mock", evalRounds: 1 } }, same), "a mock round may be upgraded to the real judge");
  assert.doesNotThrow(() => assertJudgeCompatible({ limits: { judge: "off" } }, same), "an unjudged round accepts its first judge identity");
  assert.doesNotThrow(
    () => assertJudgeCompatible({ limits: { judge: "real", judgeModel: null, evalRounds: 3 } }, same),
    "a round recorded before the framework pin existed is unknown, not a mismatch",
  );
});

test("driver options: --seed parsing and --judge-only restrictions", () => {
  assert.equal(parseOptions([], {}).seed, undefined);
  assert.equal(parseOptions(["--seed", "42"], {}).seed, 42);
  assert.equal(parseOptions([], { PIR_AACR_SEED: "7" }).seed, 7);
  // Dogfood F-2: "" (and whitespace-only) is an unset variable, not seed 0.
  assert.equal(parseOptions([], { PIR_AACR_SEED: "" }).seed, undefined);
  assert.equal(parseOptions([], { PIR_AACR_SEED: "   " }).seed, undefined);
  assert.equal(parseOptions(["--seed", "0"], {}).seed, 0, "seed 0 is a valid seed");
  assert.equal(parseOptions(["--limit", "50", "--seed", "42"], {}).limit, 50);
  assert.throws(() => parseOptions(["--seed", "-1"], {}), /seed must be a non-negative integer/);
  assert.throws(() => parseOptions(["--seed", "2.5"], {}), /seed must be a non-negative integer/);
  assert.throws(() => parseOptions(["--seed", "nope"], {}), /seed must be a non-negative integer/);
  assert.throws(() => parseOptions(["--seed"], {}), /missing value/);
  assert.throws(
    () => parseOptions(["--judge-only", "--resume", "--judge", "mock", "--seed", "42"], {}),
    /--limit\/--only\/--seed are not allowed/,
  );
});
