import { SEVERITY_ORDER, type Severity } from "../findings/types.js";
import type { ActivePack } from "../plugins/types.js";
import type { RunVerdict } from "../core/review-state.js";
import type { FindingView } from "./find.js";

export const SCHEMA_VERSION = 1;

/** Agent-facing JSON envelope. stdout carries only this when --json is set. */
export function envelope(command: string, data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, ...extra, data }, null, 2);
}

export function severityAtLeast(severity: string, threshold: string): boolean {
  const a = SEVERITY_ORDER[severity as Severity];
  const b = SEVERITY_ORDER[threshold as Severity];
  if (a === undefined || b === undefined) return false;
  return a <= b;
}

const REPORTED_STATUSES = new Set(["confirmed", "uncertain"]);

export function isReported(finding: FindingView): boolean {
  return REPORTED_STATUSES.has(finding.status);
}

export function findExitCode(findings: FindingView[], failOn: string, incomplete = false): number {
  if (failOn === "none") return 0;
  if (findings.some((finding) => isReported(finding) && severityAtLeast(finding.severity, failOn))) return 1;
  return incomplete ? 3 : 0;
}

// ---------------------------------------------------------------------------
// human-facing text rendering
// ---------------------------------------------------------------------------

export function renderFinding(finding: FindingView): string {
  const lines = [
    `${finding.displayId} [${finding.severity}/${finding.status}] ${finding.title}`,
    `  claim: ${finding.claim}`,
    `  trigger: ${finding.trigger}`,
    `  category: ${finding.category}${finding.entityKey ? ` | entity: ${finding.entityKey}` : ""}${finding.featureKey ? ` | feature: ${finding.featureKey}` : ""}`,
  ];
  for (const anchor of finding.anchors.slice(0, 3)) {
    lines.push(`  at: ${anchor.path}:${anchor.startLine}${anchor.endLine ? `-${anchor.endLine}` : ""}`);
  }
  if (finding.verifierRationale) {
    lines.push(`  verifier: ${finding.verifierRationale.slice(0, 300)}`);
  }
  for (const match of finding.memoryMatches.slice(0, 3)) {
    const m = match as { decision?: string; stillApplies?: boolean; source?: string };
    lines.push(`  memory: [${m.decision ?? "?"}] stillApplies=${m.stillApplies ?? "?"} (${m.source ?? "?"})`);
  }
  return lines.join("\n");
}

export function renderFindingsText(findings: FindingView[]): string {
  if (findings.length === 0) return "No findings.";
  return findings.map(renderFinding).join("\n\n");
}

/**
 * Low-confidence reporting split (Q4). Callers without the option render
 * exactly as before. Bucketing only — the low-confidence rows stay inside
 * `findings` (reported set, maxFindings accounting, exit-code contract all
 * unchanged); this only decides which section renders them.
 */
function splitReported(findings: FindingView[], lowConfidenceFindings?: FindingView[]): {
  main: FindingView[];
  low: FindingView[];
} {
  if (!lowConfidenceFindings?.length) return { main: findings.filter(isReported), low: [] };
  const low = lowConfidenceFindings.filter(isReported);
  const lowIds = new Set(low.map((f) => f.displayId));
  return { main: findings.filter((f) => isReported(f) && !lowIds.has(f.displayId)), low };
}

function pushLowConfidenceSection(lines: string[], low: FindingView[], minConfidence?: number): void {
  if (low.length === 0) return;
  lines.push("");
  lines.push(`Low-confidence (verifier confidence below ${minConfidence ?? 0}) (${low.length}):`);
  lines.push(renderFindingsText(low));
}

export function renderFindResultText(input: {
  degraded: boolean;
  plugins?: ActivePack[];
  rounds: Array<{ round: number; fresh: number; confirmed: number; rejected: number; uncertain: number }>;
  findings: FindingView[];
  stoppedBecause: string;
  pendingCandidates?: number;
  incomplete?: boolean;
  transcriptDir?: string;
  /** Stable run identifier — quoted by receipts and `pir runs status` (#52). */
  runId?: string;
  /** Q4: deterministic run-level verdict, shown next to the stop reason. */
  runVerdict?: RunVerdict;
  /** Q4: effective --min-confidence threshold with `lowConfidenceFindings`. */
  minConfidence?: number;
  lowConfidenceFindings?: FindingView[];
}): string {
  const lines: string[] = [];
  if (input.degraded) {
    lines.push("note: structural index unavailable (degraded mode) — run `codegraph init` for symbol-aware review");
  }
  if (input.plugins?.length) {
    lines.push(`language packs: ${input.plugins.map((p) => `${p.name}@${p.version} (${p.activation})`).join(", ")}`);
  }
  for (const round of input.rounds) {
    lines.push(
      `round ${round.round}: ${round.fresh} new candidates, ${round.confirmed} confirmed, ${round.rejected} rejected, ${round.uncertain} uncertain`,
    );
  }
  lines.push(`stopped: ${input.stoppedBecause}`);
  if (input.runVerdict) lines.push(`run verdict: ${input.runVerdict}`);
  if (input.incomplete) lines.push("review incomplete: remaining work or verification errors; this is not a clean review");
  if (input.pendingCandidates) {
    lines.push(`pending: ${input.pendingCandidates} candidates were not verified; inspect with findings list --status candidate`);
  }
  if (input.runId) lines.push(`run id: ${input.runId}`);
  if (input.transcriptDir) {
    lines.push(`transcripts: ${input.transcriptDir}`);
  }
  const { main, low } = splitReported(input.findings, input.lowConfidenceFindings);
  lines.push("");
  if (main.length > 0) {
    lines.push(`Findings (${main.length}):`);
    lines.push(renderFindingsText(main));
  } else if (low.length === 0) {
    lines.push("No confirmed findings.");
  }
  pushLowConfidenceSection(lines, low, input.minConfidence);
  const suppressed = input.findings.filter((f) => !isReported(f));
  if (suppressed.length > 0) {
    lines.push("");
    lines.push(`Suppressed by prior decisions / rejected (${suppressed.length}):`);
    for (const f of suppressed) {
      lines.push(`  ${f.displayId} [${f.status}] ${f.title}`);
    }
  }
  return lines.join("\n");
}

