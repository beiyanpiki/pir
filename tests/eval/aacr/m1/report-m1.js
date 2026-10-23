#!/usr/bin/env node
/**
 * AACR-Bench M1 — results renderer (roadmap A1).
 *
 * Pure renderer plus a thin CLI. It reads one driver round:
 *
 *   <round>/summary.json                    provenance + row metadata
 *   <metrics dir>/metrics_*_round_*.json    upstream eval_res per judge round
 *   <metrics dir>/metrics_*_average.json    upstream 3-round average summary
 *
 * and writes the committed results document: the headline file-level semantic
 * precision/recall/balanced_score per view, bucket tables by language, PR size
 * and reference-comment category, the coverage/error ledger, token and
 * duration accounting, and the provenance pins (model, CLI sha256, fixture
 * sha256, instance-set digest, judge model, arXiv citation).
 *
 * Two rules the renderer enforces:
 *  - a round without `finishedAt` is not a result (renderM1Report refuses it
 *    unless `--allow-partial` is passed, and the document then says partial);
 *  - an instance whose result file is missing is excluded from the
 *    denominators exactly as upstream does — it is never scored as an empty
 *    review, and the missing count is printed beside every headline.
 *
 * Model-free: no network, no credentials, no model. Reading and rendering only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_FIXTURE = path.join(HERE, "..", "fixtures", "test-set.json");
export const DEFAULT_META = path.join(HERE, "..", "meta.json");
const BT = String.fromCharCode(96);
export const code = (value) => BT + value + BT;

export const SIZE_BUCKETS = [
  { id: "lt50", label: "< 50 lines", test: (lines) => lines < 50 },
  { id: "50-199", label: "50–199 lines", test: (lines) => lines >= 50 && lines < 200 },
  { id: "200-499", label: "200–499 lines", test: (lines) => lines >= 200 && lines < 500 },
  { id: "ge500", label: "≥ 500 lines", test: (lines) => lines >= 500 },
];

/** PR-size bucket for a fixture `change_line_count`. */
export function sizeBucketOf(lines) {
  const bucket = SIZE_BUCKETS.find((entry) => entry.test(lines));
  return bucket ? bucket.id : "lt50";
}

/** Same formula and rounding as upstream `judge.compute_cr_statistics` / `_compute_balanced_score`. */
export function balancedScore(precision, recall) {
  if (precision + recall <= 0) return 0;
  return Math.round((2 * precision * recall) / (precision + recall) * 1000) / 1000;
}

const rate = (numerator, denominator) => (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0);

