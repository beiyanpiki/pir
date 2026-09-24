import { claimSimilarity } from "./identity.js";
import type { CandidateFinding } from "./types.js";

export interface DedupResult {
  /** New candidates not seen before. */
  fresh: CandidateFinding[];
  /** Candidates that duplicate an already-known one (same fingerprint or near-identical claim). */
  duplicates: Array<{ candidate: CandidateFinding; of: CandidateFinding }>;
}

const NEAR_DUP_THRESHOLD = 0.82;

/**
 * Deduplicate candidates within a round and against everything accumulated in
 * previous rounds. Exact fingerprint match first; then near-duplicate check on
 * (category, entity, claim similarity) so trivially reworded findings collapse.
 */
export function deduplicateCandidates(
  candidates: CandidateFinding[],
  known: CandidateFinding[] = [],
): DedupResult {
  const seen = [...known];
  const fresh: CandidateFinding[] = [];
  const duplicates: DedupResult["duplicates"] = [];

  for (const candidate of candidates) {
    const dup = seen.find(
      (s) =>
        s.identity.fingerprint === candidate.identity.fingerprint ||
        (s.category === candidate.category &&
          (!!s.entityKey || !!candidate.entityKey) &&
          (s.entityKey ?? "") === (candidate.entityKey ?? "") &&
          claimSimilarity(s.identity.normalizedClaim, candidate.identity.normalizedClaim) >= NEAR_DUP_THRESHOLD),
    );
    if (dup) {
      duplicates.push({ candidate, of: dup });
    } else {
      fresh.push(candidate);
      seen.push(candidate);
    }
  }
  return { fresh, duplicates };
}
