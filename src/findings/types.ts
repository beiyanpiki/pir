import type { SourceAnchor } from "../core/types.js";

export type Severity = "P0" | "P1" | "P2" | "P3";

export const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const FINDING_CATEGORIES = [
  "correctness",
  "concurrency",
  "security",
  "performance",
  "resource-leak",
  "error-handling",
  "api-misuse",
  "regression",
  "maintainability",
  "style",
  "other",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type EvidenceKind = "code" | "diff" | "test" | "doc" | "memory" | "commit";

export interface FindingEvidence {
  kind: EvidenceKind;
  path?: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
  description?: string;
}

/**
 * Stable identity of a finding, independent of line numbers so that historical
 * decisions can match future occurrences of the same issue.
 */
export interface FindingIdentity {
  /** sha256 of featureKey + entityKey + category + normalizedClaim + normalizedTrigger. */
  fingerprint: string;
  featureKey: string;
  entityKey: string;
  category: string;
  normalizedClaim: string;
  normalizedTrigger: string;
}

export interface CandidateFinding {
  /** Runtime id assigned when collected (F-1, F-2, ...). */
  displayId?: string;
  title: string;
  /** One-sentence assertion of the problem. */
  claim: string;
  /** The code path or condition that activates the problem. */
  trigger: string;
  category: string;
  severity: Severity;
  featureKey?: string;
  entityKey?: string;
  anchors: SourceAnchor[];
  evidence: FindingEvidence[];
  round: number;
  identity: FindingIdentity;
}

export type FindingStatus =
  | "candidate"
  | "confirmed"
  | "rejected"
  | "uncertain"
  | "expected"
  | "false_positive"
  | "accepted_risk"
  | "wont_fix"
  | "fixed";

export interface MemoryMatch {
  memoryId: string;
  decision: string;
  scope: string;
  source: string;
  claim: string;
  rationale?: string;
  stillApplies?: boolean;
  checkedByVerifier?: boolean;
}

export type VerifierVerdict = "confirmed" | "rejected" | "uncertain";

export interface VerifierResult {
  verdict: VerifierVerdict;
  rationale: string;
  /** When a historical decision was matched: does it still apply to the current code? */
  priorDecisionStillApplies?: boolean;
  confidence: number;
}

export interface VerifiedFinding extends CandidateFinding {
  status: FindingStatus;
  verifierRationale?: string;
  memoryMatches: MemoryMatch[];
}

/** A persisted finding row as returned by the store. */
export interface FindingRecord extends VerifiedFinding {
  id: string;
  projectId: string;
  runId: string;
  createdAt: number;
  updatedAt: number;
}
