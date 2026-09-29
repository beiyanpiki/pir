import type { CandidateFinding, MemoryMatch, VerifiedFinding, VerifierResult } from "../findings/types.js";
import type { IssueDecision } from "../memory/issue-memory.js";

export interface RoundInfo {
  round: number;
  candidates: number;
  fresh: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  suppressed?: number;
  pending?: number;
  reviewerRan?: boolean;
  summary: string;
}

export interface ReviewState {
  base: string;
  head: string;
  round: number;
  maxRounds: number;
  /** All candidates accumulated across rounds (dedup baseline). */
  known: CandidateFinding[];
  pending: CandidateFinding[];
  investigationFeedback: string[];
  verified: VerifiedFinding[];
  rounds: RoundInfo[];
  focus: string[];
  priorSummary?: string;
  dryRounds: number;
  estimatedTokens: number;
  stoppedBecause: string | null;
}

export function createReviewState(base: string, head: string, maxRounds: number): ReviewState {
  return {
    base,
    head,
    round: 0,
    maxRounds,
    known: [],
    pending: [],
    investigationFeedback: [],
    verified: [],
    rounds: [],
    focus: [],
    dryRounds: 0,
    estimatedTokens: 0,
    stoppedBecause: null,
  };
}

/**
 * Findings that count toward the report: confirmed plus uncertain. Rejected
 * and decision-suppressed findings do not consume the maxFindings budget.
 */
export function reportedCount(state: ReviewState): number {
  return state.verified.filter((f) => f.status === "confirmed" || f.status === "uncertain").length;
}

export function applyVerdict(
  state: ReviewState,
  candidate: CandidateFinding,
  verdict: VerifierResult,
  memoryMatches: MemoryMatch[],
): VerifiedFinding {
  let status: VerifiedFinding["status"];
  switch (verdict.verdict) {
    case "confirmed":
      status = "confirmed";
      break;
    case "rejected":
      status = "rejected";
      break;
    default:
      status = "uncertain";
  }

  const assessments = new Map((verdict.decisionAssessments ?? []).map((a) => [a.memoryId, a]));
  const annotated = memoryMatches.map((m) => {
    const assessment = assessments.get(m.memoryId);
    const stillApplies = assessment?.stillApplies ??
      (memoryMatches.length === 1 && verdict.decisionAssessments === undefined
        ? verdict.priorDecisionStillApplies
        : undefined);
    return { ...m, checkedByVerifier: stillApplies !== undefined, stillApplies };
  });

  // Suppression contract: a trusted prior decision that the verifier
  // explicitly endorses (stillApplies === true) turns the finding into the
  // prior decision's status — recorded, not silently dropped, and reopenable
  // when code changes. This holds even when the verifier *confirms* the
  // problem is technically real: for accepted_risk / wont_fix that is the
  // premise of the decision, not a contradiction of it.
  // Non-suppressive decisions (confirmed) are excluded: endorsing a prior
  // "confirmed" must not override the verifier's own verdict.
  const trusted = annotated.find(
    (m) => m.stillApplies === true && isTrustedSource(m.source) && isSuppressiveDecision(m.decision),
  );
  if (trusted) {
    status = decisionToStatus(trusted.decision);
  }

  const finding: VerifiedFinding = {
    ...candidate,
    status,
    verifierRationale: verdict.rationale,
    memoryMatches: annotated,
  };
  state.verified.push(finding);
  return finding;
}

function isTrustedSource(source: string): boolean {
  return source === "user_explicit" || source === "verified_fix";
}

/** Decisions that suppress a finding; "confirmed" is not one of them. */
const SUPPRESSIVE_DECISIONS: readonly IssueDecision[] = ["expected", "false_positive", "accepted_risk", "wont_fix"];

function isSuppressiveDecision(decision: string): decision is IssueDecision {
  return (SUPPRESSIVE_DECISIONS as readonly string[]).includes(decision);
}

function decisionToStatus(decision: string): VerifiedFinding["status"] {
  switch (decision) {
    case "expected":
      return "expected";
    case "false_positive":
      return "false_positive";
    case "accepted_risk":
      return "accepted_risk";
    case "wont_fix":
      return "wont_fix";
    default:
      return "rejected";
  }
}
