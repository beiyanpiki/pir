import { findIssues, type FindEvent, type FindOutcome, type FindOptions } from "../core/supervisor.js";
import type { FindingRow } from "../memory/finding-store.js";
import type { MemoryMatch } from "../findings/types.js";
import type { AppContext } from "./context.js";

export interface FindServiceResult extends FindOutcome {
  projectId: string;
  degraded: boolean;
}

/**
 * `pir find` / `/review-find`: run the Finding Loop over a change range and
 * persist verified findings. Progress goes to the callback (stderr for the
 * CLI, UI notifications for the extension).
 */
export async function runFind(
  ctx: AppContext,
  options: FindOptions & { onProgress?: (event: FindEvent) => void } = {},
): Promise<FindServiceResult> {
  const outcome = await findIssues({
    repoRoot: ctx.repoRoot,
    memory: ctx.memory,
    codeMap: ctx.codeMap,
    factory: ctx.factory,
    options,
    onProgress: options.onProgress,
  });
  return { ...outcome, projectId: ctx.memory.identity.projectId, degraded: ctx.codeMapDegraded };
}

export interface FindingView {
  id: string;
  displayId: string;
  title: string;
  claim: string;
  trigger: string;
  category: string;
  severity: string;
  status: string;
  featureKey: string | null;
  entityKey: string | null;
  anchors: Array<{ path: string; startLine: number; endLine?: number; excerpt?: string; lineCorrected?: boolean; originalStartLine?: number; originalEndLine?: number }>;
  evidence: Array<{ kind: string; path?: string; startLine?: number; excerpt?: string; description?: string }>;
  memoryMatches: MemoryMatch[];
  verifierRationale: string | null;
  /** Verifier 0–1 self-assessment; null when no confidence is on record. */
  confidence: number | null;
  round: number;
  createdAt: number;
  /**
   * B2: at least one anchor's lines were decided locally from its excerpt
   * (never present without a correction on the stored anchors).
   */
  lineCorrected: boolean;
}

export function toFindingView(ctx: AppContext, row: FindingRow): FindingView {
  const anchors = ctx.memory.findings.anchors(row);
  return {
    id: row.id,
    displayId: row.displayId,
    title: row.title,
    claim: row.claim,
    trigger: row.trigger,
    category: row.category,
    severity: row.severity,
    status: row.status,
    featureKey: row.featureKey,
    entityKey: row.entityKey,
    anchors,
    evidence: ctx.memory.findings.evidence(row.id),
    memoryMatches: ctx.memory.findings.memoryMatches(row),
    verifierRationale: row.verifierRationale,
    confidence: row.confidence,
    round: row.round,
    createdAt: row.createdAt,
    lineCorrected: anchors.some((anchor) => anchor.lineCorrected === true),
  };
}
