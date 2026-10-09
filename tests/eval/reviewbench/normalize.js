// Deterministic normalization of pir `find --json` output into the
// ReviewBench judging-input format (upstream docs/JUDGING_INPUT.md).
//
// Pure functions only: no dist imports, no fs, no network. Importing this
// module never starts a review (opt-in eval surface; see tests/eval/README.md).

const REPORTED_STATUSES = new Set(["confirmed", "uncertain"]);

/**
 * Repo-relative path in the shape the judge's strict loader accepts:
 * forward slashes, no leading "./", no surrounding whitespace.
 */
export function normalizeFilePath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Build one judging-input finding from a FindingView row, or null when the
 * row has no usable anchor (path + integer start line) — the caller counts
 * those as dropped with a loud warning.
 *
 * Message shape is fixed by the roadmap spec: "<title> — <claim> Trigger: <trigger>".
 */
function buildFinding(row) {
  const anchor = Array.isArray(row?.anchors) ? row.anchors[0] : null;
  const file = normalizeFilePath(anchor?.path ?? "");
  const startLine = anchor?.startLine;
  if (!file || typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1) {
    return null;
  }
  const endLine =
    typeof anchor?.endLine === "number" && Number.isInteger(anchor.endLine) && anchor.endLine >= startLine
      ? anchor.endLine
      : startLine;
  let message = "";
  const title = optionalText(row?.title);
  const claim = optionalText(row?.claim);
  const trigger = optionalText(row?.trigger);
  if (title) message = title;
  if (claim) message = message ? `${message} — ${claim}` : claim;
  if (trigger) message = message ? `${message} Trigger: ${trigger}` : `Trigger: ${trigger}`;
  return {
    producer: "pir",
    file,
    start_line: startLine,
    end_line: endLine,
    message,
  };
}

/**
 * Usage block with only the fields JUDGING_INPUT.md documents as supported
 * non-negative numbers; omitted entirely when nothing measurable is present.
 */
function buildUsage(data) {
  const usage = {};
  const totalTokens = data?.usage?.totalTokens;
  const durationMs = data?.durationMs;
  if (typeof totalTokens === "number" && totalTokens >= 0) usage.total_tokens = totalTokens;
  if (typeof durationMs === "number" && durationMs >= 0) usage.time_in_ms = durationMs;
  return usage;
}

/**
 * Normalize one task's CLI outcome into the two judging-input documents:
 * `reported` (status ∈ {confirmed, uncertain}) and `confirmedOnly` (stricter
 * precision view). Rows without a usable anchor are dropped and reported in
 * `dropped` so the runner can surface a loud, counted warning.
 */
export function normalizeTask({ manifestEntry, outcome }) {
  const findings = outcome?.data?.findings;
  if (!Array.isArray(findings)) {
    throw new TypeError("outcome.data.findings must be an array");
  }
  const reportedFindings = [];
  const confirmedFindings = [];
  const dropped = [];
  for (const row of findings) {
    if (!REPORTED_STATUSES.has(row?.status ?? "")) continue;
    const finding = buildFinding(row);
    if (!finding) {
      dropped.push({
        displayId: row?.displayId ?? null,
        reason: "reported finding without a usable anchor (path + integer start line)",
      });
      continue;
    }
    reportedFindings.push(finding);
    if (row.status === "confirmed") confirmedFindings.push(finding);
  }
  const pr = {
    repo: manifestEntry.repo,
    pr_number: manifestEntry.pr_number,
    base: manifestEntry.base,
    head: manifestEntry.head,
  };
  const usage = buildUsage(outcome.data);
  const reported = { pr, agent: "pir", findings: reportedFindings };
  const confirmedOnly = { pr, agent: "pir", findings: confirmedFindings };
  if (Object.keys(usage).length > 0) {
    reported.usage = usage;
    confirmedOnly.usage = usage;
  }
  return { reported, confirmedOnly, dropped };
}