export const pct = (value) => (typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—");

/** One round's per-instance reference/generated accounting from upstream `eval_res`. */
export function instanceStatsFromEvalRes(evalRes) {
  const stats = new Map();
  for (const entry of evalRes ?? []) {
    if (!entry || typeof entry.instance_id !== "string") continue;
    const comments = Array.isArray(entry.comments) ? entry.comments : [];
    const generated = Array.isArray(entry.generated_comments) ? entry.generated_comments : [];
    stats.set(entry.instance_id, {
      refs: comments.filter((comment) => comment && typeof comment.note === "string" && comment.note).length,
      matchedRefs: comments.filter((comment) => comment && comment.file_semantic_match === true).length,
      generated: generated.length,
      matchedGenerated: generated.filter((comment) => comment && comment.hit_new_gt === true).length,
    });
  }
  return stats;
}

function sumInto(target, key, value) {
  target[key] = (target[key] ?? 0) + value;
}

/**
 * Micro metrics per bucket for ONE judge round.
 *
 * `keyOfInstance` returns the instance-level bucket key (language, PR size) or
 * null. Category buckets are comment-level and are computed by the caller via
 * `categoryMetricsForRound`, because precision cannot be attributed to a
 * reference-comment category without double counting.
 */
export function bucketMetricsForRound(evalRes, fixtureById, keyOfInstance) {
  const buckets = new Map();
  for (const [instanceId, stats] of instanceStatsFromEvalRes(evalRes)) {
    const row = fixtureById.get(instanceId);
    if (!row) continue;
    const key = keyOfInstance(row);
    if (!key) continue;
    const bucket = buckets.get(key) ?? { key, instances: 0, refs: 0, matchedRefs: 0, generated: 0, matchedGenerated: 0 };
    bucket.instances += 1;
    bucket.refs += stats.refs;
    bucket.matchedRefs += stats.matchedRefs;
    bucket.generated += stats.generated;
    bucket.matchedGenerated += stats.matchedGenerated;
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.precision = rate(bucket.matchedGenerated, bucket.generated);
    bucket.recall = rate(bucket.matchedRefs, bucket.refs);
    bucket.balanced = balancedScore(bucket.precision, bucket.recall);
  }
  return buckets;
}

/** Category = recall only: every reference comment is index-aligned with `comment_meta`. */
export function categoryMetricsForRound(evalRes, fixtureById) {
  const buckets = new Map();
  for (const entry of evalRes ?? []) {
    const row = fixtureById.get(entry.instance_id);
    if (!row) continue;
    const comments = Array.isArray(entry.comments) ? entry.comments : [];
    comments.forEach((comment, index) => {
      if (!comment || typeof comment.note !== "string" || !comment.note) return;
      const category = row.comment_meta?.[index]?.category ?? "unknown";
      const bucket = buckets.get(category) ?? { key: category, refs: 0, matchedRefs: 0 };
      bucket.refs += 1;
      if (comment.file_semantic_match === true) bucket.matchedRefs += 1;
      buckets.set(category, bucket);
    });
  }
  for (const bucket of buckets.values()) bucket.recall = rate(bucket.matchedRefs, bucket.refs);
  return buckets;
}

/**
 * Average one metric map across judge rounds the way upstream averages its
 * summaries: compute the micro metric per round, then take the arithmetic mean.
 * Sample sizes are taken from the first round (identical population).
 */
export function averageRounds(perRoundMaps, fields = ["precision", "recall", "balanced"]) {
  const keys = new Set();
  for (const map of perRoundMaps) for (const key of map.keys()) keys.add(key);
  const averaged = new Map();
  for (const key of keys) {
    const present = perRoundMaps.map((map) => map.get(key)).filter(Boolean);
    if (present.length === 0) continue;
    const base = { ...present[0] };
    for (const field of fields) {
      const values = present.map((entry) => entry[field]).filter((value) => typeof value === "number");
      if (values.length > 0) base[field] = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10000) / 10000;
    }
    base.judgeRounds = present.length;
    averaged.set(key, base);
  }
  return averaged;
}

/**
 * Dogfood F-5: a round can run `--repeats N`, and every repeat produces its
 * own judge entries. Selecting `.at(-1)` silently showed the last repeat while
 * the health/cost tables aggregated every repeat. The repeat is now an explicit
 * selection (default 1, `--repeat`) and the caller names it in Provenance.
 */
export function selectJudgeEntry(summary, view, repeat = 1) {
  const entries = (summary?.judge ?? []).filter((entry) => entry.view === view && entry.ok !== false);
  if (entries.length === 0) return null;
  const chosen = entries.find((entry) => (entry.repeat ?? 1) === repeat);
  if (chosen) return chosen;
  const available = [...new Set(entries.map((entry) => entry.repeat ?? 1))].sort((a, b) => a - b);
  throw new Error(`no successful judge entry for view ${view} repeat ${repeat} (available repeats: ${available.join(", ")})`);
}

/**
 * Dogfood F-6: read the fixture the renderer will bucket by, but only after
 * proving it is the bytes the round pinned in `summary.fixture.sha256`. A
 * re-rendered round with a rebuilt fixture would otherwise print the recorded
 * pin above tables bucketed by different metadata.
 */
