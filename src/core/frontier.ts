import type { ReviewState } from "./review-state.js";
import type { ReviewerRoundResult } from "../agents/reviewer.js";
import type { VerifierResult } from "../findings/types.js";

const MAX_FOCUS = 16;

/**
 * The frontier is the set of symbols/paths the next round should prioritize.
 * It grows from reviewer hints, candidate entity keys, and areas where
 * verification failed (uncertain verdicts usually mean unexplored context).
 */
export function expandFrontier(state: ReviewState, result: ReviewerRoundResult, verdicts: VerifierResult[]): void {
  const next = new Set(state.focus);
  for (const item of result.nextFocus) {
    if (next.size >= MAX_FOCUS) break;
    next.add(item);
  }
  for (const candidate of result.candidates) {
    if (next.size >= MAX_FOCUS) break;
    if (candidate.entityKey) next.add(candidate.entityKey);
    else if (candidate.anchors[0]?.path) next.add(candidate.anchors[0].path);
  }
  state.focus = [...next].slice(0, MAX_FOCUS);
}
