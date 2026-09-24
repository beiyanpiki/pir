import type { AgentSessionFactory } from "./types.js";
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
}

export interface ReviewerDeps {
  factory: AgentSessionFactory;
  ctx: ToolContext;
  memoryPack: string;
  round: number;
  maxRounds: number;
  focus: string[];
  priorSummary?: string;
  model?: string;
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
  });

  let assistantText = "";
  try {
    const prompt = reviewerPrompt({
      base: deps.ctx.changeSet.base,
      head: deps.ctx.changeSet.head,
      round: deps.round,
      maxRounds: deps.maxRounds,
      focus: deps.focus,
      priorSummary: deps.priorSummary,
      memoryPack: deps.memoryPack,
      structuralQueries: deps.ctx.codeMap.structuralQueries,
    });
    await session.prompt(prompt);
    assistantText = session.getLastAssistantText() ?? "";
  } finally {
    session.dispose();
  }

  return {
    candidates: collector.candidates,
    summary: outcome.summary || assistantText.slice(0, 500),
    nextFocus: outcome.nextFocus,
    needsMoreRounds: outcome.needsMoreRounds,
    assistantText,
    submitted: outcome.submitted,
  };
}
