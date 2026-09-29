import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scoreFindings, extractOutcomeMetrics, summarizeRuns, validateExpectations } from "../eval/scoring.js";
import { cloneSnapshot, createFixture, parseOptions, runCli } from "../eval/run-eval.js";
import { SCENARIOS } from "../eval/scenarios.js";

const expectation = (extra = {}) => ({ id: "counter", claimLike: "increment", shouldReport: true,
  locations: [{ path: "src/counter.ts", startLine: 2, endLine: 4 }], categories: ["correctness"],
  minSeverity: "P2", maxSeverity: "P1", ...extra });
const finding = (extra = {}) => ({ displayId: "F-1", title: "Double increment", claim: "The counter increments twice",
  status: "confirmed", category: "correctness", severity: "P2",
  anchors: [{ path: "src/counter.ts", startLine: 3 }], ...extra });
function temporary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pir-eval-unit-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("confirmed TP requires text, category, location and valid severity", () => {
  const good = scoreFindings([finding()], [expectation()]);
  assert.equal(good.pass, true);
  assert.deepEqual(good.metrics, { precision: 1, recall: 1, f1: 1, uncertaintyRate: 0 });
  for (const extra of [{ title: "Leak", claim: "memory leak" }, { category: "style" },
    { anchors: [{ path: "other.ts", startLine: 3 }] }, { anchors: [{ path: "src/counter.ts", startLine: 10 }] },
    { anchors: [] }, { severity: "P3" }, { severity: "P0" }, { severity: "critical" }]) {
    const score = scoreFindings([finding(extra)], [expectation()]);
    assert.equal(score.counts.truePositives, 0, JSON.stringify(extra));
    assert.equal(score.counts.falsePositives, 1);
    assert.equal(score.counts.falseNegatives, 1);
  }
});

test("normalizes relative paths and accepts anchor range overlap only", () => {
  assert.equal(scoreFindings([finding({ anchors: [{ path: ".\\src\\counter.ts", startLine: 1, endLine: 2 }] })], [expectation()]).pass, true);
  for (const anchors of [[{ path: "src/counter.ts", startLine: 4, endLine: 2 }],
    [{ path: "src/counter.ts", startLine: "3" }], [null]]) {
    assert.equal(scoreFindings([finding({ anchors })], [expectation()]).pass, false);
  }
});

test("unexpected reports and duplicate reports are false positives", () => {
  const score = scoreFindings([finding(), finding({ displayId: "F-2" }),
    finding({ displayId: "F-3", title: "Other issue", claim: "unrelated" })], [expectation()]);
  assert.equal(score.counts.truePositives, 1);
  assert.equal(score.counts.falsePositives, 2);
  assert.equal(score.metrics.precision, 1 / 3);
  assert.deepEqual(score.falsePositiveReports.map((r) => r.classification).sort(), ["duplicate", "unexpected"]);
  assert.equal(scoreFindings([finding()], []).counts.falsePositives, 1);
});

test("one report cannot satisfy two labels", () => {
  const score = scoreFindings([finding()], [expectation(), expectation({ id: "second" })]);
  assert.equal(score.counts.truePositives, 1);
  assert.equal(score.counts.falseNegatives, 1);
  assert.equal(score.metrics.recall, 0.5);
});

test("maximum matching recovers overlapping labels rather than greedily missing one", () => {
  const score = scoreFindings([finding(), finding({ displayId: "F-2", title: "Wrong limit", claim: "limit too low" })],
    [expectation({ id: "broad", claimLike: "increment|limit" }), expectation({ id: "specific" })]);
  assert.equal(score.counts.truePositives, 2);
  assert.equal(new Set(score.matches.map((m) => m.findingIndex)).size, 2);
});

