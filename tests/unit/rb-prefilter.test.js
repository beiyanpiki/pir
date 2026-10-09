import { test } from "node:test";
import assert from "assert/strict";

import {
  pairScore,
  prefilterTask,
  renderPrefilterMd,
  summarizeRound,
  PROBABLE_MATCH_THRESHOLD,
  PATH_BONUS,
} from "../eval/reviewbench/prefilter.js";

// Deterministic stub standing in for claimSimilarity: word-set Jaccard over
// lowercase tokens — same shape as the real token Jaccard it injects at run
// time, without importing dist (model-free discipline).
function stubSimilarity(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

const golden = (message, file) => ({ message, file });

test("pair score adds the path bonus only when an anchor path matches", () => {
  const g = golden("race condition on shared counter increment", "src/counter.ts");
  const samePath = { message: "unrelated wording entirely here now", paths: ["src/counter.ts"] };
  const otherPath = { message: "race condition on shared counter increment", paths: ["src/other.ts"] };
  const exact = { message: "race condition on shared counter increment", paths: ["src/counter.ts"] };
  const simSamePath = pairScore(g, samePath, stubSimilarity);
  assert.equal(simSamePath, stubSimilarity(g.message, samePath.message) + PATH_BONUS);
  assert.equal(pairScore(g, otherPath, stubSimilarity), 1); // similarity 1, no bonus
  assert.equal(pairScore(g, exact, stubSimilarity), 1 + PATH_BONUS);
  // Path comparison tolerates ./ and backslashes on the pir side.
  const messyPath = { message: "nothing in common at all", paths: ["./src\\counter.ts"] };
  assert.equal(pairScore(g, messyPath, stubSimilarity), stubSimilarity(g.message, messyPath.message) + PATH_BONUS);
});

test("threshold separates probable matches and unmatched lists stay consistent", () => {
  const goldenFindings = [
    golden("mutex missing around cache update in handler", "src/cache.ts"),
    golden("sql injection through unsanitized user column", "db/query.ts"),
  ];
  const pirFindings = [
    { message: "mutex missing around cache update in handler", paths: ["src/cache.ts"] }, // high sim + bonus
    { message: "typo in documentation footer link", paths: ["docs/README.md"] }, // noise
  ];
  const result = prefilterTask({ goldenFindings, pirFindings, similarity: stubSimilarity });
  const top = result.pairs[0];
  assert.equal(top.goldenIndex, 0);
  assert.equal(top.pirIndex, 0);
  assert.ok(top.score >= PROBABLE_MATCH_THRESHOLD);
  assert.deepEqual(result.counts, { goldenTotal: 2, pirTotal: 2, goldenMatched: 1, pirMatched: 1 });
  assert.deepEqual(result.unmatchedGolden, [1]);
  assert.deepEqual(result.unmatchedPir, [1]);
});

test("pairs never cross tasks: identical texts in two tasks score independently", () => {
  const message = "identical claim text for both tasks";
  const a = prefilterTask({
    goldenFindings: [golden(message, "a.ts")],
    pirFindings: [{ message, paths: ["a.ts"] }],
    similarity: stubSimilarity,
  });
  const b = prefilterTask({
    goldenFindings: [golden(message, "b.ts")],
    pirFindings: [],
    similarity: stubSimilarity,
  });
  assert.equal(a.counts.goldenMatched, 1);
  assert.equal(b.counts.goldenMatched, 0);
  assert.deepEqual(b.unmatchedGolden, [0]);
  const summary = summarizeRound([
    { prKey: "task-a", result: a },
    { prKey: "task-b", result: b },
  ]);
  assert.deepEqual(summary, {
    tasks: 2,
    goldenTotal: 2,
    pirTotal: 1,
    goldenMatched: 1,
    pirMatched: 1,
    crudeRecall: 0.5,
    crudePrecision: 1,
  });
});

test("summarizeRound keeps missing measurements null instead of zero", () => {
  assert.equal(summarizeRound([]).crudeRecall, null);
  assert.equal(summarizeRound([]).crudePrecision, null);
  const noGolden = prefilterTask({ goldenFindings: [], pirFindings: [{ message: "x", paths: ["x.ts"] }], similarity: stubSimilarity });
  const summary = summarizeRound([{ prKey: "t", result: noGolden }]);
  assert.equal(summary.crudeRecall, null);
  assert.equal(summary.crudePrecision, 0);
});

test("renderPrefilterMd emits both unmatched sections with per-task headers", () => {
  const goldenFindings = [golden("mutex missing around cache update in handler", "src/cache.ts")];
  const pirFindings = [
    { message: "mutex missing around cache update in handler", paths: ["src/cache.ts"], start_line: 3, end_line: 5 },
    { message: "typo in documentation footer link", paths: ["docs/README.md"], start_line: 1 },
  ];
  const result = prefilterTask({ goldenFindings, pirFindings, similarity: stubSimilarity });
  const md = renderPrefilterMd({
    round: "smoke",
    variant: "candidate-run1",
    taskResults: [{ prKey: "example_repo_1-abcdef12", goldenFindings, pirFindings, result }],
  });
  assert.match(md, /^# ReviewBench prefilter — smoke \/ candidate-run1$/m);
  assert.match(md, /Advisory deterministic estimate.*threshold 0\.5/m);
  assert.match(md, /Crude recall bound: 1\/1 golden findings have ≥1 probable match/m);
  assert.match(md, /Crude precision: 1\/2 reported findings probable-matched/m);
  assert.match(md, /## Unmatched pir findings \(potential false positives\)/m);
  assert.match(md, /### example_repo_1-abcdef12/m);
  assert.match(md, /- \[1\] docs\/README\.md:1 — typo in documentation footer link/m);
  assert.doesNotMatch(md, /## Unmatched golden findings/); // no unmatched golden in this fixture
});

test("renderPrefilterMd truncates long messages to single-line excerpts", () => {
  const long = `${"very long finding text ".repeat(40)}tail`;
  const result = prefilterTask({ goldenFindings: [], pirFindings: [{ message: long, paths: ["x.ts"] }], similarity: stubSimilarity });
  const md = renderPrefilterMd({
    round: "r",
    variant: "v-run1",
    taskResults: [{ prKey: "k", goldenFindings: [], pirFindings: [{ message: long, paths: ["x.ts"] }], result }],
  });
  const lines = md.split("\n").filter((l) => l.startsWith("- [0]"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 220);
  assert.ok(lines[0].endsWith("…"));
});

test("prefilterTask requires an injected similarity function", () => {
  assert.throws(() => prefilterTask({ goldenFindings: [], pirFindings: [] }), TypeError);
});
