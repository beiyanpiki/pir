import { SEVERITY_ORDER, type Severity } from "../findings/types.js";
import type { FindingView } from "../app/find.js";
import type { GiteaIntegrationConfig } from "./config.js";

/**
 * Markdown rendering for the Gitea PR integration — the exact bodies
 * `createGiteaClient` ships: one status comment per PR (started/done/
 * failed, edited in place across runs), one review body per run, and one
 * body per inline finding. Everything is pure string building: a minimal
 * dictionary covers en + zh-CN, and user-derived text (claims, triggers,
 * rationales, error messages) passes through hygiene helpers so it can
 * neither break the markdown table structure nor forge/erase the HTML
 * comment markers pir later finds its own comments by.
 */

export type CommentLang = GiteaIntegrationConfig["commentLanguage"];

// ---------------------------------------------------------------------------
// markdown hygiene
// ---------------------------------------------------------------------------

/** Max characters of user-derived text kept in one markdown table cell. */
const CELL_MAX = 200;
/** Max characters of a sanitized error message in a status body. */
const ERROR_MAX = 300;
/** Inline-comment caps: trigger and verifier rationale. */
const TRIGGER_MAX = 400;
const RATIONALE_MAX = 1200;

/**
 * Remove HTML comments from user-derived text. A claim or error message
 * containing `<!-- pir:review v1 -->` (or any comment) must not be able to
 * forge a marker where pir looks for its own comments, nor open a comment
 * that swallows a real one.
 */
export function stripHtmlComments(text: string): string {
  // Closed comments first, then any leftover bare `<!--` — an unclosed
  // opener would pair with the NEXT `-->` in the rendered HTML (possibly
  // the marker's own closer) and swallow everything between.
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "");
}

/** Cap text at `max` characters, marking the cut with a single ellipsis character. */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Make user-derived text safe for one markdown table cell: HTML comments
 * stripped, every whitespace run (newlines included) collapsed to a single
 * space, `|` escaped as `\|` so it cannot open a new column, capped in
 * length so one verbose claim cannot blow up the table layout.
 */
export function escapeTableCell(text: string): string {
  const collapsed = stripHtmlComments(text).replace(/\s+/g, " ").trim();
  // Escape on the collapsed text before capping, so the cap cannot split a `\|` escape.
  return capText(collapsed.replace(/\|/g, "\\|"), CELL_MAX);
}

/** Error message for a failed status body: comment-free, single line, capped. */
function sanitizeError(error: string): string {
  return capText(stripHtmlComments(error).replace(/\s+/g, " ").trim(), ERROR_MAX);
}

// ---------------------------------------------------------------------------
// dictionary
// ---------------------------------------------------------------------------

/** `{name}` placeholders are filled by fmt(); both languages share the key set. */
interface CommentStrings {
  statusStartedHeading: string;
  statusDoneHeading: string;
  statusDoneClean: string;
  statusFailedHeading: string;
  baseToHead: string;
  resultsWillBePosted: string;
  errorLine: string;
  checkLogs: string;
  runLinkText: string;
  colId: string;
  colSeverity: string;
  colCategory: string;
  colLocation: string;
  colClaim: string;
  reviewHeading: string;
  contextStats: string;
  contextPlugins: string;
  summaryHeading: string;
  riskAreasLabel: string;
  findingsHeading: string;
  noFindingsLine: string;
  notOnChangedLine: string;
  unchangedNote: string;
  footerVersion: string;
  triggerLabel: string;
  verifierLabel: string;
  noLocation: string;
}

const EN: CommentStrings = {
  statusStartedHeading: "## 🔍 pir review started",
  statusDoneHeading: "## ✅ Review complete — {n} finding(s)",
  statusDoneClean: "## ✅ Review complete — no verified findings.",
  statusFailedHeading: "## ❌ Review failed",
  baseToHead: "base `{base}` → head `{head}`",
  resultsWillBePosted: "Results will be posted here.",
  errorLine: "Error: {message}",
  checkLogs: "Check the pir server logs for details.",
  runLinkText: "View run",
  colId: "ID",
  colSeverity: "Severity",
  colCategory: "Category",
  colLocation: "Location",
  colClaim: "Claim",
  reviewHeading: "# pir review: #{n} {title}",
  contextStats: "{files} file(s) changed, +{ins}/-{del}",
  contextPlugins: "Plugins: {plugins}",
  summaryHeading: "## Summary",
  riskAreasLabel: "Risk areas:",
  findingsHeading: "## Findings",
  noFindingsLine: "No findings.",
  notOnChangedLine: "not on a changed line",
  unchangedNote: "{n} previously-reported finding(s) unchanged — not reposted",
  footerVersion: "pir v{version}",
  // Labels carry their own trailing separator so zh-CN needs no space after the fullwidth colon.
  triggerLabel: "Trigger: ",
  verifierLabel: "Verifier: ",
  noLocation: "—",
};

