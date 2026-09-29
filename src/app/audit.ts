import { auditIssues, type AuditOutcome, type AuditOptions, type FindEvent } from "../core/supervisor.js";
import { isDirty } from "../changes/git.js";
import type { AppContext } from "./context.js";

export interface AuditServiceResult extends AuditOutcome {
  projectId: string;
  degraded: boolean;
  /** True when the checkout had uncommitted changes; they are never audited. */
  dirtyWorktree: boolean;
}

/**
 * `pir audit`: current-state review of one pinned snapshot through the shared
 * supervisor loop. The audit target is the committed tree at --head (default
 * HEAD); working-tree dirt is excluded by construction and reported.
 */
export async function runAudit(
  ctx: AppContext,
  options: AuditOptions & { onProgress?: (event: FindEvent) => void } = {},
): Promise<AuditServiceResult> {
  const dirtyWorktree = await isDirty(ctx.repoRoot);
  const outcome = await auditIssues({
    repoRoot: ctx.repoRoot,
    memory: ctx.memory,
    codeMap: ctx.codeMap,
    factory: ctx.factory,
    options,
    onProgress: options.onProgress,
  });
  return {
    ...outcome,
    projectId: ctx.memory.identity.projectId,
    degraded: ctx.codeMapDegraded,
    dirtyWorktree,
  };
}