test("uncertain matches explain misses but never become confirmed success", () => {
  const score = scoreFindings([finding({ status: "uncertain" })], [expectation()]);
  assert.equal(score.pass, false);
  assert.equal(score.counts.truePositives, 0);
  assert.equal(score.counts.falseNegatives, 1);
  assert.equal(score.counts.falsePositives, 0);
  assert.equal(score.counts.uncertainMatched, 1);
  assert.equal(score.uncertainReports[0].classification, "expected-unconfirmed");
  assert.equal(score.metrics.recall, 0);
  assert.equal(score.metrics.precision, null);
  const duplicate = scoreFindings([finding(), finding({ status: "uncertain" })], [expectation()]);
  assert.equal(duplicate.counts.uncertainMatched, 0);
  assert.equal(duplicate.uncertainReports[0].classification, "duplicate");
  assert.equal(duplicate.pass, false);
});

test("uncertain findings obey one-to-one matching and severity validation", () => {
  const score = scoreFindings([finding({ status: "uncertain" })], [expectation(), expectation({ id: "other" })]);
  assert.equal(score.counts.falseNegatives, 2);
  assert.equal(score.counts.uncertainMatched, 1);
  const invalid = scoreFindings([finding({ status: "uncertain", severity: "P9" })], [expectation()]);
  assert.equal(invalid.counts.uncertainMatched, 0);
  assert.equal(invalid.counts.invalidSeverities, 1);
  assert.equal(invalid.uncertainReports[0].classification, "severity-mismatch");
});

test("negative labels do not forgive unlabelled reports or count as true positives", () => {
  const labels = [expectation({ shouldReport: false })];
  const clean = scoreFindings([], labels);
  assert.equal(clean.pass, true);
  assert.equal(clean.metrics.precision, null);
  assert.equal(clean.metrics.recall, null);
  const report = scoreFindings([finding()], labels);
  assert.equal(report.counts.falsePositives, 1);
  assert.equal(report.counts.negativeLabelsReported, 1);
  assert.equal(report.falsePositiveReports[0].classification, "negative-label");
  const uncertain = scoreFindings([finding({ status: "uncertain" })], labels);
  assert.equal(uncertain.counts.negativeLabelsUncertain, 1);
  assert.equal(uncertain.pass, false);
  assert.equal(scoreFindings([finding({ claim: "unrelated", title: "unrelated" })], labels).pass, false);
});

test("suppressed and candidate records cannot satisfy positive expectations", () => {
  for (const status of ["rejected", "expected", "false_positive", "wont_fix", "fixed", "candidate"]) {
    const score = scoreFindings([finding({ status })], [expectation()]);
    assert.equal(score.counts.falseNegatives, 1);
    assert.equal(score.counts.ignored, 1);
    assert.equal(score.counts.truePositives, 0);
  }
  assert.throws(() => scoreFindings([finding({ status: "unknown" })], []), /recognized statuses/);
  assert.throws(() => scoreFindings(null, []), /array/);
});

test("malformed ground truth fails loudly", () => {
  for (const labels of [[expectation(), expectation()], [expectation({ claimLike: "[" })],
    [expectation({ minSeverity: "P9" })], [expectation({ minSeverity: "P1", maxSeverity: "P3" })],
    [expectation({ locations: [] })], [expectation({ categories: [] })], [expectation({ shouldReport: undefined })]]) {
    assert.throws(() => validateExpectations(labels));
  }
});

test("baseline missing measurements remain unknown, never zero", () => {
  const metrics = extractOutcomeMetrics({ run: { rounds: [{ round: 1 }] }, estimatedTokens: 33 }, 42);
  assert.equal(metrics.usage, null);
  assert.equal(metrics.usageComplete, null);
  assert.equal(metrics.pendingCandidates, null);
  assert.equal(metrics.verificationErrors, null);
  assert.equal(metrics.durationMs, null);
  assert.equal(metrics.wallTimeMs, 42);
  assert.equal(metrics.rounds, 1);
  const partial = extractOutcomeMetrics({ usage: { cost: 0, toolCalls: 2, totalTokens: -1 }, usageComplete: false,
    pendingCandidates: 0, verificationErrors: 0, durationMs: 5 }, 10);
  assert.equal(partial.usage.cost, 0);
  assert.equal(partial.usage.inputTokens, null);
  assert.equal(partial.usage.totalTokens, null);
  assert.equal(partial.pendingCandidates, 0);
  assert.equal(partial.usageComplete, false);
});

