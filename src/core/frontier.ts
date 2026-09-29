import type { ReviewState } from "./review-state.js";
import type { ReviewerRoundResult } from "../agents/reviewer.js";
import type { VerifierResult } from "../findings/types.js";

const MAX_FOCUS = 16;

export function expandFrontier(state: ReviewState, result: ReviewerRoundResult, verdicts: VerifierResult[]): void {
  const questions = verdicts
    .filter((v) => v.verdict === "uncertain" && v.codeFeedback)
    .map((v) => v.codeFeedback!);
  state.focus = [...new Set([
    ...questions, ...result.nextFocus, ...(result.unresolvedQuestions ?? []),
  ].map((s) => s.trim()).filter(Boolean))].slice(0, MAX_FOCUS);
}
