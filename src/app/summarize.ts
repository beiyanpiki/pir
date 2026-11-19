import { buildChangeSet } from "../changes/change-set.js";
import { applyChangeFilter } from "../changes/filter.js";
import { getHeadCommit } from "../changes/git.js";
import { runSummarizer } from "../agents/summarizer.js";
import type { ToolContext } from "../tools/context.js";
import type { AppContext } from "./context.js";

export interface SummarizeOptions {
  /** Base ref; defaults to the resolved head's parent (find's semantics). */
  base?: string;
  /** Head ref; defaults to HEAD. */
  head?: string;
  /** Model id override for the session (PIR_MODEL/pi settings otherwise). */
  model?: string;
}

export interface SummarizeResult {
  /** Resolved immutable commits (the ref labels the diff was built from). */
  base: string;
  head: string;
  stats: { files: number; insertions: number; deletions: number };
  /** Markdown walkthrough from the summarizer session. */
  summary: string;
  /** Notable risk areas as short phrases. */
  riskAreas: string[];
}

/** The canned walkthrough for an empty range: a valid zero-change summary, no model session. */
export function emptyRangeSummary(): string {
  return "No changed files in this range — there is nothing to walk through.";
}

/**
 * `pir summarize`: build the change set exactly the way find does (merge-base
 * three-dot diff plus the change-mode filter) and run ONE summarizer session
 * over it. An empty range skips the session entirely.
 */
export async function runSummarize(ctx: AppContext, options: SummarizeOptions = {}): Promise<SummarizeResult> {
  const requestedHead = options.head ?? (await getHeadCommit(ctx.repoRoot));
  const changeSet = applyChangeFilter(
    await buildChangeSet(ctx.repoRoot, options.base ?? `${requestedHead}^`, requestedHead),
  );
  const stats = {
    files: changeSet.files.length,
    insertions: changeSet.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: changeSet.files.reduce((sum, f) => sum + f.deletions, 0),
  };
  const base = changeSet.baseCommit ?? changeSet.base;
  const head = changeSet.headCommit ?? changeSet.head;
  if (changeSet.files.length === 0) {
    return { base, head, stats, summary: emptyRangeSummary(), riskAreas: [] };
  }
  const toolCtx: ToolContext = {
    repoRoot: ctx.repoRoot, headCommit: head, changeSet, codeMap: ctx.codeMap, memory: ctx.memory,
    blockSecretPaths: true,
  };
  const result = await runSummarizer({
    factory: ctx.factory,
    ctx: toolCtx,
    ...(options.model ? { model: options.model } : {}),
  });
  return { base, head, stats, summary: result.summary, riskAreas: result.riskAreas };
}