test("micro-averages report coverage and exclude incomplete usage totals", () => {
  const score = scoreFindings([finding()], [expectation()]);
  const runs = [{ score, pass: true, measurements: extractOutcomeMetrics({ usage: { cost: 2 }, usageComplete: true }, 10) },
    { score: scoreFindings([], [expectation()]), pass: false, measurements: extractOutcomeMetrics({ usage: { cost: 3 }, usageComplete: false }, 20) },
    { error: "timeout", pass: false, measurements: extractOutcomeMetrics({}, 30) }];
  const summary = summarizeRuns(runs);
  assert.equal(summary.runs, 3);
  assert.equal(summary.scoredRuns, 2);
  assert.equal(summary.executionErrors, 1);
  assert.equal(summary.metrics.recall, 0.5);
  assert.deepEqual(summary.usage.cost, { measuredRuns: 1, total: 2, mean: 2, partialOrUnknownRuns: 1 });
  assert.equal(summary.usage.totalTokens.total, null);
  assert.equal(summary.wallTimeMs.mean, 20);
  assert.equal(summary.pendingCandidates.total, null);
});

test("repeat and paired CLI options support environment equivalents and validation", () => {
  const env = { PIR_EVAL_REPEATS: "2", PIR_EVAL_BASELINE_CLI: "/tmp/baseline.js", PIR_EVAL_CANDIDATE_CLI: "/tmp/candidate.js", PIR_MODEL: "provider/model" };
  const options = parseOptions(["--repeats", "3", "--json", "--max-rounds", "4"], env);
  assert.equal(options.repeats, 3);
  assert.equal(options.baselineCli, env.PIR_EVAL_BASELINE_CLI);
  assert.equal(options.candidateCli, env.PIR_EVAL_CANDIDATE_CLI);
  assert.equal(options.model, env.PIR_MODEL);
  assert.equal(options.maxRounds, 4);
  assert.equal(options.json, true);
  for (const args of [["--repeats", "0"], ["--repeats", "-1"], ["--repeats", "1.5"], ["--repeats"], ["--unknown"], ["--timeout-ms", "NaN"]]) {
    assert.throws(() => parseOptions(args, {}));
  }
});

