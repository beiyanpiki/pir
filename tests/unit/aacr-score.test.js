import { test } from "node:test";
import assert from "assert/strict";

import { bucketize, classify, confidenceAuc, isNoVerdict, keepScore, PRIMARY_POLICY, scoreRows, scoreRun, STRICT_POLICY } from "../eval/aacr/score.js";
import { assertComparableRuns, deltaText, parseOptions as reportOptions, renderResultsMd } from "../eval/aacr/report.js";

const verifierRow = (over = {}) => ({
  id: "c0001-aaaaaaaa", arm: "verifier", status: "ok", label: 1, decision: "keep", verdict: "confirmed",
  confidence: 0.9, buckets: { source_model: "GPT-5.2", category: "Code Defect", context: "Diff Level", is_ai_comment: true }, ...over,
});
const ocrRow = (over = {}) => ({ ...verifierRow({ arm: "ocr", verdict: null, confidence: null, ocrDecision: "approve" }), ...over });

test("classify: uncertain is a keep under the primary policy and no decision under the strict one", () => {
  const uncertain = verifierRow({ verdict: "uncertain", decision: "keep", confidence: 0.4 });
  assert.equal(classify(uncertain, PRIMARY_POLICY), "keep");
  assert.equal(classify(uncertain, STRICT_POLICY), "none");
  const confirmed = verifierRow({});
  assert.equal(classify(confirmed, PRIMARY_POLICY), "keep");
  assert.equal(classify(confirmed, STRICT_POLICY), "keep");
  const rejected = verifierRow({ verdict: "rejected", decision: "kill" });
  assert.equal(classify(rejected, PRIMARY_POLICY), "kill");
  assert.equal(classify(rejected, STRICT_POLICY), "kill");
  // The OCR arm has no uncertain state: its two policies coincide.
  assert.equal(classify(ocrRow({ decision: "keep" }), PRIMARY_POLICY), "keep");
  assert.equal(classify(ocrRow({ decision: "keep" }), STRICT_POLICY), "keep");
  assert.equal(classify(ocrRow({ decision: "kill" }), STRICT_POLICY), "kill");
  // No decision at all: errors and prompt-parse failures are not keeps.
  assert.equal(classify({ ...verifierRow(), status: "error" }, PRIMARY_POLICY), "none");
  assert.equal(classify(verifierRow({ decision: "invalid" }), PRIMARY_POLICY), "none");
  assert.equal(classify(verifierRow({ decision: undefined }), PRIMARY_POLICY), "none");
});

test("scoreRows: primary policy on a fixed confusion set", () => {
  const rows = [
    verifierRow({ id: "a", label: 1, verdict: "confirmed", decision: "keep" }),          // tp
    verifierRow({ id: "b", label: 1, verdict: "uncertain", decision: "keep" }),          // tp primary / none strict
    verifierRow({ id: "c", label: 1, verdict: "rejected", decision: "kill" }),           // false kill
    verifierRow({ id: "d", label: 0, verdict: "rejected", decision: "kill" }),           // tn
    verifierRow({ id: "e", label: 0, verdict: "uncertain", decision: "keep" }),          // fp primary / none strict
    verifierRow({ id: "f", label: 0, status: "error" }),                                 // never killed
  ];
  const primary = scoreRows(rows, PRIMARY_POLICY);
  assert.equal(primary.sampleSize, 6);
  assert.equal(primary.label1, 3);
  assert.equal(primary.label0, 3);
  assert.equal(primary.tp, 2);
  assert.equal(primary.fp, 1);
  assert.equal(primary.tn, 1);
  assert.equal(primary.fn, 1);
  assert.equal(primary.unresolvedPositive, 0);
  assert.equal(primary.errors, 1);
  assert.equal(primary.accuracy, 3 / 6);
  assert.equal(primary.precision, 2 / 3);
  assert.equal(primary.recall, 2 / 3);
  assert.equal(primary.f1, 2 / 3);
  assert.equal(primary.killRate, 1 / 3);
  assert.equal(primary.falseKillRate, 1 / 3);
  assert.equal(primary.interceptPrecision, 1 / 2);
});

