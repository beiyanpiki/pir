#!/usr/bin/env node
/**
 * AACR-Bench M0 — results renderer (renders the first M0 results document). Pure renderer plus a thin CLI.
 *
 * The protocol section is copied from tests/eval/reviewbench/RESULTS.md (the
 * RB variance rules) and extended with the M0-specific rules from ADR-0007:
 * both scoring policies, kill-rate plus its cost side, the exact model id and
 * thinking level, the sample seed/limit/digest, and the dataset pin with the
 * arXiv citation. A results file that cannot be traced back to those inputs is
 * not a result; renderResultsMd refuses to render one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRun, readRunDir, PRIMARY_POLICY, STRICT_POLICY } from "./score.js";

/** Backtick built at runtime so this module needs no escaping tricks in source. */
const BT = String.fromCharCode(96);
export const code = (value) => BT + value + BT;
const fenced = (language, body) => BT + BT + BT + language + "\n" + body + "\n" + BT + BT + BT;

export const pct = (value) => (value === null || value === undefined ? "—" : (value * 100).toFixed(1) + "%");

const aucText = (auc) => (auc === null || auc === undefined ? "—" : auc.toFixed(3));

/** Token counts with thousands separators; "—" when the round reported none. */
const tokens = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US"));

/**
 * Provenance a before/after pair must share (ADR-0008 §6). Only the CLI build
 * may differ between the two rounds; a different dataset, sample, model or arm
 * set makes the two numbers unrelated rather than a controlled comparison.
 */
export const COMPARABLE_FIELDS = [
  ["dataset sha256", (run) => run?.dataset?.sha256],
  ["sample digest", (run) => run?.sample?.digest],
  ["model id", (run) => run?.model],
  ["arm set", (run) => (run?.limits?.arms ?? []).join(",")],
];

export function assertComparableRuns(before, after) {
  for (const [label, read] of COMPARABLE_FIELDS) {
    const a = read(before);
    const b = read(after);
    if (!a || !b) throw new Error("before/after comparison needs " + label + " on both runs (before " + (a ?? "missing") + ", after " + (b ?? "missing") + ")");
    if (a !== b) throw new Error("before/after runs differ in " + label + ": " + a + " vs " + b + " — only the CLI build may differ, so these are not a controlled comparison");
  }
}

/** "80.0% → 76.8% (−3.2 pp)" — a delta in percentage points, not a ratio. */
export function deltaText(before, after) {
  if (typeof before !== "number" || typeof after !== "number") return "—";
  const points = (after - before) * 100;
  const sign = points > 0 ? "+" : points < 0 ? "−" : "±";
  return pct(before) + " → " + pct(after) + " (" + sign + Math.abs(points).toFixed(1) + " pp)";
}

function metricLine(metrics, auc) {
  return [
    "acc " + pct(metrics.accuracy), "P " + pct(metrics.precision), "R " + pct(metrics.recall),
    "F1 " + pct(metrics.f1), "kill " + pct(metrics.killRate), "falseKill " + pct(metrics.falseKillRate),
    "interceptP " + pct(metrics.interceptPrecision), "AUC " + aucText(auc),
  ].join(" | ");
}

/**
 * ADR-0007 §6: headline numbers are macro-averaged over the dataset's own
 * bucket strata, and micro counts are always shown next to them. Each bucket
 * cell is one observation; a metric that is undefined in a cell (e.g. killRate
 * for a bucket with no label-0 row) is excluded from the mean, not counted as
 * zero (dogfood F-186).
 */
export const MACRO_FIELDS = ["killRate", "falseKillRate", "interceptPrecision", "accuracy", "precision", "recall", "f1"];