test("PIR_EVAL gate does not access CLI or config and emits parseable JSON", () => {
  const runner = fileURLToPath(new URL("../eval/run-eval.js", import.meta.url));
  const result = spawnSync(process.execPath, [runner, "--json", "--candidate-cli", "/does/not/exist.js"],
    { env: { ...process.env, PIR_EVAL: "0" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { skipped: true, reason: "PIR_EVAL=1 required" });
});

test("clones isolate seeded memory, repository files and mutable configuration", () => temporary((root) => {
  const snapshot = path.join(root, "snapshot");
  for (const dir of ["repo", "state", "agent"]) mkdirSync(path.join(snapshot, dir), { recursive: true });
  for (const file of ["repo/a.ts", "state/memory.sqlite", "agent/auth.json"]) writeFileSync(path.join(snapshot, file), "seed");
  const a = path.join(root, "a"), b = path.join(root, "b");
  cloneSnapshot(snapshot, a); cloneSnapshot(snapshot, b);
  for (const file of ["repo/a.ts", "state/memory.sqlite", "agent/auth.json"]) {
    writeFileSync(path.join(a, file), "changed");
    assert.equal(readFileSync(path.join(b, file), "utf8"), "seed");
    assert.equal(readFileSync(path.join(snapshot, file), "utf8"), "seed");
  }
  assert.throws(() => cloneSnapshot(snapshot, a), /already exists/);
}));

test("fake local CLI preserves baseline output and pending diagnostics without models", () => temporary((root) => {
  const runDir = path.join(root, "run");
  mkdirSync(path.join(runDir, "repo"), { recursive: true });
  const cli = path.join(root, "fake.cjs");
  const options = { model: "test/model", maxRounds: 2, maxTokens: 123, maxFindings: 4, timeoutMs: 5000 };
  const snapshot = { base: "base-sha", head: "head-sha", expectations: [expectation()] };
  const data = { findings: [finding()], run: { rounds: [] } };
  writeFileSync(cli, `process.stdout.write(JSON.stringify({data: ${JSON.stringify(data)}}));`);
  const baseline = runCli(cli, runDir, options, snapshot);
  assert.equal(baseline.pass, true);
  assert.equal(baseline.measurements.usage, null);
  assert.equal(baseline.pendingFindings, null);
  assert.equal(baseline.measurements.incomplete, null);
  writeFileSync(cli, `process.stdout.write(JSON.stringify({data: { findings: [], incomplete: true }}));`);
  const unfinishedClean = runCli(cli, runDir, options, { ...snapshot, expectations: [] });
  assert.equal(unfinishedClean.score.pass, true);
  assert.equal(unfinishedClean.pass, false);
  assert.equal(unfinishedClean.measurements.incomplete, true);
  writeFileSync(cli, `process.stdout.write(JSON.stringify({data: { findings: [], incomplete: false }}));`);
  const finishedClean = runCli(cli, runDir, options, { ...snapshot, expectations: [] });
  assert.equal(finishedClean.pass, true);
  assert.equal(finishedClean.measurements.incomplete, false);
  for (const extra of [{ incomplete: true }, { pendingCandidates: 1 }, { verificationErrors: 1 }, { pendingFindings: [{ status: "candidate" }] }]) {
    writeFileSync(cli, `process.stdout.write(JSON.stringify({data: ${JSON.stringify({ ...data, ...extra })}}));`);
    assert.equal(runCli(cli, runDir, options, snapshot).pass, false);
  }
  writeFileSync(cli, "process.stdout.write('not JSON');");
  assert.match(runCli(cli, runDir, options, snapshot).error, /JSON|Unexpected/);
}));

test("fixture histories are deterministic and labels never enter the reviewed checkout", () => temporary((root) => {
  const names = new Set(), ids = new Set();
  assert.ok(SCENARIOS.length >= 12);
  for (const [index, scenario] of SCENARIOS.entries()) {
    assert.ok(!names.has(scenario.name)); names.add(scenario.name);
    validateExpectations(scenario.expect);
    const builds = [0, 1].map((copy) => {
      const repo = createFixture(path.join(root, `fixture-${index}-${copy}`));
      scenario.build(repo); scenario.rebuild?.(repo);
      return repo;
    });
    const git = (repo, args) => execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
    assert.equal(git(builds[0], ["rev-parse", "HEAD"]), git(builds[1], ["rev-parse", "HEAD"]));
    const files = git(builds[0], ["ls-files"]).trim().split("\n");
    const contents = files.map((f) => readFileSync(path.join(builds[0].dir, f), "utf8")).join("\n");
    assert.doesNotMatch(contents, /\/\/.*(?:bug:|invariant dropped|NEW:)|shouldReport|claimLike/);
    assert.doesNotMatch(git(builds[0], ["log", "--format=%s"]), /regression|bug|break invariant/);
    for (const expected of scenario.expect) {
      assert.ok(!ids.has(expected.id)); ids.add(expected.id);
      for (const location of expected.locations) {
        const lines = readFileSync(path.join(builds[0].dir, location.path), "utf8").trimEnd().split("\n");
        assert.ok(location.startLine <= lines.length, `${scenario.name}: start line out of range`);
        assert.ok(location.endLine <= lines.length + 1, `${scenario.name}: end line out of range`);
      }
    }
    if (scenario.name.startsWith("large-diff")) {
      const diff = git(builds[0], ["diff", "HEAD^", "HEAD"]);
      assert.ok(diff.length > 200000);
      assert.match(diff, /-  return cents;[\s\S]*\+  return cents \* 100;/);
    }
  }
}));