export function readPinnedFixture(fixturePath, recordedSha256) {
  if (!recordedSha256) throw new Error(`round summary records no fixture sha256; refusing to render ${fixturePath} unverified`);
  const bytes = readFileSync(fixturePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== recordedSha256) {
    throw new Error(`fixture sha256 mismatch: round recorded ${recordedSha256}, ${fixturePath} is ${actual} (rebuild the fixture or pass the round's fixture)`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

/** Locate the per-round metrics files behind one `summary.judge[]` entry. */
export function loadJudgeMetrics(judgeEntry) {
  if (!judgeEntry?.metricsPath || !existsSync(judgeEntry.metricsPath)) {
    throw new Error(`judge metrics file is missing: ${judgeEntry?.metricsPath ?? "(none)"}`);
  }
  const dir = path.dirname(judgeEntry.metricsPath);
  const rounds = readdirSync(dir)
    .map((name) => ({ name, match: /_round_(\d+)\.json$/.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ round: Number(entry.match[1]), file: path.join(dir, entry.name) }))
    .sort((a, b) => a.round - b.round);
  if (rounds.length === 0) {
    // eval-rounds 1: the metrics file itself is the single round.
    const parsed = JSON.parse(readFileSync(judgeEntry.metricsPath, "utf8"));
    return { dir, rounds: [{ round: 1, file: judgeEntry.metricsPath, data: parsed }], average: judgeEntry.summary ?? parsed.summary ?? null };
  }
  const parsedRounds = rounds.map((entry) => ({ ...entry, data: JSON.parse(readFileSync(entry.file, "utf8")) }));
  let average = null;
  if (/average\.json$/.test(judgeEntry.metricsPath)) {
    average = JSON.parse(readFileSync(judgeEntry.metricsPath, "utf8")).summary ?? null;
  } else {
    // The driver's summary entry points at one round file when eval-rounds is 1.
    average = parsedRounds[0].data.summary ?? null;
  }
  return { dir, rounds: parsedRounds, average };
}

function metricRow(summary) {
  return {
    evaluated: summary.evaluated_instances ?? 0,
    missing: summary.missing_instances ?? 0,
    expected: summary.expected_notes ?? 0,
    generated: summary.generated_notes ?? 0,
    matchedRefs: summary.matched_file_semantic_notes ?? 0,
    matchedGenerated: summary.matched_generated_notes ?? 0,
    precision: summary.file_semantic_match_rate ?? 0,
    recall: summary.file_semantic_recall_rate ?? 0,
    balanced: summary.balanced_score ?? 0,
  };
}

/** Markdown table helper: header + separator + rows, no trailing spaces. */
function table(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Render the results document. `metricsByView` maps a view name to the result
 * of `loadJudgeMetrics`; `summary` is the driver round's summary.json.
 */
export function renderM1Report({ summary, fixtureRows, metricsByView, meta, title, notes = [], allowPartial = false, repeat = 1, renderedAt = new Date().toISOString() }) {
  if (!allowPartial && !summary.finishedAt) {
    throw new Error("refusing to render a round without finishedAt (interrupted or still running); pass --allow-partial to publish it explicitly as partial");
  }
  const fixtureById = new Map(fixtureRows.map((row) => [row.instance_id, row]));
  const views = Object.keys(metricsByView);
  if (views.length === 0) throw new Error("no view metrics to render");
  const citation = meta?.citation?.bibtex ?? summary.fixture?.citation?.bibtex ?? "arXiv 2601.19494";
  const arxiv = meta?.citation?.arxiv ?? "2601.19494";
  const judgeMode = summary.limits?.judge ?? "?";
  const judgeModel = judgeMode === "real"
    ? `${summary.limits?.judgeModel ?? "unrecorded"} (upstream judge model)`
    : judgeMode === "mock" ? "mock (pipeline check only — NOT a result)" : "off";
  const repeats = summary.repeats ?? 1;
  const rows = summary.instances ?? [];
  const errorRows = rows.filter((row) => row.status === "error");
  const incompleteRows = rows.filter((row) => row.incomplete === true);
  const okRows = rows.filter((row) => row.status !== "error");
  const usageRows = okRows.filter((row) => row.usage && typeof row.usage.total_tokens === "number");
  const totalTokens = usageRows.reduce((sum, row) => sum + row.usage.total_tokens, 0);
  const totalDurationSeconds = okRows.reduce((sum, row) => sum + (row.wallTimeMs ?? 0) / 1000, 0);
  const viewCounts = okRows.reduce((acc, row) => {
    acc.reported += row.views?.reported ?? 0;
    acc.confirmedOnly += row.views?.confirmedOnly ?? 0;
    acc.anchorless += row.dropped?.anchorless ?? 0;
    return acc;
  }, { reported: 0, confirmedOnly: 0, anchorless: 0 });
  const lines = [];

  lines.push(`# ${title ?? `AACR-Bench M1 — ${summary.round}`}`);
  lines.push("");
  lines.push(`> Generated by ${code("tests/eval/aacr/m1/report-m1.js")} from round ${code(summary.round)} at ${renderedAt}. ` +
    "Every number below is traceable to the provenance block; the reviewer is the shipped CLI, the judge is the pinned upstream framework, and no number was hand-edited.");
  lines.push("");
  if (!summary.finishedAt) {
    lines.push("> **PARTIAL ROUND.** The driver summary has no `finishedAt`: this round was interrupted or is still running. Treat the numbers as partial and do not compare them as a baseline.");
    lines.push("");
  }

  // The population pin is the point of the document: a seeded/limited subset
  // must be reproducible from what the page says (dogfood F-7).
  const selectionFlags = [
    summary.limits?.limit !== null && summary.limits?.limit !== undefined ? `--limit ${summary.limits.limit}` : null,
    summary.limits?.seed !== null && summary.limits?.seed !== undefined ? `--seed ${summary.limits.seed}` : null,
    Array.isArray(summary.limits?.only) && summary.limits.only.length > 0 ? `--only ${summary.limits.only.join(",")}` : null,
  ].filter(Boolean);
  lines.push("## Provenance");
  lines.push("");
  lines.push(table(["Input", "Value"], [
    ["Round", code(summary.round)],
    ["Model (reviewer + verifier)", summary.model ? code(summary.model) : "—"],
    ["CLI", `${code(summary.cli?.path ?? "dist/cli/cli.js")} sha256 ${code(String(summary.cli?.sha256 ?? "—").slice(0, 16))}…`],
    ["Fixture", `${fixtureRows.length} PRs / ${fixtureRows.reduce((sum, row) => sum + (row.reference_comments?.length ?? 0), 0)} reference comments; sha256 ${code(String(summary.fixture?.sha256 ?? "—").slice(0, 16))}…; this round selected ${summary.population?.selected ?? rows.length}`],
    ["Instance-set digest", code(String(summary.fixture?.instanceSetDigest ?? "—").slice(0, 24))],
    ["Views", `${views.map(code).join(", ")} (uncertain=keep for ${code("reported")}; strict precision for ${code("confirmedOnly")})`],
    ["Selection", `${summary.population?.selected ?? rows.length} instances over ${summary.population?.repos ?? "?"} repositories` + (selectionFlags.length > 0 ? `, ${selectionFlags.map(code).join(", ")}` : "")],
    ["Run limits", `${code(`--max-rounds ${summary.limits?.maxRounds ?? "?"}`)}, ${code(`--max-tokens ${summary.limits?.maxTokens ?? "?"}`)}, ${code(`--max-findings ${summary.limits?.maxFindings ?? "?"}`)}, task timeout ${Math.round((summary.limits?.timeoutMs ?? 0) / 60000)} min`],
    ["Judge", `${judgeMode} (${judgeModel}), ${summary.limits?.evalRounds ?? 1} round(s) averaged per view`],
    ["Repeats", repeats > 1 ? `${repeats} run(s); headline and bucket tables describe repeat ${repeat} of ${repeats}` : `${repeats}`],
    ["Judge framework pin", `${meta?.framework?.repo ?? "https://github.com/alibaba/aacr-bench"} @ ${code(summary.limits?.judgeFrameworkCommit ?? meta?.framework?.commit ?? "?")} (Apache-2.0)`],
    ["Started / finished", `${summary.startedAt ?? "?"} / ${summary.finishedAt ?? "not finished"}`],
    ["Citation", `${code(`arXiv:${arxiv}`)} — ${citation.replace(/\n/g, " ")}`],
  ]));
  lines.push("");

  lines.push("## Protocol");
  lines.push("");
  lines.push(bulletList([
    `The reference population is upstream ${code("positive_samples.json")}: the **label=1** split, so every reference comment is known-correct. M1 measures coverage of known-correct feedback (recall), how much of what the tool reported was credited (precision), and ${code("balanced_score")} = harmonic mean of the two.`,
    "The judge is the pinned upstream framework's file-level semantic matcher, not a pir judge. It groups reference and generated comments by normalized path and asks the judge model, one-to-many, whether each generated comment covers an uncovered reference comment.",
    `Two views are judged from ONE run: ${code("reported")} = confirmed + uncertain findings (the uncertain=keep policy ADR-0007 fixed for M0) and ${code("confirmedOnly")} = confirmed findings only. The gap between them is the calibration cost, reported rather than averaged away.`,
    `Findings without a usable anchor (path + integer start line) are dropped by the normalizer and counted; they are not relocated: ${viewCounts.anchorless} anchorless finding(s) in this round.`,
    "An instance whose result file is missing — an error row, a timeout, an unreachable commit — is counted in upstream's `missing_instances` and excluded from every denominator. It is never scored as an empty review; partial rounds are published as partial.",
    "Buckets are descriptive, not causal. Language and PR-size buckets are instance-level micro precision/recall; the category bucket is recall only, because a generated comment's precision cannot be attributed to one reference-comment category without double counting.",
    "One model, one CLI build, one fixture per round. Repeats expose sampling variance rather than establishing determinism; judge rounds are averaged (the judge model is sampled and each round is an independent draw).",
    `These numbers are not comparable to M0's kill-rate/confusion metrics: M0 asks whether supplied comments survive the verifier, M1 asks what the whole loop finds end to end.`,
  ]));
  lines.push("");

  lines.push("## Headline (file-level semantic)");
  lines.push("");
  const headlineRows = views.map((view) => {
    const summaryRow = metricRow(metricsByView[view].average ?? {});
    return [
      code(view), summaryRow.evaluated, summaryRow.missing, summaryRow.expected, summaryRow.generated,
      `${summaryRow.matchedRefs}/${summaryRow.expected}`, `${summaryRow.matchedGenerated}/${summaryRow.generated}`,
      pct(summaryRow.precision), pct(summaryRow.recall), `**${pct(summaryRow.balanced)}**`,
    ];
  });
  lines.push(table(["View", "Evaluated", "Missing", "Reference", "Generated", "Matched refs", "Credited generated", "Precision", "Recall", "balanced_score"], headlineRows));
  lines.push("");
  lines.push(`> **${code("balanced_score")} is the external comparison caliber.** Missing instances stay out of the denominators: ${views.map((view) => `${code(view)} ${metricRow(metricsByView[view].average ?? {}).missing}`).join(", ")}.`);
  if (repeats > 1) {
    lines.push("");
    lines.push(`> **Repeat selection (dogfood F-5).** This document's headline and bucket tables describe **repeat ${repeat} of ${repeats}**; the health and cost tables aggregate every repeat, so they are not a per-repeat value. Re-render another repeat with ${code(`--repeat <n>`)}.`);
  }
  lines.push("");

  lines.push("## Buckets");
  lines.push("");
  if (views.some((view) => (metricsByView[view].rounds?.length ?? 1) > 1)) {
    lines.push("Matched counts are the mean of the per-round micro counts and rates are the mean of the per-round rates (identical population each judge round), so `matched/reference` recomputes the displayed mean rate (dogfood F-3).");
    lines.push("");
  }
  for (const view of views) {
    const metrics = metricsByView[view];
    const fixtureByIdLocal = fixtureById;
    const languageMaps = metrics.rounds.map((round) => bucketMetricsForRound(round.data.eval_res, fixtureByIdLocal, (row) => row.project_main_language ?? "unknown"));
    const sizeMaps = metrics.rounds.map((round) => bucketMetricsForRound(round.data.eval_res, fixtureByIdLocal, (row) => sizeBucketOf(row.change_line_count ?? 0)));
    const categoryMaps = metrics.rounds.map((round) => categoryMetricsForRound(round.data.eval_res, fixtureByIdLocal));
    const languages = averageRounds(languageMaps, ["precision", "recall", "balanced", "matchedRefs", "matchedGenerated"]);
    const sizes = averageRounds(sizeMaps, ["precision", "recall", "balanced", "matchedRefs", "matchedGenerated"]);
    const categories = averageRounds(categoryMaps, ["recall", "matchedRefs"]);

    lines.push(`### ${code(view)} — by language`);
    lines.push("");
    lines.push(table(["Language", "PRs", "Reference", "Generated", "Matched refs", "Precision", "Recall", "balanced_score"], [...languages.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([language, bucket]) => [language, bucket.instances, bucket.refs, bucket.generated, `${bucket.matchedRefs}/${bucket.refs}`, pct(bucket.precision), pct(bucket.recall), pct(bucket.balanced)])));
    lines.push("");
    lines.push(`### ${code(view)} — by PR size`);
    lines.push("");
    lines.push(table(["Changed lines", "PRs", "Reference", "Generated", "Matched refs", "Precision", "Recall", "balanced_score"], SIZE_BUCKETS
      .filter((size) => sizes.has(size.id))
      .map((size) => {
        const bucket = sizes.get(size.id);
        return [size.label, bucket.instances, bucket.refs, bucket.generated, `${bucket.matchedRefs}/${bucket.refs}`, pct(bucket.precision), pct(bucket.recall), pct(bucket.balanced)];
      })));
    lines.push("");
    lines.push(`### ${code(view)} — by reference-comment category (recall only)`);
    lines.push("");
    lines.push(table(["Category", "Reference", "Matched", "Recall"], [...categories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, bucket]) => [category, bucket.refs, bucket.matchedRefs, pct(bucket.recall)])));
    lines.push("");
  }

  lines.push("## Coverage and run health");
  lines.push("");
  lines.push(table(["Row state", "Count"], [
    ["Instances selected", rows.length],
    ["Produced a result file (ok or incomplete)", okRows.length],
    ["Error rows (missing from the judge denominators)", errorRows.length],
    ["Incomplete rows (budget/round stop, still judged)", incompleteRows.length],
    ["Reused rows (resumed round)", rows.filter((row) => row.status === "reused").length],
    ["Reported findings (one run)", viewCounts.reported],
    ["Confirmed findings (one run)", viewCounts.confirmedOnly],
    ["Dropped for a missing anchor", viewCounts.anchorless],
  ]));
  lines.push("");
  if (errorRows.length > 0) {
    lines.push("Error rows are counted as missing instances and kept out of every denominator:");
    lines.push("");
    for (const row of errorRows.slice(0, 40)) lines.push(`- ${code(row.instanceId)} (${row.stage ?? "?"}): ${String(row.error ?? "").slice(0, 240)}`);
    if (errorRows.length > 40) lines.push(`- … and ${errorRows.length - 40} more (see the round's ${code("summary.json")})`);
    lines.push("");
  }
  if (incompleteRows.length > 0) {
    lines.push("Incomplete rows are real reviews that hit their budget or round limit; their result files are judged normally, and their partial nature is visible here rather than hidden:");
    lines.push("");
    for (const row of incompleteRows.slice(0, 40)) lines.push(`- ${code(row.instanceId)} — stopped: ${code(String(row.stoppedBecause ?? "?"))}; ${row.pendingCandidates ?? 0} pending candidate(s)`);
    if (incompleteRows.length > 40) lines.push(`- … and ${incompleteRows.length - 40} more (see the round's ${code("summary.json")})`);
    lines.push("");
  }

  lines.push("## Cost and duration");
  lines.push("");
  lines.push(table(["Measure", "Value"], [
    ["Model tokens (reported by sessions)", totalTokens.toLocaleString("en-US")],
    ["Average tokens per produced row", usageRows.length > 0 ? Math.round(totalTokens / usageRows.length).toLocaleString("en-US") : "—"],
    ["Wall time in reviewer runs", `${(totalDurationSeconds / 3600).toFixed(2)} h`],
    ["Average wall time per produced row", okRows.length > 0 ? `${Math.round(totalDurationSeconds / okRows.length)} s` : "—"],
    ["Task timeout", `${Math.round((summary.limits?.timeoutMs ?? 0) / 60000)} min`],
    ["Concurrency (different repositories)", summary.limits?.concurrency ?? "?"],
  ]));
  lines.push("");
  lines.push("Cost is reported as measured session usage; it excludes the judge's own API usage, which the pinned framework does not surface per run. The judge model is recorded above.");
  lines.push("");

  if (notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    lines.push(bulletList(notes));
    lines.push("");
  }

  lines.push("## Reproduce");
  lines.push("");
  lines.push(`From ${code("tests/eval/aacr/README.md")}, with the pins in ${code("tests/eval/aacr/meta.json")}:`);
  lines.push("");
  lines.push("```sh");
  lines.push(`# 1. fixture (gitignored, pin-verified) and build`);
  lines.push("PIR_EVAL=1 node tests/eval/aacr/fixtures/build-fixture.js");
  lines.push("npm run build:cli");
  lines.push("");
  lines.push(`# 2. the reviewer round (${summary.population?.selected ?? rows.length} instances; costs model runs, never a CI gate)`);
  lines.push(`PIR_EVAL=1 node tests/eval/aacr/m1/run-aacr.js --round ${summary.round} \\`);
  lines.push(`  ${selectionFlags.length > 0 ? `${selectionFlags.join(" ")} ` : ""}--concurrency ${summary.limits?.concurrency ?? 8} --max-rounds ${summary.limits?.maxRounds ?? "?"} --timeout ${summary.limits?.timeoutMs ?? "?"} --model ${summary.model} \\`);
  lines.push(`  --repeats ${repeats} --view both --judge real --eval-rounds ${summary.limits?.evalRounds ?? 1}`);
  lines.push("");
  lines.push(`# 3. this document`);
  lines.push(`node tests/eval/aacr/m1/report-m1.js --round tests/eval/aacr/out/${summary.round} --out tests/eval/aacr/results/M1-${summary.round}.md`);
  lines.push("```");
  lines.push("");
  lines.push(`Data and framework are Apache-2.0. Use of AACR-Bench requires citing arXiv ${arxiv}; this document and every generated result file repeat the citation.`);
  lines.push("");
  return lines.join("\n");
}

export function parseOptions(argv = [], env = process.env) {
  const values = {
    round: env.PIR_AACR_ROUND,
    fixture: env.PIR_AACR_FIXTURE ?? DEFAULT_FIXTURE,
    meta: env.PIR_AACR_META ?? DEFAULT_META,
    out: env.PIR_AACR_RESULTS,
    title: env.PIR_AACR_TITLE,
    notes: [],
    allowPartial: false,
    repeat: env.PIR_AACR_REPEAT === undefined || String(env.PIR_AACR_REPEAT).trim() === "" ? 1 : Number(env.PIR_AACR_REPEAT),
    help: false,
  };
  const flags = { "--round": "round", "--fixture": "fixture", "--meta": "meta", "--out": "out", "--title": "title", "--repeat": "repeat" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--allow-partial") { values.allowPartial = true; continue; }
    if (argv[i] === "--help") { values.help = true; continue; }
    if (argv[i] === "--note") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid option or missing value: --note");
      values.notes.push(argv[++i]);
      continue;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option or missing value: ${argv[i] ?? "(none)"}`);
    values[key] = argv[++i];
  }
  if (!values.round) throw new Error("--round is required (the driver round directory)");
  if (typeof values.repeat === "string") values.repeat = Number(values.repeat);
  if (!Number.isSafeInteger(values.repeat) || values.repeat < 1) throw new Error("repeat must be a positive integer");
  for (const key of ["fixture", "meta"]) values[key] = path.resolve(values[key]);
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    console.log("node tests/eval/aacr/m1/report-m1.js --round <out>/<round> --out <results file> [--fixture <path>] [--meta <path>] [--repeat <n>] [--title <title>] [--note <text>]... [--allow-partial]\n" +
      "Renders the committed M1 results document from one driver round and its upstream judge metrics. Model-free; a round without finishedAt is refused unless --allow-partial. --repeat selects which repeat's judge metrics are rendered (default 1).");
    return 0;
  }
  const roundDir = path.resolve(options.round);
  const summaryPath = path.join(roundDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`round summary is missing: ${summaryPath}`);
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const fixturePath = existsSync(options.fixture) ? options.fixture : summary.fixture?.path;
  if (!fixturePath || !existsSync(fixturePath)) throw new Error(`fixture is missing: ${fixturePath ?? "(none)"} (build it with fixtures/build-fixture.js)`);
  const fixture = readPinnedFixture(fixturePath, summary.fixture?.sha256);
  const meta = existsSync(options.meta) ? JSON.parse(readFileSync(options.meta, "utf8")) : null;
  const metricsByView = {};
  for (const view of summary.views ?? []) {
    const entry = selectJudgeEntry(summary, view, options.repeat);
    if (!entry) throw new Error(`no successful judge entry for view ${view}; a results document cannot be rendered without it`);
    metricsByView[view] = loadJudgeMetrics(entry);
  }
  const markdown = renderM1Report({
    summary, fixtureRows: fixture.rows, metricsByView, meta,
    title: options.title ?? `AACR-Bench M1 — ${summary.round}`,
    notes: options.notes, allowPartial: options.allowPartial, repeat: options.repeat,
  });
  if (options.out) {
    writeFileSync(options.out, markdown);
    console.log(`wrote ${path.resolve(options.out)}`);
  } else {
    console.log(markdown);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  }
}
