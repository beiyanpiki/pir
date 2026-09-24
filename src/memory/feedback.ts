import type { IssueScope } from "./issue-memory.js";
import type { Memory } from "./index.js";

export const FEEDBACK_DECISIONS = [
  "confirmed",
  "expected",
  "false-positive",
  "accepted-risk",
  "wont-fix",
  "fixed",
  "obsolete",
] as const;

export type FeedbackDecision = (typeof FEEDBACK_DECISIONS)[number];

export function isFeedbackDecision(value: string): value is FeedbackDecision {
  return (FEEDBACK_DECISIONS as readonly string[]).includes(value);
}

export interface FeedbackInput {
  findingId: string;
  decision: FeedbackDecision;
  note?: string;
  priority?: string;
  commit: string;
}

export interface FeedbackResult {
  findingDisplayId: string;
  previousStatus: string;
  newStatus: string;
  issueMemoryId?: string;
  resolutionId?: string;
  invalidatedMemories: number;
}

const DECISION_TO_STATUS: Record<FeedbackDecision, string> = {
  confirmed: "confirmed",
  expected: "expected",
  "false-positive": "false_positive",
  "accepted-risk": "accepted_risk",
  "wont-fix": "wont_fix",
  fixed: "fixed",
  obsolete: "candidate",
};

const DECISION_TO_ISSUE: Partial<Record<FeedbackDecision, string>> = {
  confirmed: "confirmed",
  expected: "expected",
  "false-positive": "false_positive",
  "accepted-risk": "accepted_risk",
  "wont-fix": "wont_fix",
};

/**
 * Apply user feedback to a finding: append the audit event first, then derive
 * long-term memory (IssueMemory and/or FindingResolution). Only user feedback
 * writes decision memories — agents never call this path.
 */
export async function applyFeedback(memory: Memory, input: FeedbackInput): Promise<FeedbackResult> {
  const finding = memory.findings.get(input.findingId);
  if (!finding) {
    throw new Error(`finding not found: ${input.findingId}`);
  }

  memory.findings.appendFeedbackEvent({
    findingId: finding.id,
    action: `mark_${input.decision.replace(/-/g, "_")}`,
    decision: input.decision,
    note: input.note ?? null,
  });

  const previousStatus = finding.status;
  let newStatus = DECISION_TO_STATUS[input.decision];
  let issueMemoryId: string | undefined;
  let resolutionId: string | undefined;
  let invalidatedMemories = 0;

  const issueDecision = DECISION_TO_ISSUE[input.decision];
  if (issueDecision) {
    const scope: IssueScope = finding.entityKey ? "symbol" : finding.featureKey ? "feature" : "project";
    const issue = memory.issues.insert({
      featureKey: finding.featureKey,
      entityKey: finding.entityKey,
      fingerprint: finding.fingerprint,
      category: finding.category,
      claim: finding.claim,
      trigger: finding.trigger,
      decision: issueDecision as never,
      priority: input.priority ?? null,
      rationale: input.note ?? "",
      scope,
      source: "user_explicit",
      createdAtCommit: input.commit,
      validUntilCommit: null,
      stale: false,
    });
    issueMemoryId = issue.id;
  }

  if (input.decision === "fixed") {
    const resolution = memory.resolutions.insert({
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      featureKey: finding.featureKey,
      entityKey: finding.entityKey,
      category: finding.category,
      originalClaim: finding.claim,
      originalTrigger: finding.trigger,
      resolution: "fixed",
      explanation: input.note ?? "",
      beforeCommit: null,
      afterCommit: input.commit,
      beforeCodeHash: null,
      afterCodeHash: null,
      fixCommit: null,
      fixDiffHash: null,
      verified: false,
    });
    resolutionId = resolution.id;
  }

  if (input.decision === "obsolete") {
    invalidatedMemories = memory.issues.invalidateForFingerprint(finding.fingerprint);
    newStatus = previousStatus === "candidate" ? "rejected" : previousStatus;
  }

  memory.findings.updateStatus(finding.id, newStatus);
  if (input.priority) memory.findings.updateSeverity(finding.id, input.priority);

  return {
    findingDisplayId: finding.displayId,
    previousStatus,
    newStatus,
    issueMemoryId,
    resolutionId,
    invalidatedMemories,
  };
}

export function applyPriority(memory: Memory, findingId: string, priority: string, note?: string): FeedbackResult {
  const finding = memory.findings.get(findingId);
  if (!finding) throw new Error(`finding not found: ${findingId}`);
  if (!["P0", "P1", "P2", "P3"].includes(priority)) {
    throw new Error(`invalid priority: ${priority}`);
  }
  memory.findings.appendFeedbackEvent({
    findingId: finding.id,
    action: "set_priority",
    priority,
    note: note ?? null,
  });
  memory.findings.updateSeverity(finding.id, priority);
  return {
    findingDisplayId: finding.displayId,
    previousStatus: finding.status,
    newStatus: finding.status,
    invalidatedMemories: 0,
  };
}
