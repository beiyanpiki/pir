import type { CandidateFinding, MemoryMatch, VerifiedFinding, VerifierResult } from "../findings/types.js";

export interface RoundInfo {
  round: number;
  candidates: number;
  fresh: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  summary: string;
}

export interface ReviewState {
  base: string;
  head: string;
  round: number;
  maxRounds: number;
  /** All candidates accumulated across rounds (dedup baseline). */
  known: CandidateFinding[];
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
    verified: [],
    rounds: [],
    focus: [],
    dryRounds: 0,
    estimatedTokens: 0,
    stoppedBecause: null,
  };
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

  const annotated = memoryMatches.map((m) => ({
    ...m,
    checkedByVerifier: true,
    stillApplies: verdict.priorDecisionStillApplies ?? undefined,
  }));

  // Suppression contract: a trusted prior decision that the verifier confirmed
  // still applies turns the finding into the prior decision's status — it is
  // recorded, not silently dropped, and can be reopened when code changes.
  const trusted = annotated.some((m) => m.stillApplies === true && isTrustedSource(m.source));
  if (trusted && verdict.verdict !== "confirmed") {
    const decision = annotated.find((m) => m.stillApplies === true)!.decision;
    status = decisionToStatus(decision);
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
