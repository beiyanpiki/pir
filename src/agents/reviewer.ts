import type { AgentSessionFactory, SessionUsage } from "./types.js";
import { READONLY_BUILTIN_TOOLS } from "./types.js";
import { auditReviewerPrompt, reviewerPrompt } from "./prompts.js";
import type { CandidateFinding } from "../findings/types.js";
import type { RepoSnapshot } from "../changes/snapshot.js";
import type { ReviewWorkUnit } from "../core/audit-planner.js";
import type { ToolContext } from "../tools/context.js";
import {
  createFindCallersTool,
  createFindCalleesTool,
  createFindReferencesTool,
  createFindSymbolTool,
  createGetChangeTool,
  createListSnapshotFilesTool,
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
  /** Audit mode: pinned head paths read during this session (coverage evidence). */
  readPaths?: string[];
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

/** Audit-mode scheduling inputs for one reviewer session. */
export interface ReviewerAuditScope {
  snapshot: RepoSnapshot;
  unit: ReviewWorkUnit;
  attempt: number;
  maxAttempts: number;
  unitsTotal: number;
  unitsRemaining: number;
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
  /** Audit mode: current-state review of one work unit (no diff attribution). */
  audit?: ReviewerAuditScope;
}

/**
 * One reviewer round: a fresh isolated session explores the target and must
 * emit candidates through record_candidate and end via finish_round. Change
 * mode reviews the base..head diff; audit mode reviews one snapshot unit.
 */
export async function runReviewerRound(deps: ReviewerDeps): Promise<ReviewerRoundResult> {
  const collector: CandidateCollector = { candidates: [] };
  const outcome: RoundOutcome = { summary: "", nextFocus: [], needsMoreRounds: false, submitted: false };
  const readPaths = new Set<string>();
  // The observer is per-session: only this session's pinned head reads count
  // toward this unit's coverage evidence.
  const sessionCtx: ToolContext = deps.audit
    ? { ...deps.ctx, readObserver: (path, revision) => { if (revision === "head") readPaths.add(path); } }
    : deps.ctx;

  const tools = [
    ...(deps.audit
      ? [createListSnapshotFilesTool(sessionCtx, deps.audit.snapshot)]
      : [createGetChangeTool(sessionCtx)]),
    createReadCodeTool(sessionCtx),
    createSearchTextTool(sessionCtx),
    createFindSymbolTool(sessionCtx),
    createFindCallersTool(sessionCtx),
    createFindCalleesTool(sessionCtx),
    createFindReferencesTool(sessionCtx),
    ...createMemoryTools(sessionCtx),
    createRecordCandidateTool(sessionCtx, collector, deps.round),
    createFinishRoundTool(outcome),
  ];

  const session = await deps.factory.createSession({
    cwd: sessionCtx.repoRoot,
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
    const prompt = deps.audit
      ? auditReviewerPrompt({
          head: sessionCtx.headCommit,
          unitId: deps.audit.unit.id,
          module: deps.audit.unit.module,
          attempt: deps.audit.attempt,
          maxAttempts: deps.audit.maxAttempts,
          owned: deps.audit.unit.owned,
          unitsTotal: deps.audit.unitsTotal,
          unitsRemaining: deps.audit.unitsRemaining,
          maxFindings: deps.maxFindings,
          findingsRemaining: deps.findingsRemaining,
          verificationCapacity: deps.verificationCapacity,
          focus: deps.focus,
          priorSummary: deps.priorSummary,
          investigationFeedback: deps.investigationFeedback,
          memoryPack: deps.memoryPack,
          structuralQueries: sessionCtx.codeMap.structuralQueries,
          languageGuidance: deps.languageGuidance,
        })
      : reviewerPrompt({
          base: sessionCtx.changeSet ? (sessionCtx.changeSet.baseCommit ?? sessionCtx.changeSet.base) : sessionCtx.headCommit,
          head: sessionCtx.changeSet?.headCommit ?? sessionCtx.headCommit,
          mergeBase: deps.mergeBase ?? sessionCtx.changeSet?.mergeBase,
          round: deps.round,
          maxRounds: deps.maxRounds,
          maxFindings: deps.maxFindings,
          findingsRemaining: deps.findingsRemaining,
          verificationCapacity: deps.verificationCapacity,
          focus: deps.focus,
          priorSummary: deps.priorSummary,
          investigationFeedback: deps.investigationFeedback,
          memoryPack: deps.memoryPack,
          structuralQueries: sessionCtx.codeMap.structuralQueries,
          languageGuidance: deps.languageGuidance,
        });
    await session.prompt(prompt);
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
    ...(deps.audit ? { readPaths: [...readPaths] } : {}),
  };
}
