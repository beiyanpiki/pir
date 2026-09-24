import type { AgentSessionFactory } from "./types.js";
import { READONLY_BUILTIN_TOOLS } from "./types.js";
import { verifierPrompt } from "./prompts.js";
import type { CandidateFinding, MemoryMatch, VerifierResult } from "../findings/types.js";
import type { ToolContext } from "../tools/context.js";
import {
  createFindCallersTool,
  createFindCalleesTool,
  createFindReferencesTool,
  createFindSymbolTool,
  createReadCodeTool,
  createSearchTextTool,
} from "../tools/review-tools.js";
import { createSubmitVerdictTool, createVerifierMemoryTools, type VerdictCollector } from "../tools/collector-tools.js";

export interface VerifierDeps {
  factory: AgentSessionFactory;
  ctx: ToolContext;
  candidate: CandidateFinding;
  /** Matched historical decisions (already fetched by the memory matcher). */
  priorDecisions: MemoryMatch[];
  model?: string;
}

/**
 * Verify one candidate in a fresh isolated session. The verifier — unlike the
 * reviewer — DOES see historical decisions, and must judge whether they still
 * apply to the current code.
 */
export async function runVerifier(deps: VerifierDeps): Promise<VerifierResult> {
  const collector: VerdictCollector = {};

  const fixHistory = deps.ctx.memory
    ? deps.ctx.memory.resolutions.byEntityOrFeature({
        entityKey: deps.candidate.entityKey,
        featureKey: deps.candidate.featureKey,
      })
    : [];

  const tools = [
    createReadCodeTool(deps.ctx),
    createSearchTextTool(deps.ctx),
    createFindSymbolTool(deps.ctx),
    createFindReferencesTool(deps.ctx),
    createFindCallersTool(deps.ctx),
    createFindCalleesTool(deps.ctx),
    ...createVerifierMemoryTools(deps.ctx),
    createSubmitVerdictTool(collector),
  ];

  const session = await deps.factory.createSession({
    cwd: deps.ctx.repoRoot,
    systemRole: "finding verifier",
    tools,
    builtinTools: [...READONLY_BUILTIN_TOOLS],
    model: deps.model,
  });

  let assistantText = "";
  try {
    await session.prompt(
      verifierPrompt({
        candidate: {
          displayId: deps.candidate.displayId,
          title: deps.candidate.title,
          claim: deps.candidate.claim,
          trigger: deps.candidate.trigger,
          category: deps.candidate.category,
          severity: deps.candidate.severity,
          anchors: deps.candidate.anchors,
        },
        head: deps.ctx.changeSet.head,
        priorDecisions: deps.priorDecisions.map((m) => ({
          decision: m.decision,
          claim: m.claim,
          trigger: "",
          rationale: m.rationale ?? "",
          scope: m.scope,
          source: m.source,
          stale: false,
        })),
        fixHistory: fixHistory.map((f) => ({
          originalClaim: f.originalClaim,
          afterCommit: f.afterCommit,
          verified: f.verified,
        })),
      }),
    );
    assistantText = session.getLastAssistantText() ?? "";
  } finally {
    session.dispose();
  }

  if (!collector.verdict) {
    return {
      verdict: "uncertain",
      rationale: assistantText
        ? `verifier did not call submit_verdict; assistant said: ${assistantText.slice(0, 400)}`
        : "verifier did not call submit_verdict and produced no text",
      confidence: 0.2,
    };
  }
  return collector.verdict;
}
