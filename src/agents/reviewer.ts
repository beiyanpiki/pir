import type { AgentSessionFactory, SessionUsage } from "./types.js";
import { READONLY_BUILTIN_TOOLS } from "./types.js";
import { reviewerPrompt } from "./prompts.js";
import type { CandidateFinding } from "../findings/types.js";
import type { ToolContext } from "../tools/context.js";
import {
  createFindCallersTool,
  createFindCalleesTool,
  createFindReferencesTool,
  createFindSymbolTool,
  createGetChangeTool,
  createMemoryTools,
  createReadCodeTool,
  createSearchTextTool,
} from "../tools/review-tools.js";
import {
  createFinishRoundTool,
  createRecordCandidateTool,
  type CandidateCollector,
  type RoundOutcome,
} from "../tools/collector-tools.js";

export interface ReviewerRoundResult {
  candidates: CandidateFinding[];
  summary: string;
  nextFocus: string[];
  needsMoreRounds: boolean;
  assistantText: string;
  submitted: boolean;
  coverage?: string[];
  unresolvedQuestions?: string[];
  blockers?: string[];
  usage?: SessionUsage;
}

/** Incomplete rounds remain failures, but retain evidence for error persistence. */
export class ReviewerRoundError extends Error {
  readonly candidates: CandidateFinding[];
  readonly usage?: SessionUsage;

  constructor(cause: unknown, candidates: CandidateFinding[], usage?: SessionUsage) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ReviewerRoundError";
    this.candidates = [...candidates];
    this.usage = usage ? { ...usage } : undefined;
  }
}

export interface ReviewerDeps {
  factory: AgentSessionFactory;
  ctx: ToolContext;
  memoryPack: string;
  round: number;
  maxRounds: number;
  maxFindings: number;
  /** Slots left under the maxFindings cap at the start of this round. */
  findingsRemaining: number;
  focus: string[];
  priorSummary?: string;
  investigationFeedback?: string[];
  mergeBase?: string;
  verificationCapacity?: number;
  model?: string;
  /** Opt-in transcript dump location for this round's session. */
  transcriptFile?: string;
  /** Rendered built-in language-pack directions for this round's prompt. */
  languageGuidance?: string;
}

/**
 * One reviewer round: a fresh isolated session explores the change and must
 * emit candidates through record_candidate and end via finish_round.
 */
export async function runReviewerRound(deps: ReviewerDeps): Promise<ReviewerRoundResult> {
  const collector: CandidateCollector = { candidates: [] };
  const outcome: RoundOutcome = { summary: "", nextFocus: [], needsMoreRounds: false, submitted: false };

  const tools = [
    createGetChangeTool(deps.ctx),
    createReadCodeTool(deps.ctx),
    createSearchTextTool(deps.ctx),
    createFindSymbolTool(deps.ctx),
    createFindCallersTool(deps.ctx),
    createFindCalleesTool(deps.ctx),
    createFindReferencesTool(deps.ctx),
    ...createMemoryTools(deps.ctx),
    createRecordCandidateTool(deps.ctx, collector, deps.round),
    createFinishRoundTool(outcome),
  ];

  const session = await deps.factory.createSession({
    cwd: deps.ctx.repoRoot,
    systemRole: "code reviewer",
    tools,
    builtinTools: [...READONLY_BUILTIN_TOOLS],
    model: deps.model,
    transcriptFile: deps.transcriptFile,
  });

  let assistantText = "";
  let usage: SessionUsage | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    await session.prompt(reviewerPrompt({
      base: deps.ctx.changeSet.baseCommit ?? deps.ctx.changeSet.base,
      head: deps.ctx.changeSet.headCommit ?? deps.ctx.headCommit,
      mergeBase: deps.mergeBase ?? deps.ctx.changeSet.mergeBase,
      round: deps.round,
      maxRounds: deps.maxRounds,
      maxFindings: deps.maxFindings,
      findingsRemaining: deps.findingsRemaining,
      verificationCapacity: deps.verificationCapacity,
      focus: deps.focus,
      priorSummary: deps.priorSummary,
      investigationFeedback: deps.investigationFeedback,
      memoryPack: deps.memoryPack,
      structuralQueries: deps.ctx.codeMap.structuralQueries,
      languageGuidance: deps.languageGuidance,
    }));
    assistantText = session.getLastAssistantText() ?? "";
    // Some providers resolve an errored turn rather than rejecting it.
    const providerError = session.getLastAssistantError();
    if (providerError) throw new Error(`reviewer session failed: ${providerError}`);
    if (!outcome.submitted) throw new Error("reviewer did not call finish_round; round incomplete");
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
  if (failure) throw new ReviewerRoundError(failure.cause, collector.candidates, usage);

  return {
    candidates: collector.candidates,
    summary: outcome.summary,
    nextFocus: outcome.nextFocus,
    needsMoreRounds: outcome.needsMoreRounds,
    assistantText,
    submitted: outcome.submitted,
    coverage: outcome.coverage ?? [],
    unresolvedQuestions: outcome.unresolvedQuestions ?? [],
    blockers: outcome.blockers ?? [],
    usage,
  };
}
