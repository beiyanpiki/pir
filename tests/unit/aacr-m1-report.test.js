import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balancedScore,
  bucketMetricsForRound,
  categoryMetricsForRound,
  instanceStatsFromEvalRes,
  renderM1Report,
  sizeBucketOf,
} from "../../tests/eval/aacr/m1/report-m1.js";

/**
 * M1 A1 renderer: the bucket math mirrors upstream's formulas (micro per
 * bucket per judge round, averaged across rounds), missing instances stay out
 * of denominators, and a partial round cannot be published by accident.
 * Model-free; synthetic eval_res only.
 */

const fixtureRows = [
  {
    instance_id: "acme__web@abc1234", project_main_language: "TypeScript", change_line_count: 40,
    reference_comments: [{ path: "a.ts", text: "one" }, { path: "a.ts", text: "two" }],
    comment_meta: [{ category: "Correctness" }, { category: "Performance" }],
  },
  {
    instance_id: "acme__api@def5678", project_main_language: "Go", change_line_count: 300,
    reference_comments: [{ path: "b.go", text: "three" }],
    comment_meta: [{ category: "Correctness" }],
  },
];

const evalRes = [
  {
    instance_id: "acme__web@abc1234",
    comments: [
      { note: "one", path: "a.ts", file_semantic_match: true },
      { note: "two", path: "a.ts", file_semantic_match: false },
    ],
    generated_comments: [
      { note: "hit", path: "a.ts", hit_new_gt: true },
      { note: "miss", path: "a.ts", hit_new_gt: false },
    ],
  },
  {
    instance_id: "acme__api@def5678",
    comments: [{ note: "three", path: "b.go", file_semantic_match: true }],
    generated_comments: [],
  },
];

const summary = {
  schemaVersion: 1,
  round: "2026-10-20-test-m1",
  startedAt: "2026-10-20T00:00:00.000Z",
  finishedAt: "2026-10-20T04:00:00.000Z",
  model: "provider/model:max",
  cli: { path: "dist/cli/cli.js", sha256: "a".repeat(64) },
  fixture: { sha256: "b".repeat(64), instanceSetDigest: "c".repeat(32) },
  views: ["reported"],
  repeats: 1,
  limits: { concurrency: 8, maxRounds: 2, maxTokens: "unlimited", maxFindings: "unlimited", timeoutMs: 7_200_000, judge: "real", evalRounds: 2, judgeModel: "judge-model" },
  population: { selected: 3, repos: 2, fixtureRows: 3 },
  instances: [
    { instanceId: "acme__web@abc1234", status: "ok", views: { reported: 2, confirmedOnly: 1 }, dropped: { anchorless: 0 }, usage: { total_tokens: 1000 }, wallTimeMs: 60_000, incomplete: false },
    { instanceId: "acme__api@def5678", status: "ok", views: { reported: 0, confirmedOnly: 0 }, dropped: { anchorless: 1 }, usage: { total_tokens: 2000 }, wallTimeMs: 120_000, incomplete: true, stoppedBecause: "budget", pendingCandidates: 1 },
    { instanceId: "acme__gone@0000000", status: "error", stage: "fetch-head", error: "upload-pack: not our ref" },
  ],
};

const metricsByView = {
  reported: {
    rounds: [
      { round: 1, data: { eval_res: evalRes } },
      { round: 2, data: { eval_res: evalRes } },
    ],
    average: {
      evaluated_instances: 2, missing_instances: 1, expected_notes: 3, generated_notes: 2,
      matched_file_semantic_notes: 2, matched_generated_notes: 1,
      file_semantic_match_rate: 0.5, file_semantic_recall_rate: 0.6667, balanced_score: 0.5714,
    },
  },
};

test("balanced score matches the upstream harmonic mean and zero guard", () => {
  assert.equal(balancedScore(0.5, 0.5), 0.5);
  assert.equal(balancedScore(0.5, 0), 0);
  assert.equal(balancedScore(0, 0), 0);
  assert.equal(balancedScore(0.5, 0.25), 0.333);
});

