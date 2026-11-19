import type { AgentSessionFactory, SessionUsage } from "./types.js";
import { READONLY_BUILTIN_TOOLS } from "./types.js";
import { summarizePrompt } from "./prompts.js";
import type { ToolContext } from "../tools/context.js";
import {
  createFindCallersTool,
  createFindCalleesTool,
  createFindReferencesTool,
  createFindSymbolTool,
  createGetChangeTool,
  createReadCodeTool,
  createSearchTextTool,
} from "../tools/review-tools.js";
import { createSubmitSummaryTool, type SummaryOutcome } from "../tools/collector-tools.js";

export interface SummarizerResult {
  /** Markdown walkthrough as submitted through submit_summary. */
  summary: string;
  /** Notable risk areas as short phrases. */
  riskAreas: string[];
  usage?: SessionUsage;
}

export interface SummarizerDeps {
  factory: AgentSessionFactory;
  /** Change-mode tool context: repoRoot, headCommit and the filtered change set. */
  ctx: ToolContext;
  model?: string;
}

/**
 * One summarizer session: a fresh isolated session reads the change range
 * and must end via submit_summary — the reviewer's finish_round contract
 * applied to a walkthrough instead of a finding loop.
 */
export async function runSummarizer(deps: SummarizerDeps): Promise<SummarizerResult> {
  const outcome: SummaryOutcome = { summary: "", riskAreas: [], submitted: false };
  const tools = [
    createGetChangeTool(deps.ctx),
    createReadCodeTool(deps.ctx),
    createSearchTextTool(deps.ctx),
    createFindSymbolTool(deps.ctx),
    createFindCallersTool(deps.ctx),
    createFindCalleesTool(deps.ctx),
    createFindReferencesTool(deps.ctx),
    createSubmitSummaryTool(outcome),
  ];
  const session = await deps.factory.createSession({
    cwd: deps.ctx.repoRoot,
    systemRole: "change summarizer",
    tools,
    builtinTools: [...READONLY_BUILTIN_TOOLS],
    model: deps.model,
  });

  let usage: SessionUsage | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    if (!deps.ctx.changeSet) throw new Error("summarizer requires a change-mode context (no change set to walk through)");
    const prompt = summarizePrompt({
      base: deps.ctx.changeSet.baseCommit ?? deps.ctx.changeSet.base,
      head: deps.ctx.changeSet.headCommit ?? deps.ctx.headCommit,
      mergeBase: deps.ctx.changeSet.mergeBase,
      stats: {
        files: deps.ctx.changeSet.files.length,
        insertions: deps.ctx.changeSet.files.reduce((sum, f) => sum + f.additions, 0),
        deletions: deps.ctx.changeSet.files.reduce((sum, f) => sum + f.deletions, 0),
      },
      files: deps.ctx.changeSet.files,
    });
    await session.prompt(prompt);
    // Some providers resolve an errored turn rather than rejecting it.
    const providerError = session.getLastAssistantError();
    if (providerError) throw new Error(`summarizer session failed: ${providerError}`);
    if (!outcome.submitted) throw new Error("summarizer did not call submit_summary; session incomplete");
  } catch (cause) {
    failure = { cause };
  } finally {
    try {
      const measured = session.getUsage?.();
      if (measured) usage = { ...measured };
    } catch (cause) {
      failure ??= { cause };
    }
    try {
      session.dispose();
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (failure) throw failure.cause;
  return { summary: outcome.summary, riskAreas: outcome.riskAreas, ...(usage ? { usage } : {}) };
}
