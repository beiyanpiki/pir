#!/usr/bin/env node
/**
 * AACR-Bench M0 — scoring (kill-family and accuracy/precision/recall metrics). Pure functions plus a thin CLI.
 *
 * Label semantics: label = 1 means the comment is correct (it should survive),
 * label = 0 means it is incorrect (it should be intercepted). "keep" is the
 * positive prediction, "kill" the negative one.
 *
 * Two policies, both always reported (ADR-0007 §4):
 *   uncertain-keep (primary)  verdict confirm/uncertain => keep, rejected => kill
 *   uncertain-miss (strict)   uncertain earns no credit in either direction, so
 *                             it neither counts as a keep nor as a kill
 * The OCR arm has no uncertain state (approve/remove), so its two policies
 * coincide; that is stated in the results file rather than papered over.
 *
 * Metrics: accuracy / precision / recall / F1 over keeps, killRate (north star:
 * share of incorrect comments intercepted), falseKillRate (share of correct
 * comments destroyed — the B4 gate) and interceptPrecision (share of kills that
 * were actually noise), plus confidence AUC. ADR-0007 §5 explains why all three
 * kill-family numbers are reported together — a rate read alone can look like an improvement.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIMARY_POLICY = "uncertain-keep";
export const STRICT_POLICY = "uncertain-miss";
export const POLICIES = [PRIMARY_POLICY, STRICT_POLICY];

/**
 * Reduce one row to keep / kill / none under a policy.
 * `none` means "the row produced no decision": an error row, a verifier
 * provider failure with no verdict, an OCR parse error, or (strict policy) an
 * uncertain verifier verdict.
 */
/**
 * F-188: a verifier session that crashed on a provider error or never called
 * submit_verdict produced no decision. Older rows stored such verdicts as
 * decision "keep"; the uncertainty reason is the authoritative signal.
 */
export function isNoVerdict(row) {
  return row?.arm === "verifier" && (row.uncertaintyReason === "provider-error" || row.uncertaintyReason === "missing-verdict");
}

export function classify(row, policy = PRIMARY_POLICY) {
  if (!row || row.status !== "ok") return "none";
  if (isNoVerdict(row)) return "none";
  if (row.decision === "invalid" || row.decision === undefined || row.decision === null) return "none";
  if (policy === STRICT_POLICY && row.arm === "verifier" && row.verdict === "uncertain") return "none";
  if (row.decision === "kill") return "kill";
  if (row.decision === "keep") return "keep";
  return "none";
}

/** Confidence mapped onto a keep-ranking score in [0,1]; three verdict tiers stay ordered. */
export function keepScore(row) {
  if (!row || row.status !== "ok") return null;
  // F-188: no verdict means no ranking signal, not a neutral 0.5.
  if (isNoVerdict(row)) return null;
  const confidence = typeof row.confidence === "number" && Number.isFinite(row.confidence)
    ? Math.min(1, Math.max(0, row.confidence))
    : null;
  if (row.arm === "ocr") {
    if (row.decision === "keep") return 1;
    if (row.decision === "kill") return 0;
    return null;
  }
  if (row.verdict === "confirmed") return 0.5 + (confidence ?? 0.7) / 2;
  if (row.verdict === "rejected") return 0.5 - (confidence ?? 0.7) / 2;
  if (row.verdict === "uncertain") return 0.5;
  return null;
}

/**
 * Confidence AUC with label=1 as the positive class (Mann-Whitney U with
 * average ranks for ties). Rows without a usable score or label are excluded;
 * the count is reported so a thin AUC can never look full-weight.
 */