test("PR size buckets cover the documented edges", () => {
  assert.equal(sizeBucketOf(0), "lt50");
  assert.equal(sizeBucketOf(49), "lt50");
  assert.equal(sizeBucketOf(50), "50-199");
  assert.equal(sizeBucketOf(199), "50-199");
  assert.equal(sizeBucketOf(200), "200-499");
  assert.equal(sizeBucketOf(499), "200-499");
  assert.equal(sizeBucketOf(500), "ge500");
});

test("instance accounting reads reference matches and credited generated comments", () => {
  const stats = instanceStatsFromEvalRes(evalRes);
  assert.deepEqual(stats.get("acme__web@abc1234"), { refs: 2, matchedRefs: 1, generated: 2, matchedGenerated: 1 });
  assert.deepEqual(stats.get("acme__api@def5678"), { refs: 1, matchedRefs: 1, generated: 0, matchedGenerated: 0 });
});

test("bucket metrics are micro per round with integer-friendly rates", () => {
  const byId = new Map(fixtureRows.map((row) => [row.instance_id, row]));
  const languages = bucketMetricsForRound(evalRes, byId, (row) => row.project_main_language);
  const ts = languages.get("TypeScript");
  assert.equal(ts.instances, 1);
  assert.equal(ts.refs, 2);
  assert.equal(ts.matchedRefs, 1);
  assert.equal(ts.precision, 0.5);
  assert.equal(ts.recall, 0.5);
  assert.equal(ts.balanced, 0.5);
  const go = languages.get("Go");
  assert.equal(go.precision, 0);
  assert.equal(go.recall, 1);
  assert.equal(go.balanced, 0);

  const categories = categoryMetricsForRound(evalRes, byId);
  assert.equal(categories.get("Correctness").refs, 2);
  assert.equal(categories.get("Correctness").matchedRefs, 2);
  assert.equal(categories.get("Performance").recall, 0);
});

test("rendered document carries the headline, buckets, missing count and health ledger", () => {
  const markdown = renderM1Report({
    summary, fixtureRows, metricsByView,
    meta: { framework: { repo: "https://github.com/alibaba/aacr-bench", commit: "e".repeat(40) }, citation: { arxiv: "2601.19494", bibtex: "@misc{test}" } },
    title: "M1 test report", renderedAt: "2026-10-20T05:00:00.000Z",
  });
  assert.match(markdown, /# M1 test report/);
  assert.match(markdown, /arXiv:2601\.19494/);
  assert.match(markdown, /judge-model/);
  assert.match(markdown, /\*\*57\.1%\*\*/, "balanced_score headline");
  assert.match(markdown, /50\.0%/);
  assert.match(markdown, /by language/);
  assert.match(markdown, /TypeScript/);
  assert.match(markdown, /by PR size/);
  assert.match(markdown, /< 50 lines/);
  assert.match(markdown, /by reference-comment category/);
  assert.match(markdown, /Correctness/);
  assert.match(markdown, /1 error row|Error rows/);
  assert.match(markdown, /upload-pack: not our ref/);
  assert.match(markdown, /budget/);
  assert.match(markdown, /Missing instances stay out of the denominators/);
  assert.match(markdown, /Cost and duration/);
  assert.match(markdown, /M1-2026-10-20-test-m1\.md/);
});

test("a seeded subset is reproducible from the rendered document (dogfood F-7)", () => {
  const seeded = { ...summary, limits: { ...summary.limits, limit: 2, seed: 42 }, population: { selected: 2, repos: 2, fixtureRows: 3 } };
  const markdown = renderM1Report({ summary: seeded, fixtureRows, metricsByView, meta: null, renderedAt: "2026-10-20T05:00:00.000Z" });
  assert.match(markdown, /--limit 2/);
  assert.match(markdown, /--seed 42/);
  assert.match(markdown, /this round selected 2/);
  assert.match(markdown, /the reviewer round \(2 instances/);
  assert.doesNotMatch(markdown, /196 PRs; costs model runs/);
});

test("a round without finishedAt is refused unless explicitly partial", () => {
  const partial = { ...summary, finishedAt: undefined };
  assert.throws(
    () => renderM1Report({ summary: partial, fixtureRows, metricsByView, meta: null }),
    /refusing to render a round without finishedAt/,
  );
  const markdown = renderM1Report({ summary: partial, fixtureRows, metricsByView, meta: null, allowPartial: true });
  assert.match(markdown, /PARTIAL ROUND/);
});
