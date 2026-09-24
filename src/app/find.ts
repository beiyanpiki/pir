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
  anchors: Array<{ path: string; startLine: number; endLine?: number }>;
  evidence: Array<{ kind: string; path?: string; startLine?: number; excerpt?: string; description?: string }>;
  memoryMatches: MemoryMatch[];
  verifierRationale: string | null;
  round: number;
  createdAt: number;
}

export function toFindingView(ctx: AppContext, row: FindingRow): FindingView {
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
    anchors: ctx.memory.findings.anchors(row),
    evidence: ctx.memory.findings.evidence(row.id),
    memoryMatches: ctx.memory.findings.memoryMatches(row),
    verifierRationale: row.verifierRationale,
    round: row.round,
    createdAt: row.createdAt,
  };
}