export function confidenceAuc(rows) {
  const scored = rows.map((row) => ({ score: keepScore(row), label: row?.label }))
    .filter((entry) => entry.score !== null && (entry.label === 0 || entry.label === 1));
  const positives = scored.filter((entry) => entry.label === 1).length;
  const negatives = scored.length - positives;
  if (positives === 0 || negatives === 0) return { auc: null, positives, negatives, eligible: scored.length };
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  const ranks = new Map();
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].score === sorted[index].score) end += 1;
    const averageRank = (index + end) / 2 + 1;
    for (let i = index; i <= end; i += 1) ranks.set(i, averageRank);
    index = end + 1;
  }
  let positiveRankSum = 0;
  sorted.forEach((entry, position) => { if (entry.label === 1) positiveRankSum += ranks.get(position); });
  const auc = (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
  return { auc, positives, negatives, eligible: scored.length };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * One confusion matrix + derived metrics. `rows` is the score-row population
 * (successful and failed runs alike): error and unresolved rows are counted,
 * never silently dropped — a crashed task must show up as a miss.
 */
export function scoreRows(rows, policy = PRIMARY_POLICY) {
  const counts = { tp: 0, fp: 0, tn: 0, fn: 0, killedPositive: 0, killedNegative: 0, unresolvedPositive: 0, unresolvedNegative: 0, errors: 0, invalid: 0, otherLabel: 0 };
  for (const row of rows ?? []) {
    const label = row?.label;
    if (label !== 0 && label !== 1) { counts.otherLabel += 1; continue; }
    // An errored run produced no decision: a correct comment it never kept is a
    // miss for recall, an incorrect one it never killed is a miss for killRate.
    if (!row || row.status !== "ok") {
      counts.errors += 1;
      if (label === 1) counts.fn += 1;
      else counts.unresolvedNegative += 1;
      continue;
    }
    const verdict = classify(row, policy);
    if (verdict === "none") {
      if (row.decision === "invalid" || row.decision === null || row.decision === undefined || isNoVerdict(row)) counts.invalid += 1;
      if (label === 1) { counts.fn += 1; counts.unresolvedPositive += 1; } else { counts.unresolvedNegative += 1; }
      continue;
    }
    if (label === 1 && verdict === "keep") counts.tp += 1;
    else if (label === 1 && verdict === "kill") { counts.fn += 1; counts.killedPositive += 1; }
    else if (label === 0 && verdict === "kill") { counts.tn += 1; counts.killedNegative += 1; }
    else counts.fp += 1;
  }
  const positives = counts.tp + counts.fn;
  const negatives = counts.tn + counts.fp + counts.unresolvedNegative;
  const killed = counts.killedPositive + counts.killedNegative;
  const total = positives + negatives;
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  const recall = ratio(counts.tp, positives);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : precision === 0 || recall === 0 ? 0 : null;
  return {
    policy,
    sampleSize: total,
    label1: positives,
    label0: negatives,
    tp: counts.tp, fp: counts.fp, tn: counts.tn, fn: counts.fn,
    killed: counts.killedPositive + counts.killedNegative,
    killedPositive: counts.killedPositive, killedNegative: counts.killedNegative,
    errors: counts.errors, invalid: counts.invalid, otherLabel: counts.otherLabel,
    unresolvedPositive: counts.unresolvedPositive, unresolvedNegative: counts.unresolvedNegative,
    accuracy: ratio(counts.tp + counts.tn, total),
    precision, recall, f1,
    killRate: ratio(counts.killedNegative, negatives),
    falseKillRate: ratio(counts.killedPositive, positives),
    interceptPrecision: ratio(counts.killedNegative, killed),
    keepRate: ratio(counts.tp + counts.fp, total),
  };
}

export function bucketize(rows, key) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const value = key === "is_ai_comment" ? String(Boolean(row?.buckets?.is_ai_comment)) : String(row?.buckets?.[key] ?? "unknown");
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0])).map(([value, groupRows]) => ({ value, rows: groupRows }));
}

export const BUCKET_KEYS = ["source_model", "category", "context", "is_ai_comment"];

/**
 * B4: rejection grounds, counted per arm. A ground is the auditable reason a
 * comment died, so a false-kill cluster can be attributed to "guarded" or
 * "pre-existing" instead of a rationale archive. Rows from builds that
 * predate B4 carry no ground and are counted as `unknown` rather than
 * dropped — a mixed round must not look clean.
 */
export function rejectionGroundCounts(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const ground = row?.rejectionGround ?? "unknown";
    if (!groups.has(ground)) groups.set(ground, { ground, killed: 0, label0: 0, label1: 0 });
    const group = groups.get(ground);
    group.killed += 1;
    if (row?.label === 1) group.label1 += 1;
    else if (row?.label === 0) group.label0 += 1;
  }
  return [...groups.values()].sort((a, b) => (b.killed - a.killed) || a.ground.localeCompare(b.ground));
}

/**
 * Token usage per arm, summed from the rows the CLI result reported. The M0
 * S1 experiment (ADR 0015) pre-registers output tokens as the cost side of a
 * field-order comparison, so the number has to be part of the scorecard and of
 * the rendered results document, not a side note typed by hand. Rows that
 * reported no usage (error rows, older builds) are counted, never assumed to
 * be zero-cost.
 */
