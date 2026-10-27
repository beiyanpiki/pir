// Deterministic normalization of pir `find --json` output into AACR-Bench's
// upstream (OCR-shaped) result format.
//
// Pure functions only: no fs, no network, no dist imports. Importing this
// module never starts a review (opt-in eval surface; see tests/eval/aacr/README.md).
//
// Views:
//   reported       confirmed + uncertain  (the uncertain=keep calibration,
//                  the same primary policy ADR-0007 fixed for M0)
//   confirmedOnly  confirmed only          (the strict precision view)
//
// The upstream judge only counts comments with non-empty `content`; every
// status-eligible finding without a usable anchor (a path plus an integer
// start line) is DROPPED and counted — it is never silently mapped to a
// made-up file or line.

export const REPORTED_STATUSES = new Set(["confirmed", "uncertain"]);
export const VIEWS = ["reported", "confirmedOnly"];
export const DEFAULT_VIEWS = [...VIEWS];

/**
 * Repo-relative path in the shape the upstream loader expects: forward
 * slashes, no leading "./", no surrounding whitespace.
 */
export function normalizeFilePath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").trim();
}

/** Collapse every whitespace run (including newlines) into one space. */
function flatten(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Single deterministic text for one finding: title, claim, trigger joined by
 * exactly one blank line; whitespace inside each part is flattened so the
 * result can never contain more than one consecutive newline.
 */
export function findingText(row) {
  return [flatten(row?.title), flatten(row?.claim), flatten(row?.trigger)].filter(Boolean).join("\n\n");
}

function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * One FindingView row -> upstream comment, or null when the row has no usable
 * anchor. The anchor is the FIRST anchor carrying a path; if that anchor's
 * start line is missing or invalid the row is dropped (reported as anchorless)
 * rather than rewritten to a different location.
 */
export function buildUpstreamComment(row) {
  const anchors = Array.isArray(row?.anchors) ? row.anchors : [];
  const anchor = anchors.find((candidate) => normalizeFilePath(candidate?.path) !== "");
  if (!anchor) return null;
  const startLine = positiveInt(anchor.startLine);
  if (startLine === null) return null;
  const endCandidate = positiveInt(anchor.endLine);
  return {
    path: normalizeFilePath(anchor.path),
    start_line: startLine,
    // Missing / inverted / non-integer end line closes the range at start.
    end_line: endCandidate !== null && endCandidate >= startLine ? endCandidate : startLine,
    text: findingText(row),
  };
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = numberOrZero(usage.inputTokens);
  const output = numberOrZero(usage.outputTokens);
  const normalized = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOrZero(usage.totalTokens) || input + output,
  };
  if (typeof usage.cacheReadTokens === "number" && usage.cacheReadTokens >= 0) normalized.cache_read_input_tokens = usage.cacheReadTokens;
  if (typeof usage.cacheWriteTokens === "number" && usage.cacheWriteTokens >= 0) normalized.cache_creation_input_tokens = usage.cacheWriteTokens;
  return normalized;
}

function normalizeDurationSeconds(data) {
  if (typeof data?.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0) {
    return Math.round((data.durationMs / 1000) * 1000) / 1000;
  }
  if (typeof data?.durationSeconds === "number" && Number.isFinite(data.durationSeconds) && data.durationSeconds >= 0) {
    return data.durationSeconds;
  }
  return 0;
}

/**
 * Normalize a parsed `find --json` envelope into both views.
 *
 * `dropped.total` counts status-eligible findings (confirmed + uncertain) that
 * were considered; `dropped.anchorless` is the subset thrown away for lacking
 * a usable anchor. Rejected/candidate rows are not part of "reported" and are
 * neither counted nor dropped here.
 */
export function normalizeFindings(envelope) {
  const data = envelope?.data ?? envelope;
  const findings = data?.findings;
  if (!Array.isArray(findings)) throw new TypeError("envelope.data.findings must be an array");
  const reported = [];
  const confirmedOnly = [];
  let anchorless = 0;
  let total = 0;
  for (const row of findings) {
    if (!REPORTED_STATUSES.has(row?.status ?? "")) continue;
    total += 1;
    const comment = buildUpstreamComment(row);
    if (!comment) {
      anchorless += 1;
      continue;
    }
    reported.push(comment);
    if (row.status === "confirmed") confirmedOnly.push({ ...comment });
  }
  return {
    reported,
    confirmedOnly,
    dropped: { anchorless, total },
    usage: normalizeUsage(data?.usage),
    durationSeconds: normalizeDurationSeconds(data),
  };
}

/**
 * Upstream result file body (`evaluation/evaluate.py`'s OCR fallback):
 * `<results_dir>/<safe_id>.json` with review.comments[{content,path,start_line,end_line}].
 *
 * `review.summary` also carries input/output tokens: the pinned evaluate.py
 * reads OCR-shaped usage from there, while `token_usage` is the parent
 * contract's explicit cost field. Both are additive, never contradictory.
 */
export function toUpstreamResult(normalized, { view } = {}) {
  if (!normalized || typeof normalized !== "object") throw new TypeError("normalized must be an object");
  if (!VIEWS.includes(view)) throw new Error(`unknown view: ${view} (available: ${VIEWS.join(", ")})`);
  const comments = (normalized[view] ?? []).map((comment) => ({
    content: comment.text,
    path: comment.path,
    start_line: comment.start_line,
    end_line: comment.end_line,
  }));
  const usage = normalized.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    review: { comments, summary: { input_tokens: input, output_tokens: output } },
    duration_seconds: normalized.durationSeconds ?? 0,
    token_usage: {
      input_tokens: input,
      output_tokens: output,
      ...(usage.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: usage.cache_read_input_tokens }),
      ...(usage.cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
    },
  };
}

/**
 * Upstream `config.safe_id`: `<instance_id>.replace("/", "__")`. The M1
 * instance convention already encodes `/` as `__`, and `@` is deliberately
 * preserved — this mirrors upstream exactly instead of inventing a new rule.
 */
export function safeId(instanceId) {
  return String(instanceId).replace(/\//g, "__");
}
