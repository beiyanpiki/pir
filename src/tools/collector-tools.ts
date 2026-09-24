import { Type } from "typebox";
import { buildIdentity } from "../findings/identity.js";
import { FINDING_CATEGORIES, type CandidateFinding, type Severity } from "../findings/types.js";
import type { ReviewTool } from "../agents/types.js";
import type { IssueMemory } from "../memory/issue-memory.js";
import type { ToolContext } from "./context.js";

/**
 * Structured output collectors. The reviewer/verifier prompts require these
 * tools to be called; their payloads become candidate findings and verdicts.
 */

export interface CandidateCollector {
  candidates: CandidateFinding[];
}

export function createRecordCandidateTool(ctx: ToolContext, collector: CandidateCollector, round: number): ReviewTool {
  let seq = 0;
  return {
    name: "record_candidate",
    description:
      "Record a candidate finding you have verified evidence for. Call once per finding. Categories: " +
      FINDING_CATEGORIES.join(", ") +
      ". Severity: P0 (data loss/security/crash), P1 (incorrect behavior), P2 (risky/uncertain), P3 (minor).",
    promptSnippet: "record_candidate: submit a candidate finding (structured)",
    parameters: Type.Object({
      title: Type.String({ description: "Short title (<= 80 chars)" }),
      claim: Type.String({ description: "One sentence: what is wrong, asserted precisely." }),
      trigger: Type.String({ description: "The code path/condition that activates the problem." }),
      category: Type.String({ description: "One of the documented categories" }),
      severity: Type.String({ description: "P0 | P1 | P2 | P3" }),
      featureKey: Type.Optional(Type.String({ description: "Feature key if known, e.g. payment-retry" })),
      entityKey: Type.Optional(Type.String({ description: "Qualified symbol key if known" })),
      anchors: Type.Array(
        Type.Object({
          path: Type.String(),
          startLine: Type.Number(),
          endLine: Type.Optional(Type.Number()),
        }),
        { description: "Code locations (repository-relative, head-side line numbers)" },
      ),
      evidence: Type.Array(
        Type.Object({
          kind: Type.String({ description: "code | diff | test | doc | memory | commit" }),
          path: Type.Optional(Type.String()),
          startLine: Type.Optional(Type.Number()),
          endLine: Type.Optional(Type.Number()),
          excerpt: Type.Optional(Type.String({ description: "Short supporting snippet" })),
          description: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(params) {
      const category = String(params.category);
      const severity = String(params.severity) as Severity;
      if (!(FINDING_CATEGORIES as readonly string[]).includes(category)) {
        return { text: `ERROR: unknown category "${category}". Use one of: ${FINDING_CATEGORIES.join(", ")}` };
      }
      if (!["P0", "P1", "P2", "P3"].includes(severity)) {
        return { text: "ERROR: severity must be P0, P1, P2 or P3." };
      }
      seq += 1;
      const displayId = `F-${round}${String(seq).padStart(2, "0")}`;
      const candidate: CandidateFinding = {
        displayId,
        title: String(params.title),
        claim: String(params.claim),
        trigger: String(params.trigger),
        category,
        severity,
        featureKey: params.featureKey ? String(params.featureKey) : undefined,
        entityKey: params.entityKey ? String(params.entityKey) : undefined,
        anchors: (params.anchors as CandidateFinding["anchors"]) ?? [],
        evidence: ((params.evidence as CandidateFinding["evidence"]) ?? []).map((e) => ({
          ...e,
          kind: (["code", "diff", "test", "doc", "memory", "commit"] as const).includes(e.kind as never)
            ? (e.kind as CandidateFinding["evidence"][number]["kind"])
            : "code",
        })),
        round,
        identity: buildIdentity({
          featureKey: params.featureKey ? String(params.featureKey) : undefined,
          entityKey: params.entityKey ? String(params.entityKey) : undefined,
          category,
          claim: String(params.claim),
          trigger: String(params.trigger),
        }),
      };
      collector.candidates.push(candidate);
      return { text: `Recorded candidate ${displayId}: ${candidate.title}` };
    },
  };
}

export interface RoundOutcome {
  summary: string;
  nextFocus: string[];
  needsMoreRounds: boolean;
  submitted: boolean;
}

export function createFinishRoundTool(outcome: RoundOutcome): ReviewTool {
  return {
    name: "finish_round",
    description: "End this review round. Required: everything you found must already be recorded via record_candidate.",
    promptSnippet: "finish_round: end the round (required)",
    parameters: Type.Object({
      summary: Type.String({ description: "What you examined and concluded this round." }),
      nextFocus: Type.Array(Type.String(), {
        description: "Symbols/paths worth examining in a follow-up round, if any.",
      }),
      needsMoreRounds: Type.Boolean({ description: "True only if a follow-up round is clearly warranted." }),
    }),
    async execute(params) {
      outcome.summary = String(params.summary);
      outcome.nextFocus = (params.nextFocus as string[]) ?? [];
      outcome.needsMoreRounds = Boolean(params.needsMoreRounds);
      outcome.submitted = true;
      return { text: "Round complete.", terminate: true };
    },
  };
}

export interface VerdictCollector {
  verdict?: {
    verdict: "confirmed" | "rejected" | "uncertain";
    rationale: string;
    priorDecisionStillApplies?: boolean;
    confidence: number;
  };
}

export function createSubmitVerdictTool(collector: VerdictCollector): ReviewTool {
  return {
    name: "submit_verdict",
    description:
      "Submit the verification verdict for the candidate finding. 'rejected' requires concrete evidence the claim is wrong or intended.",
    promptSnippet: "submit_verdict: submit the verification verdict (required)",
    parameters: Type.Object({
      verdict: Type.String({ description: "confirmed | rejected | uncertain" }),
      rationale: Type.String({ description: "Evidence-based reasoning citing what you checked." }),
      priorDecisionStillApplies: Type.Optional(
        Type.Boolean({ description: "If a prior user decision was matched: does it still apply to the current code?" }),
      ),
      confidence: Type.Optional(Type.Number({ description: "0..1" })),
    }),
    async execute(params) {
      const verdict = String(params.verdict);
      if (!["confirmed", "rejected", "uncertain"].includes(verdict)) {
        return { text: "ERROR: verdict must be confirmed, rejected or uncertain." };
      }
      collector.verdict = {
        verdict: verdict as "confirmed" | "rejected" | "uncertain",
        rationale: String(params.rationale),
        priorDecisionStillApplies:
          params.priorDecisionStillApplies === undefined ? undefined : Boolean(params.priorDecisionStillApplies),
        confidence: Math.min(1, Math.max(0, Number(params.confidence ?? 0.7))),
      };
      return { text: "Verdict recorded.", terminate: true };
    },
  };
}

// ---------------------------------------------------------------------------
// verifier-only memory tools (historical decisions and fix history)
// ---------------------------------------------------------------------------

export function createVerifierMemoryTools(ctx: ToolContext): ReviewTool[] {
  if (!ctx.memory) {
    const none = (name: string, description: string): ReviewTool => ({
      name,
      description,
      parameters: Type.Object({}),
      async execute() {
        return { text: "No repository memory available." };
      },
    });
    return [none("get_relevant_issue_memory", "Historical issue decisions."), none("get_fix_history", "Historical fixes.")];
  }

  const getRelevantIssueMemory: ReviewTool = {
    name: "get_relevant_issue_memory",
    description:
      "Historical user decisions about similar issues (expected / false-positive / accepted-risk / wont-fix). Evidence, not truth: verify they still apply.",
    parameters: Type.Object({
      claim: Type.Optional(Type.String({ description: "Claim text to match" })),
      entityKey: Type.Optional(Type.String()),
      featureKey: Type.Optional(Type.String()),
    }),
    async execute(params) {
      const memory = ctx.memory!;
      const entityKey = params.entityKey ? String(params.entityKey) : undefined;
      const featureKey = params.featureKey ? String(params.featureKey) : undefined;
      let list: IssueMemory[] = [];
      if (entityKey) list = memory.issues.byEntity(entityKey);
      if (list.length === 0 && featureKey) list = memory.issues.byFeature(featureKey);
      if (list.length === 0) list = memory.issues.recent(20);
      if (list.length === 0) return { text: "No historical issue decisions." };
      return {
        text: list
          .slice(0, 20)
          .map(
            (m) =>
              `[${m.decision}] (${m.scope}, ${m.source}) ${m.claim}\n  trigger: ${m.trigger}\n  rationale: ${m.rationale || "(none)"}${m.stale ? "\n  (stale)" : ""}`,
          )
          .join("\n"),
      };
    },
  };

  const getFixHistory: ReviewTool = {
    name: "get_fix_history",
    description: "Historical fixed findings (regression memory) for a symbol or feature.",
    parameters: Type.Object({
      entityKey: Type.Optional(Type.String()),
      featureKey: Type.Optional(Type.String()),
    }),
    async execute(params) {
      const memory = ctx.memory!;
      const list = memory.resolutions.byEntityOrFeature({
        entityKey: params.entityKey ? String(params.entityKey) : undefined,
        featureKey: params.featureKey ? String(params.featureKey) : undefined,
      });
      if (list.length === 0) return { text: "No fix history for this scope." };
      return {
        text: list
          .map(
            (r) =>
              `[${r.resolution}${r.verified ? ",verified" : ""}] ${r.originalClaim}\n  trigger: ${r.originalTrigger}\n  after commit: ${r.afterCommit ?? "?"}`,
          )
          .join("\n"),
      };
    },
  };

  return [getRelevantIssueMemory, getFixHistory];
}