export function renderAuditResultText(input: {
  degraded: boolean;
  dirtyWorktree: boolean;
  plugins?: ActivePack[];
  coverage: {
    filesTotal: number;
    filesInScope: number;
    filesReviewed: number;
    filesPartial: number;
    filesUnreviewed: number;
    filesBlocked: number;
    filesFailed: number;
    filesExcluded: number;
    filesNotSelected: number;
    batchesTotal: number;
    batchesCompleted: number;
  };
  findings: FindingView[];
  stoppedBecause: string;
  incomplete: boolean;
  incompleteReasons: string[];
  pendingCandidates?: number;
  transcriptDir?: string;
  /** Stable run identifier — quoted by receipts and `pir runs status` (#52). */
  runId?: string;
  /** Advisory: reported findings that may describe the same defect. */
  suspectedDuplicates?: Array<{ representative: string; members: string[]; reason: string }>;
  /** Q4: deterministic run-level verdict, shown next to the stop reason. */
  runVerdict?: RunVerdict;
  /** Q4: effective --min-confidence threshold with `lowConfidenceFindings`. */
  minConfidence?: number;
  lowConfidenceFindings?: FindingView[];
}): string {
  const lines: string[] = [];
  if (input.degraded) {
    lines.push("note: structural index unavailable (degraded mode) — run `codegraph init` for symbol-aware review");
  }
  if (input.dirtyWorktree) {
    lines.push("note: working tree has uncommitted changes; the audit covers the committed HEAD snapshot only");
  }
  if (input.plugins?.length) {
    lines.push(`language packs: ${input.plugins.map((p) => p.name).join(", ")} (audit-aware guidance where available)`);
  }
  const c = input.coverage;
  lines.push(
    `coverage: ${c.filesReviewed}/${c.filesInScope} reviewed in scope (${c.filesTotal} files total: ` +
    `${c.filesNotSelected} not selected, ${c.filesExcluded} excluded, ${c.filesPartial} partial, ${c.filesUnreviewed} unreviewed, ${c.filesBlocked} blocked, ${c.filesFailed} failed); ` +
    `units ${c.batchesCompleted}/${c.batchesTotal} completed`,
  );
  lines.push(`stopped: ${input.stoppedBecause}`);
  if (input.runVerdict) lines.push(`run verdict: ${input.runVerdict}`);
  if (input.incomplete) {
    lines.push(`audit incomplete: ${input.incompleteReasons.join("; ")}`);
    lines.push('coverage is process accounting — "reviewed" means the allotted review sessions completed, not a guarantee that every defect was found');
  }
  if (input.pendingCandidates) {
    lines.push(`pending: ${input.pendingCandidates} candidates were not verified; inspect with findings list --status candidate`);
  }
  if (input.runId) lines.push(`run id: ${input.runId}`);
  if (input.transcriptDir) {
    lines.push(`transcripts: ${input.transcriptDir}`);
  }
  const { main, low } = splitReported(input.findings, input.lowConfidenceFindings);
  lines.push("");
  if (main.length > 0) {
    lines.push(`Findings (${main.length}):`);
    lines.push(renderFindingsText(main));
  } else if (low.length === 0) {
    lines.push("No confirmed findings.");
  }
  pushLowConfidenceSection(lines, low, input.minConfidence);
  const suppressed = input.findings.filter((f) => !isReported(f));
  if (suppressed.length > 0) {
    lines.push("");
    lines.push(`Suppressed by prior decisions / rejected (${suppressed.length}):`);
    for (const f of suppressed) {
      lines.push(`  ${f.displayId} [${f.status}] ${f.title}`);
    }
  }
  if (input.suspectedDuplicates?.length) {
    lines.push("");
    lines.push(`Suspected duplicate reports (advisory, not merged — ${input.suspectedDuplicates.length}):`);
    for (const group of input.suspectedDuplicates) {
      lines.push(`  ${group.representative} ~= ${group.members.join(", ")} (${group.reason})`);
    }
  }
  return lines.join("\n");
}
