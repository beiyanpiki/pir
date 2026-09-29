import type { AgentHandle, AgentSessionFactory, SessionUsage } from "./types.js";
import { READONLY_BUILTIN_TOOLS } from "./types.js";
import { auditVerifierPrompt, verifierPrompt } from "./prompts.js";
import type { CandidateFinding, MemoryMatch, VerifierResult } from "../findings/types.js";
import type { ToolContext } from "../tools/context.js";
import {
  createFindCallersTool, createFindCalleesTool, createFindReferencesTool, createFindSymbolTool,
  createGetChangeTool, createMemoryTools, createReadCodeTool, createSearchTextTool,
} from "../tools/review-tools.js";
import { createSubmitVerdictTool, createVerifierMemoryTools, type VerdictCollector } from "../tools/collector-tools.js";

export interface VerifierDeps {
  factory: AgentSessionFactory;
  ctx: ToolContext;
  candidate: CandidateFinding;
  /** Only these matched IDs are eligible for decision assessments. */
  priorDecisions: MemoryMatch[];
  model?: string;
  transcriptFile?: string;
  /** Rendered built-in language-pack playbooks for this session's prompt. */
  languageGuidance?: string;
  /** Audit mode: current-state verification without change attribution. */
  audit?: boolean;
}

/** Verify technical realness independently of historical acceptance. */
export async function runVerifier(deps: VerifierDeps): Promise<VerifierResult> {
  const collector: VerdictCollector = {};
  let queriedDecisions = false;
  let session: AgentHandle | undefined;
  let usage: SessionUsage | undefined;
  let result: VerifierResult = {
    verdict: "uncertain", rationale: "verifier did not call submit_verdict",
    confidence: 0, uncertaintyReason: "missing-verdict",
  };
  const sessionFailure = (error: unknown): VerifierResult => ({
    verdict: "uncertain", confidence: 0, uncertaintyReason: "provider-error",
    rationale: `verifier session error: ${error instanceof Error ? error.message : String(error)}`,
  });
  try {
    const historyTools = createVerifierMemoryTools(deps.ctx).map((tool) => {
      if (tool.name !== "get_relevant_issue_memory") return tool;
      return { ...tool, async execute(params: Record<string, unknown>) {
        // Even an empty or failed lookup crosses the historical-feedback boundary.
        queriedDecisions = true;
        return tool.execute(params);
      } };
    });
    session = await deps.factory.createSession({
      cwd: deps.ctx.repoRoot, systemRole: "finding verifier",
      tools: [
        ...(deps.audit ? [] : [createGetChangeTool(deps.ctx)]),
        createReadCodeTool(deps.ctx), createSearchTextTool(deps.ctx),
        createFindSymbolTool(deps.ctx), createFindReferencesTool(deps.ctx),
        createFindCallersTool(deps.ctx), createFindCalleesTool(deps.ctx),
        ...createMemoryTools(deps.ctx), ...historyTools,
        createSubmitVerdictTool(collector, deps.priorDecisions.map((match) => match.memoryId)),
      ],
      builtinTools: [...READONLY_BUILTIN_TOOLS], model: deps.model, transcriptFile: deps.transcriptFile,
    });
    const fixHistory = deps.ctx.memory?.resolutions.byEntityOrFeature({
      entityKey: deps.candidate.entityKey, featureKey: deps.candidate.featureKey,
    }) ?? [];
    const priorDecisions = deps.priorDecisions.map((match) => ({
      memoryId: match.memoryId, decision: match.decision, claim: match.claim,
      trigger: match.trigger, rationale: match.rationale, scope: match.scope,
      source: match.source, stale: match.stale,
    }));
    const fixHistoryView = fixHistory.map((fix) => ({
      originalClaim: fix.originalClaim, afterCommit: fix.afterCommit, verified: fix.verified,
    }));
    await session.prompt(deps.audit
      ? auditVerifierPrompt({
          candidate: deps.candidate,
          head: deps.ctx.headCommit,
          structuralQueries: deps.ctx.codeMap.structuralQueries,
          priorDecisions,
          fixHistory: fixHistoryView,
          languageGuidance: deps.languageGuidance,
        })
      : verifierPrompt({
          candidate: deps.candidate,
          base: deps.ctx.changeSet?.baseCommit ?? deps.ctx.changeSet?.base,
          head: deps.ctx.changeSet?.headCommit ?? deps.ctx.headCommit,
          mergeBase: deps.ctx.changeSet?.mergeBase,
          structuralQueries: deps.ctx.codeMap.structuralQueries,
          priorDecisions,
          fixHistory: fixHistoryView,
          languageGuidance: deps.languageGuidance,
        }));
    const providerError = session.getLastAssistantError();
    if (providerError) {
      result = sessionFailure(providerError);
    } else if (collector.verdict) {
      result = { ...collector.verdict };
    } else {
      const assistantText = session.getLastAssistantText();
      if (assistantText) result.rationale += `; assistant said: ${assistantText.slice(0, 400)}`;
    }
  } catch (error) {
    result = sessionFailure(error);
  } finally {
    if (session) {
      try {
        const measured = session.getUsage?.();
        if (measured) usage = { ...measured };
      } catch {
        console.error("verifier warning: session usage unavailable");
      }
      try { session.dispose(); } catch {
        console.error("verifier warning: session disposal failed");
      }
    }
  }
  // Never derive follow-up from verdict rationale. A lookup can introduce
  // historical bias even if initial matching found no decisions.
  if (deps.priorDecisions.length || queriedDecisions) delete result.codeFeedback;
  return { ...result, ...(usage ? { usage } : {}) };
}