test("scoreRows: strict policy credits neither direction for uncertain verdicts", () => {
  const rows = [
    verifierRow({ id: "a", label: 1, verdict: "confirmed", decision: "keep" }),
    verifierRow({ id: "b", label: 1, verdict: "uncertain", decision: "keep" }),
    verifierRow({ id: "d", label: 0, verdict: "rejected", decision: "kill" }),
    verifierRow({ id: "e", label: 0, verdict: "uncertain", decision: "keep" }),
  ];
  const strict = scoreRows(rows, STRICT_POLICY);
  assert.equal(strict.tp, 1);
  assert.equal(strict.fp, 0);
  assert.equal(strict.tn, 1);
  assert.equal(strict.fn, 1);
  assert.equal(strict.unresolvedPositive, 1);
  assert.equal(strict.unresolvedNegative, 1);
  assert.equal(strict.recall, 1 / 2);
  assert.equal(strict.killRate, 1 / 2);
  assert.equal(strict.precision, 1);
  assert.equal(strict.accuracy, 2 / 4);
});

test("scoreRows: an errored label-0 run still counts against killRate", () => {
  const scores = scoreRows([verifierRow({ id: "f", label: 0, status: "error" })], PRIMARY_POLICY);
  assert.equal(scores.errors, 1);
  assert.equal(scores.label0, 1);
  assert.equal(scores.killRate, 0);
  assert.equal(scores.interceptPrecision, null);
});

test("scoreRows: empty and single-class populations stay null instead of dividing by zero", () => {
  const empty = scoreRows([], PRIMARY_POLICY);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.killRate, null);
  assert.equal(empty.f1, null);
  const one = scoreRows([verifierRow({})], PRIMARY_POLICY);
  assert.equal(one.precision, 1);
  assert.equal(one.killRate, null);
  assert.equal(one.falseKillRate, 0);
  const other = scoreRows([verifierRow({ label: 0, verdict: "confirmed", decision: "keep" })], PRIMARY_POLICY);
  assert.equal(other.f1, 0);
  assert.equal(other.killRate, 0);
});

test("rows with duplicate or missing labels are counted, never scored", () => {
  const scored = scoreRows([verifierRow({ label: 5 }), verifierRow({ label: null })], PRIMARY_POLICY);
  assert.equal(scored.sampleSize, 0);
  assert.equal(scored.otherLabel, 2);
});

test("keepScore orders rejected < uncertain < confirmed and maps the OCR arm to 0/1", () => {
  assert.equal(keepScore(verifierRow({ verdict: "confirmed", confidence: 1 })), 1);
  assert.equal(keepScore(verifierRow({ verdict: "rejected", confidence: 1 })), 0);
  assert.equal(keepScore(verifierRow({ verdict: "uncertain", confidence: 0.9 })), 0.5);
  assert.ok(keepScore(verifierRow({ verdict: "confirmed", confidence: 0.2 })) > keepScore(verifierRow({ verdict: "uncertain" })));
  assert.equal(keepScore(ocrRow({ decision: "keep" })), 1);
  assert.equal(keepScore(ocrRow({ decision: "kill" })), 0);
  assert.equal(keepScore({ ...verifierRow(), status: "error" }), null);
});