const ZH_CN: CommentStrings = {
  statusStartedHeading: "## 🔍 pir 评审已开始",
  statusDoneHeading: "## ✅ 评审完成 — {n} 个发现",
  statusDoneClean: "## ✅ 评审完成 — 没有已验证的发现。",
  statusFailedHeading: "## ❌ 评审失败",
  baseToHead: "基准 `{base}` → 提交 `{head}`",
  resultsWillBePosted: "评审结果将发布到这里。",
  errorLine: "错误：{message}",
  checkLogs: "详情请查看 pir 服务器日志。",
  runLinkText: "查看运行",
  colId: "ID",
  colSeverity: "严重级别",
  colCategory: "类别",
  colLocation: "位置",
  colClaim: "问题说明",
  reviewHeading: "# pir 评审：#{n} {title}",
  contextStats: "{files} 个文件变更，+{ins}/-{del}",
  contextPlugins: "插件：{plugins}",
  summaryHeading: "## 总结",
  riskAreasLabel: "风险点：",
  findingsHeading: "## 发现",
  noFindingsLine: "没有发现。",
  notOnChangedLine: "不在变更行上",
  unchangedNote: "{n} 个先前已报告的发现未变化，不再重复发布",
  footerVersion: "pir v{version}",
  triggerLabel: "触发：",
  verifierLabel: "验证说明：",
  noLocation: "—",
};

const DICTS: Record<CommentLang, CommentStrings> = { en: EN, "zh-CN": ZH_CN };

function strings(lang: CommentLang): CommentStrings {
  return DICTS[lang];
}

/** Fill `{name}` placeholders; unknown placeholders are left verbatim. */
function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Severity counts as one deterministic line: known severities in P0..P3 order, unknown last. */
function severityCountsLine(counts: Record<string, number>): string {
  const order = (sev: string): number => {
    const rank = SEVERITY_ORDER[sev as Severity];
    return rank === undefined ? SEVERITY_ORDER.P3 + 1 : rank;
  };
  const keys = Object.keys(counts).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return keys.map((sev) => `**${sev}**: ${counts[sev]}`).join(" · ");
}

function runLink(url: string | undefined, t: CommentStrings): string | null {
  return url ? `[${t.runLinkText}](${url})` : null;
}

function findingTableHeader(t: CommentStrings): string[] {
  return [
    `| ${t.colId} | ${t.colSeverity} | ${t.colCategory} | ${t.colLocation} | ${t.colClaim} |`,
    "| --- | --- | --- | --- | --- |",
  ];
}

/** First anchor as `path:line`, path-only when it carries no usable line, em-dash when anchorless. */
function anchorLocation(finding: FindingView, t: CommentStrings): string {
  const anchor = finding.anchors[0];
  if (anchor === undefined) return t.noLocation;
  return typeof anchor.startLine === "number" ? `${anchor.path}:${anchor.startLine}` : anchor.path;
}

// ---------------------------------------------------------------------------
// status comment body
// ---------------------------------------------------------------------------

/** One row of the status body's findings table, already projected by the caller. */
export interface GiteaStatusFindingSummary {
  displayId: string;
  severity: string;
  category: string;
  /** Pre-rendered location, e.g. `src/a.ts:42`. */
  anchor: string;
  claim: string;
}

export interface GiteaStatusBodyInput {
  lang: CommentLang;
  /** The PR's status marker (PIR_STATUS_MARKER) — first line, standalone. */
  marker: string;
  phase: "started" | "done" | "failed";
  repoFullName: string;
  number: number;
  headSha: string;
  baseRef: string;
  /** Findings to list when phase is done; empty/undefined = clean run. */
  findingsSummary?: GiteaStatusFindingSummary[];
  severityCounts?: Record<string, number>;
  /** Failure reason when phase is failed; sanitized before embedding. */
  error?: string;
  runUrl?: string;
}

/**
 * Body of the per-PR status comment. The marker is the first line so the
 * endpoint can find and edit this comment in place across runs; every
 * phase keeps the same context line so a reader can tell which SHA was
 * reviewed even in the started/failed bodies.
 */