export function usageSummary(rows) {
  let rowsWithUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const row of rows ?? []) {
    const usage = row?.usage;
    if (!usage || typeof usage !== "object") continue;
    rowsWithUsage += 1;
    if (Number.isFinite(usage.inputTokens)) inputTokens += usage.inputTokens;
    if (Number.isFinite(usage.outputTokens)) outputTokens += usage.outputTokens;
    if (Number.isFinite(usage.totalTokens)) totalTokens += usage.totalTokens;
  }
  return {
    rowsWithUsage,
    inputTokens,
    outputTokens,
    totalTokens,
    outputTokensPerRow: rowsWithUsage === 0 ? null : Math.round(outputTokens / rowsWithUsage),
    totalTokensPerRow: rowsWithUsage === 0 ? null : Math.round(totalTokens / rowsWithUsage),
  };
}

/** Full scorecard: both policies overall plus every requested bucket. */
export function scoreRun(rows, { bucketKeys = BUCKET_KEYS } = {}) {
  const byArm = new Map();
  for (const row of rows ?? []) {
    const arm = row?.arm ?? "unknown";
    if (!byArm.has(arm)) byArm.set(arm, []);
    byArm.get(arm).push(row);
  }
  const arms = {};
  for (const [arm, armRows] of [...byArm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const policies = {};
    for (const policy of POLICIES) {
      policies[policy] = {
        overall: scoreRows(armRows, policy),
        auc: confidenceAuc(armRows),
        buckets: Object.fromEntries(bucketKeys.map((key) => [
          key,
          bucketize(armRows, key).map((group) => ({ value: group.value, ...scoreRows(group.rows, policy), auc: confidenceAuc(group.rows) })),
        ])),
      };
    }
    // Diff-base provenance (dogfood F-181): a base-tip row was materialized
    // from the degraded capture-time pair, so its verdict is lower-confidence.
    const diffBaseKinds = {};
    for (const row of armRows) {
      const kind = row?.diffBaseKind ?? "unknown";
      diffBaseKinds[kind] = (diffBaseKinds[kind] ?? 0) + 1;
    }
    // B4 grounds describe kills, which both policies agree on (a kill is a
    // rejected verdict either way), so the distribution is policy-independent.
    arms[arm] = { rows: armRows.length, diffBaseKinds, usage: usageSummary(armRows), rejectionGrounds: rejectionGroundCounts(armRows.filter((row) => classify(row, PRIMARY_POLICY) === "kill")), policies };
  }
  return { primaryPolicy: PRIMARY_POLICY, strictPolicy: STRICT_POLICY, arms };
}

export function readRunDir(dir, { arms = null } = {}) {
  const result = { rows: [], arms: [] };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (arms && !arms.includes(entry.name)) continue;
    result.arms.push(entry.name);
    for (const file of readdirSync(path.join(dir, entry.name)).sort()) {
      if (!file.endsWith(".json")) continue;
      result.rows.push(JSON.parse(readFileSync(path.join(dir, entry.name, file), "utf8")));
    }
  }
  result.arms.sort();
  return result;
}

export function parseOptions(argv = [], env = process.env) {
  const values = { run: env.PIR_AACR_RUN, out: env.PIR_AACR_SCORES, json: env.PIR_EVAL_JSON === "1", help: false, arms: null };
  const flags = { "--run": "run", "--out": "out", "--arms": "arms" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") { values.json = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
  }
  if (values.arms) values.arms = String(values.arms).split(",").map((s) => s.trim()).filter(Boolean);
  if (!values.run) throw new Error("--run <round-directory> is required");
  values.run = path.resolve(values.run);
  if (values.out) values.out = path.resolve(values.out);
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("node tests/eval/aacr/score.js --run <out-root>/<round> [--arms verifier,ocr] [--out scores.json] [--json]\n" +
      "Scores a finished M0 round directory (its <arm>/<id>.json rows) under both policies and prints the scorecard. Pure input/output: no model, no network.");
    return 0;
  }
  if (!existsSync(options.run)) throw new Error(`run directory not found: ${options.run}`);
  const { rows, arms } = readRunDir(options.run, { arms: options.arms });
  const scorecard = { run: options.run, arms, ...scoreRun(rows) };
  if (options.out) writeFileSync(options.out, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(options.json ? JSON.stringify(scorecard) : JSON.stringify(scorecard, null, 2));
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
