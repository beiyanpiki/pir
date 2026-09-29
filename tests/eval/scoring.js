/** Pure, deterministic scoring of human-labelled fixtures; no model or dist imports. */
const SEVERITIES = ["P0", "P1", "P2", "P3"];
const STATUSES = new Set(["confirmed", "uncertain", "candidate", "rejected", "expected",
  "false_positive", "accepted_risk", "wont_fix", "fixed"]);
export const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "totalTokens", "cost", "durationMs", "toolCalls", "repeatedToolCalls"];
const ratio = (n, d) => d === 0 ? null : n / d;
const numberOrNull = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const countOrNull = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const normalizedPath = (p) => typeof p === "string" ? p.replaceAll("\\", "/").replace(/^\.\//, "") : null;

export function validateExpectations(expectations) {
  if (!Array.isArray(expectations)) throw new TypeError("expectations must be an array");
  const ids = new Set();
  for (const e of expectations) {
    if (!e || typeof e.id !== "string" || !e.id || ids.has(e.id)) {
      throw new TypeError("expectations require unique stable ids");
    }
    ids.add(e.id);
    if (typeof e.shouldReport !== "boolean" || typeof e.claimLike !== "string" || !e.claimLike) {
      throw new TypeError(`${e.id}: shouldReport and claimLike are required`);
    }
    new RegExp(e.claimLike, "i");
    if (!Array.isArray(e.categories) || !e.categories.length ||
        e.categories.some((c) => typeof c !== "string" || !c)) {
      throw new TypeError(`${e.id}: categories are required`);
    }
    if (!Array.isArray(e.locations) || !e.locations.length || e.locations.some((l) =>
      !l || typeof l.path !== "string" || !l.path || !Number.isSafeInteger(l.startLine) ||
      l.startLine < 1 || !Number.isSafeInteger(l.endLine) || l.endLine < l.startLine)) {
      throw new TypeError(`${e.id}: valid labelled locations are required`);
    }
    for (const key of ["minSeverity", "maxSeverity"]) {
      if (e[key] !== undefined && !SEVERITIES.includes(e[key])) throw new TypeError(`${e.id}: invalid ${key}`);
    }
    if (e.minSeverity && e.maxSeverity &&
        SEVERITIES.indexOf(e.maxSeverity) > SEVERITIES.indexOf(e.minSeverity)) {
      throw new TypeError(`${e.id}: inverted severity range`);
    }
  }
}

function matchesLabel(finding, expectation) {
  const text = [finding.title, finding.claim].filter((v) => typeof v === "string").join("\n");
  return new RegExp(expectation.claimLike, "i").test(text) &&
    expectation.categories.includes(finding.category) &&
    (Array.isArray(finding.anchors) ? finding.anchors : []).some((a) => {
      if (!a || !Number.isSafeInteger(a.startLine) || a.startLine < 1) return false;
      const end = a.endLine ?? a.startLine;
      return Number.isSafeInteger(end) && end >= a.startLine && expectation.locations.some((l) =>
        normalizedPath(a.path) === normalizedPath(l.path) && a.startLine <= l.endLine && end >= l.startLine);
    });
}

function matchesSeverity(finding, expectation) {
  const rank = SEVERITIES.indexOf(finding.severity);
  return rank !== -1 &&
    (expectation.minSeverity === undefined || rank <= SEVERITIES.indexOf(expectation.minSeverity)) &&
    (expectation.maxSeverity === undefined || rank >= SEVERITIES.indexOf(expectation.maxSeverity));
}

// Maximum-cardinality bipartite matching, not greedy regex hits. Neither a
// report nor a label can earn credit twice, even when label regexes overlap.
function matchOneToOne(reports, expectations) {
  const assigned = new Map();
  function visit(reportIndex, seen) {
    for (let e = 0; e < expectations.length; e++) {
      if (seen.has(e) || !matchesLabel(reports[reportIndex].finding, expectations[e]) ||
          !matchesSeverity(reports[reportIndex].finding, expectations[e])) continue;
      seen.add(e);
      if (!assigned.has(e) || visit(assigned.get(e), seen)) {
        assigned.set(e, reportIndex);
        return true;
      }
    }
    return false;
  }
  reports.forEach((_, index) => visit(index, new Set()));
  return [...assigned].sort(([a], [b]) => a - b).map(([e, r]) => ({
    expectationId: expectations[e].id,
    findingIndex: reports[r].index,
    findingId: reports[r].finding.displayId ?? reports[r].finding.id ?? null,
  }));
}

export function scoreFindings(findings, expectations) {
  validateExpectations(expectations);
  if (!Array.isArray(findings) || findings.some((f) => !f || !STATUSES.has(f.status))) {
    throw new TypeError("findings must be an array of records with recognized statuses");
  }
  const positive = expectations.filter((e) => e.shouldReport);
  const negative = expectations.filter((e) => !e.shouldReport);
  const reports = findings.map((finding, index) => ({ finding, index }));
  const confirmed = reports.filter((r) => r.finding.status === "confirmed");
  const uncertain = reports.filter((r) => r.finding.status === "uncertain");
  const matches = matchOneToOne(confirmed, positive);
  const matchedReports = new Set(matches.map((m) => m.findingIndex));
  const matchedLabels = new Set(matches.map((m) => m.expectationId));
  const missed = positive.filter((e) => !matchedLabels.has(e.id));
  // Uncertainty can explain a miss, but NEVER turns it into a confirmed TP.
  const uncertainMatches = matchOneToOne(uncertain, missed);
  const uncertainByReport = new Map(uncertainMatches.map((m) => [m.findingIndex, m.expectationId]));
  function classify({ finding, index }, expectedId) {
    const negatives = negative.filter((e) => matchesLabel(finding, e));
    const positives = positive.filter((e) => matchesLabel(finding, e));
    const compatible = positives.filter((e) => matchesSeverity(finding, e));
    const classification = expectedId ? "expected-unconfirmed" : negatives.length ? "negative-label" :
      compatible.length ? "duplicate" : positives.length ? "severity-mismatch" : "unexpected";
    return { findingIndex: index, findingId: finding.displayId ?? finding.id ?? null, classification,
      expectationIds: expectedId ? [expectedId] : [...negatives, ...positives].map((e) => e.id),
      invalidSeverity: !SEVERITIES.includes(finding.severity) };
  }
  const falsePositiveReports = confirmed.filter((r) => !matchedReports.has(r.index)).map((r) => classify(r));
  const uncertainReports = uncertain.map((r) => classify(r, uncertainByReport.get(r.index)));
  const tp = matches.length, fp = confirmed.length - tp, fn = positive.length - tp;
  const counts = { truePositives: tp, falsePositives: fp, falseNegatives: fn,
    confirmed: confirmed.length, uncertain: uncertain.length, uncertainMatched: uncertainMatches.length,
    uncertainUnmatched: uncertain.length - uncertainMatches.length,
    ignored: findings.length - confirmed.length - uncertain.length,
    negativeLabels: negative.length,
    negativeLabelsReported: negative.filter((e) => confirmed.some((r) => matchesLabel(r.finding, e))).length,
    negativeLabelsUncertain: negative.filter((e) => uncertain.some((r) => matchesLabel(r.finding, e))).length,
    invalidSeverities: [...confirmed, ...uncertain].filter((r) => !SEVERITIES.includes(r.finding.severity)).length };
  return { pass: fp === 0 && fn === 0 && uncertain.length === 0, counts,
    metrics: { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
      f1: ratio(2 * tp, 2 * tp + fp + fn), uncertaintyRate: ratio(uncertain.length, confirmed.length + uncertain.length) },
    matches, missedExpectations: missed.map((e) => e.id), falsePositiveReports, uncertainReports };
}

export function extractOutcomeMetrics(data, wallTimeMs) {
  const raw = data.usage;
  const usage = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(USAGE_FIELDS.map((key) => [key, numberOrNull(raw[key])])) : null;
  const rounds = data.run?.rounds ?? data.rounds;
  return { usage, usageComplete: usage && typeof data.usageComplete === "boolean" ? data.usageComplete : null,
    wallTimeMs: numberOrNull(wallTimeMs), durationMs: numberOrNull(data.durationMs),
    incomplete: typeof data.incomplete === "boolean" ? data.incomplete : null,
    pendingCandidates: countOrNull(data.pendingCandidates), verificationErrors: countOrNull(data.verificationErrors),
    estimatedTokens: numberOrNull(data.estimatedTokens), memoryPackTokens: numberOrNull(data.memoryPackTokens),
    rounds: Array.isArray(rounds) ? rounds.length : null };
}

/** Partial usage sums always carry coverage; absent measurements stay null. */
export function summarizeRuns(runs) {
  const scored = runs.filter((r) => r.score);
  const counts = {};
  for (const r of scored) for (const [key, value] of Object.entries(r.score.counts)) counts[key] = (counts[key] ?? 0) + value;
  const { truePositives: tp = 0, falsePositives: fp = 0, falseNegatives: fn = 0 } = counts;
  function summarize(values) {
    const measured = values.filter((v) => numberOrNull(v) !== null);
    const total = measured.length ? measured.reduce((a, b) => a + b, 0) : null;
    return { measuredRuns: measured.length, total, mean: total === null ? null : total / measured.length };
  }
  return { runs: runs.length, scoredRuns: scored.length, executionErrors: runs.filter((r) => r.error).length,
    passed: runs.filter((r) => r.pass).length, counts,
    metrics: { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
      uncertaintyRate: ratio(counts.uncertain ?? 0, (counts.confirmed ?? 0) + (counts.uncertain ?? 0)),
      labelledNegativeReportRate: ratio(counts.negativeLabelsReported ?? 0, counts.negativeLabels ?? 0) },
    usage: Object.fromEntries(USAGE_FIELDS.map((key) => [key, {
      ...summarize(runs.map((r) => r.measurements?.usageComplete === true ? r.measurements.usage?.[key] : null)),
      partialOrUnknownRuns: runs.filter((r) => r.measurements?.usageComplete !== true &&
        numberOrNull(r.measurements?.usage?.[key]) !== null).length,
    }])),
    wallTimeMs: summarize(runs.map((r) => r.measurements?.wallTimeMs)),
    durationMs: summarize(runs.map((r) => r.measurements?.durationMs)),
    pendingCandidates: summarize(runs.map((r) => r.measurements?.pendingCandidates)),
    verificationErrors: summarize(runs.map((r) => r.measurements?.verificationErrors)) };
}
