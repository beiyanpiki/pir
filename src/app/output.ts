import { SEVERITY_ORDER, type Severity } from "../findings/types.js";
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

export function renderFindResultText(input: {
  degraded: boolean;
  rounds: Array<{ round: number; fresh: number; confirmed: number; rejected: number; uncertain: number }>;
  findings: FindingView[];
  stoppedBecause: string;
}): string {
  const lines: string[] = [];
  if (input.degraded) {
    lines.push("note: structural index unavailable (degraded mode) — run `codegraph init` for symbol-aware review");
  }
  for (const round of input.rounds) {
    lines.push(
      `round ${round.round}: ${round.fresh} new candidates, ${round.confirmed} confirmed, ${round.rejected} rejected, ${round.uncertain} uncertain`,
    );
  }
  lines.push(`stopped: ${input.stoppedBecause}`);
  const reported = input.findings.filter(isReported);
  lines.push("");
  if (reported.length > 0) {
    lines.push(`Findings (${reported.length}):`);
    lines.push(renderFindingsText(reported));
  } else {
    lines.push("No confirmed findings.");
  }
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