export function macroAverage(armScore, policy = PRIMARY_POLICY) {
  const cells = Object.values(armScore?.policies?.[policy]?.buckets ?? {}).flat();
  const macro = {};
  for (const field of MACRO_FIELDS) {
    const values = cells.map((cell) => cell[field]).filter((value) => typeof value === "number" && Number.isFinite(value));
    macro[field] = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return macro;
}

function bucketTable(bucketRows) {
  const lines = [
    "| value | n | label1 | label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | AUC |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of bucketRows) {
    lines.push([
      "", row.value, String(row.sampleSize), String(row.label1), String(row.label0), pct(row.accuracy),
      pct(row.precision), pct(row.recall), pct(row.f1), pct(row.killRate), pct(row.falseKillRate),
      pct(row.interceptPrecision), aucText(row.auc?.auc), "",
    ].join(" | "));
  }
  return lines;
}

/**
 * Render one results document. `run` is a run-m0.js summary.json object and
 * `scores` is scoreRun()'s scorecard; missing provenance fields throw rather
 * than rendering a table nobody can reproduce. An optional `baseline`
 * (`{ run, scores }`) adds the controlled before/after section ADR-0008's B4
 * gate is read from; it must share the after-run's dataset, sample, model and
 * arms, and is rejected otherwise.
 */
export function renderResultsMd({ run, scores, baseline = null, title, notes = [] }) {
  if (!run?.model) throw new Error("run.model is required (results must name the exact model id)");
  if (!run?.dataset?.sha256) throw new Error("run.dataset.sha256 is required");
  if (!run?.sample?.digest) throw new Error("run.sample.digest is required");
  if (!scores?.arms || Object.keys(scores.arms).length === 0) throw new Error("scores.arms is empty — nothing to report");
  const date = (run.finishedAt ?? run.startedAt ?? new Date().toISOString()).slice(0, 10);
  const lines = [];
  lines.push("# " + (title ?? ("M0 — AACR-Bench verifier offline benchmark (" + date + ")")));
  lines.push("");
  lines.push("> Dataset: [Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) " + code("dataset.json") +
    " revision " + code(run.dataset.revision) + ", sha256 " + code(run.dataset.sha256) + " (" + run.dataset.records + " records), Apache-2.0.",
    " The OCR comparison arm ports " + code("review_filter_task_system.md") + " / " + code("review_filter_task_user.md") +
    " from [alibaba/open-code-review](https://github.com/alibaba/open-code-review) @ " + code("8eb83340a487b1150af00701b94f01af97e4b4d6") + " (Apache-2.0), strictly as evaluation apparatus.");
  lines.push(">");
  lines.push("");
  lines.push("## Protocol");
  lines.push("");
  lines.push("Comment-level binary classification: label 1 = the comment is correct (should survive), label 0 = incorrect (should be intercepted).",
    " The pir arm runs the shipped verifier (" + code("pir _verify-comment --arm verifier") + ", production " + code("runVerifier") +
    " with the full repository checkout at the comment's capture-time head commit); the OCR arm runs the ported open-code-review reflection prompt on the same material (diff only, no tools), same model id, same scoring code. Per ADR-0007:");
  if (!Object.keys(scores.arms).includes("ocr")) {
    lines.push("");
    lines.push("**This round ran the pir verifier arm only** (the arms row in Run configuration names it): no OCR row was scored, so the comparison sentences below describe the two-arm protocol and not a second arm of this run.");
  }
  lines.push("");
  lines.push("- Primary policy **uncertain = keep**: " + code("confirmed") + " and " + code("uncertain") + " both count as keeps, only " + code("rejected") + " kills." +
    " The strict policy **uncertain = miss** is reported beside it: an uncertain verdict earns no credit in either direction (neither a keep nor a kill).");
  lines.push("- **killRate** = share of label-0 comments intercepted (north-star metric; higher is better). **falseKillRate** = share of label-1 comments destroyed (cost side, and the B4 merge gate; lower is better).",
    " **interceptPrecision** = share of kills that were label 0. ADR-0007 §5 explains why the three are always read together; the roadmap's B4 acceptance text uses \"kill-rate\" for what this file calls falseKillRate, so this file names all three explicitly and none can be misread.");
  lines.push("- Accuracy/precision/recall/F1 are over the keep decision (positives = label 1).",
    " AUC ranks rows by the verifier's keep-score: confirmed = 0.5 + c/2, rejected = 0.5 − c/2, uncertain = 0.5 (OCR arm: approve = 1, remove = 0).",
    " Rows with no decision (error, invalid, or strict-policy uncertain) count as misses, never as silent exclusions.");
  lines.push("- Sample variance rules copied from " + code("tests/eval/reviewbench/RESULTS.md") + ": a \"no regression\" claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability.",
    " Every M0 round publishes one run per arm — these are one sample's numbers, not a variance floor; repeats are a separate round's job.");
  lines.push("- No judge is involved (ADR-0007 §9): the dependent variable is the dataset's expert label, so these numbers are judge-drift-free by construction and are **not** comparable to M1's " + code("balanced_score") + ".");
  lines.push("");
  lines.push("## Run configuration");
  lines.push("");
  lines.push("| field | value |");
  lines.push("| --- | --- |");
  lines.push("| round | " + code(run.round) + " |");
  lines.push("| date | " + (run.startedAt ?? "—") + " → " + (run.finishedAt ?? "(unfinished)") + " |");
  lines.push("| model (both arms) | " + code(run.model) + " |");
  lines.push("| CLI sha256 | " + code(run.cli?.sha256 ?? "—") + " |");
  lines.push("| build sha256 (dist digest) | " + code(run.cli?.buildSha256 ?? "—") + " |");
  lines.push("| dataset sha256 | " + code(run.dataset.sha256) + " |");
  lines.push("| sample | limit " + (run.sample.limit ?? run.sample.eligible) + ", seed " + run.sample.seed + ", digest " + code(run.sample.digest) + " |");
  lines.push("| arms | " + (run.limits?.arms ?? Object.keys(scores.arms)).join(", ") + " |");
  lines.push("| concurrency / timeout | " + (run.limits?.concurrency ?? "—") + " / " + (run.limits?.timeoutMs ?? "—") + " ms |");
  lines.push("| materialization errors | " + (run.materializationErrors ?? 0) + " (excluded rows) |");
  lines.push("| clone cache | " + code(run.limits?.cache ?? "—") + " (" + ((run.cacheBytes ?? 0) / 1024 / 1024).toFixed(0) + " MiB) |");
  lines.push("| config snapshot | model " + (run.config?.model ?? "—") + ", thinking " + (run.config?.thinking ?? "—") + " |");
  lines.push("");
  lines.push("## Headline metrics");
  lines.push("");
  lines.push("| arm | policy | n | label1/label0 | metrics |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [arm, armScore] of Object.entries(scores.arms)) {
    for (const policy of [PRIMARY_POLICY, STRICT_POLICY]) {
      const bucket = armScore.policies[policy];
      const overall = bucket.overall;
      lines.push([ "", arm, policy === PRIMARY_POLICY ? "**uncertain=keep**" : "uncertain=miss", String(overall.sampleSize),
        overall.label1 + " / " + overall.label0, metricLine(overall, bucket.auc?.auc), "" ].join(" | "));
    }
    const primary = armScore.policies[PRIMARY_POLICY].overall;
    // ADR-0007 §6 + dogfood F-186: the macro row is the unweighted mean of the
    // per-bucket metrics; the overall sample size and label split are the
    // micro counts that must stay beside it.
    const macro = macroAverage(armScore);
    lines.push([ "", arm, "macro (bucket mean)", String(primary.sampleSize), primary.label1 + " / " + primary.label0, metricLine(macro, null), "" ].join(" | "));
    const strict = armScore.policies[STRICT_POLICY].overall;
    lines.push([ "", arm, "errors / invalid / strict-unresolved", primary.errors + " / " + primary.invalid + " / " + (strict.unresolvedPositive + strict.unresolvedNegative), "", "" ].join(" | "));
  }
  lines.push("");
  lines.push("The macro row is the unweighted mean of each metric over every bucket cell below (the four dataset strata of ADR-0007 §6); the " + code("n") + " and " + code("label1/label0") + " beside it are the micro overall counts. A metric undefined in a bucket (for example " + code("killRate") + " with no label-0 rows) is left out of the mean rather than counted as zero, and the " + code("strict-unresolved") + " counter is read from the strict (uncertain = miss) bucket while " + code("errors") + "/" + code("invalid") + " stay policy-independent.");
  lines.push("");
  const usageArms = Object.entries(scores.arms).filter(([, armScore]) => (armScore.usage?.rowsWithUsage ?? 0) > 0);
  if (usageArms.length > 0) {
    lines.push("## Session usage");
    lines.push("");
    lines.push("Tokens as reported by each run's CLI result, summed over the rows that reported usage. " + code("total tokens") + " includes cache reads and the CLI result does not itemise them, so the three columns do not compose: read " + code("output tokens") + " as the generated-token cost and " + code("total tokens") + " as session volume, never as input + output. " + code("output / row") + " is the cost side, read beside killRate and falseKillRate as one group and never instead of them. Rows without usage (errors, older builds) are excluded from the sums and stay visible in the " + code("rows with usage") + " column.");
    lines.push("");
    lines.push("| arm | rows with usage | input tokens | output tokens | total tokens | output / row | total / row |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [arm, armScore] of usageArms) {
      const usage = armScore.usage;
      lines.push(["", arm, String(usage.rowsWithUsage), tokens(usage.inputTokens), tokens(usage.outputTokens), tokens(usage.totalTokens), tokens(usage.outputTokensPerRow), tokens(usage.totalTokensPerRow), ""].join(" | "));
    }
    lines.push("");
  }
  if (baseline) {
    assertComparableRuns(baseline.run, run);
    lines.push("## Before/after (controlled build comparison)");
    lines.push("");
    lines.push("Same dataset, sample, model and arms; only the CLI build differs (− = the pre-change build, + = the build under test). This is a point comparison: the rb variance rule (a \"no regression\" claim needs both runs no worse than the comparison's worse run) cannot be satisfied by one run per side, and repeats remain a separate round.");
    lines.push("");
    lines.push("| side | arm | n | label1/label0 | acc | P | R | F1 | killRate | falseKillRate | interceptP | invalid/errors |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const shoulder of [["−", baseline.run, baseline.scores], ["+", run, scores]]) {
      const [mark, sideRun, sideScores] = shoulder;
      // The build digest, not the entry-file sha256: cli.js is a thin
      // dispatcher and the two builds can share it byte for byte (B4 did).
      const buildId = sideRun.cli?.buildSha256 ?? sideRun.cli?.sha256 ?? "?";
      for (const arm of Object.keys(sideScores.arms).sort()) {
        const armScore = sideScores.arms[arm];
        const overall = armScore.policies[PRIMARY_POLICY].overall;
        lines.push(["", mark + " " + code(String(buildId).slice(0, 8)), arm,
          String(overall.sampleSize), overall.label1 + " / " + overall.label0,
          pct(overall.accuracy), pct(overall.precision), pct(overall.recall), pct(overall.f1),
          pct(overall.killRate), pct(overall.falseKillRate), pct(overall.interceptPrecision),
          overall.invalid + " / " + overall.errors, ""].join(" | "));
      }
    }
    const beforeBuild = baseline.run.cli?.buildSha256 ?? baseline.run.cli?.sha256;
    const afterBuild = run.cli?.buildSha256 ?? run.cli?.sha256;
    if (beforeBuild && afterBuild && beforeBuild === afterBuild) {
      lines.push("");
      lines.push("> **The two sides report the same build digest** — either the change did not alter any built module or the rounds used the same build. A comparison of one build against itself cannot demonstrate a regression or its absence; check the CLI path/`--cli` before reading this section.");
    }
    lines.push("");
    for (const arm of Object.keys(scores.arms).sort()) {
      const before = baseline.scores.arms[arm]?.policies?.[PRIMARY_POLICY]?.overall;
      const after = scores.arms[arm].policies[PRIMARY_POLICY].overall;
      if (!before) continue;
      const gate = after.falseKillRate !== null && before.falseKillRate !== null && after.falseKillRate <= before.falseKillRate;
      lines.push("- **" + arm + " — B4 gate**: falseKillRate " + deltaText(before.falseKillRate, after.falseKillRate) + " ⇒ **" + (gate ? "no regression" : "REGRESSION") + "**;" +
        " killRate " + deltaText(before.killRate, after.killRate) + "; interceptPrecision " + deltaText(before.interceptPrecision, after.interceptPrecision) + "." +
        " The three are read together (roadmap R9): a falseKillRate that fell by rejecting fewer comments overall is not automatically an improvement.");
    }
    lines.push("");
    const comparedUsageArms = Object.keys(scores.arms).sort().filter((arm) =>
      (scores.arms[arm].usage?.rowsWithUsage ?? 0) > 0 && (baseline.scores.arms[arm]?.usage?.rowsWithUsage ?? 0) > 0);
    if (comparedUsageArms.length > 0) {
      lines.push("**Session usage (both sides).** Tokens as reported by each run's CLI result; " + code("output / row") + " is the cost side of the comparison, read beside the other metrics and never instead of them. " + code("total tokens") + " includes cache reads the CLI result does not itemise, so it does not equal input + output.");
      lines.push("");
      lines.push("| side | arm | rows with usage | input tokens | output tokens | total tokens | output / row |");
      lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
      for (const [mark, sideRun, sideScores] of [["−", baseline.run, baseline.scores], ["+", run, scores]]) {
        const buildId = sideRun.cli?.buildSha256 ?? sideRun.cli?.sha256 ?? "?";
        for (const arm of comparedUsageArms) {
          const usage = sideScores.arms[arm].usage;
          lines.push(["", mark + " " + code(String(buildId).slice(0, 8)), arm, String(usage.rowsWithUsage), tokens(usage.inputTokens), tokens(usage.outputTokens), tokens(usage.totalTokens), tokens(usage.outputTokensPerRow), ""].join(" | "));
        }
      }
      lines.push("");
    }
  }
  for (const [arm, armScore] of Object.entries(scores.arms)) {
    lines.push("## " + arm + " — per-bucket metrics");
    lines.push("");
    for (const [policy, label] of [[PRIMARY_POLICY, "uncertain = keep (primary)"], [STRICT_POLICY, "uncertain = miss (strict)"]]) {
      lines.push("### " + label);
      lines.push("");
      for (const [bucketKey, bucketRows] of Object.entries(armScore.policies[policy].buckets)) {
        lines.push("**" + bucketKey + "**");
        lines.push("");
        lines.push(...bucketTable(bucketRows));
        lines.push("");
      }
    }
    const grounds = armScore.rejectionGrounds ?? [];
    if (grounds.some((entry) => entry.ground !== "unknown")) {
      lines.push("### Rejection grounds (B4)");
      lines.push("");
      lines.push("| ground | kills | label0 | label1 | false-kill share of ground |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const entry of grounds) lines.push(["", entry.ground, String(entry.killed), String(entry.label0), String(entry.label1), pct(entry.killed === 0 ? null : entry.label1 / entry.killed), ""].join(" | "));
      lines.push("");
      lines.push("A ground is the reason a rejected verdict named (ADR-0008). The distribution is over kills under both policies — a rejected verdict is a kill either way — so it reads as the audit trail of the arm's kill decisions. Rows without a ground pre-date B4 or belong to the OCR arm, which has no ground vocabulary; they are counted as " + code("unknown") + " rather than dropped.");
      lines.push("");
    }
  }
  lines.push("## Notes and limits");
  lines.push("");
  if (notes.length === 0) lines.push("- (none recorded)");
  for (const note of notes) lines.push("- " + note);
  lines.push("- Caliber (roadmap R2): the pir arm is repository-aware (pinned reads, search, structural queries) while the OCR arm is diff-only, which is the OCR prompt's native material. A diff-only pir ablation is deliberately out of scope for M0.");
  const degraded = Object.entries(scores.arms)
    .map(([arm, score]) => [arm, score.diffBaseKinds?.["base-tip"] ?? 0])
    .filter(([, count]) => count > 0);
  lines.push(degraded.length === 0
    ? "- Diff base: every scored row used the GitHub merge base (ADR-0007 §7); no degraded base-tip rows."
    : "- Diff base (dogfood F-181): " + degraded.map(([arm, count]) => count + " " + arm + " row(s)").join(", ") + " used a degraded base-tip diff because the compare API was unavailable; those rows read the capture-time base..head pair ADR-0007 §7 warns about, so treat their verdicts as lower-confidence.");
  lines.push("- **Target question (measured limitation, ADR-0007 Consequences):** the dataset's label asks whether the comment is *correct review feedback*; " + code("runVerifier") + " answers whether a *concrete, change-attributable defect* exists. The first run's rationales show valid comments rejected precisely because they are a style preference or a pre-existing observation, which the shipped do-not-report contract requires. " + code("falseKillRate") + " is therefore still " + code("rejected(label=1)/label=1") + " operationally, but it must not be read as \"the verifier destroys real findings\", and it is not the same quantity as the OCR arm's false-kill. Read " + code("killRate") + " (label-0 interception) and the per-category table jointly; Maintainability concentrates the mismatch.");
  lines.push("- Ground truth is 3/4 AI-authored comments verified by domain experts (roadmap R3); read the " + code("is_ai_comment") + " and " + code("source_model") + " buckets before extrapolating to human-review taste.",
    " The dataset's 1,505/640 split makes label-0 the smaller population, so every kill-family number carries a wide interval at this sample size.");
  lines.push("- Dataset " + code("pr_source_commit") + "/" + code("pr_target_commit") + " are a capture-time base/head pair; the per-comment diff is " + code("merge-base..head") + " using the merge base GitHub reports for that pair, narrowed to the comment's path (ADR-0007 §7).",
    " Comments whose path is not in the PR diff are materialized as " + code("pathInDiff=false") + " with an empty diff rather than dropped.");
  lines.push("- The git clone cache is shared and out of tree (" + code("$PIR_AACR_CACHE") + "); " + code("tests/eval/aacr/dataset/") + " and " + code("tests/eval/aacr/out/") + " are gitignored, so every number below is rebuildable from the pin in " + code("tests/eval/aacr/meta.json") + ".");
  lines.push("");
  lines.push("Citation (required when using AACR-Bench data):");
  lines.push("");
  lines.push(fenced("bibtex", "@misc{zhang2026aacrbenchevaluatingautomaticcode,\n  title={AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},\n  author={Lei Zhang and Yongda Yu and Minghui Yu and others},\n  year={2026}, eprint={2601.19494}, archivePrefix={arXiv}, primaryClass={cs.SE}\n}"));
  lines.push("");
  return lines.join("\n");
}

export function parseOptions(argv = [], env = process.env) {
  const values = { run: env.PIR_AACR_RUN, baseline: env.PIR_AACR_BASELINE, out: env.PIR_AACR_RESULTS, title: env.PIR_AACR_TITLE, notes: [], json: env.PIR_EVAL_JSON === "1", help: false };
  const flags = { "--run": "run", "--baseline": "baseline", "--out": "out", "--title": "title" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--note") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid option or missing value: " + argv[i]);
      values.notes.push(argv[++i]);
      continue;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid option or missing value: " + argv[i]);
    values[key] = argv[++i];
  }
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("node tests/eval/aacr/report.js --run <out-root>/<round> --out <results file> [--baseline <pre-change round dir>] [--title <title>] [--note <text>]... [--json]\n" +
      "Scores a finished M0 round and renders the results document (per-bucket metrics, sample sizes, model versions, variance notes, arXiv citation).\n" +
      "--baseline adds the controlled before/after section (ADR-0008): the two rounds must share dataset, sample digest, model and arms, so only the CLI build differs.\n" +
      "--note <text> appends one bullet to the report's Notes and limits section (repeatable).");
    return 0;
  }
  if (!options.run) throw new Error("--run <round-directory> is required");
  const readRound = (dir) => {
    const resolved = path.resolve(dir);
    const summary = path.join(resolved, "summary.json");
    if (!existsSync(summary)) throw new Error("no summary.json in " + resolved);
    const summaryJson = JSON.parse(readFileSync(summary, "utf8"));
    const { rows, arms } = readRunDir(resolved, { arms: summaryJson.limits?.arms ?? null });
    return { run: summaryJson, scores: scoreRun(rows), arms, rows: rows.length, dir: resolved };
  };
  const { run, scores, arms } = readRound(options.run);
  const baseline = options.baseline ? readRound(options.baseline) : null;
  const markdown = renderResultsMd({ run, scores, baseline, title: options.title, notes: [...(run.notes ?? []), ...options.notes] });
  if (options.out) {
    writeFileSync(path.resolve(options.out), markdown);
    console.error("wrote " + options.out);
  } else {
    console.log(markdown);
  }
  if (options.json) console.log(JSON.stringify({ run: options.run, arms, scores, ...(baseline ? { baseline: { run: baseline.dir, arms: baseline.arms, scores: baseline.scores } } : {}) }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error);
    process.exitCode = 3;
  }
}
