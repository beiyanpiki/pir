import type { Budget } from "./budget.js";
import type { ReviewState } from "./review-state.js";

/** Stop conditions: explicit reviewer signal, information dry-up, or budget. */
export function shouldStop(state: ReviewState, budget: Budget): { stop: boolean; reason: string | null } {
  if (state.round >= state.maxRounds) {
    return { stop: true, reason: `max rounds reached (${state.maxRounds})` };
  }
  const exhausted = budget.exhausted();
  if (exhausted) return { stop: true, reason: exhausted };
  // Two consecutive rounds without new information → converged.
  if (state.dryRounds >= 2) return { stop: true, reason: "converged: no new information in the last rounds" };
  return { stop: false, reason: null };
}

/**
 * Information gain per round: fresh candidates and non-rejected verdicts both
 * count; a round that only re-derives known findings or yields nothing is dry.
 */
export function calculateInformationGain(state: ReviewState, freshCount: number, nonRejected: number): void {
  if (freshCount === 0 && nonRejected === 0) {
    state.dryRounds += 1;
  } else {
    state.dryRounds = 0;
  }
}