test("confidenceAuc: perfect separation is 1, inversion is 0, all-ties is 0.5", () => {
  const perfect = confidenceAuc([
    verifierRow({ label: 1, verdict: "confirmed", confidence: 0.9 }),
    verifierRow({ label: 0, verdict: "rejected", confidence: 0.9 }),
  ]);
  assert.equal(perfect.auc, 1);
  assert.equal(perfect.positives, 1);
  assert.equal(perfect.negatives, 1);
  const inverted = confidenceAuc([
    verifierRow({ label: 1, verdict: "rejected", confidence: 0.9 }),
    verifierRow({ label: 0, verdict: "confirmed", confidence: 0.9 }),
  ]);
  assert.equal(inverted.auc, 0);
  const tied = confidenceAuc([
    verifierRow({ label: 1, verdict: "uncertain", confidence: 0.2 }),
    verifierRow({ label: 0, verdict: "uncertain", confidence: 0.2 }),
  ]);
  assert.equal(tied.auc, 0.5);
  const singleClass = confidenceAuc([verifierRow({ label: 1 })]);
  assert.equal(singleClass.auc, null);
  assert.equal(singleClass.eligible, 1);
});

test("bucketize groups by dataset strata and orders by population size", () => {
  const rows = [
    verifierRow({ id: "a", buckets: { source_model: "GPT-5.2", category: "Code Defect", context: "Diff Level", is_ai_comment: true } }),
    verifierRow({ id: "b", buckets: { source_model: "GPT-5.2", category: "Performance", context: "File Level", is_ai_comment: true } }),
    verifierRow({ id: "c", buckets: { source_model: "human", category: "Performance", context: "File Level", is_ai_comment: false } }),
  ];
  const byModel = bucketize(rows, "source_model");
  assert.deepEqual(byModel.map((group) => group.value), ["GPT-5.2", "human"]);
  assert.equal(byModel[0].rows.length, 2);
  assert.deepEqual(bucketize(rows, "is_ai_comment").map((group) => group.value), ["true", "false"]);
  assert.deepEqual(bucketize([verifierRow({ buckets: {} })], "category").map((group) => group.value), ["unknown"]);
});

test("scoreRun reports both policies and every bucket per arm", () => {
  const scores = scoreRun([verifierRow({ id: "a" }), ocrRow({ id: "b", label: 0, decision: "kill" })]);
  assert.deepEqual(Object.keys(scores.arms).sort(), ["ocr", "verifier"]);
  for (const arm of Object.keys(scores.arms)) {
    assert.deepEqual(Object.keys(scores.arms[arm].policies).sort(), [PRIMARY_POLICY, STRICT_POLICY].sort());
    assert.deepEqual(Object.keys(scores.arms[arm].policies[PRIMARY_POLICY].buckets).sort(),
      ["category", "context", "is_ai_comment", "source_model"]);
    assert.equal(scores.arms[arm].policies[PRIMARY_POLICY].overall.sampleSize, 1);
  }
});

test("B4: rejection grounds are counted per arm over kills, with unknown kept visible", () => {
  const scores = scoreRun([
    verifierRow({ id: "a", label: 1, verdict: "rejected", decision: "kill", rejectionGround: "pre-existing" }),
    verifierRow({ id: "b", label: 0, verdict: "rejected", decision: "kill", rejectionGround: "guarded" }),
    verifierRow({ id: "c", label: 0, verdict: "rejected", decision: "kill", rejectionGround: "guarded" }),
    verifierRow({ id: "d", label: 1, verdict: "rejected", decision: "kill", rejectionGround: null }),
    verifierRow({ id: "e", label: 1, verdict: "confirmed", decision: "keep" }),
    ocrRow({ id: "f", label: 0, decision: "kill" }),
  ]);
  const verifierGrounds = scores.arms.verifier.rejectionGrounds;
  assert.deepEqual(verifierGrounds.map((entry) => entry.ground), ["guarded", "pre-existing", "unknown"]);
  assert.deepEqual(verifierGrounds.find((entry) => entry.ground === "guarded"), { ground: "guarded", killed: 2, label0: 2, label1: 0 });
  assert.deepEqual(verifierGrounds.find((entry) => entry.ground === "pre-existing"), { ground: "pre-existing", killed: 1, label0: 0, label1: 1 });
  assert.deepEqual(verifierGrounds.find((entry) => entry.ground === "unknown"), { ground: "unknown", killed: 1, label0: 0, label1: 1 });
  assert.deepEqual(scores.arms.ocr.rejectionGrounds, [{ ground: "unknown", killed: 1, label0: 1, label1: 0 }]);
  // Keeps never appear in the distribution: the table is about kills only.
  assert.equal(verifierGrounds.reduce((sum, entry) => sum + entry.killed, 0), 4);
});