export function renderStatusBody(input: GiteaStatusBodyInput): string {
  const t = strings(input.lang);
  const pr = `${input.repoFullName}#${input.number}`;
  const context = `${pr}: ${fmt(t.baseToHead, { base: input.baseRef, head: shortSha(input.headSha) })}`;
  const link = runLink(input.runUrl, t);

  const lines: string[] = [input.marker];
  if (input.phase === "started") {
    lines.push(t.statusStartedHeading, context, "", t.resultsWillBePosted);
  } else if (input.phase === "failed") {
    lines.push(t.statusFailedHeading, context, "");
    lines.push(fmt(t.errorLine, { message: sanitizeError(input.error ?? "") }));
    lines.push(t.checkLogs);
  } else {
    const rows = input.findingsSummary ?? [];
    if (rows.length === 0) {
      lines.push(t.statusDoneClean, context);
    } else {
      lines.push(fmt(t.statusDoneHeading, { n: rows.length }), context, "");
      if (input.severityCounts && Object.keys(input.severityCounts).length > 0) {
        lines.push(severityCountsLine(input.severityCounts), "");
      }
      lines.push(...findingTableHeader(t));
      for (const row of rows) {
        lines.push(
          `| ${escapeTableCell(row.displayId)} | ${escapeTableCell(row.severity)} | ${escapeTableCell(row.category)} | ${escapeTableCell(row.anchor)} | ${escapeTableCell(row.claim)} |`,
        );
      }
    }
  }
  if (link) lines.push("", link);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// review body
// ---------------------------------------------------------------------------

export interface GiteaReviewBodyInput {
  lang: CommentLang;
  /** PIR_REVIEW_MARKER — the last line of the body. */
  marker: string;
  repoFullName: string;
  number: number;
  title: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  stats: { files: number; insertions: number; deletions: number };
  /** Detected language packs by name. */
  plugins: string[];
  /** `pir summarize` output: summary markdown verbatim plus risk-area phrases; null omits the section. */
  walkthrough: { summary: string; riskAreas: string[] } | null;
  findings: {
    inline: Array<{ finding: FindingView; path: string; new_position: number }>;
    demoted: FindingView[];
    unchangedCount: number;
  };
  runUrl?: string;
  version: string;
}

/**
 * Body of the one review pir posts (and deletes-and-reposts) per run:
 * title header, context, walkthrough, an overview table of ALL reportable
 * findings — inline ones at their `path:line`, demoted ones flagged as not
 * on a changed line — an unchanged-suppression note, and a footer whose
 * last line is the review marker.
 */
export function renderReviewBody(input: GiteaReviewBodyInput): string {
  const t = strings(input.lang);
  const lines: string[] = [];

  lines.push(fmt(t.reviewHeading, { n: input.number, title: input.title }));
  lines.push(
    `${input.repoFullName}#${input.number}: \`${input.baseRef}@${shortSha(input.baseSha)}\` → \`${input.headRef}@${shortSha(input.headSha)}\``,
  );
  lines.push(fmt(t.contextStats, { files: input.stats.files, ins: input.stats.insertions, del: input.stats.deletions }));
  if (input.plugins.length > 0) lines.push(fmt(t.contextPlugins, { plugins: input.plugins.join(", ") }));

  if (input.walkthrough !== null) {
    lines.push("", t.summaryHeading, "", input.walkthrough.summary);
    if (input.walkthrough.riskAreas.length > 0) {
      lines.push("", t.riskAreasLabel);
      for (const area of input.walkthrough.riskAreas) lines.push(`- ${area}`);
    }
  }

  lines.push("", t.findingsHeading, "");
  const inlineRows = input.findings.inline.map((c) =>
    [c.finding.displayId, c.finding.severity, c.finding.category, `${c.path}:${c.new_position}`, c.finding.claim],
  );
  const demotedRows = input.findings.demoted.map((finding) => [
    finding.displayId,
    finding.severity,
    finding.category,
    `${anchorLocation(finding, t)} (${t.notOnChangedLine})`,
    finding.claim,
  ]);
  const rows = [...inlineRows, ...demotedRows];
  if (rows.length === 0) {
    lines.push(t.noFindingsLine);
  } else {
    lines.push(...findingTableHeader(t));
    for (const row of rows) {
      lines.push(`| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`);
    }
    if (input.findings.unchangedCount > 0) {
      lines.push("", fmt(t.unchangedNote, { n: input.findings.unchangedCount }));
    }
  }

  const footer = fmt(t.footerVersion, { version: input.version });
  const link = runLink(input.runUrl, t);
  lines.push("", "---", link ? `${footer} · ${link}` : footer, input.marker);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// inline finding body
// ---------------------------------------------------------------------------

export interface GiteaInlineBodyInput {
  finding: FindingView;
  lang: CommentLang;
  /**
   * Where the comment is pinned, as `path:line`. Defaults to the finding's
   * first anchor, which can differ from the mapped position when that first
   * anchor did not land on a changed line — callers that already ran the
   * anchor mapping pass the mapped `path:new_position` here so the header
   * never disagrees with the pin.
   */
  location?: string;
  runUrl?: string;
}

/**
 * Body of one inline review comment: severity/category/location header,
 * the full claim, capped trigger and verifier rationale, run link. No
 * marker — inline comments belong to the review, not to the status
 * comment; HTML comments are stripped so a claim cannot forge one.
 */
export function renderInlineFindingBody(input: GiteaInlineBodyInput): string {
  const t = strings(input.lang);
  const { finding } = input;
  const link = runLink(input.runUrl, t);

  const lines: string[] = [];
  const location = input.location ?? anchorLocation(finding, t);
  lines.push(`**${finding.severity} · ${finding.category}** — \`${location}\``);
  lines.push("", stripHtmlComments(finding.claim).trim());
  lines.push("", `${t.triggerLabel}${capText(stripHtmlComments(finding.trigger).trim(), TRIGGER_MAX)}`);
  if (finding.verifierRationale) {
    lines.push("", `${t.verifierLabel}${capText(stripHtmlComments(finding.verifierRationale).trim(), RATIONALE_MAX)}`);
  }
  if (link) lines.push("", link);
  return `${lines.join("\n")}\n`;
}
