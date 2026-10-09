// Deterministic advisory pre-filter for ReviewBench rounds: probable golden ×
// pir matches scored with token similarity plus an anchor-path bonus, before
// any LLM judge spend. Official numbers always come from the judge; this
// module only aims cheap iteration.
//
// Pure functions only: no dist imports, no fs, no network. The similarity
// function is injected by the runner (the real one is claimSimilarity from
// src/findings/identity.ts, imported lazily from dist so that importing this
// module stays side-effect free).

export const PROBABLE_MATCH_THRESHOLD = 0.5;
export const PATH_BONUS = 0.2;

function normalizePath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").trim();
}

/**
 * pir finding shape consumed here: { message, paths } where paths are all
 * normalized anchor paths (reported findings only). Golden finding shape:
 * { file, message } straight from fixtures/golden/<pr_key>.json.
 */
export function pairScore(goldenFinding, pirFinding, similarity) {
  const base = similarity(goldenFinding.message ?? "", pirFinding.message ?? "");
  const goldenPath = normalizePath(goldenFinding.file ?? "");
  const bonus = (pirFinding.paths ?? []).some((path) => normalizePath(path) === goldenPath) ? PATH_BONUS : 0;
  return base + bonus;
}

/**
 * Score every golden × pir pair for ONE task (pairs never cross tasks) and
 * list pairs ≥ threshold as probable matches.
 */
export function prefilterTask({ goldenFindings = [], pirFindings = [], similarity, threshold = PROBABLE_MATCH_THRESHOLD }) {
  if (typeof similarity !== "function") throw new TypeError("similarity function is required");
  const pairs = [];
  for (let g = 0; g < goldenFindings.length; g += 1) {
    for (let p = 0; p < pirFindings.length; p += 1) {
      const score = pairScore(goldenFindings[g], pirFindings[p], similarity);
      if (score >= threshold) pairs.push({ goldenIndex: g, pirIndex: p, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.goldenIndex - b.goldenIndex || a.pirIndex - b.pirIndex);
  const goldenMatched = new Set(pairs.map((p) => p.goldenIndex));
  const pirMatched = new Set(pairs.map((p) => p.pirIndex));
  return {
    pairs,
    counts: {
      goldenTotal: goldenFindings.length,
      pirTotal: pirFindings.length,
      goldenMatched: goldenMatched.size,
      pirMatched: pirMatched.size,
    },
    unmatchedGolden: goldenFindings.map((_, i) => i).filter((i) => !goldenMatched.has(i)),
    unmatchedPir: pirFindings.map((_, i) => i).filter((i) => !pirMatched.has(i)),
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Aggregate per-task results into round-level crude bounds. Missing
 * measurements stay null (never zero) — same convention as scoring.js.
 */
export function summarizeRound(taskResults) {
  const counts = taskResults.reduce(
    (acc, { result }) => {
      acc.goldenTotal += result.counts.goldenTotal;
      acc.pirTotal += result.counts.pirTotal;
      acc.goldenMatched += result.counts.goldenMatched;
      acc.pirMatched += result.counts.pirMatched;
      return acc;
    },
    { goldenTotal: 0, pirTotal: 0, goldenMatched: 0, pirMatched: 0 },
  );
  return {
    tasks: taskResults.length,
    ...counts,
    crudeRecall: ratio(counts.goldenMatched, counts.goldenTotal),
    crudePrecision: ratio(counts.pirMatched, counts.pirTotal),
  };
}

function excerpt(message, length = 160) {
  const flat = String(message ?? "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function location(finding) {
  const file = normalizePath(finding.file ?? finding.paths?.[0] ?? "");
  const start = finding.start_line ?? finding.startLine;
  const end = finding.end_line ?? finding.endLine;
  if (!file) return "";
  if (typeof start !== "number") return file;
  return typeof end === "number" && end !== start ? `${file}:${start}-${end}` : `${file}:${start}`;
}

/**
 * Render the advisory PREFILTER.md for one variant-run of a round. Unmatched
 * lists are per task (prKey), truncated to single-line excerpts.
 */
export function renderPrefilterMd({ round, variant, taskResults }) {
  const summary = summarizeRound(taskResults);
  const recall =
    summary.crudeRecall === null
      ? "n/a"
      : `${summary.goldenMatched}/${summary.goldenTotal} golden findings have ≥1 probable match`;
  const precision =
    summary.crudePrecision === null
      ? "n/a"
      : `${summary.pirMatched}/${summary.pirTotal} reported findings probable-matched`;
  const lines = [
    `# ReviewBench prefilter — ${round} / ${variant}`,
    "",
    "Advisory deterministic estimate: token similarity + 0.2 anchor-path bonus, threshold 0.5.",
    "Official numbers come from the judge (`bench:judge`); this file only aims cheap iteration.",
    "",
    `- Tasks scored: ${summary.tasks}`,
    `- Crude recall bound: ${recall}`,
    `- Crude precision: ${precision}`,
  ];
  const goldenMisses = taskResults.filter(({ result }) => result.unmatchedGolden.length > 0);
  if (goldenMisses.length > 0) {
    lines.push("", "## Unmatched golden findings (potential misses)");
    for (const { prKey, goldenFindings, result } of goldenMisses) {
      lines.push("", `### ${prKey}`);
      for (const index of result.unmatchedGolden) {
        lines.push(`- [${index}] ${location(goldenFindings[index]) || "(no location)"} — ${excerpt(goldenFindings[index].message)}`);
      }
    }
  }
  const pirExtras = taskResults.filter(({ result }) => result.unmatchedPir.length > 0);
  if (pirExtras.length > 0) {
    lines.push("", "## Unmatched pir findings (potential false positives)");
    for (const { prKey, pirFindings, result } of pirExtras) {
      lines.push("", `### ${prKey}`);
      for (const index of result.unmatchedPir) {
        lines.push(`- [${index}] ${location(pirFindings[index]) || "(no location)"} — ${excerpt(pirFindings[index].message)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
