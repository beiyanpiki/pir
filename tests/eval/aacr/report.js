#!/usr/bin/env node
/**
 * AACR-Bench M0 — results renderer (roadmap A1). Pure renderer plus a thin CLI.
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

function metricLine(metrics, auc) {
  return [
    "acc " + pct(metrics.accuracy), "P " + pct(metrics.precision), "R " + pct(metrics.recall),
    "F1 " + pct(metrics.f1), "kill " + pct(metrics.killRate), "falseKill " + pct(metrics.falseKillRate),
    "interceptP " + pct(metrics.interceptPrecision), "AUC " + aucText(auc),
  ].join(" | ");
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
 * than rendering a table nobody can reproduce.
 */
export function renderResultsMd({ run, scores, title, notes = [] }) {
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
  lines.push("");
  lines.push("- Primary policy **uncertain = keep**: " + code("confirmed") + " and " + code("uncertain") + " both count as keeps, only " + code("rejected") + " kills." +
    " The strict policy **uncertain = miss** is reported beside it: an uncertain verdict earns no credit in either direction (neither a keep nor a kill).");
  lines.push("- **killRate** = share of label-0 comments intercepted (north-star metric; higher is better). **falseKillRate** = share of label-1 comments destroyed (cost side, and the B4 merge gate; lower is better).",
    " **interceptPrecision** = share of kills that were label 0. ADR-0007 §5 explains why the three are always read together; the roadmap's B4 acceptance text uses \"kill-rate\" for what this file calls falseKillRate, so this file names all three explicitly and none can be misread.");
  lines.push("- Accuracy/precision/recall/F1 are over the keep decision (positives = label 1).",
    " AUC ranks rows by the verifier's keep-score: confirmed = 0.5 + c/2, rejected = 0.5 − c/2, uncertain = 0.5 (OCR arm: approve = 1, remove = 0).",
    " Rows with no decision (error, invalid, or strict-policy uncertain) count as misses, never as silent exclusions.");
  lines.push("- Sample variance rules copied from " + code("tests/eval/reviewbench/RESULTS.md") + ": a \"no regression\" claim needs both comparison runs no worse than the comparison's worse run; a model or prompt change voids comparability.",
    " M0 is single-run per arm in Iteration 1 — these are one sample's numbers, not a variance floor; repeats are Iteration 2's job.");
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
    lines.push([ "", arm, "errors / invalid / strict-unresolved", primary.errors + " / " + primary.invalid + " / " + (primary.unresolvedPositive + primary.unresolvedNegative), "", "" ].join(" | "));
  }
  lines.push("");
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
  }
  lines.push("## Notes and limits");
  lines.push("");
  if (notes.length === 0) lines.push("- (none recorded)");
  for (const note of notes) lines.push("- " + note);
  lines.push("- Caliber (roadmap R2): the pir arm is repository-aware (pinned reads, search, structural queries) while the OCR arm is diff-only, which is the OCR prompt's native material. A diff-only pir ablation is deliberately out of scope for M0.");
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
  const values = { run: env.PIR_AACR_RUN, out: env.PIR_AACR_RESULTS, title: env.PIR_AACR_TITLE, notes: [], json: env.PIR_EVAL_JSON === "1", help: false };
  const flags = { "--run": "run", "--out": "out", "--title": "title" };
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
    console.log("node tests/eval/aacr/report.js --run <out-root>/<round> --out <results file> [--title <title>] [--note <text>]... [--json]\n" +
      "Scores a finished M0 round and renders the results document (per-bucket metrics, sample sizes, model versions, variance notes, arXiv citation).\n" +
      "--note <text> appends one bullet to the report's Notes and limits section (repeatable).");
    return 0;
  }
  if (!options.run) throw new Error("--run <round-directory> is required");
  const runDir = path.resolve(options.run);
  const summaryPath = path.join(runDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error("no summary.json in " + runDir);
  const run = JSON.parse(readFileSync(summaryPath, "utf8"));
  const { rows, arms } = readRunDir(runDir, { arms: run.limits?.arms ?? null });
  const scores = scoreRun(rows);
  const markdown = renderResultsMd({ run, scores, title: options.title, notes: [...(run.notes ?? []), ...options.notes] });
  if (options.out) {
    writeFileSync(path.resolve(options.out), markdown);
    console.error("wrote " + options.out);
  } else {
    console.log(markdown);
  }
  if (options.json) console.log(JSON.stringify({ run: runDir, arms, scores }, null, 2));
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