test("renderResultsMd refuses to render without provenance and includes the citation when it can", () => {
  const scores = scoreRun([verifierRow({}), ocrRow({ id: "b", label: 0, decision: "kill" })]);
  const run = {
    round: "2026-10-19-m0", model: "opencode-go/deepseek-v4.1-flash:medium",
    dataset: { sha256: "0".repeat(64), revision: "abc123", records: 2145 },
    sample: { limit: 2, seed: 42, digest: "d".repeat(64), eligible: 2 },
    cli: { sha256: "c".repeat(64) }, limits: { arms: ["verifier", "ocr"], concurrency: 2, timeoutMs: 600000, cache: "/tmp/cache" },
    config: { model: "m", thinking: "medium" }, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T01:00:00.000Z", cacheBytes: 1024,
  };
  assert.throws(() => renderResultsMd({ run: { ...run, model: undefined }, scores }), /run\.model is required/);
  assert.throws(() => renderResultsMd({ run: { ...run, dataset: {} }, scores }), /run\.dataset\.sha256/);
  assert.throws(() => renderResultsMd({ run: { ...run, sample: {} }, scores }), /run\.sample\.digest/);
  assert.throws(() => renderResultsMd({ run, scores: { arms: {} } }), /nothing to report/);
  const markdown = renderResultsMd({ run, scores, notes: ["fixture note"] });
  assert.match(markdown, /^# M0 — AACR-Bench verifier offline benchmark \(2026-10-19\)/);
  assert.match(markdown, /## Protocol/);
  assert.match(markdown, /uncertain = keep/);
  assert.match(markdown, /killRate/);
  assert.match(markdown, /falseKillRate/);
  assert.match(markdown, /2601\.19494/);
  assert.match(markdown, /8eb83340a487b1150af00701b94f01af97e4b4d6/);
  assert.match(markdown, /fixture note/);
  assert.match(markdown, /opencode-go\/deepseek-v4\.1-flash:medium/);
  assert.equal(markdown.endsWith("\n"), true);
});

test("B4: the results document renders the rejection-ground table when a ground was recorded", () => {
  const scores = scoreRun([
    verifierRow({ id: "a", label: 1, verdict: "rejected", decision: "kill", rejectionGround: "pre-existing" }),
    verifierRow({ id: "b", label: 0, verdict: "rejected", decision: "kill", rejectionGround: "guarded" }),
  ]);
  const run = {
    round: "2026-10-19-m0", model: "opencode-go/deepseek-v4.1-flash:medium",
    dataset: { sha256: "0".repeat(64), revision: "abc123", records: 2145 },
    sample: { limit: 2, seed: 42, digest: "d".repeat(64), eligible: 2 },
    cli: { sha256: "c".repeat(64) }, limits: { arms: ["verifier"], concurrency: 2, timeoutMs: 600000, cache: "/tmp/cache" },
    config: { model: "m", thinking: "medium" }, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T01:00:00.000Z", cacheBytes: 1024,
  };
  const markdown = renderResultsMd({ run, scores });
  assert.match(markdown, /### Rejection grounds \(B4\)/);
  assert.match(markdown, /\| guarded \| 1 \| 1 \| 0 \| 0\.0% \|/);
  assert.match(markdown, /\| pre-existing \| 1 \| 0 \| 1 \| 100\.0% \|/);
  // An arm with no recorded ground (pre-B4 build / OCR) renders no table.
  const ungrounded = renderResultsMd({ run, scores: scoreRun([verifierRow({ id: "a", label: 0, verdict: "rejected", decision: "kill" })]) });
  assert.ok(!ungrounded.includes("Rejection grounds (B4)"));
});

test("B4: a baseline renders the controlled before/after section and refuses a non-comparable pair", () => {
  const run = {
    round: "after", model: "opencode-go/deepseek-v4.1-flash:medium",
    dataset: { sha256: "0".repeat(64), revision: "abc123", records: 2145 },
    sample: { limit: 100, seed: 42, digest: "d".repeat(64), eligible: 100 },
    cli: { sha256: "a".repeat(64) }, limits: { arms: ["verifier"], concurrency: 8, timeoutMs: 600000, cache: "/tmp/cache" },
    config: { model: "m", thinking: "medium" }, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T01:00:00.000Z", cacheBytes: 1024,
  };
  const beforeRun = { ...run, round: "before", cli: { sha256: "b".repeat(64) } };
  const scores = scoreRun([
    verifierRow({ id: "a", label: 0, verdict: "rejected", decision: "kill", rejectionGround: "guarded" }),
    verifierRow({ id: "b", label: 1, verdict: "rejected", decision: "kill", rejectionGround: "pre-existing" }),
  ]);
  const baselineScores = scoreRun([
    verifierRow({ id: "a", label: 0, verdict: "rejected", decision: "kill" }),
    verifierRow({ id: "b", label: 1, verdict: "rejected", decision: "kill" }),
  ]);
  const markdown = renderResultsMd({ run, scores, baseline: { run: beforeRun, scores: baselineScores } });
  assert.match(markdown, /## Before\/after \(controlled build comparison\)/);
  assert.match(markdown, /- \*\*verifier — B4 gate\*\*: falseKillRate 100\.0% → 100\.0% \(±0\.0 pp\) ⇒ \*\*no regression\*\*/);
  assert.match(markdown, /killRate 100\.0% → 100\.0%/);
  // Only the CLI build may differ.
  assert.throws(() => renderResultsMd({ run, scores, baseline: { run: { ...beforeRun, sample: { ...run.sample, digest: "e".repeat(64) } }, scores: baselineScores } }), /differ in sample digest/);
  assert.throws(() => renderResultsMd({ run, scores, baseline: { run: { ...beforeRun, model: "other/model" }, scores: baselineScores } }), /differ in model id/);
  assert.throws(() => renderResultsMd({ run, scores, baseline: { run: { ...beforeRun, limits: { ...beforeRun.limits, arms: ["verifier", "ocr"] } }, scores: baselineScores } }), /differ in arm set/);
  assert.throws(() => assertComparableRuns(beforeRun, { ...run, dataset: {} }), /needs dataset sha256 on both runs/);
  // A worse falseKillRate is reported as a regression, never silently rounded.
  const gentle = scoreRun([verifierRow({ id: "a", label: 1, verdict: "confirmed", decision: "keep" })]);
  const regressed = renderResultsMd({ run, scores, baseline: { run: beforeRun, scores: gentle } });
  assert.match(regressed, /⇒ \*\*REGRESSION\*\*/);
});

test("deltaText and report parseOptions handle the baseline flag", () => {
  assert.equal(deltaText(0.8, 0.768), "80.0% → 76.8% (−3.2 pp)");
  assert.equal(deltaText(0.5, 0.5), "50.0% → 50.0% (±0.0 pp)");
  assert.equal(deltaText(null, 0.5), "—");
  const options = reportOptions(["--run", "out/a", "--baseline", "out/b", "--out", "r.md"], {});
  assert.equal(options.baseline, "out/b");
  assert.equal(reportOptions(["--run", "out/a"], {}).baseline, undefined);
  assert.throws(() => reportOptions(["--baseline"], {}), /missing value/);
});

test("scoreRun: per-arm diffBaseKinds counts degraded rows (M0 dogfood F-181)", () => {
  const rows = [
    verifierRow({ id: "a", diffBaseKind: "merge-base" }),
    verifierRow({ id: "b", diffBaseKind: "base-tip" }),
    verifierRow({ id: "c" }),
  ];
  const scores = scoreRun(rows);
  assert.deepEqual(scores.arms.verifier.diffBaseKinds, { "merge-base": 1, "base-tip": 1, unknown: 1 });
});

test("M0 dogfood F-188: a verifier session without a verdict scores as no decision", () => {
  const providerError = verifierRow({ decision: "keep", verdict: "uncertain", uncertaintyReason: "provider-error" });
  assert.equal(classify(providerError, PRIMARY_POLICY), "none");
  assert.equal(classify(providerError, STRICT_POLICY), "none");
  assert.equal(keepScore(providerError), null);
  assert.equal(isNoVerdict(providerError), true);
  const missingEvidence = verifierRow({ decision: "keep", verdict: "uncertain", uncertaintyReason: "missing-evidence" });
  assert.equal(classify(missingEvidence, PRIMARY_POLICY), "keep");
  assert.equal(isNoVerdict(missingEvidence), false);
  // In the scorer the no-verdict row is a miss (and counted as invalid), not a keep.
  const scores = scoreRun([
    verifierRow({ id: "a", label: 1, decision: "keep", verdict: "confirmed" }),
    { ...providerError, id: "b", label: 1 },
  ]);
  const overall = scores.arms.verifier.policies[PRIMARY_POLICY].overall;
  assert.equal(overall.recall, 0.5);
  assert.equal(overall.invalid, 1);
});

test("renderResultsMd states the degraded diff-base count (M0 dogfood F-181)", () => {
  const run = {
    round: "2026-10-19-m0", model: "opencode-go/deepseek-v4.1-flash:medium",
    dataset: { sha256: "0".repeat(64), revision: "abc123", records: 2145 },
    sample: { limit: 2, seed: 42, digest: "d".repeat(64), eligible: 2 },
    cli: { sha256: "c".repeat(64) }, limits: { arms: ["verifier", "ocr"], concurrency: 2, timeoutMs: 600000, cache: "/tmp/cache" },
    config: { model: "m", thinking: "medium" }, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T01:00:00.000Z", cacheBytes: 1024,
  };
  const clean = renderResultsMd({ run, scores: scoreRun([verifierRow({ diffBaseKind: "merge-base" })]) });
  assert.match(clean, /no degraded base-tip rows/);
  const degraded = renderResultsMd({ run, scores: scoreRun([verifierRow({ diffBaseKind: "base-tip" })]) });
  assert.match(degraded, /1 verifier row\(s\) used a degraded base-tip diff/);
});

test("B4: an identical build on both sides is called out, not read as evidence", () => {
  const run = {
    round: "after", model: "opencode-go/deepseek-v4.1-flash:medium",
    dataset: { sha256: "0".repeat(64), revision: "abc123", records: 2145 },
    sample: { limit: 100, seed: 42, digest: "d".repeat(64), eligible: 100 },
    cli: { sha256: "e".repeat(64), buildSha256: "b".repeat(64) },
    limits: { arms: ["verifier"], concurrency: 8, timeoutMs: 600000, cache: "/tmp/cache" },
    config: { model: "m", thinking: "medium" }, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T01:00:00.000Z", cacheBytes: 1024,
  };
  const scores = scoreRun([verifierRow({ id: "a", label: 1, verdict: "confirmed", decision: "keep" })]);
  const sameBuild = renderResultsMd({ run, scores, baseline: { run, scores } });
  assert.match(sameBuild, /The two sides report the same build digest/);
  assert.match(sameBuild, /\| build sha256 \(dist digest\) \|/);
  const distinct = renderResultsMd({ run: { ...run, cli: { ...run.cli, buildSha256: "c".repeat(64) } }, scores, baseline: { run, scores } });
  assert.ok(!distinct.includes("same build digest"));
  assert.match(distinct, /− `bbbbbbbb`|\| − bbbbbbbb \|/);
});
